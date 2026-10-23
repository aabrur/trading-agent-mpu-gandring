import { afterEach, describe, expect, it, vi } from 'vitest';
import { closedLiveCandles, fetchDeribitMeasurements, fetchOpenInterestChanges, openInterestChanges } from '../server/market/observations.js';
import { buildTechnicalSummary, calculateVolatility } from '../server/strategy.js';
import { fetchL2Orderbook, getCandles, getNewsFor, getSnapshot } from '../server/market/index.js';
import { sampleCandles } from '../server/market/sample.js';
import { getHyperliquidWhales } from '../server/market/whale.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const json = (body: unknown) => new Response(JSON.stringify(body));

describe('live open interest', () => {
  it('computes exact horizons from timestamped observations and records their source', () => {
    const now = Date.now();
    const result = openInterestChanges([
      { timestamp: now - 240 * 60_000, openInterest: 50 },
      { timestamp: now, openInterest: 120 },
      { timestamp: now - 60 * 60_000, openInterest: 80 },
      { timestamp: now - 15 * 60_000, openInterest: 100 }
    ], now);
    expect(result.oiDelta15mPct).toBe(20);
    expect(result.oiDelta1hPct).toBe(50);
    expect(result.oiDelta4hPct).toBe(140);
    expect(result.evidence.oiDelta4hPct.baselineAt).toBe(now - 240 * 60_000);
  });
  it('does not invent a missing horizon or divide by zero', () => {
    const now = Date.now();
    const result = openInterestChanges([{ timestamp: now, openInterest: 100 }, { timestamp: now - 14 * 60_000, openInterest: 90 }, { timestamp: now - 60 * 60_000, openInterest: 0 }], now);
    expect(result.oiDelta15mPct).toBeNull();
    expect(result.oiDelta1hPct).toBeNull();
    expect(result.oiDelta4hPct).toBeNull();
    expect(result.evidence.oiDelta15mPct.status).toBe('unavailable');
  });
  it('rejects stale and future samples', () => {
    const now = Date.now();
    expect(openInterestChanges([{ timestamp: now - 11 * 60_000, openInterest: 100 }, { timestamp: now - 26 * 60_000, openInterest: 80 }], now).oiDelta15mPct).toBeNull();
    expect(openInterestChanges([{ timestamp: now + 1, openInterest: 100 }], now).oiDelta15mPct).toBeNull();
  });
  it('reports API failures as unavailable', async () => {
    const fetchImpl = vi.fn(async () => json({ retCode: 10001, result: { list: [] } }));
    const result = await fetchOpenInterestChanges('BTCUSDT', fetchImpl);
    expect(result.oiDelta15mPct).toBeNull();
    expect(result.evidence.oiDelta15mPct.status).toBe('unavailable');
  });
});

describe('live options observations', () => {
  it('derives put/call from option OI and DVOL from its actual index series', async () => {
    const now = Date.now();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('get_book_summary_by_currency')) return json({ result: [
        { instrument_name: 'BTC-30OCT26-100000-P', open_interest: 30 },
        { instrument_name: 'BTC-30OCT26-100000-C', open_interest: 100 },
        { instrument_name: 'BTC-30OCT26-110000-C', open_interest: 50 }
      ] });
      if (url.includes('get_volatility_index_data')) return json({ result: { data: [[now - 60_000, 30, 40, 20, 37.2]] } });
      return json({ result: { index_price: 65000 } });
    });
    const result = await fetchDeribitMeasurements('BTC', fetchImpl);
    expect(result.putCallRatio).toBe(0.2);
    expect(result.dvol).toBe(37.2);
    expect(result.indexPrice).toBe(65000);
    expect(result.evidence?.putCallRatio.status).toBe('live');
    expect(fetchImpl.mock.calls[0][0]).toContain('kind=option');
  });
  it('keeps independent results when one feed fails, and rejects stale DVOL', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('get_index_price')) return json({ result: { index_price: 50000 } });
      if (String(input).includes('get_volatility_index_data')) return json({ result: { data: [[Date.now() - 600_000, 0, 0, 0, 52.4]] } });
      return new Response('', { status: 503 });
    });
    const result = await fetchDeribitMeasurements('BTC', fetchImpl);
    expect(result.putCallRatio).toBeNull();
    expect(result.dvol).toBeNull();
    expect(result.indexPrice).toBe(50000);
    expect(result.evidence?.dvol.status).toBe('unavailable');
  });
  it('does not describe a failed wallet query as zero whale positions', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 503 }));
    expect(await getHyperliquidWhales('BTC', ['0x-test'], fetchImpl)).toBeUndefined();
  });
});

describe('no fabricated live fallbacks', () => {
  it('preserves small-price precision in measured technical levels and orderbook microprice', async () => {
    const candles = sampleCandles('BTCUSDT', 250).map(candle => ({ ...candle, o: candle.o / 1e10, h: candle.h / 1e10, l: candle.l / 1e10, c: candle.c / 1e10 }));
    const summary = buildTechnicalSummary({ '15m': candles });
    expect(summary.volatility?.atr14).toBeGreaterThan(0);
    expect(summary.mtfTrend['15m']?.ema200).toBeGreaterThan(0);
    expect(summary.volumeProfile?.poc).toBeGreaterThan(0);
    expect(summary.swingLevels?.recentSwingLow).toBeGreaterThan(0);
    vi.stubGlobal('fetch', vi.fn(async () => json({ result: { b: [['0.00001', '3']], a: [['0.00002', '1']] } })));
    const book = await fetchL2Orderbook('PEPEUSDT', 'bybit');
    expect(book?.microPrice).toBeCloseTo(0.0000175, 10);
  });
  it('uses only valid fresh closed candles and discards history before a gap', () => {
    const now = Date.now();
    const bars = sampleCandles('BTCUSDT', 100, now - 15 * 60_000);
    expect(closedLiveCandles(bars, 15 * 60_000, now)).toHaveLength(100);
    expect(closedLiveCandles(bars.filter((_, index) => index !== 90), 15 * 60_000, now)).toHaveLength(9);
    expect(closedLiveCandles(bars, 15 * 60_000, now + 4 * 15 * 60_000)).toEqual([]);
  });
  it('requires a complete contiguous 24h window for realized volatility', () => {
    const candles = sampleCandles('BTCUSDT', 120);
    expect(calculateVolatility(candles.slice(-60)).realizedVol24h).toBeNull();
    expect(calculateVolatility(candles).realizedVol24h).not.toBeNull();
    const gap = candles.filter((_, index) => index !== 100);
    expect(calculateVolatility(gap).realizedVol24h).toBeNull();
  });
  it('does not substitute 15m candles for missing 1h/4h data or price for EMA200', () => {
    const summary = buildTechnicalSummary({ '15m': sampleCandles('BTCUSDT', 60) });
    expect(summary.mtfTrend['1h']).toBeNull();
    expect(summary.mtfTrend['4h']).toBeNull();
    expect(summary.mtfTrend['15m']?.ema200).toBeNull();
    expect(summary.momentum.rsi14_1h).toBeNull();
  });
  it('refuses synthetic market and candle fallbacks in live-only requests', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(getSnapshot('BTCUSDT', 'sample', true)).rejects.toThrow('sample fallback disabled');
    await expect(getCandles('BTCUSDT', '1h', 'sample', 100, true)).rejects.toThrow('sample fallback disabled');
    expect((await getSnapshot('BTCUSDT', 'sample')).example).toBe(true);
  });
  it('does not return sample news to LIVE when both news providers fail', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 503 }));
    expect(await getNewsFor('BTCUSDT', { tradingMode: 'LIVE', news: { provider: 'sample', key: '', baseUrl: '' } }, fetchImpl)).toEqual([]);
  });
});
