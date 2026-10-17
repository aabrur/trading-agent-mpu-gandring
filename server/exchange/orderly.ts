import { ed25519 } from '@noble/curves/ed25519.js';
import { base58 } from '@scure/base';
import { ExchangeError, httpJson, floorStep, roundTick, pickProtection, type ExchangeAdapter, type FetchLike, type Network, type PermissionReport, type PlaceOrder, type OrderRecord, type VenuePosition, type Side, type Protection, type ProtectRequest } from './types.js';

// EXPERIMENTAL, UNTESTED against a real account. Orderly Network perpetuals (PERP_<COIN>_USDC).
// Docs: https://orderly.network/docs/build-on-omnichain/api-authentication
// Auth: the Orderly account id (public) plus an Orderly key (ed25519, base58 secret) with scope read,trading.
// An Orderly key cannot withdraw on its own: withdrawals and transfers need an EIP-712 signature from the wallet.
// Request signature: ed25519 over `${timestamp}${METHOD}${path?query}${jsonBody}`, base64url, header orderly-signature.
// Stops are POSITIONAL_TP_SL algo orders (STOP_LOSS / TAKE_PROFIT, CLOSE_POSITION) resting on Orderly.

const BASE: Record<Network, string> = { mainnet: 'https://api.orderly.org', testnet: 'https://testnet-api.orderly.org' };
export const orderlySymbol = (symbol: string) => `PERP_${symbol.replace(/USDT?$|USDC$/, '')}_USDC`;
export const fromOrderlySymbol = (s: string) => `${s.replace(/^PERP_/, '').replace(/_USDC$/, '')}USDT`;
const ALLOWED_SCOPES = new Set(['read', 'trading']);

/** Parses the Orderly key secret. Refuses anything that looks like an EVM wallet private key. */
export function parseOrderlySecret(secret: string): Uint8Array {
  const s = secret.trim().replace(/^ed25519:/, '');
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(s)) throw new ExchangeError('this looks like a wallet private key (hex). Orderly needs an Orderly key secret (base58 ed25519), never the wallet key.');
  let b: Uint8Array;
  try { b = base58.decode(s); } catch { throw new ExchangeError('Orderly key secret must be base58 (ed25519)'); }
  if (b.length === 64) b = b.slice(0, 32);
  if (b.length !== 32) throw new ExchangeError('Orderly key secret must decode to 32 bytes');
  return b;
}

export class OrderlyAdapter implements ExchangeAdapter {
  readonly name = 'orderly' as const;
  readonly exchangeStops = true;
  private base: string;
  private secret: Uint8Array;
  readonly orderlyKey: string;
  constructor(public readonly network: Network, private accountId: string, keySecret: string, private fetchImpl: FetchLike = fetch, base = process.env[network === 'testnet' ? 'ORDERLY_TESTNET_BASE_URL' : 'ORDERLY_BASE_URL']) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(accountId)) throw new ExchangeError('ORDERLY account id must be the 0x account id (public, 32 bytes)');
    this.secret = parseOrderlySecret(keySecret);
    this.orderlyKey = `ed25519:${base58.encode(ed25519.getPublicKey(this.secret))}`;
    this.base = base || BASE[network];
  }

  /** Normalized message and signature, exposed for tests. */
  sign(ts: number, method: string, pathWithQuery: string, body = '') {
    const message = `${ts}${method}${pathWithQuery}${body}`;
    return { message, signature: Buffer.from(ed25519.sign(new TextEncoder().encode(message), this.secret)).toString('base64url') };
  }
  private async req(method: 'GET' | 'POST' | 'DELETE', path: string, body?: Record<string, unknown>) {
    const ts = Date.now();
    const json = body ? JSON.stringify(body) : '';
    const { signature } = this.sign(ts, method, path, json);
    const r = await httpJson(this.fetchImpl, `${this.base}${path}`, {
      method, body: json || undefined,
      headers: { 'Content-Type': method === 'POST' ? 'application/json' : 'application/x-www-form-urlencoded', 'orderly-account-id': this.accountId, 'orderly-key': this.orderlyKey, 'orderly-timestamp': String(ts), 'orderly-signature': signature }
    });
    if (r?.success === false) throw new ExchangeError(`orderly ${path.split('?')[0]}: ${r?.message ?? 'error'} (${r?.code ?? '?'})`, r?.code);
    return r?.data;
  }
  private async pub(path: string) { const r = await httpJson(this.fetchImpl, `${this.base}${path}`); if (r?.success === false) throw new ExchangeError(`orderly ${path}: ${r?.message ?? 'error'}`); return r?.data; }

  async ping() { await this.req('GET', '/v1/client/holding'); return { ok: true, detail: 'holdings readable' }; }
  async permissions(): Promise<PermissionReport> {
    const d = await this.req('GET', '/v1/client/key_info');
    const row = (d?.rows ?? []).find((r: any) => r.orderly_key === this.orderlyKey);
    if (!row) return { ok: false, canWithdraw: null, canTrade: false, verified: true, detail: `Orderly key ${this.orderlyKey.slice(0, 18)}... is not registered on account ${this.accountId.slice(0, 10)}...` };
    if (row.key_status && row.key_status !== 'ACTIVE') return { ok: false, canWithdraw: false, canTrade: false, verified: true, detail: `Orderly key status ${row.key_status}` };
    if (row.expiration && Number(row.expiration) < Date.now()) return { ok: false, canWithdraw: false, canTrade: false, verified: true, detail: 'Orderly key expired' };
    const scopes = String(row.scope ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const extra = scopes.filter((s) => !ALLOWED_SCOPES.has(s));
    if (extra.length) return { ok: false, canWithdraw: null, canTrade: scopes.includes('trading'), verified: true, detail: `Orderly key has scope(s) beyond read,trading: ${extra.join(', ')}. Refusing.` };
    const canTrade = scopes.includes('trading');
    return { ok: true, canWithdraw: false, canTrade, verified: true, detail: `Orderly key scope ${scopes.join(',') || 'none'}${row.ip_restriction_status === 'ALLOW_ALL_IPS' ? '; no IP restriction (recommended)' : ''}; Orderly keys cannot withdraw (wallet signature required)` };
  }
  async balance() {
    const d = await this.req('GET', '/v1/positions');
    return { equityUsdt: Number(d?.total_collateral_value ?? 0), availableUsdt: Number(d?.free_collateral ?? 0) };
  }
  async instrument(symbol: string) {
    const i = await this.pub(`/v1/public/info/${orderlySymbol(symbol)}`);
    if (!i) throw new ExchangeError(`orderly: unknown symbol ${symbol}`);
    const mn = Number(i.min_notional), mx = Number(i.base_max);
    return { symbol, qtyStep: Number(i.base_tick), minQty: Math.max(Number(i.base_min), Number(i.base_tick)), tickSize: Number(i.quote_tick), minNotional: mn > 0 ? mn : null, maxQty: mx > 0 ? mx : null };
  }
  async ticker(symbol: string) { const d = await this.pub(`/v1/public/futures/${orderlySymbol(symbol)}`); const px = Number(d?.mark_price); if (!px) throw new ExchangeError('orderly: no price'); return px; }
  async funding(symbol: string) { const d = await this.pub(`/v1/public/funding_rate/${orderlySymbol(symbol)}`); return Number(d?.est_funding_rate ?? d?.last_funding_rate ?? NaN); }

  private tpslBody(symbol: string, side: Side, stop: number | null, tp: number | null, tick: number) {
    const sym = orderlySymbol(symbol), exit = side === 'LONG' ? 'SELL' : 'BUY';
    const child = (algo: 'STOP_LOSS' | 'TAKE_PROFIT', px: number) => ({ symbol: sym, algo_type: algo, side: exit, type: 'CLOSE_POSITION', trigger_price_type: 'MARK_PRICE', trigger_price: roundTick(px, tick), reduce_only: true });
    return { symbol: sym, algo_type: 'POSITIONAL_TP_SL', trigger_price_type: 'MARK_PRICE', child_orders: [...(tp ? [child('TAKE_PROFIT', tp)] : []), ...(stop ? [child('STOP_LOSS', stop)] : [])] };
  }
  async placeOrder(o: PlaceOrder) {
    if (!(o.stop > 0)) throw new ExchangeError('refusing an order without a stop loss');
    const ins = await this.instrument(o.symbol);
    const qty = floorStep(o.qty, ins.qtyStep);
    if (qty < ins.minQty) throw new ExchangeError(`size ${qty} is under the minimum ${ins.minQty}`);
    const sym = orderlySymbol(o.symbol), exit = o.side === 'LONG' ? 'SELL' : 'BUY';
    const r = await this.req('POST', '/v1/order', { symbol: sym, client_order_id: o.clientId, order_type: 'MARKET', order_quantity: qty, side: o.side === 'LONG' ? 'BUY' : 'SELL' });
    try {
      await this.req('POST', '/v1/algo/order', this.tpslBody(o.symbol, o.side, o.stop, o.tp, ins.tickSize));
    } catch (e) {
      await this.req('POST', '/v1/order', { symbol: sym, client_order_id: `${o.clientId}x`, order_type: 'MARKET', order_quantity: qty, side: exit, reduce_only: true }).catch(() => {});
      throw new ExchangeError(`stop could not be placed, entry closed: ${(e as Error).message}`);
    }
    return { orderId: r?.order_id != null ? String(r.order_id) : null };
  }
  async getOrder(_symbol: string, clientId: string): Promise<OrderRecord> {
    try {
      const d = await this.req('GET', `/v1/client/order/${encodeURIComponent(clientId)}`);
      if (!d) return { clientId, orderId: '', status: 'unknown', filledQty: 0, avgPrice: null };
      const map: Record<string, OrderRecord['status']> = { FILLED: 'filled', PARTIAL_FILLED: 'partial', NEW: 'open', REJECTED: 'rejected', CANCELLED: 'cancelled' };
      const filled = Number(d.total_executed_quantity ?? d.executed_quantity ?? 0);
      return { clientId, orderId: String(d.order_id ?? ''), status: map[d.status] ?? (filled > 0 ? 'partial' : 'unknown'), filledQty: filled, avgPrice: Number(d.average_executed_price) || null, raw: d.status };
    } catch { return { clientId, orderId: '', status: 'unknown', filledQty: 0, avgPrice: null }; }
  }
  async positions(symbol?: string): Promise<VenuePosition[]> {
    const d = await this.req('GET', '/v1/positions');
    return (d?.rows ?? []).filter((p: any) => Number(p.position_qty) !== 0).map((p: any) => ({
      symbol: fromOrderlySymbol(p.symbol), side: Number(p.position_qty) > 0 ? 'LONG' : 'SHORT', qty: Math.abs(Number(p.position_qty)), entry: Number(p.average_open_price),
      stop: null, tp: null, unrealizedPnl: Number(p.unsettled_pnl ?? 0)
    })).filter((p: VenuePosition) => !symbol || p.symbol === symbol);
  }
  async closePosition(symbol: string, side: Side, qty: number, clientId: string) {
    const r = await this.req('POST', '/v1/order', { symbol: orderlySymbol(symbol), client_order_id: clientId, order_type: 'MARKET', order_quantity: qty, side: side === 'LONG' ? 'SELL' : 'BUY', reduce_only: true });
    return { orderId: r?.order_id != null ? String(r.order_id) : null };
  }
  async cancelAll(symbol: string) {
    await this.req('DELETE', `/v1/orders?symbol=${orderlySymbol(symbol)}`);
    await this.req('DELETE', `/v1/algo/orders?symbol=${orderlySymbol(symbol)}`);
  }
  private async algoRows(symbol: string) {
    const d = await this.req('GET', `/v1/algo/orders?symbol=${orderlySymbol(symbol)}&status=INCOMPLETE`);
    const flat: any[] = [];
    const walk = (rows: any[]) => { for (const r of rows ?? []) { flat.push(r); if (Array.isArray(r.child_orders)) walk(r.child_orders); } };
    walk(d?.rows ?? []);
    return flat;
  }
  async protection(symbol: string, side: Side): Promise<Protection> {
    const rows = await this.algoRows(symbol);
    return pickProtection(side, rows.filter((r) => Number(r.trigger_price) > 0 && (r.algo_type === 'STOP_LOSS' || r.algo_type === 'TAKE_PROFIT')).map((r) => ({
      price: Number(r.trigger_price), kind: r.algo_type === 'STOP_LOSS' ? 'stop' as const : 'tp' as const, closes: (r.side === 'SELL' ? 'LONG' : 'SHORT') as Side
    })));
  }
  /** Orderly allows one positional TP/SL per symbol and side, so the missing leg is merged with what is already there. */
  async protect(p: ProtectRequest) {
    if (!p.stop && !p.tp) return;
    const ins = await this.instrument(p.symbol);
    const have = await this.protection(p.symbol, p.side);
    if (have.stop || have.tp) await this.req('DELETE', `/v1/algo/orders?symbol=${orderlySymbol(p.symbol)}`);
    await this.req('POST', '/v1/algo/order', this.tpslBody(p.symbol, p.side, p.stop ?? have.stop, p.tp ?? have.tp, ins.tickSize));
  }
}
