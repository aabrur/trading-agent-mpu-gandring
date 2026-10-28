import { describe, expect, it } from 'vitest';
import type { Candle, MarketSnapshot } from '../server/types.js';
import { strategyVote } from '../server/strategy.js';
import { revalidateEntry } from '../server/decision/stale.js';

const bars = (closes: number[]): Candle[] => closes.map((c, i) => ({ t: i * 900_000, o: c, h: c + 0.1, l: c - 0.1, c, v: 100 }));
const rising = Array.from({ length: 80 }, (_, i) => 100 + i * 0.2);
const snapshot = (overrides: Partial<MarketSnapshot> = {}): MarketSnapshot => ({ symbol: 'BTCUSDT', source: 'bybit', example: false, last: 116, bid: 115.99, ask: 116, change24hPct: 1, fundingRate: null, fetchedAt: Date.now(), candles: bars(rising), ...overrides });

describe('Owner momentum alignment', () => {
  it('does not turn EMA alignment into LONG with negative short-term momentum', () => {
    const closes = [...rising.slice(0, -6), 116.6, 116.5, 116.4, 116.3, 116.2, 116.1];
    const result = strategyVote(bars(closes));
    expect(result.close).toBeGreaterThan(result.ema9);
    expect(result.change5Pct).toBeLessThan(0);
    expect(result).toMatchObject({ side: 'ABSTAIN', momentumConflict: true });
  });

  it('does not turn bearish EMA alignment into SHORT with positive short-term momentum', () => {
    const closes = [...rising.slice(0, -6), 116.6, 116.5, 116.4, 116.3, 116.2, 116.1].map(c => 240 - c);
    const result = strategyVote(bars(closes));
    expect(result.close).toBeLessThan(result.ema9);
    expect(result.change5Pct).toBeGreaterThan(0);
    expect(result).toMatchObject({ side: 'ABSTAIN', momentumConflict: true });
  });

  it('keeps conflicting ROC and flow visible rather than using an OR condition', () => {
    expect(strategyVote(bars(rising), { roc5: -0.01 })).toMatchObject({ side: 'ABSTAIN', momentumConflict: true });
    expect(strategyVote(bars(rising), { orderflow: { cvdDelta: -100, buySellRatio: 0.8 } })).toMatchObject({ side: 'ABSTAIN', momentumConflict: true });
    expect(strategyVote(bars(rising), { orderflow: { cvdDelta: 100, buySellRatio: 1.2 } })).toMatchObject({ side: 'LONG', momentumConflict: false });
  });
});

describe('binding entry revalidation', () => {
  const zone = { low: 115, high: 117, basis: 'confirmed pullback structure' };
  const evaluate = (overrides: Partial<Parameters<typeof revalidateEntry>[0]> = {}) => {
    const snap = snapshot();
    return revalidateEntry({ original: snap, originalRule: strategyVote(snap.candles), side: 'LONG', fresh: snap, entryZone: zone, invalidationLevel: 114, expectedVenue: 'bybit', tradingMode: 'LIVE', ...overrides });
  };

  it('binds an actual venue quote to the entry zone and strictly directional invalidation', () => {
    expect(evaluate({ executionQuote: 116 }).ok).toBe(true);
    expect(evaluate({ executionQuote: 119 })).toMatchObject({ ok: false, quote: 119 });
    expect(evaluate({ invalidationLevel: 116 }).ok).toBe(false);
    expect(evaluate({ entryZone: null }).ok).toBe(false);
    expect(evaluate({ entryZone: { ...zone, low: 118, high: 117 } }).ok).toBe(false);
    expect(evaluate({ side: 'SHORT', invalidationLevel: 116 }).ok).toBe(false);
  });

  it('surfaces sample data and price-source conflict rather than silently using another venue', () => {
    expect(evaluate({ fresh: snapshot({ source: 'sample', example: true }) }).ok).toBe(false);
    expect(evaluate({ fresh: snapshot({ source: 'binance' }) }).reason).toMatch(/source conflict/i);
    expect(evaluate({ tradingMode: 'PAPER', fresh: snapshot({ source: 'sample', example: true }), original: snapshot({ source: 'sample', example: true }) }).ok).toBe(true);
  });

  it('rejects an entry into confirmed tactical exhaustion in its direction', () => {
    const fresh = snapshot({ tacticalTradePlan: { symbol: 'BTCUSDT', timestamp: Date.now(), marketRegime: 'UNKNOWN', scenarios: [], exhaustion: { present: true, direction: 'BUYER', evidence: ['confirmed closed-candle and flow exhaustion'] } } });
    expect(evaluate({ fresh, executionQuote: 116 }).reason).toMatch(/exhaustion/i);
  });
});
