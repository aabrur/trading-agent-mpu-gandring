import { safe } from '../redact.js';
import type { InstrumentRules } from './rules.js';

// One interface for every venue. The desk never talks to an exchange directly,
// it talks to an ExchangeAdapter, and only through the LiveExecutor.
export type ExchangeName = 'bybit' | 'binance' | 'okx' | 'hyperliquid' | 'aster' | 'dydx' | 'paradex' | 'orderly';
export const EXCHANGES: ExchangeName[] = ['bybit', 'binance', 'okx', 'hyperliquid', 'aster', 'dydx', 'paradex', 'orderly'];
/** Centralized exchange or perp DEX. Used to group the setup list and the docs. */
export const VENUE_KIND: Record<ExchangeName, 'CEX' | 'DEX'> = { bybit: 'CEX', binance: 'CEX', okx: 'CEX', hyperliquid: 'DEX', aster: 'DEX', dydx: 'DEX', paradex: 'DEX', orderly: 'DEX' };
export const VENUE_LABEL: Record<ExchangeName, string> = { bybit: 'Bybit', binance: 'Binance', okx: 'OKX', hyperliquid: 'Hyperliquid', aster: 'Aster', dydx: 'dYdX v4', paradex: 'Paradex', orderly: 'Orderly' };
/** What kind of key each venue takes. Never a main wallet key, never a key that can withdraw. */
export const VENUE_KEY_HINT: Record<ExchangeName, string> = {
  bybit: 'API key + secret, trade only, withdrawals off',
  binance: 'API key + secret, futures on, withdrawals off',
  okx: 'API key + secret + passphrase, trade only, withdrawals off',
  hyperliquid: 'main account ADDRESS (public) + API agent wallet private key',
  aster: 'main wallet ADDRESS (public) + Pro API agent (API wallet) private key, perp trading on, withdraw off',
  dydx: 'owner dYdX ADDRESS (public) + API Trading Key private key + authenticator id. SDK REQUIRED: npm install @dydxprotocol/v4-client-js (not bundled)',
  paradex: 'main Paradex account ADDRESS (public) + registered subkey private key',
  orderly: 'Orderly account id (public) + Orderly key secret with scope read,trading'
};
export type Network = 'testnet' | 'mainnet';
export type Side = 'LONG' | 'SHORT';

/** Fully implemented and covered by tests (against mocked HTTP), or still experimental. */
export const ADAPTER_STATUS: Record<ExchangeName, 'implemented' | 'experimental'> = {
  bybit: 'implemented',
  binance: 'experimental',
  okx: 'experimental',
  hyperliquid: 'experimental',
  aster: 'experimental',
  dydx: 'experimental',
  paradex: 'experimental',
  orderly: 'experimental'
};

/** Lot step, min qty, tick. minNotional (qty * price, quote) when the venue publishes one; null/undefined = none published. */
export interface Instrument { symbol: string; qtyStep: number; minQty: number; tickSize: number; minNotional?: number | null; maxQty?: number | null; status?: string | null }
export interface Balance { equityUsdt: number; availableUsdt: number }
export interface PermissionReport {
  /** true only when the venue told us the key cannot withdraw (or, on Hyperliquid, it is an approved agent wallet). */
  ok: boolean;
  canWithdraw: boolean | null;
  canTrade: boolean;
  /** true when the answer came from the exchange API, false when we could not check. */
  verified: boolean;
  detail: string;
}
export interface PlaceOrder { symbol: string; side: Side; qty: number; stop: number; tp: number | null; leverage: number; clientId: string }
export interface OrderRecord { clientId: string; orderId: string; status: 'filled' | 'partial' | 'open' | 'rejected' | 'cancelled' | 'unknown'; filledQty: number; avgPrice: number | null; raw?: string }
/** Stop loss and take profit that rest ON THE EXCHANGE (attached to the position or as reduce-only trigger orders). */
export interface Protection { stop: number | null; tp: number | null }
export interface ProtectRequest { symbol: string; side: Side; qty: number; stop: number | null; tp: number | null; clientId: string }
export interface VenuePosition { symbol: string; side: Side; qty: number; entry: number; stop: number | null; tp: number | null; unrealizedPnl: number }

export interface ExchangeAdapter {
  readonly name: ExchangeName;
  readonly network: Network;
  /** Harmless authenticated read. Used by `npm run doctor`. */
  ping(): Promise<{ ok: boolean; detail: string }>;
  permissions(): Promise<PermissionReport>;
  balance(): Promise<Balance>;
  instrument(symbol: string): Promise<Instrument>;
  /** Full exchange rules for sizing (lot, tick, min notional, taker fee), cached briefly. Optional; see adapterRules(). */
  instrumentRules?(symbol: string): Promise<InstrumentRules>;
  /** Last traded or mid price, public read. */
  ticker(symbol: string): Promise<number>;
  /** One send. Market entry with the stop loss (and take profit) attached. Never retried by the adapter. */
  placeOrder(o: PlaceOrder): Promise<{ orderId: string | null }>;
  /** Reads the exchange's own record for a client id. This is the source of truth after a send. */
  getOrder(symbol: string, clientId: string): Promise<OrderRecord>;
  positions(symbol?: string): Promise<VenuePosition[]>;
  /** Reduce-only market close. */
  closePosition(symbol: string, side: Side, qty: number, clientId: string): Promise<{ orderId: string | null }>;
  cancelAll(symbol: string): Promise<void>;
  /**
   * true when this adapter places the stop loss on the exchange itself, so a position stays protected
   * if this computer shuts down. The executor refuses to open anything on an adapter that says false.
   */
  readonly exchangeStops: boolean;
  /** Reads the stop loss and take profit resting on the exchange for an open position. */
  protection(symbol: string, side: Side): Promise<Protection>;
  /** Places only the legs given (stop and/or take profit) as exchange-side reduce-only triggers. One send per leg. */
  protect(p: ProtectRequest): Promise<void>;
}

export class ExchangeError extends Error {
  // Exchange error text can echo request details back, so it is scrubbed before anyone sees it.
  constructor(message: string, public code?: string | number, public retryable = false) { super(safe(message)); }
}

export type FetchLike = typeof fetch;

export async function httpJson(fetchImpl: FetchLike, url: string, init: RequestInit = {}, timeoutMs = 8000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 300) }; }
    if (!res.ok) throw new ExchangeError(`HTTP ${res.status}: ${(body?.msg ?? body?.retMsg ?? body?.raw ?? '').toString().slice(0, 160)}`, res.status);
    return body;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new ExchangeError('request timed out', 'timeout', true);
    throw e;
  } finally { clearTimeout(t); }
}

/** Rounds down to a step, never up, so size can only shrink. */
export function floorStep(v: number, step: number) {
  if (!(step > 0)) return v;
  const n = Math.floor(v / step + 1e-9) * step;
  const dec = Math.max(0, (step.toString().split('.')[1] ?? '').length);
  return Number(n.toFixed(dec));
}
/** Picks the stop and take profit out of a list of open trigger orders for a position. */
export function pickProtection(side: Side, triggers: { price: number; kind: 'stop' | 'tp' | 'unknown'; closes: Side | null }[], entryRef: number | null = null): Protection {
  const exits = triggers.filter((t) => t.price > 0 && (t.closes === null || t.closes === side));
  const classify = (t: (typeof exits)[number]): 'stop' | 'tp' | 'unknown' => {
    if (t.kind !== 'unknown') return t.kind;
    if (entryRef == null) return 'unknown';
    return side === 'LONG' ? (t.price < entryRef ? 'stop' : 'tp') : (t.price > entryRef ? 'stop' : 'tp');
  };
  const stop = exits.find((t) => classify(t) === 'stop')?.price ?? null;
  const tp = exits.find((t) => classify(t) === 'tp')?.price ?? null;
  return { stop, tp };
}
export function roundTick(v: number, tick: number) {
  if (!(tick > 0)) return v;
  const dec = Math.max(0, (tick.toString().split('.')[1] ?? '').length);
  return Number((Math.round(v / tick) * tick).toFixed(dec));
}
