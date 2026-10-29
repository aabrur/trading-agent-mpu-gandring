// In-memory fakes for exchange tests. No network.
import { sampleSnapshot } from '../server/market/sample.js';
import type { ExchangeAdapter, OrderRecord, VenuePosition, PlaceOrder, Side, PermissionReport, ProtectRequest } from '../server/exchange/index.js';

/** A tiny Bybit v5 testnet lookalike behind a fetch function. */
export function fakeBybit(opts: { withdraw?: boolean; readOnly?: number; failCreate?: 'timeout' | 'error' | null; createStillFills?: boolean; ignoreStop?: boolean; failTradingStop?: boolean } = {}) {
  const calls: { method: string; path: string; headers: Record<string, string>; body: any }[] = [];
  let pos: { side: 'Buy' | 'Sell'; size: number; avgPrice: number; stopLoss: string; takeProfit: string } | null = null;
  const orders = new Map<string, any>();
  const ok = (result: unknown) => new Response(JSON.stringify({ retCode: 0, retMsg: 'OK', result }), { status: 200 });
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method: init.method ?? 'GET', path: u.pathname, headers: (init.headers ?? {}) as Record<string, string>, body });
    switch (u.pathname) {
      case '/v5/market/time': {
        const ms = Date.now();
        return new Response(JSON.stringify({ retCode: 0, retMsg: 'OK', result: { timeSecond: String(Math.floor(ms / 1000)), timeNano: `${ms}000000` }, time: ms }), { status: 200 });
      }
      case '/v5/user/query-api': return ok({ readOnly: opts.readOnly ?? 0, permissions: { ContractTrade: ['Order', 'Position'], Wallet: opts.withdraw ? ['AccountTransfer', 'Withdraw'] : ['AccountTransfer'] }, ips: ['1.2.3.4'] });
      case '/v5/account/wallet-balance': return ok({ list: [{ totalEquity: '1000', totalAvailableBalance: '900' }] });
      case '/v5/market/instruments-info': return ok({ list: [{ lotSizeFilter: { qtyStep: '0.001', minOrderQty: '0.001' }, priceFilter: { tickSize: '0.1' } }] });
      case '/v5/market/tickers': return ok({ list: [{ lastPrice: '60000' }] });
      case '/v5/position/set-leverage': return new Response(JSON.stringify({ retCode: 110043, retMsg: 'leverage not modified' }), { status: 200 });
      case '/v5/order/create': {
        const fill = () => {
          const qty = Number(body.qty);
          if (body.reduceOnly) { pos = null; } else pos = { side: body.side, size: qty, avgPrice: 60010, stopLoss: opts.ignoreStop ? '' : body.stopLoss, takeProfit: opts.ignoreStop ? '' : (body.takeProfit ?? '') };
          orders.set(body.orderLinkId, { orderId: `id-${orders.size + 1}`, orderStatus: 'Filled', cumExecQty: body.qty, avgPrice: '60010' });
        };
        if (opts.failCreate && !body.reduceOnly) {
          if (opts.createStillFills) fill();
          if (opts.failCreate === 'timeout') { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
          return new Response(JSON.stringify({ retCode: 10001, retMsg: 'params error' }), { status: 200 });
        }
        fill();
        return ok({ orderId: orders.get(body.orderLinkId).orderId, orderLinkId: body.orderLinkId });
      }
      case '/v5/order/realtime': { const o = orders.get(u.searchParams.get('orderLinkId')!); return ok({ list: o ? [o] : [] }); }
      case '/v5/order/history': return ok({ list: [] });
      case '/v5/position/list': return ok({ list: pos ? [{ symbol: 'BTCUSDT', side: pos.side, size: String(pos.size), avgPrice: String(pos.avgPrice), stopLoss: pos.stopLoss, takeProfit: pos.takeProfit, unrealisedPnl: '0' }] : [] });
      case '/v5/order/cancel-all': return ok({ list: [] });
      case '/v5/position/trading-stop': {
        if (opts.failTradingStop) return new Response(JSON.stringify({ retCode: 10001, retMsg: 'cannot set stop' }), { status: 200 });
        if (pos) { if (body.stopLoss) pos.stopLoss = body.stopLoss; if (body.takeProfit) pos.takeProfit = body.takeProfit; }
        return ok({});
      }
      default: return new Response('not found', { status: 404 });
    }
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, count: (p: string) => calls.filter((c) => c.path === p).length };
}

/** Plain in-memory adapter for desk-level tests. */
export class MemoryAdapter implements ExchangeAdapter {
  readonly name = 'bybit' as const;
  readonly network = 'mainnet' as const;
  exchangeStops = true;
  /** simulate a venue that drops the attached stop (or refuses protect calls) */
  dropStops = false;
  failProtect = false;
  protects: ProtectRequest[] = [];
  placed: PlaceOrder[] = [];
  /** fill price for an entry; defaults to 60005 (a BTC-like price) */
  fillAt: (o: PlaceOrder) => number = () => 60005;
  /** fill price for a close; defaults to 60100 */
  closeAt: (symbol: string) => number = () => 60100;
  closes = 0;
  pos: VenuePosition[] = [];
  private rec = new Map<string, OrderRecord>();
  constructor(public perm: PermissionReport = { ok: true, canWithdraw: false, canTrade: true, verified: true, detail: 'no withdraw' }, public failPlace = false) {}
  async ping() { return { ok: true, detail: 'ok' }; }
  async permissions() { return this.perm; }
  async balance() { return { equityUsdt: 1000, availableUsdt: 1000 }; }
  async instrument(symbol: string) { return { symbol, qtyStep: 0.001, minQty: 0.001, tickSize: 0.1 }; }
  async ticker(symbol = 'BTCUSDT') { return symbol === 'BTCUSDT' ? 60000 : sampleSnapshot(symbol).last; }
  async placeOrder(o: PlaceOrder) {
    this.placed.push(o);
    if (this.failPlace) throw new Error('socket hang up');
    this.rec.set(o.clientId, { clientId: o.clientId, orderId: 'x1', status: 'filled', filledQty: o.qty, avgPrice: this.fillAt(o) });
    this.pos.push({ symbol: o.symbol, side: o.side, qty: o.qty, entry: this.fillAt(o), stop: this.dropStops ? null : o.stop, tp: this.dropStops ? null : o.tp, unrealizedPnl: 0 });
    return { orderId: 'x1' };
  }
  async getOrder(_s: string, clientId: string) { return this.rec.get(clientId) ?? { clientId, orderId: '', status: 'unknown' as const, filledQty: 0, avgPrice: null }; }
  async positions(symbol?: string) { return this.pos.filter((p) => !symbol || p.symbol === symbol); }
  async closePosition(symbol: string, side: Side, qty: number, clientId: string) {
    this.closes++;
    const px = this.closeAt(symbol);
    this.pos = this.pos.filter((p) => p.symbol !== symbol);
    this.rec.set(clientId, { clientId, orderId: 'c1', status: 'filled', filledQty: qty, avgPrice: px });
    return { orderId: 'c1' };
  }
  async cancelAll() {}
  async protection(symbol: string, side: Side, requiredQty?: number) {
    const p = this.pos.find((x) => x.symbol === symbol && x.side === side);
    return { stop: p?.stop ?? null, tp: p?.tp ?? null, ...(requiredQty == null ? {} : { stopCoverage: 'quantity' as const, stopQty: p?.qty ?? null }) };
  }
  async protect(r: ProtectRequest) {
    this.protects.push(r);
    if (this.failProtect) throw new Error('venue refused the stop');
    const p = this.pos.find((x) => x.symbol === r.symbol && x.side === r.side);
    if (p) { if (r.stop) p.stop = r.stop; if (r.tp) p.tp = r.tp; }
  }
}
