import { describe, expect, it } from 'vitest';
import { calculateAlphaFactors, type Alpha158Factors } from '../server/market/alpha-factors.js';

describe('Alpha158 Formulaic Factor Library', () => {
  const baseTime = 1700000000000;

  function makeRisingCandles(count: number = 30) {
    const candles = [];
    let price = 100;
    for (let i = 0; i < count; i++) {
      const open = price;
      const close = price + 1.5;
      const high = close + 0.5;
      const low = open - 0.5;
      candles.push({
        t: baseTime + i * 60_000,
        o: open,
        h: high,
        l: low,
        c: close,
        v: 1000 + i * 50,
      });
      price = close;
    }
    return candles;
  }

  function makeFallingCandles(count: number = 30) {
    const candles = [];
    let price = 200;
    for (let i = 0; i < count; i++) {
      const open = price;
      const close = price - 1.5;
      const high = open + 0.5;
      const low = close - 0.5;
      candles.push({
        t: baseTime + i * 60_000,
        o: open,
        h: high,
        l: low,
        c: close,
        v: 1000 + i * 50,
      });
      price = close;
    }
    return candles;
  }

  it('returns null when insufficient candle history is provided (< 5 bars)', () => {
    const shortCandles = [
      { t: 1, o: 100, h: 101, l: 99, c: 100, v: 10 },
      { t: 2, o: 100, h: 102, l: 99, c: 101, v: 12 },
    ];
    expect(calculateAlphaFactors(shortCandles)).toBeNull();
  });

  it('correctly computes structural and momentum factors on a bullish trend', () => {
    const candles = makeRisingCandles(30);
    const factors = calculateAlphaFactors(candles);

    expect(factors).not.toBeNull();
    if (!factors) return;

    // Structural
    expect(factors.kmid).toBeGreaterThan(0); // close > open
    expect(factors.roc5).toBeGreaterThan(0);
    expect(factors.roc20).toBeGreaterThan(0);
    expect(factors.ma5Ratio).toBeGreaterThan(0);
    expect(factors.rsv14).toBeGreaterThan(0.5);

    // Composite score & regime
    expect(factors.compositeScore).toBeGreaterThan(0);
    expect(factors.compositeScore).toBeLessThanOrEqual(1.0);
    expect(factors.regime).toBe('TRENDING_BULL');
  });

  it('correctly computes structural and momentum factors on a bearish trend', () => {
    const candles = makeFallingCandles(30);
    const factors = calculateAlphaFactors(candles);

    expect(factors).not.toBeNull();
    if (!factors) return;

    // Structural
    expect(factors.kmid).toBeLessThan(0); // close < open
    expect(factors.roc5).toBeLessThan(0);
    expect(factors.roc20).toBeLessThan(0);
    expect(factors.ma5Ratio).toBeLessThan(0);
    expect(factors.rsv14).toBeLessThan(0.5);

    // Composite score & regime
    expect(factors.compositeScore).toBeLessThan(0);
    expect(factors.compositeScore).toBeGreaterThanOrEqual(-1.0);
    expect(factors.regime).toBe('TRENDING_BEAR');
  });

  it('calculates volatility and volume ratios correctly', () => {
    const candles = makeRisingCandles(30);
    const factors = calculateAlphaFactors(candles);

    expect(factors).not.toBeNull();
    if (!factors) return;

    expect(factors.atr14).toBeGreaterThan(0);
    expect(factors.atrRatio).toBeGreaterThan(0);
    expect(factors.bbBandwidth20).toBeGreaterThan(0);
    expect(factors.vma5Ratio).toBeGreaterThan(0); // Rising volume
  });

  it('keeps a sub-cent ATR instead of rounding it to zero', () => {
    const candles = Array.from({ length: 20 }, (_, i) => {
      const close = 0.0000095 + i * 1e-9;
      return { t: i, o: close, h: close + 2e-9, l: close - 1e-9, c: close, v: 10 };
    });
    const factors = calculateAlphaFactors(candles);
    expect(factors).not.toBeNull();
    expect(factors!.atr14).toBeGreaterThan(0);
    expect(factors!.atr14).toBeLessThan(0.01);
  });
});
