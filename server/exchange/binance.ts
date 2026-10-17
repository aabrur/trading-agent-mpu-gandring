import { createHmac } from 'node:crypto';
import { ExchangeError, httpJson, floorStep, roundTick, type ExchangeAdapter, type FetchLike, type Network, type PermissionReport, type PlaceOrder, type OrderRecord, type VenuePosition, type Side } from './types.js';

// EXPERIMENTAL, UNTESTED against a real account. Binance USD-M futures, one-way mode.
// The stop is a separate STOP_MARKET order. If it cannot be placed, the entry is closed at once.
export class BinanceAdapter implements ExchangeAdapter {
  readonly name = 'binance' as const;
  private base: string;
  constructor(public readonly network: Network, private key: string, private secret: string, private fetchImpl: FetchLike = fetch, testnetBase = process.env.BINANCE_TESTNET_BASE_URL) {
    if (!key || !secret) throw new ExchangeError('Binance key and secret are required');
    this.base = network === 'testnet' ? (testnetBase || 'https://testnet.binancefuture.com') : 'https://fapi.binance.com';
  }
  private async req(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, string | number | boolean | undefined> = {}, base = this.base) {
    const q = new URLSearchParams(Object.fromEntries(Object.entries({ ...params, recvWindow: 5000, timestamp: Date.now() }).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])));
    q.append('signature', createHmac('sha256', this.secret).update(q.toString()).digest('hex'));
    return httpJson(this.fetchImpl, `${base}${path}?${q}`, { method, headers: { 'X-MBX-APIKEY': this.key } });
  }
  async ping() { const r = await this.req('GET', '/fapi/v2/balance'); return { ok: Array.isArray(r), detail: 'futures balance readable' }; }
  async permissions(): Promise<PermissionReport> {
    if (this.network === 'testnet') return { ok: true, canWithdraw: null, canTrade: true, verified: false, detail: 'testnet keys cannot withdraw real funds; restriction API not available on testnet' };
    const r = await this.req('GET', '/sapi/v1/account/apiRestrictions', {}, 'https://api.binance.com');
    const canWithdraw = !!r?.enableWithdrawals;
    return { ok: !canWithdraw, canWithdraw, canTrade: !!r?.enableFutures, verified: true, detail: `${canWithdraw ? 'key HAS withdraw permission' : 'no withdraw permission'}; futures ${r?.enableFutures ? 'enabled' : 'disabled'}; ip restrict ${r?.ipRestrict ? 'on' : 'off (recommended on)'}` };
  }
  async balance() { const r = await this.req('GET', '/fapi/v2/account'); return { equityUsdt: Number(r.totalMarginBalance ?? 0), availableUsdt: Number(r.availableBalance ?? 0) }; }
  async instrument(symbol: string) {
    const r = await httpJson(this.fetchImpl, `${this.base}/fapi/v1/exchangeInfo`);
    const s = r?.symbols?.find((x: any) => x.symbol === symbol);
    if (!s) throw new ExchangeError(`binance: unknown symbol ${symbol}`);
    const lot = s.filters.find((f: any) => f.filterType === 'MARKET_LOT_SIZE') ?? s.filters.find((f: any) => f.filterType === 'LOT_SIZE');
    const px = s.filters.find((f: any) => f.filterType === 'PRICE_FILTER');
    return { symbol, qtyStep: Number(lot.stepSize), minQty: Number(lot.minQty), tickSize: Number(px.tickSize) };
  }
  async ticker(symbol: string) { const r = await httpJson(this.fetchImpl, `${this.base}/fapi/v1/ticker/price?symbol=${symbol}`); const px = Number(r?.price); if (!px) throw new ExchangeError('binance: no price'); return px; }
  async placeOrder(o: PlaceOrder) {
    if (!(o.stop > 0)) throw new ExchangeError('refusing an order without a stop loss');
    const ins = await this.instrument(o.symbol);
    const qty = floorStep(o.qty, ins.qtyStep);
    if (qty < ins.minQty) throw new ExchangeError(`size ${qty} is under the minimum ${ins.minQty}`);
    await this.req('POST', '/fapi/v1/leverage', { symbol: o.symbol, leverage: o.leverage });
    const side = o.side === 'LONG' ? 'BUY' : 'SELL', exit = o.side === 'LONG' ? 'SELL' : 'BUY';
    const r = await this.req('POST', '/fapi/v1/order', { symbol: o.symbol, side, type: 'MARKET', quantity: qty, newClientOrderId: o.clientId });
    try {
      await this.req('POST', '/fapi/v1/order', { symbol: o.symbol, side: exit, type: 'STOP_MARKET', stopPrice: roundTick(o.stop, ins.tickSize), closePosition: true, workingType: 'MARK_PRICE', newClientOrderId: `${o.clientId}s` });
    } catch (e) {
      await this.req('POST', '/fapi/v1/order', { symbol: o.symbol, side: exit, type: 'MARKET', quantity: qty, reduceOnly: true, newClientOrderId: `${o.clientId}x` }).catch(() => {});
      throw new ExchangeError(`stop could not be placed, entry closed: ${(e as Error).message}`);
    }
    if (o.tp) await this.req('POST', '/fapi/v1/order', { symbol: o.symbol, side: exit, type: 'TAKE_PROFIT_MARKET', stopPrice: roundTick(o.tp, ins.tickSize), closePosition: true, workingType: 'MARK_PRICE', newClientOrderId: `${o.clientId}t` }).catch(() => {});
    return { orderId: r?.orderId != null ? String(r.orderId) : null };
  }
  async getOrder(symbol: string, clientId: string): Promise<OrderRecord> {
    try {
      const r = await this.req('GET', '/fapi/v1/order', { symbol, origClientOrderId: clientId });
      const map: Record<string, OrderRecord['status']> = { FILLED: 'filled', PARTIALLY_FILLED: 'partial', NEW: 'open', REJECTED: 'rejected', CANCELED: 'cancelled', EXPIRED: 'cancelled' };
      return { clientId, orderId: String(r.orderId), status: map[r.status] ?? 'unknown', filledQty: Number(r.executedQty ?? 0), avgPrice: Number(r.avgPrice) || null, raw: r.status };
    } catch { return { clientId, orderId: '', status: 'unknown', filledQty: 0, avgPrice: null }; }
  }
  async positions(symbol?: string): Promise<VenuePosition[]> {
    const r = await this.req('GET', '/fapi/v2/positionRisk', { symbol });
    return (r ?? []).filter((p: any) => Number(p.positionAmt) !== 0).map((p: any) => ({ symbol: p.symbol, side: Number(p.positionAmt) > 0 ? 'LONG' : 'SHORT', qty: Math.abs(Number(p.positionAmt)), entry: Number(p.entryPrice), stop: null, tp: null, unrealizedPnl: Number(p.unRealizedProfit ?? 0) }));
  }
  async closePosition(symbol: string, side: Side, qty: number, clientId: string) {
    const r = await this.req('POST', '/fapi/v1/order', { symbol, side: side === 'LONG' ? 'SELL' : 'BUY', type: 'MARKET', quantity: qty, reduceOnly: true, newClientOrderId: clientId });
    return { orderId: r?.orderId != null ? String(r.orderId) : null };
  }
  async cancelAll(symbol: string) { await this.req('DELETE', '/fapi/v1/allOpenOrders', { symbol }); }
}
