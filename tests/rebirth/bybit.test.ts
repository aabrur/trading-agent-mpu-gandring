import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BybitMarketHub,
  CORE_ANALYSIS_TIMEFRAMES,
  SUPPORTED_TIMEFRAMES,
  type BybitWsLike
} from '../../server/v2/market/bybit.js';
import { mapReferenceToNativeInstrument } from '../../server/v2/market/instruments.js';

const fixtures = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, 'fixtures/bybit/linear-fixtures.json'), 'utf8')
);

class FakeBybitWs implements BybitWsLike {
  private readonly handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  public readonly sent: unknown[] = [];
  public closed = false;

  on(event: 'open' | 'message' | 'close' | 'error', listener: (...args: unknown[]) => void): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(listener);
  }

  send(payload: string): void {
    this.sent.push(JSON.parse(payload));
  }

  close(): void {
    this.closed = true;
    this.emit('close', 1000, 'closed');
  }

  emit(event: 'open' | 'message' | 'close' | 'error', ...args: unknown[]): void {
    for (const fn of this.handlers.get(event) ?? []) {
      fn(...args);
    }
  }

  pushJson(frame: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(frame), 'utf8'));
  }
}

function createFixtureHarness(options: {
  retainedPositionSymbols?: () => string[];
  bootstrapBarrier?: { promise: Promise<void> };
  customKlineHandler?: (url: URL) => string[][];
} = {}) {
  const requests: URL[] = [];
  const sockets: FakeBybitWs[] = [];

  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    requests.push(url);

    if (options.bootstrapBarrier && url.pathname.endsWith('/v5/market/kline')) {
      await options.bootstrapBarrier.promise;
    }

    if (url.pathname.endsWith('/v5/market/instruments-info')) {
      return new Response(
        JSON.stringify({ retCode: 0, retMsg: 'OK', result: { category: 'linear', list: fixtures.instruments } }),
        { status: 200 }
      );
    }
    if (url.pathname.endsWith('/v5/market/tickers')) {
      const sym = url.searchParams.get('symbol') ?? 'BTCUSDT';
      const found = fixtures.instruments.some((i: { symbol: string }) => i.symbol === sym);
      return new Response(
        JSON.stringify({
          retCode: 0,
          retMsg: 'OK',
          time: 1761897724000,
          result: {
            category: 'linear',
            list: found
              ? [
                  {
                    symbol: sym,
                    lastPrice: '95050.0',
                    bid1Price: '95049.9',
                    ask1Price: '95050.1',
                    fundingRate: '0.0001',
                    openInterest: '54210.500'
                  }
                ]
              : []
          }
        }),
        { status: 200 }
      );
    }
    if (url.pathname.endsWith('/v5/market/kline')) {
      const sym = url.searchParams.get('symbol') ?? 'BTCUSDT';
      const found = fixtures.instruments.some((i: { symbol: string }) => i.symbol === sym);
      const list = !found
        ? []
        : options.customKlineHandler
          ? options.customKlineHandler(url)
          : fixtures.restKlines1m;
      return new Response(
        JSON.stringify({
          retCode: 0,
          retMsg: 'OK',
          time: 1761897725000,
          result: { category: 'linear', symbol: sym, list }
        }),
        { status: 200 }
      );
    }
    if (url.pathname.endsWith('/v5/market/orderbook')) {
      const sym = url.searchParams.get('symbol') ?? 'BTCUSDT';
      return new Response(
        JSON.stringify({
          retCode: 0,
          retMsg: 'OK',
          time: 1761897726500,
          result: {
            s: sym,
            b: [['95090.0', '6.000']],
            a: [['95091.0', '4.000']],
            u: 500,
            seq: 900500,
            ts: 1761897726500
          }
        }),
        { status: 200 }
      );
    }
    throw new Error(`Unexpected URL ${url.href}`);
  };

  const hub = new BybitMarketHub({
    fetchImpl,
    wsFactory: () => {
      const ws = new FakeBybitWs();
      sockets.push(ws);
      queueMicrotask(() => ws.emit('open'));
      return ws;
    },
    retainedSymbolsProvider: options.retainedPositionSymbols
  });

  return { hub, requests, sockets };
}

describe('T04 Bybit linear realtime hub', () => {
  it('bootstrap_merges_ws_without_duplicate_volume', async () => {
    let releaseBootstrap!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    const { hub, requests, sockets } = createFixtureHarness({ bootstrapBarrier: { promise: barrier } });

    const configPromise = hub.configure(['BTCUSDT']);
    await new Promise((r) => setTimeout(r, 15));
    const ws = sockets[0]!;

    // While REST bootstrap is still in-flight, WS sends overlapping confirmed 1m bar + duplicate trade ID
    ws.pushJson({
      topic: 'kline.1.BTCUSDT',
      type: 'snapshot',
      ts: 1761897721000,
      data: [
        {
          start: 1761897720000,
          end: 1761897779999,
          interval: '1',
          open: '95020.0',
          close: '95050.0',
          high: '95060.0',
          low: '95010.0',
          volume: '14.250',
          turnover: '1354280.0',
          confirm: true,
          timestamp: 1761897721000
        }
      ]
    });
    ws.pushJson({
      topic: 'publicTrade.BTCUSDT',
      type: 'snapshot',
      ts: 1761897722000,
      data: [
        { i: 'trade-dup-1', T: 1761897722000, p: '95050.0', v: '1.500', S: 'Buy', s: 'BTCUSDT' },
        { i: 'trade-dup-1', T: 1761897722000, p: '95050.0', v: '1.500', S: 'Buy', s: 'BTCUSDT' }
      ]
    });

    releaseBootstrap();
    await configPromise;

    const frame = hub.snapshot('BTCUSDT');
    expect(frame.venue).toBe('bybit');
    expect(frame.category).toBe('linear');

    const barsAt720 = frame.closed['1m'].filter((c) => c.startAt === 1761897720000);
    expect(barsAt720).toHaveLength(1);
    expect(barsAt720[0]!.volume).toBe('14.250');

    // Duplicate trade ID counted once
    const trades = hub.recentTrades('BTCUSDT');
    expect(trades).toHaveLength(1);
    expect(trades[0]!.tradeId).toBe('trade-dup-1');

    // Every REST request specifies category=linear and never hits Binance, spot, or sample hosts
    expect(requests.length).toBeGreaterThan(0);
    for (const reqUrl of requests) {
      expect(reqUrl.hostname).toContain('bybit.com');
      expect(reqUrl.searchParams.get('category')).toBe('linear');
    }

    await hub.stop();
  });

  it('confirmed_candles_only', async () => {
    const { hub, sockets } = createFixtureHarness();
    await hub.configure(['BTCUSDT']);
    const ws = sockets[0]!;

    expect(SUPPORTED_TIMEFRAMES).toEqual(['1m', '5m', '15m', '1h', '4h', '1d']);
    expect(CORE_ANALYSIS_TIMEFRAMES).toEqual(['1m', '5m', '1h', '4h', '1d']);

    const initial = hub.snapshot('BTCUSDT');
    expect(Object.keys(initial.closed)).toEqual(['1m', '5m', '15m', '1h', '4h', '1d']);
    // Chronological order ascending
    const starts = initial.closed['1m'].map((c) => c.startAt);
    expect(starts).toEqual([1761897600000, 1761897660000, 1761897720000]);

    // Unconfirmed candle stays in current, excluded from closed
    ws.pushJson({
      topic: 'kline.1.BTCUSDT',
      type: 'snapshot',
      ts: 1761897790000,
      data: [
        {
          start: 1761897780000,
          end: 1761897839999,
          interval: '1',
          open: '95050.0',
          close: '95090.0',
          high: '95100.0',
          low: '95045.0',
          volume: '4.100',
          confirm: false,
          timestamp: 1761897790000
        }
      ]
    });

    const mid = hub.snapshot('BTCUSDT');
    expect(mid.closed['1m'].some((c) => c.startAt === 1761897780000)).toBe(false);
    expect(mid.current['1m']?.startAt).toBe(1761897780000);
    expect(mid.current['1m']?.confirmed).toBe(false);

    // Once confirm=true arrives, candle moves to closed
    ws.pushJson({
      topic: 'kline.1.BTCUSDT',
      type: 'snapshot',
      ts: 1761897840005,
      data: [
        {
          start: 1761897780000,
          end: 1761897839999,
          interval: '1',
          open: '95050.0',
          close: '95110.0',
          high: '95120.0',
          low: '95045.0',
          volume: '8.750',
          confirm: true,
          timestamp: 1761897840005
        }
      ]
    });

    const after = hub.snapshot('BTCUSDT');
    expect(after.closed['1m'].some((c) => c.startAt === 1761897780000)).toBe(true);
    expect(after.closed['1m'].at(-1)?.close).toBe('95110.0');

    await hub.stop();
  });

  it('accepts_nonconsecutive_valid_update_ids', async () => {
    const { hub, sockets } = createFixtureHarness();
    await hub.configure(['BTCUSDT']);
    const ws = sockets[0]!;

    ws.pushJson(fixtures.orderbookSnapshot1);
    ws.pushJson(fixtures.orderbookDeltaJump1); // u jumps 100 -> 107 (valid nonconsecutive Bybit u)
    ws.pushJson(fixtures.orderbookDeltaJump2); // u jumps 107 -> 115, deletes ask 95050.1 via "0.000"

    const book = hub.orderbook('BTCUSDT');
    expect(book).not.toBeNull();
    expect(book!.updateId).toBe(115);
    expect(book!.bids[0]).toEqual({ price: '95050.0', size: '1.000' });
    expect(book!.bids.some((b) => b.price === '95049.0')).toBe(false);
    expect(book!.asks[0]).toEqual({ price: '95050.5', size: '1.250' });
    expect(book!.asks.some((a) => a.price === '95050.1')).toBe(false);

    // Sequence regression on delta (u: 90 < 115) triggers REST snapshot recovery
    ws.pushJson({
      topic: 'orderbook.50.BTCUSDT',
      type: 'delta',
      ts: 1761897726100,
      cts: 1761897726090,
      data: { s: 'BTCUSDT', b: [['95000.0', '9.000']], a: [], u: 90, seq: 900090 }
    });
    await new Promise((r) => setTimeout(r, 25));

    const recoveredBook = hub.orderbook('BTCUSDT');
    expect(recoveredBook!.updateId).toBe(500);
    expect(recoveredBook!.bids).toEqual([{ price: '95090.0', size: '6.000' }]);

    await hub.stop();
  });

  it('reset_book_on_snapshot', async () => {
    const { hub, sockets } = createFixtureHarness();
    await hub.configure(['BTCUSDT']);
    const ws = sockets[0]!;

    ws.pushJson(fixtures.orderbookSnapshot1);
    expect(hub.orderbook('BTCUSDT')!.bids).toHaveLength(2);

    ws.pushJson(fixtures.orderbookSnapshotReset);
    const resetBook = hub.orderbook('BTCUSDT')!;
    expect(resetBook.updateId).toBe(1);
    expect(resetBook.bids).toEqual([{ price: '95080.0', size: '4.000' }]);
    expect(resetBook.asks).toEqual([{ price: '95081.0', size: '2.000' }]);

    await hub.stop();
  });

  it('ticker_delta_preserves_fields', async () => {
    const { hub, sockets } = createFixtureHarness();
    await hub.configure(['BTCUSDT']);
    const ws = sockets[0]!;

    ws.pushJson(fixtures.tickerSnapshot);
    ws.pushJson(fixtures.tickerDelta);

    const frame = hub.snapshot('BTCUSDT');
    expect(frame.last.value).toBe('95085.5');
    expect(frame.bid.value).toBe('95049.9');
    expect(frame.ask.value).toBe('95050.1');
    expect(frame.funding.value).toBe('0.0001');
    expect(frame.openInterest.value).toBe('54210.500');

    await hub.stop();
  });

  it('reconnect_backfills_gap', async () => {
    let callPhase: 'initial' | 'backfill' = 'initial';
    const { hub, sockets } = createFixtureHarness({
      customKlineHandler: (url) => {
        if (callPhase === 'backfill' && url.searchParams.get('interval') === '1') {
          return [
            ['1761897840000', '95070.0', '95110.0', '95065.0', '95100.0', '9.000', '855810.0'],
            ['1761897780000', '95050.0', '95080.0', '95040.0', '95070.0', '7.500', '712950.0'],
            ...fixtures.restKlines1m
          ];
        }
        return fixtures.restKlines1m;
      }
    });

    await hub.configure(['BTCUSDT']);
    const beforeRev = hub.snapshot('BTCUSDT').revision;

    callPhase = 'backfill';
    // Simulate WS disconnect -> automatic reconnect + gap backfill
    sockets[0]!.emit('close', 1006, 'abnormal closure');
    await new Promise((r) => setTimeout(r, 50));

    const after = hub.snapshot('BTCUSDT');
    expect(after.revision).toBeGreaterThan(beforeRev);
    expect(after.closed['1m'].map((c) => c.startAt)).toEqual([
      1761897600000,
      1761897660000,
      1761897720000,
      1761897780000,
      1761897840000
    ]);

    await hub.stop();
  });

  it('watchlist_does_not_drop_open_position', async () => {
    let openPositionSymbols = ['ETHUSDT'];
    const { hub, sockets } = createFixtureHarness({
      retainedPositionSymbols: () => openPositionSymbols
    });

    await hub.configure(['BTCUSDT', 'ETHUSDT']);
    // Remove ETHUSDT from watchlist while ETHUSDT still has an open position
    await hub.configure(['BTCUSDT']);

    const ws = sockets[0]!;
    ws.pushJson({
      topic: 'tickers.ETHUSDT',
      type: 'snapshot',
      ts: 1761897730000,
      data: {
        symbol: 'ETHUSDT',
        lastPrice: '3125.45',
        bid1Price: '3125.40',
        ask1Price: '3125.50',
        fundingRate: '0.0001',
        openInterest: '120000.00'
      }
    });

    const ethFrame = hub.snapshot('ETHUSDT');
    expect(ethFrame.last.availability).toBe('AVAILABLE');
    expect(ethFrame.last.value).toBe('3125.45');

    // Missing Bybit linear instrument returns explicit UNAVAILABLE, never substituted
    const unknownFrame = hub.snapshot('UNKNOWNCOINUSDT');
    expect(unknownFrame.last.availability).toBe('UNAVAILABLE');
    expect(unknownFrame.last.value).toBeNull();

    // Reference-to-native mapping handles 1000-token contracts explicitly
    const pepeMapping = mapReferenceToNativeInstrument('1000PEPEUSDT', 'hyperliquid', {
      nativeSymbol: 'kPEPE',
      baseCoin: 'PEPE',
      quoteCoin: 'USDC',
      settleCoin: 'USDC',
      contractMultiplier: 1000,
      referenceMultiplier: 1000
    });
    expect(pepeMapping.ok).toBe(true);

    openPositionSymbols = [];
    await hub.stop();
  });
});
