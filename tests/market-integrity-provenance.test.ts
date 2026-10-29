import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Candle, NewsItem } from '../server/types.js';
import { candleMetadata, closedLiveCandles } from '../server/market/observations.js';
import { asterSymbolDiagnostic, fetchL2Orderbook, fetchRecentTrades, getCandles } from '../server/market/index.js';
import { comparableMetricWindows, metricProvenance, newsFreshness, normalizeLegacyItem } from '../server/market/news.js';
import { summarizeOrderflow } from '../server/market/microstructure.js';
import { volumeDelta, volumeDiagnostics } from '../server/strategy.js';

const now = Date.UTC(2026, 9, 29, 8, 30);
const barMs = 15 * 60_000;
const candle = (t: number, v = 10): Candle => ({ t, o: 100, h: 102, l: 99, c: 101, v });
const bars = (count: number, intervalMs = barMs) => Array.from({ length: count }, (_, i) => candle(now - (count - i) * intervalMs));
const json = (value: unknown) => new Response(JSON.stringify(value));
const klines = (series: Candle[]) => series.map(c => [c.t, c.o, c.h, c.l, c.c, c.v].map(String));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('closed candle time and integrity contract', () => {
  it('includes 08:15 exactly at 08:30 and keeps 08:30 unfinished until 08:45', () => {
    const input = [candle(now - barMs), candle(now)];
    expect(closedLiveCandles(input, barMs, now - 1)).toEqual([]);
    expect(closedLiveCandles(input, barMs, now)).toEqual([input[0]]);
    expect(closedLiveCandles(input, barMs, now + barMs - 1)).toEqual([input[0]]);
    expect(closedLiveCandles(input, barMs, now + barMs)).toEqual(input);
  });
  it.each([60, 240])('uses actual %i minute intervals, rather than a fixed 15m close', minutes => {
    const interval = minutes * 60_000;
    const input = [candle(now - interval)];
    expect(closedLiveCandles(input, interval, now - 1)).toEqual([]);
    expect(closedLiveCandles(input, interval, now)).toEqual(input);
  });
  it('reports repeated, out-of-order and gapped bars while retaining the existing contiguous suffix rule', () => {
    const input = bars(20);
    const raw = [...input.filter((_, index) => index !== 10), input[5]].reverse();
    const result = closedLiveCandles(raw, barMs, now);
    const metadata = candleMetadata(raw, result, barMs, 'aster', false, now);
    expect(result).toEqual(input.slice(11));
    expect(metadata).toMatchObject({ duplicates: 1, conflictingDuplicates: 0, outOfOrder: true, lastClosedAt: now, latencyMs: 0 });
    expect(metadata.gaps).toEqual([{ afterOpenAt: input[9].t, beforeOpenAt: input[11].t, missingBars: 1 }]);
  });
  it('reports stale reads and future open times without fabricating a clock correction', () => {
    const raw = [candle(now - 4 * barMs), candle(now + barMs)];
    const returned = closedLiveCandles(raw, barMs, now);
    expect(returned).toEqual([]);
    expect(candleMetadata(raw, returned, barMs, 'aster', false, now)).toMatchObject({ stale: true, futureOpenTimes: 1, lastClosedAt: null });
  });
  it('preserves the last completed venue row and actual source metadata across fallback', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const input = [...bars(21), candle(now)];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => String(url).includes('bybit.com')
      ? json({ result: { list: klines(input).reverse() } }) : new Response('', { status: 503 })));
    const result = await getCandles('NEARUSDT', '15m', 'aster', 21, true, 'testnet');
    expect(result.source).toBe('bybit');
    expect(result.requestedVenue).toBe('aster');
    expect(result.candles).toEqual(input.slice(0, 21));
    expect(result.provenance).toMatchObject({ requestedVenue: 'aster', actualVenue: 'bybit', requestedNetwork: 'testnet', network: 'mainnet', sourceType: 'reference', instrument: 'perpetual' });
    expect(result.candleMetadata).toMatchObject({ lastClosedOpenAt: now - barMs, lastClosedAt: now, intervalMs: barMs, observedAt: now, source: 'bybit', closedOnly: true, example: false });
  });
  it('keeps genuine Aster bars native and does not round very small JSON volumes', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const input = bars(21).map(c => ({ ...c, v: 0.00000000000123456789 }));
    vi.stubGlobal('fetch', vi.fn(async () => json(klines(input))));
    const result = await getCandles('HYPEUSDT', '15m', 'aster', 21, true);
    expect(result.provenance).toMatchObject({ requestedVenue: 'aster', actualVenue: 'aster', sourceType: 'native' });
    expect(JSON.parse(JSON.stringify(result)).candles[20].v).toBe(input[20].v);
  });
  it('retains separate candle, depth and trade venues and exposes an unavailable depth read', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('orderbook')) return json({ result: { b: [['100', '2']], a: [['101', '3']] } });
      if (String(url).includes('aggTrades')) return json([{ a: 1, T: now - 1000, p: '100', q: '0.1', m: false }]);
      return new Response('', { status: 503 });
    }));
    expect((await fetchL2Orderbook('NEARUSDT', 'bybit', 'aster'))?.provenance).toMatchObject({ actualVenue: 'bybit', sourceType: 'reference' });
    expect((await fetchRecentTrades('NEARUSDT', 'aster', 'aster'))?.provenance).toMatchObject({ actualVenue: 'aster', sourceType: 'native' });
    expect(await fetchL2Orderbook('NEARUSDT', 'aster', 'aster')).toBeNull();
  });
  it('fails live-only requests when all feeds fail and labels sample diagnostics unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    await expect(getCandles('NEARUSDT', '15m', 'aster', 21, true)).rejects.toThrow('sample fallback disabled');
    const result = await getCandles('NEARUSDT', '15m', 'sample', 21);
    expect(result.provenance.sourceType).toBe('sample');
    expect(result.volumeDiagnostics.relativeVolumeMedian20Previous.value).toBeNull();
  });
});

describe('diagnostic relative volume does not select a strategy', () => {
  const context = { source: 'aster', unit: 'base_asset' as const, observedAt: now, intervalMs: barMs };
  it('separates a 41x prior-median spike from legacy mean including candidate without changing ranking input', () => {
    const input = bars(21); input[20].v = 410;
    const diagnostic = volumeDiagnostics(input, context);
    expect(diagnostic.relativeVolumeMedian20Previous).toMatchObject({ value: 41, method: 'median', lookback: 20, candidateIncluded: false, barTime: now - barMs });
    expect(diagnostic.relativeVolumeMean20IncludingCurrent.value).toBe(410 / 30);
    expect(volumeDelta(input).volRatio).toBe(13.67);
    expect(diagnostic.bullishCandleVolumeShare5.method).toBe('inferred_candle_direction_volume_share');
  });
  it('sorts timestamps and numeric volumes and preserves native precision for very small observations', () => {
    const input = bars(21).map((c, i) => ({ ...c, v: (i + 1) * 1e-20 }));
    const result = volumeDiagnostics([...input].reverse(), context).relativeVolumeMedian20Previous;
    expect(result.value).toBe(input[20].v / ((input[9].v + input[10].v) / 2));
    expect(result.status).toBe('available');
  });
  it('does not turn zero, missing, nonfinite, negative, sample or mismatched observations into 1.0 evidence', () => {
    for (const input of [bars(20), bars(21).map(c => ({ ...c, v: 0 })), bars(21).map((c, i) => ({ ...c, v: i === 5 ? NaN : c.v })), bars(21).map((c, i) => ({ ...c, v: i === 5 ? -1 : c.v }))]) {
      expect(volumeDiagnostics(input, context).relativeVolumeMedian20Previous.value).toBeNull();
    }
    expect(volumeDiagnostics(bars(21), { ...context, example: true }).relativeVolumeMedian20Previous.status).toBe('unknown');
    expect(volumeDiagnostics(bars(21), { ...context, barUnits: Array.from({ length: 21 }, (_, i) => i ? 'base_asset' : 'quote_asset') }).relativeVolumeMedian20Previous.value).toBeNull();
    expect(volumeDiagnostics(bars(21), { ...context, barSources: Array.from({ length: 21 }, (_, i) => i ? 'aster' : 'bybit') }).relativeVolumeMedian20Previous.value).toBeNull();
  });
  it('keeps real normalized taker volumes separate and exposes their unrounded observations', () => {
    const result = summarizeOrderflow([{ id: 'tiny', time: now - 100, price: 1, quantity: 1.23456789e-12, takerSide: 'Buy' }], { venue: 'aster', now, historyKey: 'tiny-volume-fixture' });
    expect(result.rollingWindows['1m'].rawVolumes.takerBuyVol).toBe(1.23456789e-12);
  });
});

describe('metric event time differs from article time', () => {
  const news: NewsItem = { id: 'old-liquidation', symbol: 'BTC', headline: 'Liquidations reported', body: 'A historical event', source: 'fixture', sourceUrl: 'https://example.test/article', sentiment: 'neutral', example: false, publishedAt: now, eventAt: Date.UTC(2026, 9, 15), observedAt: now, metric: { value: 932000000, unit: 'USD', scope: 'crypto liquidations', windowHours: 24 } };
  it('keeps a fresh article reporting 15 October historical and REPORTED, with UNKNOWN window', () => {
    expect(newsFreshness(news.publishedAt!, now)).toBe('fresh');
    expect(normalizeLegacyItem(news, 'BTCUSDT', now).metricProvenance).toMatchObject({ eventAt: news.eventAt, evidenceStatus: 'REPORTED', eventWindowStatus: 'UNKNOWN', canDescribeAsLast24Hours: false });
  });
  it('does not infer a missing event/window date from the publication date', () => {
    expect(metricProvenance({ ...news, eventAt: undefined }, now)).toMatchObject({ eventAt: null, windowEndAt: null, eventWindowStatus: 'UNKNOWN' });
  });
  it('requires the same explicit window, unit and scope to compare metrics', () => {
    const first = metricProvenance({ ...news, windowStartAt: now - 86400000, windowEndAt: now }, now);
    const older = metricProvenance({ ...news, windowStartAt: now - 2 * 86400000, windowEndAt: now - 86400000 }, now);
    expect(first.canDescribeAsLast24Hours).toBe(true);
    expect(comparableMetricWindows(first, older)).toBe(false);
    expect(comparableMetricWindows(first, { ...first })).toBe(true);
    expect(comparableMetricWindows(first, { ...first, unit: 'BTC' })).toBe(false);
  });
  it('preserves the existing 6h/48h article freshness boundaries', () => {
    expect(newsFreshness(now - 6 * 3600000, now)).toBe('fresh');
    expect(newsFreshness(now - 6 * 3600000 - 1, now)).toBe('stale');
    expect(newsFreshness(now - 48 * 3600000, now)).toBe('stale');
    expect(newsFreshness(now - 48 * 3600000 - 1, now)).toBe('archived');
  });
});

describe('Aster symbol diagnostics are independent from fee classes and fallback', () => {
  it('preserves the 1000 prefix and checks both current listing and native completed candles', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const fetchImpl = vi.fn(async (url: string | URL | Request) => String(url).includes('exchangeInfo')
      ? json({ symbols: [{ symbol: '1000FLOKIUSDT', status: 'TRADING' }] }) : json(klines(bars(11))));
    vi.stubGlobal('fetch', fetchImpl);
    expect(await asterSymbolDiagnostic('1000FLOKIUSDT')).toMatchObject({ resolvedSymbol: '1000FLOKIUSDT', symbolStatus: 'LISTED', candleStatus: 'AVAILABLE' });
    expect(String(fetchImpl.mock.calls[1][0])).toContain('symbol=1000FLOKIUSDT');
  });
  it('distinguishes an unavailable listing lookup from a listed instrument with a failed feed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })));
    expect(await asterSymbolDiagnostic('1000FLOKIUSDT')).toMatchObject({ symbolStatus: 'UNAVAILABLE', candleStatus: 'UNAVAILABLE' });
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => String(url).includes('exchangeInfo')
      ? json({ symbols: [{ symbol: '1000FLOKIUSDT', status: 'TRADING' }] }) : json({ code: -1121, msg: 'Invalid symbol' })));
    const result = await asterSymbolDiagnostic('1000FLOKIUSDT');
    expect(result).toMatchObject({ symbolStatus: 'LISTED', candleStatus: 'UNAVAILABLE' });
    expect(result.errors[0]).toContain('-1121');
  });
});
