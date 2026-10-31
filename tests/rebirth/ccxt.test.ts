import { describe, expect, it } from 'vitest';
import { CcxtMarketAdapter } from '../../server/v2/market/ccxt.js';

describe('CCXT Market Intelligence Layer', () => {
  it('reports capabilities without crashing when uninstalled or offline', async () => {
    const adapter = new CcxtMarketAdapter();
    const report = await adapter.getCapabilityReport();

    expect(report).toBeDefined();
    expect(typeof report.installed).toBe('boolean');
    expect(report.venues).toBeDefined();
    expect(report.venues.bybit.executionRole).toBe('NATIVE_ADAPTER_ONLY');
  });

  it('runs venue diagnostics cleanly', async () => {
    const adapter = new CcxtMarketAdapter();
    const diag = await adapter.diagnoseConnection('bybit');

    expect(diag.venue).toBe('bybit');
    expect(typeof diag.ok).toBe('boolean');
  });

  it('gracefully handles missing credentials or offline fetch', async () => {
    const adapter = new CcxtMarketAdapter();
    const candles = await adapter.fetchOhlcv('bybit', 'BTC/USDT', '15m');
    expect(candles).toEqual([]);

    const ob = await adapter.fetchOrderBook('bybit', 'BTC/USDT');
    expect(ob).toEqual({ bids: [], asks: [], timestamp: null });
  });
});
