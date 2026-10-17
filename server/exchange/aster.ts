import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { ExchangeError, httpJson, floorStep, roundTick, pickProtection, type ExchangeAdapter, type FetchLike, type Network, type PermissionReport, type PlaceOrder, type OrderRecord, type VenuePosition, type Side, type Protection, type ProtectRequest } from './types.js';

// EXPERIMENTAL, UNTESTED against a real account. Aster perpetual futures, API v3, one-way mode.
// Docs: https://github.com/asterdex/api-docs (V3 Futures), https://asterdex.github.io/aster-api-website/asterCode/authentication/
// Auth: the main wallet ADDRESS (public, "user") plus a Pro API agent wallet ("signer") private key.
// Every signed request sends user, signer, nonce (microseconds) and an EIP-712 signature over the exact
// query string (domain AsterSignTransaction, version 1, chainId 1666 mainnet / 714 testnet, primaryType Message{msg}).
// The main wallet key is refused. Stops are STOP_MARKET closePosition orders resting on Aster.

export const ASTER_CHAIN_ID: Record<Network, number> = { mainnet: 1666, testnet: 714 };
const BASE: Record<Network, string> = { mainnet: 'https://fapi.asterdex.com', testnet: 'https://fapi.asterdex-testnet.com' };
const ZERO = '0x0000000000000000000000000000000000000000';

let lastNonce = 0;
/** Microsecond nonce, strictly increasing inside this process (Aster keeps the last 100 per agent). */
export function asterNonce(now = Date.now()) { lastNonce = Math.max(lastNonce + 1, now * 1000); return lastNonce; }

export class AsterAdapter implements ExchangeAdapter {
  readonly name = 'aster' as const;
  readonly exchangeStops = true;
  private base: string;
  private account: ReturnType<typeof privateKeyToAccount>;
  constructor(public readonly network: Network, private user: string, signerPrivateKey: string, private fetchImpl: FetchLike = fetch, base = process.env[network === 'testnet' ? 'ASTER_TESTNET_BASE_URL' : 'ASTER_BASE_URL']) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(user)) throw new ExchangeError('ASTER user address must be the 0x main wallet address (public)');
    if (!/^0x[0-9a-fA-F]{64}$/.test(signerPrivateKey)) throw new ExchangeError('Aster signer key must be the 0x private key of a Pro API agent wallet');
    this.account = privateKeyToAccount(signerPrivateKey as Hex);
    this.base = base || BASE[network];
  }
  get signerAddress() { return this.account.address; }

  /** Builds the exact query string Aster verifies and signs it. Exposed for tests. */
  async signedQuery(params: Record<string, string | number | boolean | undefined>, nonce = asterNonce()) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) q.append(k, String(v));
    q.append('nonce', String(nonce)); q.append('user', this.user); q.append('signer', this.account.address);
    const msg = q.toString();
    const signature = await this.account.signTypedData({
      domain: { name: 'AsterSignTransaction', version: '1', chainId: ASTER_CHAIN_ID[this.network], verifyingContract: ZERO },
      types: { Message: [{ name: 'msg', type: 'string' }] }, primaryType: 'Message', message: { msg }
    });
    return { msg, signature, query: `${msg}&signature=${signature}` };
  }
  private async req(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, string | number | boolean | undefined> = {}) {
    const { query } = await this.signedQuery(params);
    const r = await httpJson(this.fetchImpl, `${this.base}${path}?${query}`, { method, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    if (r && typeof r === 'object' && !Array.isArray(r) && typeof r.code === 'number' && r.code < 0) throw new ExchangeError(`aster ${path}: ${r.msg ?? 'error'} (${r.code})`, r.code);
    return r;
  }
  private pub(path: string) { return httpJson(this.fetchImpl, `${this.base}${path}`); }

  async ping() { const r = await this.req('GET', '/fapi/v3/balance'); return { ok: Array.isArray(r), detail: 'futures balance readable' }; }
  async permissions(): Promise<PermissionReport> {
    if (this.account.address.toLowerCase() === this.user.toLowerCase()) {
      return { ok: false, canWithdraw: true, canTrade: true, verified: true, detail: 'this is the MAIN wallet key, not a Pro API agent wallet. Refusing. Create an API wallet (asterdex.com/en/api-wallet, Pro API) with withdraw off and use that key.' };
    }
    // Aster documents no per-agent permission query. The only exchange answer is the account flag read with the agent signature.
    // We accept only an explicit canWithdraw false. Anything else is refused (fail closed).
    const r = await this.req('GET', '/fapi/v3/account');
    const canWithdraw = r?.canWithdraw === false ? false : r?.canWithdraw === true ? true : null;
    const canTrade = r?.canTrade !== false;
    const detail = `agent ${this.account.address} for ${this.user}; account reports canTrade ${String(r?.canTrade)}, canWithdraw ${String(r?.canWithdraw)}`;
    return { ok: canWithdraw === false, canWithdraw, canTrade, verified: canWithdraw === false, detail: canWithdraw === false ? detail : `${detail}. Refusing unless Aster reports canWithdraw false for this signer.` };
  }
  async balance() { const r = await this.req('GET', '/fapi/v3/account'); return { equityUsdt: Number(r?.totalMarginBalance ?? 0), availableUsdt: Number(r?.availableBalance ?? 0) }; }
  async instrument(symbol: string) {
    const r = await this.pub('/fapi/v3/exchangeInfo');
    const s = r?.symbols?.find((x: any) => x.symbol === symbol);
    if (!s) throw new ExchangeError(`aster: unknown symbol ${symbol}`);
    const lot = s.filters.find((f: any) => f.filterType === 'MARKET_LOT_SIZE') ?? s.filters.find((f: any) => f.filterType === 'LOT_SIZE');
    const px = s.filters.find((f: any) => f.filterType === 'PRICE_FILTER');
    return { symbol, qtyStep: Number(lot.stepSize), minQty: Number(lot.minQty), tickSize: Number(px.tickSize) };
  }
  async ticker(symbol: string) { const r = await this.pub(`/fapi/v3/ticker/price?symbol=${symbol}`); const px = Number(r?.price); if (!px) throw new ExchangeError('aster: no price'); return px; }
  async funding(symbol: string) { const r = await this.pub(`/fapi/v3/premiumIndex?symbol=${symbol}`); return Number(r?.lastFundingRate ?? NaN); }

  async placeOrder(o: PlaceOrder) {
    if (!(o.stop > 0)) throw new ExchangeError('refusing an order without a stop loss');
    const ins = await this.instrument(o.symbol);
    const qty = floorStep(o.qty, ins.qtyStep);
    if (qty < ins.minQty) throw new ExchangeError(`size ${qty} is under the minimum ${ins.minQty}`);
    await this.req('POST', '/fapi/v3/leverage', { symbol: o.symbol, leverage: Math.round(o.leverage) });
    const side = o.side === 'LONG' ? 'BUY' : 'SELL', exit = o.side === 'LONG' ? 'SELL' : 'BUY';
    const r = await this.req('POST', '/fapi/v3/order', { symbol: o.symbol, side, type: 'MARKET', quantity: qty, newClientOrderId: o.clientId });
    try {
      await this.req('POST', '/fapi/v3/order', { symbol: o.symbol, side: exit, type: 'STOP_MARKET', stopPrice: roundTick(o.stop, ins.tickSize), closePosition: 'true', workingType: 'MARK_PRICE', newClientOrderId: `${o.clientId}s` });
    } catch (e) {
      await this.req('POST', '/fapi/v3/order', { symbol: o.symbol, side: exit, type: 'MARKET', quantity: qty, reduceOnly: 'true', newClientOrderId: `${o.clientId}x` }).catch(() => {});
      throw new ExchangeError(`stop could not be placed, entry closed: ${(e as Error).message}`);
    }
    if (o.tp) await this.req('POST', '/fapi/v3/order', { symbol: o.symbol, side: exit, type: 'TAKE_PROFIT_MARKET', stopPrice: roundTick(o.tp, ins.tickSize), closePosition: 'true', workingType: 'MARK_PRICE', newClientOrderId: `${o.clientId}t` }).catch(() => {});
    return { orderId: r?.orderId != null ? String(r.orderId) : null };
  }
  async getOrder(symbol: string, clientId: string): Promise<OrderRecord> {
    try {
      const r = await this.req('GET', '/fapi/v3/order', { symbol, origClientOrderId: clientId });
      const map: Record<string, OrderRecord['status']> = { FILLED: 'filled', PARTIALLY_FILLED: 'partial', NEW: 'open', REJECTED: 'rejected', CANCELED: 'cancelled', EXPIRED: 'cancelled' };
      return { clientId, orderId: String(r.orderId), status: map[r.status] ?? 'unknown', filledQty: Number(r.executedQty ?? 0), avgPrice: Number(r.avgPrice) || null, raw: r.status };
    } catch { return { clientId, orderId: '', status: 'unknown', filledQty: 0, avgPrice: null }; }
  }
  async positions(symbol?: string): Promise<VenuePosition[]> {
    const r = await this.req('GET', '/fapi/v3/positionRisk', { symbol });
    return (r ?? []).filter((p: any) => Number(p.positionAmt) !== 0).map((p: any) => ({ symbol: p.symbol, side: Number(p.positionAmt) > 0 ? 'LONG' : 'SHORT', qty: Math.abs(Number(p.positionAmt)), entry: Number(p.entryPrice), stop: null, tp: null, unrealizedPnl: Number(p.unRealizedProfit ?? 0) }));
  }
  async closePosition(symbol: string, side: Side, qty: number, clientId: string) {
    const r = await this.req('POST', '/fapi/v3/order', { symbol, side: side === 'LONG' ? 'SELL' : 'BUY', type: 'MARKET', quantity: qty, reduceOnly: 'true', newClientOrderId: clientId });
    return { orderId: r?.orderId != null ? String(r.orderId) : null };
  }
  async cancelAll(symbol: string) { await this.req('DELETE', '/fapi/v3/allOpenOrders', { symbol }); }
  async protection(symbol: string, side: Side): Promise<Protection> {
    const open: any[] = await this.req('GET', '/fapi/v3/openOrders', { symbol });
    return pickProtection(side, (open ?? []).map((o) => ({
      price: Number(o.stopPrice), kind: /^STOP/.test(o.type) ? 'stop' as const : /^TAKE_PROFIT/.test(o.type) ? 'tp' as const : 'unknown' as const,
      closes: (o.side === 'SELL' ? 'LONG' : 'SHORT') as Side
    })).filter((t) => t.kind !== 'unknown'));
  }
  async protect(p: ProtectRequest) {
    const ins = await this.instrument(p.symbol);
    const exit = p.side === 'LONG' ? 'SELL' : 'BUY';
    if (p.stop) await this.req('POST', '/fapi/v3/order', { symbol: p.symbol, side: exit, type: 'STOP_MARKET', stopPrice: roundTick(p.stop, ins.tickSize), closePosition: 'true', workingType: 'MARK_PRICE', newClientOrderId: `${p.clientId}s` });
    if (p.tp) await this.req('POST', '/fapi/v3/order', { symbol: p.symbol, side: exit, type: 'TAKE_PROFIT_MARKET', stopPrice: roundTick(p.tp, ins.tickSize), closePosition: 'true', workingType: 'MARK_PRICE', newClientOrderId: `${p.clientId}t` });
  }
}
