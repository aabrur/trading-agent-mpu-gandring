// In-memory fakes for exchange tests. No network.
import type { ExchangeAdapter, OrderRecord, VenuePosition, PlaceOrder, Side, PermissionReport } from '../server/exchange/index.js';

/** A tiny Bybit v5 testnet lookalike behind a fetch function. */
export function fakeBybit(opts: { withdraw?: boolean; readOnly?: number; failCreate?: 'timeout' | 'error' | null; createStillFills?: boolean } = {}) {
  const calls: { method: string; path: string; headers: Record<string, string>; body: any }[] = [];
  let pos: { side: 'Buy' | 'Sell'; size: number; avgPrice: number; stopLoss: string } | null = null;
  const orders = new Map<string, any>();
  const ok = (result: unknown) => new Response(JSON.stringify({ retCode: 0, retMsg: 'OK', result }), { status: 200 });
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method: init.method ?? 'GET', path: u.pathname, headers: (init.headers ?? {}) as Record<string, string>, body });
    switch (u.pathname) {
      case '/v5/user/query-api': return ok({ readOnly: opts.readOnly ?? 0, permissions: { ContractTrade: ['Order', 'Position'], Wallet: opts.withdraw ? ['AccountTransfer', 'Withdraw'] : ['AccountTransfer'] }, ips: ['1.2.3.4'] });
      case '/v5/account/wallet-balance': return ok({ list: [{ totalEquity: '1000', totalAvailableBalance: '900' }] });
      case '/v5/market/instruments-info': return ok({ list: [{ lotSizeFilter: { qtyStep: '0.001', minOrderQty: '0.001' }, priceFilter: { tickSize: '0.1' } }] });
      case '/v5/market/tickers': return ok({ list: [{ lastPrice: '60000' }] });
      case '/v5/position/set-leverage': return new Response(JSON.stringify({ retCode: 110043, retMsg: 'leverage not modified' }), { status: 200 });
      case '/v5/order/create': {
        const fill = () => {
          const qty = Number(body.qty);
          if (body.reduceOnly) { pos = null; } else pos = { side: body.side, size: qty, avgPrice: 60010, stopLoss: body.stopLoss };
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
      case '/v5/position/list': return ok({ list: pos ? [{ symbol: 'BTCUSDT', side: pos.side, size: String(pos.size), avgPrice: String(pos.avgPrice), stopLoss: pos.stopLoss, takeProfit: '', unrealisedPnl: '0' }] : [] });
      case '/v5/order/cancel-all': return ok({ list: [] });
      default: return new Response('not found', { status: 404 });
    }
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, count: (p: string) => calls.filter((c) => c.path === p).length };
}

/** Plain in-memory adapter for desk-level tests. */
export class MemoryAdapter implements ExchangeAdapter {
  readonly name = 'bybit' as const;
  readonly network = 'mainnet' as const;
  placed: PlaceOrder[] = [];
  closes = 0;
  pos: VenuePosition[] = [];
  private rec = new Map<string, OrderRecord>();
  constructor(public perm: PermissionReport = { ok: true, canWithdraw: false, canTrade: true, verified: true, detail: 'no withdraw' }, public failPlace = false) {}
  async ping() { return { ok: true, detail: 'ok' }; }
  async permissions() { return this.perm; }
  async balance() { return { equityUsdt: 1000, availableUsdt: 1000 }; }
  async instrument(symbol: string) { return { symbol, qtyStep: 0.001, minQty: 0.001, tickSize: 0.1 }; }
  async ticker() { return 60000; }
  async placeOrder(o: PlaceOrder) {
    this.placed.push(o);
    if (this.failPlace) throw new Error('socket hang up');
    this.rec.set(o.clientId, { clientId: o.clientId, orderId: 'x1', status: 'filled', filledQty: o.qty, avgPrice: 60005 });
    this.pos.push({ symbol: o.symbol, side: o.side, qty: o.qty, entry: 60005, stop: o.stop, tp: o.tp, unrealizedPnl: 0 });
    return { orderId: 'x1' };
  }
  async getOrder(_s: string, clientId: string) { return this.rec.get(clientId) ?? { clientId, orderId: '', status: 'unknown' as const, filledQty: 0, avgPrice: null }; }
  async positions(symbol?: string) { return this.pos.filter((p) => !symbol || p.symbol === symbol); }
  async closePosition(symbol: string, side: Side, qty: number, clientId: string) {
    this.closes++;
    this.pos = this.pos.filter((p) => p.symbol !== symbol);
    this.rec.set(clientId, { clientId, orderId: 'c1', status: 'filled', filledQty: qty, avgPrice: 60100 });
    return { orderId: 'c1' };
  }
  async cancelAll() {}
}
