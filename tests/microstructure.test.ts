import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearFlowHistoryForTest, normalizeTrades, summarizeDepth, summarizeOrderflow } from '../server/market/microstructure.js';
import { fetchL2Orderbook, fetchRecentTrades } from '../server/market/index.js';

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => clearFlowHistoryForTest());

describe('public trade normalization', () => {
  it('sorts chronologically and deduplicates regardless of input order', () => {
    const rows = [
      { id: '2', time: 2_000, price: 102, quantity: 1, takerSide: 'Sell' as const },
      { id: '1', time: 1_000, price: 101, quantity: 2, takerSide: 'Buy' as const },
      { id: '1', time: 1_000, price: 101, quantity: 2, takerSide: 'Buy' as const }
    ];
    expect(normalizeTrades(rows).map(t => t.id)).toEqual(['1', '2']);
    expect(normalizeTrades([...rows].reverse())).toEqual(normalizeTrades(rows));
  });

  it('sorts numeric trade IDs naturally at equal timestamps and deduplicates by execution ID', () => {
    const rows = [
      { id: '10', time: 2_000, price: 10, quantity: 1, takerSide: 'Buy' as const },
      { id: '2', time: 2_000, price: 10, quantity: 1, takerSide: 'Buy' as const },
      { id: 'same', time: 2_002, price: 11, quantity: 2, takerSide: 'Sell' as const },
      { id: 'same', time: 2_001, price: 12, quantity: 3, takerSide: 'Buy' as const }
    ];
    const normalized = normalizeTrades(rows);
    expect(normalized.map(trade => trade.id)).toEqual(['2', '10', 'same']);
    expect(normalized.find(trade => trade.id === 'same')).toMatchObject({ time: 2_001, quantity: 3 });
  });

  it('deduplicates repeated execution IDs across responses even when timestamps differ', () => {
    const historyKey = 'execution-id-dedup';
    summarizeOrderflow([{ id: 'exec-1', time: 970_000, price: 10, quantity: 2, takerSide: 'Buy' }], { now: 1_000_000, observedAt: 1_000_000, venue: 'bybit', historyKey });
    const next = summarizeOrderflow([{ id: 'exec-1', time: 1_029_000, price: 11, quantity: 9, takerSide: 'Sell' }], { now: 1_030_000, observedAt: 1_030_000, venue: 'bybit', historyKey });
    expect(next.takerBuyVol).toBe(2);
    expect(next.takerSellVol).toBe(0);
    expect(next.rollingWindows['1m'].coverageMs).toBe(0);
  });

  it('classifies maker flags correctly and detects divergence in chronological order', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      id: String(i), time: 1_000 + i, price: 100 + i,
      quantity: 1, takerSide: i < 6 ? 'Sell' as const : 'Buy' as const
    }));
    const summary = summarizeOrderflow(rows, { now: 2_000, observedAt: 2_000, venue: 'binance' });
    expect(summary.takerSellVol).toBe(6);
    expect(summary.deltaDivergence).toBe(true);
  });

  it('marks rolling windows partial when retained observations do not cover the window', () => {
    const rows = [{ id: 'a', time: 59_000, price: 10, quantity: 1, takerSide: 'Buy' as const }];
    const summary = summarizeOrderflow(rows, { now: 60_000, observedAt: 60_000, venue: 'bybit' });
    expect(summary.rollingWindows?.['1m'].partial).toBe(true);
    expect(summary.rollingWindows?.['15m'].coveragePct).toBeLessThan(100);
  });

  it('does not infer poll coverage when sequential batches have no overlapping trades', () => {
    summarizeOrderflow([{ id: 'old', time: 970_000, price: 10, quantity: 1, takerSide: 'Buy' }], { now: 1_000_000, observedAt: 1_000_000, venue: 'bybit', historyKey: 'coverage-test' });
    const next = summarizeOrderflow([{ id: 'new', time: 1_030_000, price: 11, quantity: 1, takerSide: 'Buy' }], { now: 1_030_000, observedAt: 1_030_000, venue: 'bybit', historyKey: 'coverage-test' });
    expect(next.rollingWindows['1m'].coverageMs).toBe(0);
    expect(next.rollingWindows['1m'].partial).toBe(true);
  });

  it('does not turn an overlapping but stale trade batch into fresh window coverage', () => {
    const staleTrade = [{ id: 'same', time: 970_000, price: 10, quantity: 1, takerSide: 'Buy' as const }];
    summarizeOrderflow(staleTrade, { now: 1_000_000, observedAt: 1_000_000, venue: 'bybit', historyKey: 'stale-overlap' });
    const next = summarizeOrderflow(staleTrade, { now: 1_100_000, observedAt: 1_100_000, venue: 'bybit', historyKey: 'stale-overlap' });
    expect(next.rollingWindows['1m'].coverageMs).toBe(0);
    expect(next.rollingWindows['1m'].partial).toBe(true);
  });

  it('covers only the advancing trade timestamp range when batches overlap', () => {
    const first = [{ id: 'old', time: 970_000, price: 10, quantity: 1, takerSide: 'Buy' as const }];
    summarizeOrderflow(first, { now: 1_000_000, observedAt: 1_000_000, venue: 'bybit', historyKey: 'advancing-overlap' });
    const next = summarizeOrderflow([
      ...first,
      { id: 'new', time: 1_030_000, price: 11, quantity: 1, takerSide: 'Buy' as const }
    ], { now: 1_030_000, observedAt: 1_030_000, venue: 'bybit', historyKey: 'advancing-overlap' });
    expect(next.rollingWindows['1m'].coverageMs).toBe(30_000);
    expect(next.rollingWindows['1m'].partial).toBe(true);
  });

  it('records an empty but successful trade poll as zero flow', () => {
    const summary = summarizeOrderflow([], { now: 60_000, observedAt: 60_000, venue: 'bybit', historyKey: 'empty-poll', emptyActivity: true });
    expect(summary.tradesCount).toBe(0);
    expect(summary.takerBuyVol).toBe(0);
    expect(summary.takerSellVol).toBe(0);
    expect(summary.rollingWindows['1m'].partial).toBe(true);
  });
});

describe('order book depth coverage', () => {
  it('does not claim bands beyond returned price coverage are complete', () => {
    const summary = summarizeDepth([[99.9, 2], [99.8, 3]], [[100.1, 2], [100.2, 4]], 100);
    expect(summary.depthBands?.['0.5%'].complete).toBe(false);
    expect(summary.depthBands?.['2.0%'].complete).toBe(false);
    expect(summary.depthBands?.['0.5%'].coveredPct).toBeLessThan(100);
  });

  it('reports no liquidity changes on first observation and keeps histories venue scoped', () => {
    const bybitFirst = summarizeDepth([[99.9, 2], [99.8, 3]], [[100.1, 2], [100.2, 4]], 100, { historyKey: 'bybit:BTCUSDT', observedAt: 1_000 });
    const asterFirst = summarizeDepth([[99.9, 2], [99.8, 3]], [[100.1, 2], [100.2, 4]], 100, { historyKey: 'aster:BTCUSDT', observedAt: 2_000 });
    expect(bybitFirst.liquidityChanges).toBeNull();
    expect(asterFirst.liquidityChanges).toBeNull();
  });

  it('measures bid and ask depth change only across overlapping returned ranges', () => {
    const first = summarizeDepth([[99, 5], [98, 3]], [[101, 4], [102, 2]], 100, { historyKey: 'depth-overlap', observedAt: 1_000 });
    const next = summarizeDepth([[99, 7], [98.5, 2]], [[101, 3], [101.5, 2]], 100, { historyKey: 'depth-overlap', observedAt: 2_000 });
    expect(first.maxObservedCoveragePct).toBe(2);
    expect(next.liquidityChanges).toMatchObject({ addedBidVolume: 2, removedAskVolume: 1, observedAt: 2_000 });
  });
});

describe('native Aster market data', () => {
  it('uses native Aster depth and aggregate trade endpoints with venue provenance', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes('/depth?')
        ? { bids: [['99.9', '2'], ['99.8', '3']], asks: [['100.1', '2'], ['100.2', '4']] }
        : [{ a: 77, p: '100', q: '1.25', T: Date.now() - 3_000, m: true }];
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const book = await fetchL2Orderbook('BTCUSDT', 'aster');
    const flow = await fetchRecentTrades('BTCUSDT', 'aster');
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(expect.arrayContaining([
      expect.stringContaining('fapi.asterdex.com/fapi/v3/depth'),
      expect.stringContaining('fapi.asterdex.com/fapi/v3/aggTrades')
    ]));
    expect(book?.actualDataVenue).toBe('aster');
    expect(flow?.requestedVenue).toBe('aster');
    expect(flow?.actualDataVenue).toBe('aster');
    expect(flow?.takerSellVol).toBe(1.25);
  });

  it('labels a Bybit fallback requested for Aster as an external proxy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ result: { list: [
      { execId: 'proxy-1', time: Date.now() - 2_000, price: '100', size: '2', side: 'Buy' }
    ] } }), { status: 200 })));
    const flow = await fetchRecentTrades('ETHUSDT', 'bybit', 'aster');
    expect(flow?.requestedVenue).toBe('aster');
    expect(flow?.actualDataVenue).toBe('bybit');
    expect(flow?.dataType).toBe('external_proxy');
    expect(flow?.sourceEndpoint).toContain('api.bybit.com/v5/market/recent-trade');
  });

  it('fails closed on native Aster rate limits and malformed depth payloads', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => String(input).includes('/aggTrades')
      ? new Response('{}', { status: 429 })
      : new Response(JSON.stringify({ bids: 'malformed', asks: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchRecentTrades('BTCUSDT', 'aster')).toBeNull();
    expect(await fetchL2Orderbook('BTCUSDT', 'aster')).toBeNull();
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes('fapi.asterdex.com'))).toBe(true);
  });

  it('does not relabel a failed native Aster request as a successful proxy observation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('timeout'); }));
    expect(await fetchRecentTrades('SOLUSDT', 'aster')).toBeNull();
  });

  it('returns unavailable for nonempty batches whose timestamps are invalid or future-dated', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: { list: [
      { execId: 'bad-time', time: 'not-a-time', price: '100', size: '2', side: 'Buy' },
      { execId: 'future', time: Date.now() + 60_000, price: '101', size: '1', side: 'Buy' }
    ] } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchRecentTrades('BTCUSDT', 'bybit')).toBeNull();
  });
});
