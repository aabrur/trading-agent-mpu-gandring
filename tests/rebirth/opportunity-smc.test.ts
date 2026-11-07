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
});
