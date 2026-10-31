import { safe } from '../../redact.js';

export interface NormalizedMarketMeta {
  symbol: string;
  base: string;
  quote: string;
  active: boolean;
  precision: {
    price: number | null;
    amount: number | null;
  };
  limits: {
    amount: { min: number | null; max: number | null };
    price: { min: number | null; max: number | null };
    cost: { min: number | null; max: number | null };
  };
}

export interface NormalizedOhlcv {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface NormalizedOrderBook {
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
  timestamp: number | null;
}

export interface CcxtVenueCapabilities {
  venue: string;
  available: boolean;
  supported: boolean;
  hasFetchOHLCV: boolean;
  hasFetchTicker: boolean;
  hasFetchOrderBook: boolean;
  hasPublicTradeStream: boolean;
  executionRole: 'NATIVE_ADAPTER_ONLY';
  note: string;
}

export interface CcxtCapabilityReport {
  installed: boolean;
  version: string | null;
  venues: Record<string, CcxtVenueCapabilities>;
}

export interface CcxtDiagnosticResult {
  ok: boolean;
  venue: string;
  latencyMs: number | null;
  tickerPrice: number | null;
  error: string | null;
}

const SUPPORTED_VENUES = ['bybit', 'binance', 'okx', 'hyperliquid'] as const;

export class CcxtMarketAdapter {
  private ccxtModule: any | null = null;
  private importAttempted = false;
  private readonly instances = new Map<string, any>();

  private async getCcxt(): Promise<any | null> {
    if (this.importAttempted) return this.ccxtModule;
    this.importAttempted = true;
    try {
      // Dynamic import to avoid hard dependency failure if ccxt is not in node_modules
      const dynamicImporter = new Function('spec', 'return import(spec)');
      const mod = (await dynamicImporter('ccxt')) as any;
      this.ccxtModule = mod?.default ?? mod;
      return this.ccxtModule;
    } catch {
      this.ccxtModule = null;
      return null;
    }
  }

  async getCapabilityReport(): Promise<CcxtCapabilityReport> {
    const ccxt = await this.getCcxt();
    const installed = Boolean(ccxt);
    const version = ccxt?.version ?? null;

    const venues: Record<string, CcxtVenueCapabilities> = {};
    for (const v of SUPPORTED_VENUES) {
      const isKnown = Boolean(ccxt && ccxt[v]);
      venues[v] = {
        venue: v,
        available: isKnown,
        supported: true,
        hasFetchOHLCV: isKnown,
        hasFetchTicker: isKnown,
        hasFetchOrderBook: isKnown,
        hasPublicTradeStream: isKnown,
        executionRole: 'NATIVE_ADAPTER_ONLY',
        note: isKnown
          ? `CCXT unified market read provider ready for ${v}. Execution remains strictly through native adapter.`
          : installed
          ? `Exchange class ${v} not found in installed CCXT version.`
          : 'CCXT module is not installed. Native Bybit/exchange adapters handle market data.'
      };
    }

    return {
      installed,
      version,
      venues
    };
  }

  private async getExchangeInstance(venue: string): Promise<any | null> {
    if (this.instances.has(venue)) return this.instances.get(venue);
    const ccxt = await this.getCcxt();
    if (!ccxt || !ccxt[venue]) return null;

    try {
      const ExchangeClass = ccxt[venue];
      const instance = new ExchangeClass({
        enableRateLimit: true,
        timeout: 10_000,
        options: { defaultType: 'swap' }
      });
      this.instances.set(venue, instance);
      return instance;
    } catch {
      return null;
    }
  }

  async loadMarkets(venue: string): Promise<Record<string, NormalizedMarketMeta>> {
    const ex = await this.getExchangeInstance(venue);
    if (!ex) return {};

    try {
      const raw = await ex.loadMarkets();
      const result: Record<string, NormalizedMarketMeta> = {};

      for (const [sym, m] of Object.entries(raw as Record<string, any>)) {
        if (!m) continue;
        result[sym] = {
          symbol: sym,
          base: m.base ?? '',
          quote: m.quote ?? '',
          active: Boolean(m.active),
          precision: {
            price: m.precision?.price ?? null,
            amount: m.precision?.amount ?? null
          },
          limits: {
            amount: { min: m.limits?.amount?.min ?? null, max: m.limits?.amount?.max ?? null },
            price: { min: m.limits?.price?.min ?? null, max: m.limits?.price?.max ?? null },
            cost: { min: m.limits?.cost?.min ?? null, max: m.limits?.cost?.max ?? null }
          }
        };
      }
      return result;
    } catch (err) {
      throw new Error(`CCXT loadMarkets failed for ${venue}: ${safe((err as Error).message)}`);
    }
  }

  async fetchOhlcv(
    venue: string,
    symbol: string,
    timeframe = '15m',
    since?: number,
    limit = 100
  ): Promise<NormalizedOhlcv[]> {
    const ex = await this.getExchangeInstance(venue);
    if (!ex) return [];

    try {
      const rows: Array<[number, number, number, number, number, number]> = await ex.fetchOHLCV(
        symbol,
        timeframe,
        since,
        limit
      );
      if (!Array.isArray(rows)) return [];

      return rows.map((r) => ({
        time: Math.floor(r[0] / 1000),
        open: r[1],
        high: r[2],
        low: r[3],
        close: r[4],
        volume: r[5]
      }));
    } catch (err) {
      throw new Error(`CCXT fetchOHLCV failed for ${venue}/${symbol}: ${safe((err as Error).message)}`);
    }
  }

  async fetchOrderBook(venue: string, symbol: string, limit = 20): Promise<NormalizedOrderBook> {
    const ex = await this.getExchangeInstance(venue);
    if (!ex) {
      return { bids: [], asks: [], timestamp: null };
    }

    try {
      const ob = await ex.fetchOrderBook(symbol, limit);
      return {
        bids: Array.isArray(ob.bids) ? ob.bids.slice(0, limit) : [],
        asks: Array.isArray(ob.asks) ? ob.asks.slice(0, limit) : [],
        timestamp: ob.timestamp ?? Date.now()
      };
    } catch (err) {
      throw new Error(`CCXT fetchOrderBook failed for ${venue}/${symbol}: ${safe((err as Error).message)}`);
    }
  }

  async diagnoseConnection(venue: string, symbol = 'BTC/USDT:USDT'): Promise<CcxtDiagnosticResult> {
    const start = Date.now();
    try {
      const ex = await this.getExchangeInstance(venue);
      if (!ex) {
        return {
          ok: false,
          venue,
          latencyMs: null,
          tickerPrice: null,
          error: 'CCXT exchange module not available or exchange ID unsupported'
        };
      }
      const ticker = await ex.fetchTicker(symbol).catch(async () => ex.fetchTicker('BTC/USDT'));
      const latencyMs = Date.now() - start;
      const price = Number(ticker?.last ?? ticker?.close ?? 0);
      return {
        ok: price > 0,
        venue,
        latencyMs,
        tickerPrice: price > 0 ? price : null,
        error: null
      };
    } catch (err) {
      return {
        ok: false,
        venue,
        latencyMs: Date.now() - start,
        tickerPrice: null,
        error: safe((err as Error).message)
      };
    }
  }
}
