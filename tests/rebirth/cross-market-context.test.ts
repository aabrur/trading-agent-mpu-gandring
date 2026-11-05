import { describe, expect, it } from 'vitest';
import {
  computeCrossMarketBreadth
} from '../../server/v2/runtime.js';

describe('Task 3: Cross-Market Breadth and Owner Discussion Context', () => {
  it('identifies systemic risk-off when majority of active symbols are dropping with high relative volume', () => {
    const tickers: Record<string, { last: number; change15m?: number; relVol15m?: number; trend15m?: string }> = {
      BTCUSDT: { last: 67000, change15m: -1.8, relVol15m: 5.2, trend15m: 'DOWNTREND' },
      ETHUSDT: { last: 2350, change15m: -2.4, relVol15m: 6.1, trend15m: 'DOWNTREND' },
      SOLUSDT: { last: 93.5, change15m: -3.1, relVol15m: 8.8, trend15m: 'DOWNTREND' },
      BNBUSDT: { last: 705, change15m: -1.9, relVol15m: 4.5, trend15m: 'DOWNTREND' },
      XRPUSDT: { last: 1.27, change15m: -2.1, relVol15m: 7.0, trend15m: 'DOWNTREND' },
      DOGEUSDT: { last: 0.074, change15m: -2.8, relVol15m: 11.2, trend15m: 'DOWNTREND' },
      ZECUSDT: { last: 1270, change15m: 0.5, relVol15m: 1.1, trend15m: 'UPTREND' }
    };

    const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ZECUSDT'];

    const breadth = computeCrossMarketBreadth(tickers, symbols);

    expect(breadth.regime).toBe('SYSTEMIC_RISK_OFF');
    expect(breadth.bearishCount).toBe(6);
    expect(breadth.bullishCount).toBe(1);
    expect(breadth.highRelVolCount).toBe(6);
    expect(breadth.summary).toContain('risk-off');
  });

  it('identifies normal or mixed regime when symbols are balanced without volume expansion', () => {
    const tickers: Record<string, { last: number; change15m?: number; relVol15m?: number; trend15m?: string }> = {
      BTCUSDT: { last: 67000, change15m: 0.2, relVol15m: 1.0, trend15m: 'UPTREND' },
      ETHUSDT: { last: 2350, change15m: -0.1, relVol15m: 0.9, trend15m: 'DOWNTREND' },
      SOLUSDT: { last: 93.5, change15m: 0.4, relVol15m: 1.2, trend15m: 'UPTREND' }
    };

    const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

    const breadth = computeCrossMarketBreadth(tickers, symbols);

    expect(breadth.regime).toBe('BALANCED_CHOP');
    expect(breadth.bearishCount).toBe(1);
    expect(breadth.bullishCount).toBe(2);
  });
});
