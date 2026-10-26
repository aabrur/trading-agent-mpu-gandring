import { describe, expect, it } from 'vitest';
import { analyzeSMC, findSwingPoints, detectFairValueGaps } from '../server/market/smc.js';

describe('Smart Money Concepts (SMC) Structure Engine', () => {
  const baseTime = 1700000000000;

  it('detects swing highs and swing lows correctly', () => {
    // Construct a wave pattern: Low (90) -> High (110) -> Low (95) -> High (120)
    const raw = [
      { t: 0, o: 95, h: 96, l: 94, c: 95, v: 10 },
      { t: 1, o: 94, h: 95, l: 92, c: 93, v: 10 },
      { t: 2, o: 92, h: 93, l: 89, c: 90, v: 10 }, // Swing Low at index 2 (price 89)
      { t: 3, o: 90, h: 98, l: 90, c: 97, v: 10 },
      { t: 4, o: 97, h: 105, l: 96, c: 104, v: 10 },
      { t: 5, o: 104, h: 112, l: 103, c: 110, v: 10 }, // Swing High at index 5 (price 112)
      { t: 6, o: 110, h: 111, l: 102, c: 103, v: 10 },
      { t: 7, o: 103, h: 104, l: 95, c: 96, v: 10 },
      { t: 8, o: 96, h: 100, l: 94, c: 98, v: 10 },
    ].map(c => ({
      index: c.t,
      timestamp: baseTime + c.t * 60_000,
      open: c.o,
      high: c.h,
      low: c.l,
      close: c.c,
      volume: c.v,
    }));

    const swings = findSwingPoints(raw, 2);
    expect(swings.length).toBeGreaterThanOrEqual(2);

    const high = swings.find(s => s.type === 'HIGH');
    const low = swings.find(s => s.type === 'LOW');

    expect(high).toBeDefined();
    expect(high?.price).toBe(112);
    expect(low).toBeDefined();
    expect(low?.price).toBe(89);
  });

  it('detects Bullish Fair Value Gap (FVG) and tracks mitigation', () => {
    // 3-bar Bullish FVG: Bar 0 High is 100, Bar 2 Low is 105 -> Gap is [100, 105]
    const raw = [
      { index: 0, timestamp: 0, open: 98, high: 100, low: 97, close: 99, volume: 10 },
      { index: 1, timestamp: 1, open: 100, high: 110, low: 100, close: 109, volume: 50 },
      { index: 2, timestamp: 2, open: 109, high: 115, low: 105, close: 114, volume: 20 },
      // Bar 3 stays above 100 -> unmitigated
      { index: 3, timestamp: 3, open: 114, high: 116, low: 108, close: 112, volume: 10 },
    ];

    const fvgs = detectFairValueGaps(raw);
    expect(fvgs).toHaveLength(1);
    expect(fvgs[0].type).toBe('BULLISH');
    expect(fvgs[0].topPrice).toBe(105);
    expect(fvgs[0].bottomPrice).toBe(100);
    expect(fvgs[0].mitigated).toBe(false);

    // If Bar 4 dips to 99, FVG is mitigated
    raw.push({ index: 4, timestamp: 4, open: 112, high: 113, low: 99, close: 102, volume: 30 });
    const fvgsUpdated = detectFairValueGaps(raw);
    expect(fvgsUpdated[0].mitigated).toBe(true);
  });

  it('detects Break of Structure (BOS) and identifies Order Blocks', () => {
    // Create sequence with a swing high at 105, pull back, then breakout to 115
    const candles = [
      { t: 0, o: 95, h: 96, l: 94, c: 95, v: 10 },
      { t: 1, o: 95, h: 97, l: 94, c: 96, v: 10 },
      { t: 2, o: 96, h: 105, l: 95, c: 104, v: 10 }, // Swing High at 105
      { t: 3, o: 104, h: 104, l: 98, c: 99, v: 10 },  // Bearish pullback (Potential OB)
      { t: 4, o: 99, h: 101, l: 97, c: 98, v: 10 },   // Bearish pullback
      { t: 5, o: 98, h: 102, l: 98, c: 101, v: 10 },
      { t: 6, o: 101, h: 110, l: 100, c: 109, v: 20 }, // Breakout bar above 105!
      { t: 7, o: 109, h: 115, l: 108, c: 114, v: 25 },
      { t: 8, o: 114, h: 116, l: 112, c: 115, v: 15 },
      { t: 9, o: 115, h: 118, l: 113, c: 117, v: 15 },
      { t: 10, o: 117, h: 120, l: 115, c: 119, v: 15 },
    ];

    const smc = analyzeSMC(candles);
    expect(smc).not.toBeNull();
    if (!smc) return;

    expect(smc.marketTrend).toBe('BULLISH');
    expect(smc.lastBreak).not.toBeNull();
    expect(smc.lastBreak?.type).toBe('BULLISH_BOS');
    expect(smc.lastBreak?.brokenLevel).toBe(105);
    expect(smc.activeOrderBlocks.length).toBeGreaterThan(0);
    expect(smc.premiumDiscountZone).toBeDefined();
  });
});
