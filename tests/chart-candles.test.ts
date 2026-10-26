import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import * as market from '../server/market/index.js';

let built: ReturnType<typeof createApp>;
let url: string;
beforeEach(async () => {
  built = createApp(loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEFAULT_PROVIDER: 'mock' }), { reportsDir: null, learningsPath: null, conversationsPath: null, sessionLog: null, jevEnv: {} });
  await new Promise<void>((resolve) => built.server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(built.server.address() as AddressInfo).port}/api/candles`;
});
afterEach(async () => {
  built.desk.stop();
  await new Promise<void>((resolve) => built.close(() => resolve()));
  vi.restoreAllMocks();
});

describe('chart candle contract', () => {
  it('returns the requested timeframe and volume without invoking research snapshots', async () => {
    const snapshot = vi.spyOn(market, 'getSnapshot');
    const candles = vi.spyOn(market, 'getCandles').mockImplementation(async (symbol, tf) => ({ symbol, tf, source: 'bybit', example: false, errors: [], candles: [{ t: 1_800_000, o: 100, h: 105, l: 98, c: 103, v: 42 }] }));
    for (const tf of market.TIMEFRAMES) {
      const result = await fetch(`${url}?symbol=BTCUSDT&tf=${tf}`).then(r => r.json());
      expect(result).toMatchObject({ symbol: 'BTCUSDT', tf, source: 'bybit', example: false, candles: [{ time: 1800, volume: 42 }] });
    }
    expect(candles).toHaveBeenCalledTimes(6);
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('keeps caches separate per symbol and timeframe and coalesces concurrent loads', async () => {
    const candles = vi.spyOn(market, 'getCandles').mockImplementation(async (symbol, tf) => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return { symbol, tf, source: 'sample', example: true, errors: [], candles: [] };
    });
    await Promise.all(Array.from({ length: 4 }, () => fetch(`${url}?symbol=BTCUSDT&tf=1h`)));
    await fetch(`${url}?symbol=BTCUSDT&tf=1h`);
    expect(candles).toHaveBeenCalledTimes(1);
    await fetch(`${url}?symbol=BTCUSDT&tf=4h`);
    await fetch(`${url}?symbol=ETHUSDT&tf=1h`);
    expect(candles).toHaveBeenCalledTimes(3);
  });

  it('rejects invalid intervals before fetching and never relabels sample 15m bars as 5m', async () => {
    const candles = vi.spyOn(market, 'getCandles');
    expect((await fetch(`${url}?tf=2m`)).status).toBe(400);
    expect(candles).not.toHaveBeenCalled();
    expect((await fetch(`${url}?tf=5m`)).status).toBe(503);
    expect((await fetch(`${url}?tf=15m`)).status).toBe(200);
  });

  it('allows retry after an upstream failure', async () => {
    vi.spyOn(market, 'getCandles').mockRejectedValueOnce(new Error('provider unavailable'));
    expect((await fetch(url)).status).toBe(503);
    expect((await fetch(url)).status).toBe(200);
  });
});
