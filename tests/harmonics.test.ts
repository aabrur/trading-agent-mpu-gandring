import { describe, expect, it } from 'vitest';
import { detectHarmonicPatterns } from '../server/market/harmonics.js';

describe('Harmonic Fibonacci PRZ Geometry Engine', () => {
  it('returns empty array when insufficient candle data is provided', () => {
    const candles = [
      { t: 0, o: 100, h: 101, l: 99, c: 100, v: 10 },
      { t: 1, o: 100, h: 102, l: 98, c: 101, v: 10 },
    ];
    expect(detectHarmonicPatterns(candles)).toEqual([]);
  });

  it('identifies a Bullish Gartley pattern matching Fibonacci proportions', () => {
    // Bullish Gartley XABCD geometry:
    // X at 100 (Low)
    // A at 200 (High) -> XA = 100
    // B at 138.2 (Low, retraces ~0.618 of XA: 200 - 61.8 = 138.2)
    // C at 165 (High, retraces ~0.43 of AB)
    // D at 121.4 (Low, retraces ~0.786 of XA: 200 - 78.6 = 121.4)

    // Build synthetic bars that generate these swing points
    const makePivots = () => {
      const bars = [];
      let t = 0;
      // Pre-bars
      for (let i = 0; i < 3; i++) bars.push({ t: t++, o: 105, h: 106, l: 104, c: 105, v: 10 });
      // Point X: Low 100
      bars.push({ t: t++, o: 104, h: 105, l: 100, c: 102, v: 10 });
      for (let i = 0; i < 3; i++) bars.push({ t: t++, o: 110 + i * 20, h: 115 + i * 20, l: 108 + i * 20, c: 114 + i * 20, v: 10 });
      // Point A: High 200
      bars.push({ t: t++, o: 195, h: 200, l: 194, c: 196, v: 10 });
      for (let i = 0; i < 3; i++) bars.push({ t: t++, o: 180 - i * 10, h: 182 - i * 10, l: 160 - i * 10, c: 165 - i * 10, v: 10 });
      // Point B: Low 138
      bars.push({ t: t++, o: 140, h: 142, l: 138, c: 140, v: 10 });
      for (let i = 0; i < 3; i++) bars.push({ t: t++, o: 145 + i * 5, h: 152 + i * 5, l: 144 + i * 5, c: 150 + i * 5, v: 10 });
      // Point C: High 165
      bars.push({ t: t++, o: 163, h: 165, l: 161, c: 163, v: 10 });
      for (let i = 0; i < 3; i++) bars.push({ t: t++, o: 150 - i * 8, h: 152 - i * 8, l: 135 - i * 8, c: 140 - i * 8, v: 10 });
      // Point D: Low 121
      bars.push({ t: t++, o: 125, h: 127, l: 121, c: 124, v: 10 });
      for (let i = 0; i < 3; i++) bars.push({ t: t++, o: 126, h: 128, l: 125, c: 127, v: 10 });
      return bars;
    };

    const candles = makePivots();
    const patterns = detectHarmonicPatterns(candles);

    expect(patterns.length).toBeGreaterThanOrEqual(1);
    const gartley = patterns[0];
    expect(gartley.name).toBe('GARTLEY');
    expect(gartley.orientation).toBe('BULLISH');
    expect(gartley.prz).toBeDefined();
    expect(gartley.prz.entryMin).toBeLessThanOrEqual(gartley.prz.entryMax);
    expect(gartley.prz.stopLoss).toBeLessThan(gartley.prz.entryMin);
    expect(gartley.prz.target1).toBeGreaterThan(gartley.prz.entryMax);
    expect(gartley.qualityScore).toBeGreaterThan(60);
  });
});
