import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  TIMEFRAMES,
  unavailableEvidence,
  verifiedEvidence,
  type DecimalString,
  type Evidence,
  type MarketFrame,
  type TF
} from '../contracts.js';
import {
  BYBIT_INTERVAL_BY_TF,
  SymbolCandleBook,
  TF_BY_BYBIT_INTERVAL,
  TF_DURATION_MS
} from './candles.js';
import {
  normalizeBybitInstrument,
  type BybitLinearInstrument
} from './instruments.js';
import { LocalOrderbook, type OrderbookView } from './orderbook.js';

export const SUPPORTED_TIMEFRAMES: readonly TF[] = TIMEFRAMES;
export const CORE_ANALYSIS_TIMEFRAMES: readonly TF[] = ['1m', '5m', '1h', '4h', '1d'] as const;

export interface PublicTradeRecord {
  tradeId: string;
  symbol: string;
  price: DecimalString;
  size: DecimalString;
  side: 'Buy' | 'Sell';
  sourceAt: number;
  observedAt: number;
}

export interface BybitWsLike {
  on(event: 'open' | 'message' | 'close' | 'error', listener: (...args: unknown[]) => void): void;
  send(payload: string): void;
  close(): void;
}

interface TickerState {
  lastPrice?: string;
  bid1Price?: string;
  ask1Price?: string;
  fundingRate?: string;
  openInterest?: string;
  price24hPcnt?: string;
  sourceAt: number;
  observedAt: number;
}

interface SymbolHubState {
  symbol: string;
  revision: number;
  candles: SymbolCandleBook;
  orderbook: LocalOrderbook;
  ticker: TickerState | null;
  trades: PublicTradeRecord[];
  seenTradeIds: Set<string>;
  tradesEvidenceId: string | null;
  bookEvidenceId: string | null;
  bootstrapping: boolean;
  bufferedFrames: Array<{ raw: Record<string, unknown>; observedAt: number }>;
}

export interface BybitMarketHubOptions {
  restBaseUrl?: string;
  wsUrl?: string;
  fetchImpl?: typeof fetch;
  wsFactory?: (url: string) => BybitWsLike;
  retainedSymbolsProvider?: () => string[];
  maxTradesPerSymbol?: number;
  pingIntervalMs?: number;
}

export class BybitMarketHub {
  private readonly restBaseUrl: string;
  private readonly wsUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly wsFactory: (url: string) => BybitWsLike;
  private readonly retainedSymbolsProvider: () => string[];
  private readonly maxTradesPerSymbol: number;
  private readonly pingIntervalMs: number;

  private readonly instruments = new Map<string, BybitLinearInstrument>();
  private readonly states = new Map<string, SymbolHubState>();
  private readonly listeners = new Set<(frame: MarketFrame) => void>();
  private desiredWatchlist = new Set<string>();
  private subscribedTopics = new Set<string>();
  private ws: BybitWsLike | null = null;
  private wsOpen = false;
  private stopped = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: BybitMarketHubOptions = {}) {
    this.restBaseUrl = (options.restBaseUrl ?? 'https://api.bybit.com').replace(/\/+$/, '');
    this.wsUrl = options.wsUrl ?? 'wss://stream.bybit.com/v5/public/linear';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.wsFactory = options.wsFactory ?? ((url) => new WebSocket(url) as unknown as BybitWsLike);
    this.retainedSymbolsProvider = options.retainedSymbolsProvider ?? (() => []);
    this.maxTradesPerSymbol = options.maxTradesPerSymbol ?? 400;
    this.pingIntervalMs = options.pingIntervalMs ?? 20_000;
  }

  private effectiveSymbols(): string[] {
    const merged = new Set<string>();
    for (const s of this.desiredWatchlist) merged.add(s.trim().toUpperCase());
    for (const s of this.retainedSymbolsProvider()) {
      if (s && s.trim()) merged.add(s.trim().toUpperCase());
    }
    return [...merged].sort((a, b) => a.localeCompare(b));
  }

  private ensureSymbolState(symbol: string): SymbolHubState {
    let st = this.states.get(symbol);
    if (!st) {
      st = {
        symbol,
        revision: 0,
        candles: new SymbolCandleBook(),
        orderbook: new LocalOrderbook(symbol),
        ticker: null,
        trades: [],
        seenTradeIds: new Set(),
        tradesEvidenceId: null,
        bookEvidenceId: null,
        bootstrapping: false,
        bufferedFrames: []
      };
      this.states.set(symbol, st);
    }
    return st;
  }

  private topicsForSymbols(symbols: string[]): string[] {
    const topics: string[] = [];
    for (const sym of symbols) {
      topics.push(`tickers.${sym}`, `orderbook.50.${sym}`, `publicTrade.${sym}`);
      for (const tf of SUPPORTED_TIMEFRAMES) {
        topics.push(`kline.${BYBIT_INTERVAL_BY_TF[tf]}.${sym}`);
      }
    }
    return topics;
  }

  private connectSocket(): void {
    if (this.stopped || this.ws) return;
    const socket = this.wsFactory(this.wsUrl);
    this.ws = socket;
    this.wsOpen = false;

    socket.on('open', () => {
      if (this.stopped || this.ws !== socket) return;
      this.wsOpen = true;
      this.reconcileWsSubscriptions();
    });

    socket.on('message', (rawBuf: unknown) => {
      if (this.stopped || this.ws !== socket) return;
      const text = typeof rawBuf === 'string'
        ? rawBuf
        : Buffer.isBuffer(rawBuf)
          ? rawBuf.toString('utf8')
          : String(rawBuf);
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return;
      }
      this.handleWsMessage(parsed, Date.now());
    });

    socket.on('close', () => {
      if (this.ws === socket) {
        this.ws = null;
        this.wsOpen = false;
        this.subscribedTopics.clear();
      }
      if (!this.stopped) {
        void this.handleReconnect();
      }
    });

    socket.on('error', () => {
      // Handled via close/reconnect path without crashing process.
    });

    if (!this.pingTimer) {
      this.pingTimer = setInterval(() => {
        if (this.ws && this.wsOpen) {
          try {
            this.ws.send(JSON.stringify({ op: 'ping' }));
          } catch {
            // Reconnect handles dead socket.
          }
        }
      }, this.pingIntervalMs);
      this.pingTimer.unref?.();
    }
  }

  private reconcileWsSubscriptions(): void {
    if (!this.ws || !this.wsOpen) return;
    const activeSymbols = this.effectiveSymbols().filter((s) => this.instruments.has(s));
    const desired = new Set(this.topicsForSymbols(activeSymbols));
    const toSub = [...desired].filter((t) => !this.subscribedTopics.has(t));
    const toUnsub = [...this.subscribedTopics].filter((t) => !desired.has(t));

    if (toUnsub.length > 0) {
      this.ws.send(JSON.stringify({ op: 'unsubscribe', args: toUnsub }));
      for (const t of toUnsub) this.subscribedTopics.delete(t);
    }
    if (toSub.length > 0) {
      for (let i = 0; i < toSub.length; i += 10) {
        const chunk = toSub.slice(i, i + 10);
        this.ws.send(JSON.stringify({ op: 'subscribe', args: chunk }));
      }
      for (const t of toSub) this.subscribedTopics.add(t);
    }
  }

  private async fetchLinearJson(pathname: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const url = new URL(`${this.restBaseUrl}${pathname}`);
    url.searchParams.set('category', 'linear');
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
    const res = await this.fetchImpl(url.href);
    if (!res.ok) {
      throw new Error(`Bybit linear HTTP ${res.status} on ${pathname}`);
    }
    const body = (await res.json()) as Record<string, unknown>;
    if (Number(body.retCode ?? 0) !== 0) {
      throw new Error(`Bybit linear API error ${body.retCode}: ${String(body.retMsg ?? 'unknown')}`);
    }
    return body;
  }

  private async ensureInstrumentsLoaded(): Promise<void> {
    if (this.instruments.size > 0) return;
    const body = await this.fetchLinearJson('/v5/market/instruments-info', { limit: '1000' });
    const result = (body.result ?? {}) as { list?: Array<Record<string, unknown>> };
    for (const raw of result.list ?? []) {
      const sym = String(raw.symbol ?? '').trim().toUpperCase();
      if (!sym) continue;
      this.instruments.set(
        sym,
        normalizeBybitInstrument({
          symbol: sym,
          baseCoin: String(raw.baseCoin ?? sym.replace(/USDT$/, '')),
          quoteCoin: String(raw.quoteCoin ?? 'USDT'),
          settleCoin: String(raw.settleCoin ?? 'USDT'),
          priceFilter: raw.priceFilter as { tickSize?: string } | undefined,
          lotSizeFilter: raw.lotSizeFilter as {
            qtyStep?: string;
            minOrderQty?: string;
            maxOrderQty?: string;
            minNotionalValue?: string;
          } | undefined
        })
      );
    }
  }

  async configure(symbols: string[]): Promise<void> {
    this.desiredWatchlist = new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean));
    await this.ensureInstrumentsLoaded();

    const active = this.effectiveSymbols().filter((sym) => this.instruments.has(sym));
    // Open WS first and mark bootstrapping=true so live WS frames during REST seed are buffered!
    for (const sym of active) {
      const st = this.ensureSymbolState(sym);
      if (st.revision === 0) {
        st.bootstrapping = true;
      }
    }
    this.connectSocket();
    this.reconcileWsSubscriptions();

    for (const sym of active) {
      const st = this.ensureSymbolState(sym);
      if (st.bootstrapping) {
        await this.bootstrapSymbol(sym);
      }
    }
  }

  private async bootstrapSymbol(symbol: string): Promise<void> {
    const st = this.ensureSymbolState(symbol);
    const inst = this.instruments.get(symbol);
    if (!inst) {
      st.bootstrapping = false;
      st.bufferedFrames.length = 0;
      return;
    }

    try {
      const tickerBody = await this.fetchLinearJson('/v5/market/tickers', { symbol });
      const tickerObsAt = Date.now();
      const tickerSourceAt = Number(tickerBody.time ?? tickerObsAt);
      const tickerList = ((tickerBody.result as { list?: Array<Record<string, unknown>> } | undefined)?.list) ?? [];
      if (tickerList.length > 0) {
        const t = tickerList[0]!;
        st.ticker = {
          lastPrice: t.lastPrice ? String(t.lastPrice) : st.ticker?.lastPrice,
          bid1Price: t.bid1Price ? String(t.bid1Price) : st.ticker?.bid1Price,
          ask1Price: t.ask1Price ? String(t.ask1Price) : st.ticker?.ask1Price,
          fundingRate: t.fundingRate ? String(t.fundingRate) : st.ticker?.fundingRate,
          openInterest: t.openInterest ? String(t.openInterest) : st.ticker?.openInterest,
          price24hPcnt: t.price24hPcnt ? String(t.price24hPcnt) : st.ticker?.price24hPcnt,
          sourceAt: tickerSourceAt,
          observedAt: tickerObsAt
        };
      }

      for (const tf of SUPPORTED_TIMEFRAMES) {
        const klineBody = await this.fetchLinearJson('/v5/market/kline', {
          symbol,
          interval: BYBIT_INTERVAL_BY_TF[tf],
          limit: '200'
        });
        const observedAt = Date.now();
        const sourceAt = Number(klineBody.time ?? observedAt);
        const rows = ((klineBody.result as { list?: string[][] } | undefined)?.list) ?? [];
        // Seed REST klines with cutoff = latest start + duration so closed REST klines enter closed
        const maxStart = rows.reduce((acc, r) => Math.max(acc, Number(r[0]) || 0), 0);
        st.candles.seedRestCandles(symbol, tf, rows, {
          volumeUnit: inst.volumeUnit,
          sourceAt,
          observedAt,
          nowMs: Math.max(sourceAt, maxStart + TF_DURATION_MS[tf])
        });
      }
    } finally {
      st.bootstrapping = false;
      const buffered = st.bufferedFrames.splice(0, st.bufferedFrames.length);
      for (const item of buffered) {
        this.applySymbolWsFrame(st, item.raw, item.observedAt);
      }
      st.revision += 1;
      this.publishSymbolFrame(symbol);
    }
  }

  private async handleReconnect(): Promise<void> {
    if (this.stopped) return;
    this.connectSocket();
    const active = this.effectiveSymbols().filter((s) => this.instruments.has(s));
    for (const sym of active) {
      await this.backfillCandlesAndOrderbook(sym);
    }
  }

  private async backfillCandlesAndOrderbook(symbol: string): Promise<void> {
    const inst = this.instruments.get(symbol);
    if (!inst) return;
    const st = this.ensureSymbolState(symbol);

    for (const tf of SUPPORTED_TIMEFRAMES) {
      const klineBody = await this.fetchLinearJson('/v5/market/kline', {
        symbol,
        interval: BYBIT_INTERVAL_BY_TF[tf],
        limit: '200'
      });
      const observedAt = Date.now();
      const sourceAt = Number(klineBody.time ?? observedAt);
      const rows = ((klineBody.result as { list?: string[][] } | undefined)?.list) ?? [];
      const maxStart = rows.reduce((acc, r) => Math.max(acc, Number(r[0]) || 0), 0);
      st.candles.seedRestCandles(symbol, tf, rows, {
        volumeUnit: inst.volumeUnit,
        sourceAt,
        observedAt,
        nowMs: Math.max(sourceAt, maxStart + TF_DURATION_MS[tf])
      });
    }

    await this.resyncOrderbookFromRest(symbol);
    st.revision += 1;
    this.publishSymbolFrame(symbol);
  }

  private async resyncOrderbookFromRest(symbol: string): Promise<void> {
    const st = this.ensureSymbolState(symbol);
    const body = await this.fetchLinearJson('/v5/market/orderbook', { symbol, limit: '50' });
    const observedAt = Date.now();
    const res = (body.result ?? {}) as {
      b?: Array<[string, string]>;
      a?: Array<[string, string]>;
      u?: number;
      seq?: number;
      ts?: number;
    };
    if (Array.isArray(res.b) && Array.isArray(res.a) && typeof res.u === 'number') {
      st.orderbook.applySnapshot({
        bids: res.b,
        asks: res.a,
        u: res.u,
        seq: res.seq ?? null,
        sourceAt: Number(res.ts ?? body.time ?? observedAt),
        observedAt
      });
      st.bookEvidenceId = `book-${symbol}-${res.u}`;
      st.revision += 1;
      this.publishSymbolFrame(symbol);
    }
  }

  private extractSymbolFromTopic(topic: string): string | null {
    const parts = topic.split('.');
    if (parts[0] === 'tickers' && parts[1]) return parts[1];
    if (parts[0] === 'publicTrade' && parts[1]) return parts[1];
    if (parts[0] === 'orderbook' && parts[2]) return parts[2];
    if (parts[0] === 'kline' && parts[2]) return parts[2];
    return null;
  }

  private handleWsMessage(raw: Record<string, unknown>, observedAt: number): void {
    const topic = typeof raw.topic === 'string' ? raw.topic : null;
    if (!topic) return;
    const symbol = this.extractSymbolFromTopic(topic);
    if (!symbol || !this.instruments.has(symbol)) return;

    const st = this.ensureSymbolState(symbol);
    if (st.bootstrapping) {
      st.bufferedFrames.push({ raw, observedAt });
      return;
    }

    this.applySymbolWsFrame(st, raw, observedAt);
    st.revision += 1;
    this.publishSymbolFrame(symbol);
  }

  private applySymbolWsFrame(
    st: SymbolHubState,
    raw: Record<string, unknown>,
    observedAt: number
  ): void {
    const topic = String(raw.topic ?? '');
    const msgType = String(raw.type ?? 'snapshot');
    const sourceAt = Number(raw.ts ?? observedAt);
    const inst = this.instruments.get(st.symbol);
    const volumeUnit = inst?.volumeUnit ?? st.symbol.replace(/USDT$/, '');

    if (topic.startsWith('tickers.')) {
      const d = (raw.data ?? {}) as Record<string, unknown>;
      const prev = msgType === 'snapshot' ? null : st.ticker;
      st.ticker = {
        lastPrice: d.lastPrice !== undefined ? String(d.lastPrice) : prev?.lastPrice,
        bid1Price: d.bid1Price !== undefined ? String(d.bid1Price) : prev?.bid1Price,
        ask1Price: d.ask1Price !== undefined ? String(d.ask1Price) : prev?.ask1Price,
        fundingRate: d.fundingRate !== undefined ? String(d.fundingRate) : prev?.fundingRate,
        openInterest: d.openInterest !== undefined ? String(d.openInterest) : prev?.openInterest,
        price24hPcnt: d.price24hPcnt !== undefined ? String(d.price24hPcnt) : prev?.price24hPcnt,
        sourceAt,
        observedAt
      };
      return;
    }

    if (topic.startsWith('orderbook.')) {
      const d = (raw.data ?? {}) as {
        b?: Array<[string, string]>;
        a?: Array<[string, string]>;
        u?: number;
        seq?: number;
      };
      const u = Number(d.u ?? 0);
      const bids = Array.isArray(d.b) ? d.b : [];
      const asks = Array.isArray(d.a) ? d.a : [];

      if (msgType === 'snapshot') {
        st.orderbook.applySnapshot({
          bids,
          asks,
          u,
          seq: d.seq ?? null,
          sourceAt,
          observedAt
        });
        st.bookEvidenceId = `book-${st.symbol}-${u}`;
      } else {
        const res = st.orderbook.applyDelta({
          bids,
          asks,
          u,
          seq: d.seq ?? null,
          sourceAt,
          observedAt
        });
        if (res.needsResync) {
          void this.resyncOrderbookFromRest(st.symbol);
        } else if (res.applied) {
          st.bookEvidenceId = `book-${st.symbol}-${u}`;
        }
      }
      return;
    }

    if (topic.startsWith('kline.')) {
      const parts = topic.split('.');
      const tf = TF_BY_BYBIT_INTERVAL[parts[1] ?? ''];
      if (!tf) return;
      const list = Array.isArray(raw.data) ? (raw.data as Array<Record<string, unknown>>) : [];
      for (const item of list) {
        const startAt = Number(item.start);
        const endAt = Number(item.end ?? startAt + TF_DURATION_MS[tf] - 1);
        if (!Number.isFinite(startAt)) continue;
        st.candles.upsertCandle({
          symbol: st.symbol,
          tf,
          startAt,
          endAt,
          open: String(item.open),
          high: String(item.high),
          low: String(item.low),
          close: String(item.close),
          volume: String(item.volume),
          volumeUnit,
          confirmed: Boolean(item.confirm),
          sourceAt: Number(item.timestamp ?? sourceAt),
          observedAt
        });
      }
      return;
    }

    if (topic.startsWith('publicTrade.')) {
      const list = Array.isArray(raw.data) ? (raw.data as Array<Record<string, unknown>>) : [];
      let added = false;
      for (const item of list) {
        const tradeId = String(item.i ?? '');
        if (!tradeId || st.seenTradeIds.has(tradeId)) continue;
        st.seenTradeIds.add(tradeId);
        st.trades.push({
          tradeId,
          symbol: st.symbol,
          price: String(item.p),
          size: String(item.v),
          side: String(item.S) === 'Sell' ? 'Sell' : 'Buy',
          sourceAt: Number(item.T ?? sourceAt),
          observedAt
        });
        added = true;
      }
      if (st.trades.length > this.maxTradesPerSymbol) {
        const overflow = st.trades.splice(0, st.trades.length - this.maxTradesPerSymbol);
        for (const old of overflow) {
          st.seenTradeIds.delete(old.tradeId);
        }
      }
      if (added) {
        st.tradesEvidenceId = `trades-${st.symbol}-${st.trades.at(-1)?.tradeId ?? randomUUID()}`;
      }
    }
  }

  private publishSymbolFrame(symbol: string): void {
    if (this.listeners.size === 0) return;
    const frame = this.snapshot(symbol);
    for (const listener of this.listeners) {
      listener(frame);
    }
  }

  orderbook(symbol: string): OrderbookView | null {
    const clean = symbol.trim().toUpperCase();
    return this.states.get(clean)?.orderbook.view() ?? null;
  }

  recentTrades(symbol: string): PublicTradeRecord[] {
    const clean = symbol.trim().toUpperCase();
    return [...(this.states.get(clean)?.trades ?? [])];
  }

  instrument(symbol: string): BybitLinearInstrument | null {
    return this.instruments.get(symbol.trim().toUpperCase()) ?? null;
  }

  snapshot(symbol: string): MarketFrame {
    const clean = symbol.trim().toUpperCase();
    const now = Date.now();
    const inst = this.instruments.get(clean);
    const st = this.states.get(clean);

    if (!inst || !st) {
      const emptyClosed = {
        '1m': [],
        '5m': [],
        '15m': [],
        '1h': [],
        '4h': [],
        '1d': []
      };
      const reason = !inst
        ? `Bybit linear instrument "${clean}" is unavailable`
        : `Symbol "${clean}" has not been subscribed`;
      return {
        evidenceId: `mkt-${clean}-unavail-${randomUUID()}`,
        revision: 0,
        symbol: clean,
        venue: 'bybit',
        category: 'linear',
        asOf: now,
        last: unavailableEvidence('bybit.linear.tickers', reason, now, 'USDT'),
        bid: unavailableEvidence('bybit.linear.orderbook', reason, now, 'USDT'),
        ask: unavailableEvidence('bybit.linear.orderbook', reason, now, 'USDT'),
        closed: emptyClosed,
        current: {},
        tradesEvidenceId: null,
        bookEvidenceId: null,
        funding: unavailableEvidence('bybit.linear.tickers', reason, now, 'ratio'),
        openInterest: unavailableEvidence('bybit.linear.tickers', reason, now, inst?.baseCoin ?? null)
      };
    }

    const { closed, current } = st.candles.snapshot();
    const bookView = st.orderbook.view();
    const ticker = st.ticker;

    const makePriceEvidence = (
      val: string | undefined,
      src: string,
      srcAt: number | undefined,
      obsAt: number | undefined,
      unit: string
    ): Evidence<DecimalString> => {
      if (!val) {
        return unavailableEvidence(src, 'Field not yet received from Bybit linear feed', now, unit);
      }
      return verifiedEvidence({
        value: val,
        source: src,
        sourceAt: srcAt ?? now,
        observedAt: obsAt ?? now,
        unit
      });
    };

    const bestBid = bookView?.bids[0]?.price ?? ticker?.bid1Price;
    const bestAsk = bookView?.asks[0]?.price ?? ticker?.ask1Price;
    const lastCloseFallback = closed['1m'].at(-1)?.close;

    return {
      evidenceId: `mkt-${clean}-r${st.revision}`,
      revision: st.revision,
      symbol: clean,
      venue: 'bybit',
      category: 'linear',
      asOf: Math.max(ticker?.observedAt ?? 0, bookView?.observedAt ?? 0, now),
      last: makePriceEvidence(
        ticker?.lastPrice ?? lastCloseFallback,
        ticker?.lastPrice ? 'bybit.linear.tickers' : 'bybit.linear.kline',
        ticker?.sourceAt,
        ticker?.observedAt,
        inst.quoteCoin
      ),
      bid: makePriceEvidence(
        bestBid,
        bookView ? 'bybit.linear.orderbook.50' : 'bybit.linear.tickers',
        bookView?.sourceAt ?? ticker?.sourceAt,
        bookView?.observedAt ?? ticker?.observedAt,
        inst.quoteCoin
      ),
      ask: makePriceEvidence(
        bestAsk,
        bookView ? 'bybit.linear.orderbook.50' : 'bybit.linear.tickers',
        bookView?.sourceAt ?? ticker?.sourceAt,
        bookView?.observedAt ?? ticker?.observedAt,
        inst.quoteCoin
      ),
      closed,
      current,
      tradesEvidenceId: st.tradesEvidenceId,
      bookEvidenceId: st.bookEvidenceId,
      funding: makePriceEvidence(
        ticker?.fundingRate,
        'bybit.linear.tickers',
        ticker?.sourceAt,
        ticker?.observedAt,
        'ratio'
      ),
      openInterest: makePriceEvidence(
        ticker?.openInterest,
        'bybit.linear.tickers',
        ticker?.sourceAt,
        ticker?.observedAt,
        inst.baseCoin
      )
    };
  }

  onFrame(listener: (frame: MarketFrame) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.ws) {
      const sock = this.ws;
      this.ws = null;
      this.wsOpen = false;
      sock.close();
    }
    this.subscribedTopics.clear();
  }
}
