import { describe, expect, it } from 'vitest';
import { evaluateWatchlistOpportunity } from '../../server/v2/market/opportunity.js';
import { analyzeSMC } from '../../server/market/smc.js';

function hubWith(bars: Array<{ open: number; high: number; low: number; close: number; volume: number }>, p24: string) {
  return {
    snapshot: () => ({
      last: { value: String(bars.at(-1)!.close), availability: 'AVAILABLE' },
      closed: { '15m': bars.map((b, i) => ({ ...b, startAt: i * 900_000, confirmed: true })) },
      price24hPcnt: p24
    })
  } as any;
}

describe('watchlist opportunity scoring', () => {
  it('ranks aligned evidence above conflicting evidence', () => {
    const rising = Array.from({ length: 25 }, (_, i) => ({ open: 100 + i, high: 101 + i, low: 99.5 + i, close: 100.8 + i, volume: 100 }));
    const aligned = evaluateWatchlistOpportunity('AAAUSDT', hubWith(rising, '0.05'));
    const conflicted = evaluateWatchlistOpportunity('BBBUSDT', hubWith(rising, '-0.05'));

    expect(aligned.bias).toBe('BULLISH');
    expect(conflicted.reasons.some((r) => r.startsWith('CONFLICT'))).toBe(true);
    expect(aligned.score).toBeGreaterThan(conflicted.score);
  });
});

describe('SMC order blocks', () => {
  it('includes symbol and tf prefix in order block and fvg ids when provided', () => {
    const bars = Array.from({ length: 40 }, (_, i) => {
      const base = i < 20 ? 100 + (i % 4) : 110 + i;
      const up = i % 3 !== 0;
      return { timestamp: i * 60_000, open: up ? base : base + 1, high: base + 2, low: base - 1, close: up ? base + 1 : base, volume: 10 };
    });
    const smc = analyzeSMC(bars, { symbol: 'ETHUSDT', tf: '15m' })!;
    for (const ob of smc.activeOrderBlocks) {
      expect(ob.id.startsWith('ob-ETHUSDT-15m-')).toBe(true);
    }
    for (const fvg of smc.activeFVGs) {
      expect(fvg.id.startsWith('fvg-ETHUSDT-15m-')).toBe(true);
    }
  });

  it('marks bullish OB mitigated when an intervening bar wicks below its low even if latest close recovers', () => {
    const bars = [
      { timestamp: 1000, open: 100, high: 102, low: 98, close: 101, volume: 10 },
      { timestamp: 2000, open: 101, high: 104, low: 99, close: 103, volume: 10 },
      { timestamp: 3000, open: 103, high: 110, low: 102, close: 104, volume: 10 }, // swing high 110
      { timestamp: 4000, open: 104, high: 106, low: 100, close: 102, volume: 10 },
      { timestamp: 5000, open: 102, high: 105, low: 99, close: 100, volume: 10 },
      { timestamp: 6000, open: 103, high: 104, low: 97, close: 98, volume: 10 }, // bearish candle OB (97..104)
      { timestamp: 7000, open: 98, high: 115, low: 98, close: 114, volume: 20 }, // BOS above 110
      { timestamp: 8000, open: 114, high: 116, low: 94, close: 112, volume: 20 }, // intervening wick below 97 mitigates OB, closes at 112
      { timestamp: 9000, open: 112, high: 115, low: 110, close: 113, volume: 10 },
      { timestamp: 10000, open: 113, high: 114, low: 111, close: 113.5, volume: 10 }
    ];
    const smc = analyzeSMC(bars, { symbol: 'BTCUSDT', tf: '15m' })!;
    expect(smc.activeOrderBlocks.some((ob) => ob.bottomPrice === 97)).toBe(false);
  });
});
