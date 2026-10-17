import { typedData, ec, shortString } from 'starknet';
import { ExchangeError, httpJson, floorStep, roundTick, pickProtection, type ExchangeAdapter, type FetchLike, type Network, type PermissionReport, type PlaceOrder, type OrderRecord, type VenuePosition, type Side, type Protection, type ProtectRequest } from './types.js';

// EXPERIMENTAL, UNTESTED against a real account. Paradex perpetuals (<COIN>-USD-PERP).
// Docs: https://docs.paradex.trade/api/general-information/api-authentication
// Auth: the main Paradex account ADDRESS (public) plus a registered SUBKEY private key.
// Subkeys can place, modify and cancel orders but cannot withdraw, transfer or manage keys.
// JWT: POST /v1/auth/{subkey_public_key} with a Starknet typed-data signature (Request, domain Paradex v1).
// Orders: each order carries a Starknet signature over Order{timestamp, market, side, orderType, size, price} (8 decimals).
// Stops are STOP_MARKET reduce-only orders resting on Paradex.

const BASE: Record<Network, string> = { mainnet: 'https://api.prod.paradex.trade/v1', testnet: 'https://api.testnet.paradex.trade/v1' };
export const paradexMarket = (symbol: string) => `${symbol.replace(/USDT?$|USDC$/, '')}-USD-PERP`;
export const fromParadexMarket = (m: string) => `${m.replace(/-USD-PERP$/, '')}USDT`;
const DOMAIN_TYPES = [{ name: 'name', type: 'felt' }, { name: 'chainId', type: 'felt' }, { name: 'version', type: 'felt' }];
/** Quantum value with 8 decimals, as Paradex signs it. */
export const chainNumber = (v: number) => (BigInt(Math.round(v * 1e8))).toString();

export class ParadexAdapter implements ExchangeAdapter {
  readonly name = 'paradex' as const;
  readonly exchangeStops = true;
  private base: string;
  private chainId: string | null = null;
  private jwt: { token: string; until: number } | null = null;
  readonly subkeyPublic: string;
  constructor(public readonly network: Network, private account: string, private subkey: string, private fetchImpl: FetchLike = fetch, base = process.env[network === 'testnet' ? 'PARADEX_TESTNET_BASE_URL' : 'PARADEX_BASE_URL']) {
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(account)) throw new ExchangeError('PARADEX account address must be the 0x main Paradex (Starknet) account address (public)');
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(subkey)) throw new ExchangeError('Paradex subkey must be a 0x Starknet private key of a registered subkey');
    this.subkey = `0x${subkey.slice(2).padStart(64, '0')}`;
    this.subkeyPublic = ec.starkCurve.getStarkKey(this.subkey);
    this.base = base || BASE[network];
  }

  private async chain() {
    if (!this.chainId) {
      const c = await httpJson(this.fetchImpl, `${this.base}/system/config`);
      if (!c?.starknet_chain_id) throw new ExchangeError('paradex: no starknet_chain_id in system config');
      this.chainId = shortString.encodeShortString(String(c.starknet_chain_id));
    }
    return this.chainId;
  }
  /** Signs Starknet typed data with the subkey, for the main account. Returns the flattened ["r","s"] string. */
  async signTyped(primaryType: string, fields: { name: string; type: string }[], message: Record<string, unknown>) {
    const td = { domain: { name: 'Paradex', chainId: await this.chain(), version: '1' }, primaryType, types: { StarkNetDomain: DOMAIN_TYPES, [primaryType]: fields }, message };
    const hash = typedData.getMessageHash(td as any, this.account);
    const sig = ec.starkCurve.sign(hash, this.subkey);
    return { hash, signature: `["${sig.r.toString()}","${sig.s.toString()}"]` };
  }
  async authHeaders(now = Math.floor(Date.now() / 1000)) {
    const expiration = now + 30 * 60;
    const { signature } = await this.signTyped('Request', [{ name: 'method', type: 'felt' }, { name: 'path', type: 'felt' }, { name: 'body', type: 'felt' }, { name: 'timestamp', type: 'felt' }, { name: 'expiration', type: 'felt' }], { method: 'POST', path: '/v1/auth', body: '', timestamp: now, expiration });
    return { 'PARADEX-STARKNET-ACCOUNT': this.account, 'PARADEX-STARKNET-SIGNATURE': signature, 'PARADEX-TIMESTAMP': String(now), 'PARADEX-SIGNATURE-EXPIRATION': String(expiration) };
  }
  private async token() {
    if (this.jwt && this.jwt.until > Date.now()) return this.jwt.token;
    const r = await httpJson(this.fetchImpl, `${this.base}/auth/${this.subkeyPublic}`, { method: 'POST', headers: { ...(await this.authHeaders()), 'Content-Type': 'application/json' } });
    if (!r?.jwt_token) throw new ExchangeError('paradex: no JWT returned for this subkey');
    this.jwt = { token: r.jwt_token, until: Date.now() + 3 * 60_000 }; // JWTs live 5 minutes; refresh after 3
    return r.jwt_token as string;
  }
  private async req(method: 'GET' | 'POST' | 'DELETE', path: string, body?: Record<string, unknown>) {
    return httpJson(this.fetchImpl, `${this.base}${path}`, { method, headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  }
  private pub(path: string) { return httpJson(this.fetchImpl, `${this.base}${path}`); }

  /** Signed order body. Exposed for tests. */
  async orderBody(o: { market: string; side: 'BUY' | 'SELL'; type: 'MARKET' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET'; size: number; clientId: string; trigger?: number; reduceOnly?: boolean }, ts = Date.now()) {
    const { signature } = await this.signTyped('Order', [
      { name: 'timestamp', type: 'felt' }, { name: 'market', type: 'felt' }, { name: 'side', type: 'felt' }, { name: 'orderType', type: 'felt' }, { name: 'size', type: 'felt' }, { name: 'price', type: 'felt' }
    ], { timestamp: String(ts), market: o.market, side: o.side === 'BUY' ? '1' : '2', orderType: o.type, size: chainNumber(o.size), price: '0' });
    return {
      market: o.market, side: o.side, size: String(o.size), type: o.type, client_id: o.clientId, instruction: 'GTC', signature, signature_timestamp: ts,
      ...(o.trigger ? { trigger_price: String(o.trigger) } : {}), ...(o.reduceOnly ? { flags: ['REDUCE_ONLY'] } : {})
    };
  }

  async ping() { const r = await this.req('GET', '/account'); return { ok: !!r, detail: 'account readable' }; }
  async permissions(): Promise<PermissionReport> {
    let sub: any;
    try { sub = await this.req('GET', `/account/keys/subkeys/${this.subkeyPublic}`); }
    catch (e) { return { ok: false, canWithdraw: null, canTrade: false, verified: true, detail: `this key is not a registered subkey of ${this.account} (${(e as Error).message}). A main account key is refused; register a subkey and use that.` }; }
    if (!sub || (sub.public_key && BigInt(sub.public_key) !== BigInt(this.subkeyPublic))) return { ok: false, canWithdraw: null, canTrade: false, verified: true, detail: 'subkey lookup did not return this key. Refusing.' };
    if (Number(sub.revoked_at ?? 0) > 0 || /revoked/i.test(String(sub.state ?? ''))) return { ok: false, canWithdraw: false, canTrade: false, verified: true, detail: 'subkey is revoked' };
    return { ok: true, canWithdraw: false, canTrade: true, verified: true, detail: `registered subkey "${sub.name ?? sub.id ?? '?'}" (state ${sub.state ?? 'unknown'}); Paradex subkeys cannot withdraw or transfer${Array.isArray(sub.allowed_cidrs) && sub.allowed_cidrs.length ? '' : '; no IP allowlist (recommended)'}` };
  }
  async balance() { const r = await this.req('GET', '/account'); return { equityUsdt: Number(r?.account_value ?? 0), availableUsdt: Number(r?.free_collateral ?? 0) }; }
  async instrument(symbol: string) {
    const r = await this.pub(`/markets?market=${paradexMarket(symbol)}`);
    const m = r?.results?.[0];
    if (!m) throw new ExchangeError(`paradex: unknown market ${paradexMarket(symbol)}`);
    const mn = Number(m.min_notional);
    return { symbol, qtyStep: Number(m.order_size_increment), minQty: Number(m.order_size_increment), tickSize: Number(m.price_tick_size), minNotional: mn > 0 ? mn : null };
  }
  async ticker(symbol: string) { const r = await this.pub(`/markets/summary?market=${paradexMarket(symbol)}`); const px = Number(r?.results?.[0]?.mark_price ?? r?.results?.[0]?.last_traded_price); if (!px) throw new ExchangeError('paradex: no price'); return px; }
  async funding(symbol: string) { const r = await this.pub(`/markets/summary?market=${paradexMarket(symbol)}`); return Number(r?.results?.[0]?.funding_rate ?? NaN); }

  async placeOrder(o: PlaceOrder) {
    if (!(o.stop > 0)) throw new ExchangeError('refusing an order without a stop loss');
    const ins = await this.instrument(o.symbol);
    const qty = floorStep(o.qty, ins.qtyStep);
    if (qty < ins.minQty) throw new ExchangeError(`size ${qty} is under the minimum ${ins.minQty}`);
    const market = paradexMarket(o.symbol), side = o.side === 'LONG' ? 'BUY' : 'SELL', exit = o.side === 'LONG' ? 'SELL' : 'BUY';
    const r = await this.req('POST', '/orders', await this.orderBody({ market, side, type: 'MARKET', size: qty, clientId: o.clientId }));
    try {
      await this.req('POST', '/orders', await this.orderBody({ market, side: exit, type: 'STOP_MARKET', size: qty, clientId: `${o.clientId}s`, trigger: roundTick(o.stop, ins.tickSize), reduceOnly: true }));
    } catch (e) {
      await this.req('POST', '/orders', await this.orderBody({ market, side: exit, type: 'MARKET', size: qty, clientId: `${o.clientId}x`, reduceOnly: true })).catch(() => {});
      throw new ExchangeError(`stop could not be placed, entry closed: ${(e as Error).message}`);
    }
    if (o.tp) await this.req('POST', '/orders', await this.orderBody({ market, side: exit, type: 'TAKE_PROFIT_MARKET', size: qty, clientId: `${o.clientId}t`, trigger: roundTick(o.tp, ins.tickSize), reduceOnly: true })).catch(() => {});
    return { orderId: r?.id != null ? String(r.id) : null };
  }
  async getOrder(_symbol: string, clientId: string): Promise<OrderRecord> {
    try {
      const d = await this.req('GET', `/orders/by_client_id/${encodeURIComponent(clientId)}`);
      if (!d) return { clientId, orderId: '', status: 'unknown', filledQty: 0, avgPrice: null };
      const filled = Math.max(0, Number(d.size ?? 0) - Number(d.remaining_size ?? 0));
      const status: OrderRecord['status'] = d.status === 'CLOSED' ? (filled >= Number(d.size) && filled > 0 ? 'filled' : filled > 0 ? 'partial' : 'cancelled') : d.status === 'NEW' || d.status === 'OPEN' || d.status === 'UNTRIGGERED' ? (filled > 0 ? 'partial' : 'open') : 'unknown';
      return { clientId, orderId: String(d.id ?? ''), status, filledQty: filled, avgPrice: Number(d.avg_fill_price) || null, raw: `${d.status}${d.cancel_reason ? `:${d.cancel_reason}` : ''}` };
    } catch { return { clientId, orderId: '', status: 'unknown', filledQty: 0, avgPrice: null }; }
  }
  async positions(symbol?: string): Promise<VenuePosition[]> {
    const r = await this.req('GET', '/positions');
    return (r?.results ?? []).filter((p: any) => p.status !== 'CLOSED' && Number(p.size) !== 0).map((p: any) => ({
      symbol: fromParadexMarket(p.market), side: (p.side === 'SHORT' || Number(p.size) < 0 ? 'SHORT' : 'LONG') as Side, qty: Math.abs(Number(p.size)), entry: Number(p.average_entry_price),
      stop: null, tp: null, unrealizedPnl: Number(p.unrealized_pnl ?? 0)
    })).filter((p: VenuePosition) => !symbol || p.symbol === symbol);
  }
  async closePosition(symbol: string, side: Side, qty: number, clientId: string) {
    const r = await this.req('POST', '/orders', await this.orderBody({ market: paradexMarket(symbol), side: side === 'LONG' ? 'SELL' : 'BUY', type: 'MARKET', size: qty, clientId, reduceOnly: true }));
    return { orderId: r?.id != null ? String(r.id) : null };
  }
  async cancelAll(symbol: string) { await this.req('DELETE', `/orders?market=${paradexMarket(symbol)}`); }
  async protection(symbol: string, side: Side): Promise<Protection> {
    const r = await this.req('GET', `/orders?market=${paradexMarket(symbol)}`);
    return pickProtection(side, (r?.results ?? []).filter((o: any) => Number(o.trigger_price) > 0).map((o: any) => ({
      price: Number(o.trigger_price), kind: /^STOP/.test(o.type) ? 'stop' as const : /^TAKE_PROFIT/.test(o.type) ? 'tp' as const : 'unknown' as const, closes: (o.side === 'SELL' ? 'LONG' : 'SHORT') as Side
    })));
  }
  async protect(p: ProtectRequest) {
    const ins = await this.instrument(p.symbol);
    const market = paradexMarket(p.symbol), exit = p.side === 'LONG' ? 'SELL' : 'BUY';
    const qty = floorStep(p.qty, ins.qtyStep);
    if (p.stop) await this.req('POST', '/orders', await this.orderBody({ market, side: exit, type: 'STOP_MARKET', size: qty, clientId: `${p.clientId}s`, trigger: roundTick(p.stop, ins.tickSize), reduceOnly: true }));
    if (p.tp) await this.req('POST', '/orders', await this.orderBody({ market, side: exit, type: 'TAKE_PROFIT_MARKET', size: qty, clientId: `${p.clientId}t`, trigger: roundTick(p.tp, ins.tickSize), reduceOnly: true }));
  }
}
