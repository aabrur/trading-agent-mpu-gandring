import { safe } from '../redact.js';

// One interface for every venue. The desk never talks to an exchange directly,
// it talks to an ExchangeAdapter, and only through the LiveExecutor.
export type ExchangeName = 'bybit' | 'binance' | 'okx' | 'hyperliquid';
export const EXCHANGES: ExchangeName[] = ['bybit', 'binance', 'okx', 'hyperliquid'];
export type Network = 'testnet' | 'mainnet';
export type Side = 'LONG' | 'SHORT';

/** Fully implemented and covered by tests (against mocked HTTP), or still experimental. */
export const ADAPTER_STATUS: Record<ExchangeName, 'implemented' | 'experimental'> = {
  bybit: 'implemented',
  binance: 'experimental',
  okx: 'experimental',
  hyperliquid: 'experimental'
};

export interface Instrument { symbol: string; qtyStep: number; minQty: number; tickSize: number }
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
export interface VenuePosition { symbol: string; side: Side; qty: number; entry: number; stop: number | null; tp: number | null; unrealizedPnl: number }

export interface ExchangeAdapter {
  readonly name: ExchangeName;
  readonly network: Network;
  /** Harmless authenticated read. Used by `npm run doctor`. */
  ping(): Promise<{ ok: boolean; detail: string }>;
  permissions(): Promise<PermissionReport>;
  balance(): Promise<Balance>;
  instrument(symbol: string): Promise<Instrument>;
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
export function roundTick(v: number, tick: number) {
  if (!(tick > 0)) return v;
  const dec = Math.max(0, (tick.toString().split('.')[1] ?? '').length);
  return Number((Math.round(v / tick) * tick).toFixed(dec));
}
