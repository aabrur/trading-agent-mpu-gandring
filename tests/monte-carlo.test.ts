import { describe, expect, it } from 'vitest';
import { simulateMonteCarlo } from '../server/market/monte-carlo.js';

describe('Monte Carlo Path Distributions & Volatility Regimes', () => {
  const candles = [
    { t: 1, c: 100 },
    { t: 2, c: 101 },
    { t: 3, c: 103 },
    { t: 4, c: 102 },
    { t: 5, c: 104 },
    { t: 6, c: 106 },
    { t: 7, c: 105 },
    { t: 8, c: 108 },
  ];

  it('generates forward quantiles with monotonic ordering p10 <= p50 <= p90', () => {
    const forecast = simulateMonteCarlo({
      candles,
      horizon: 8,
      numPaths: 150,
      tpPrice: 115,
      slPrice: 102,
    });

    expect(forecast.currentPrice).toBe(108);
    expect(forecast.horizon).toBe(8);
    expect(forecast.p10.length).toBe(9);
    expect(forecast.p50.length).toBe(9);
    expect(forecast.p90.length).toBe(9);

    // Initial step is current price
    expect(forecast.p10[0]).toBe(108);
    expect(forecast.p50[0]).toBe(108);
    expect(forecast.p90[0]).toBe(108);

    // Terminal step respects quantile ordering
    expect(forecast.p10[8]).toBeLessThanOrEqual(forecast.p50[8]);
    expect(forecast.p50[8]).toBeLessThanOrEqual(forecast.p90[8]);
    expect(forecast.probTpFirst).toBeGreaterThanOrEqual(0);
    expect(forecast.probTpFirst).toBeLessThanOrEqual(1);
    expect(['EXPANDING_VOLATILITY', 'CONTRACTING_VOLATILITY', 'STABLE_DRIFT']).toContain(forecast.regime);
  });

  it('handles sparse candle inputs gracefully with fallback defaults', () => {
    const emptyForecast = simulateMonteCarlo({ candles: [] });
    expect(emptyForecast.regime).toBe('UNCERTAIN');
    expect(emptyForecast.p10).toEqual([]);
    expect(emptyForecast.probTpFirst).toBe(0.5);

    const singleBar = simulateMonteCarlo({ candles: [{ c: 50 }] });
    expect(singleBar.currentPrice).toBe(50);
    expect(singleBar.regime).toBe('UNCERTAIN');
  });
});
