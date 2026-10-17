// In-memory lookalikes of the perp DEX APIs used by the experimental adapters. No network.
// They model just enough state (one position, resting trigger orders, order records) to test
// order + stop, the fail-closed path and startup reconcile.
import type { DydxChain, DydxOrderParams, DydxAuthenticator } from '../server/exchange/dydx.js';

type Call = { method: string; path: string; query: URLSearchParams; headers: Record<string, string>; body: any };
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
function record(calls: Call[], url: string, init: RequestInit = {}) {
  const u = new URL(url);
  let body: any = null;
  try { body = init.body ? JSON.parse(String(init.body)) : null; } catch { body = String(init.body); }
  const c = { method: init.method ?? 'GET', path: u.pathname, query: u.searchParams, headers: (init.headers ?? {}) as Record<string, string>, body };
  calls.push(c);
  return c;
}
export interface FakeOpts { rejectStop?: boolean; canWithdraw?: boolean | null; dropStops?: boolean }

// ---------------- Aster (Binance-like v3) ----------------
export function fakeAster(opts: FakeOpts = {}) {
  const calls: Call[] = [];
  let pos: { amt: number; entry: number } | null = null;
  let open: any[] = [];
  const orders = new Map<string, any>();
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const c = record(calls, url, init), q = c.query;
    switch (`${c.method} ${c.path}`) {
      case 'GET /fapi/v3/account': return json({ canTrade: true, canWithdraw: opts.canWithdraw === undefined ? false : opts.canWithdraw, totalMarginBalance: '1000', availableBalance: '900' });
      case 'GET /fapi/v3/exchangeInfo': return json({ symbols: [{ symbol: 'BTCUSDT', filters: [{ filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' }, { filterType: 'PRICE_FILTER', tickSize: '0.1' }] }] });
      case 'GET /fapi/v3/ticker/price': return json({ symbol: 'BTCUSDT', price: '60000' });
      case 'POST /fapi/v3/leverage': return json({ leverage: Number(q.get('leverage')) });
      case 'POST /fapi/v3/order': {
        const type = q.get('type')!, side = q.get('side')!, cid = q.get('newClientOrderId')!;
        if (type === 'MARKET') {
          const qty = Number(q.get('quantity'));
          if (q.get('reduceOnly') === 'true') pos = null; else pos = { amt: side === 'BUY' ? qty : -qty, entry: 60010 };
          orders.set(cid, { orderId: orders.size + 1, status: 'FILLED', executedQty: String(qty), avgPrice: '60010' });
          return json({ orderId: orders.size, clientOrderId: cid });
        }
        if (type === 'STOP_MARKET' && opts.rejectStop) return json({ code: -2021, msg: 'Order would immediately trigger.' });
        if (!opts.dropStops) open.push({ type, side, stopPrice: q.get('stopPrice'), clientOrderId: cid, closePosition: q.get('closePosition') });
        return json({ orderId: 99, clientOrderId: cid });
      }
      case 'GET /fapi/v3/order': { const o = orders.get(q.get('origClientOrderId')!); return o ? json(o) : json({ code: -2013, msg: 'Order does not exist.' }); }
      case 'GET /fapi/v3/positionRisk': return json(pos ? [{ symbol: 'BTCUSDT', positionAmt: String(pos.amt), entryPrice: String(pos.entry), unRealizedProfit: '0' }] : []);
      case 'GET /fapi/v3/openOrders': return json(open);
      case 'DELETE /fapi/v3/allOpenOrders': open = []; return json({ code: 200, msg: 'ok' });
      default: return json({ code: -1, msg: `no route ${c.method} ${c.path}` }, 404);
    }
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, get open() { return open; }, clearStops() { open = []; }, setPosition(amt: number, entry = 60010) { pos = { amt, entry }; } };
}

// ---------------- Orderly ----------------
export function fakeOrderly(opts: FakeOpts & { keyRow?: Record<string, unknown> | null } = {}) {
  const calls: Call[] = [];
  let pos: { qty: number; entry: number } | null = null;
  let algos: any[] = [];
  const orders = new Map<string, any>();
  const ok = (data: unknown) => json({ success: true, data, timestamp: Date.now() });
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const c = record(calls, url, init);
    const route = `${c.method} ${c.path}`;
    if (route === 'GET /v1/client/key_info') return ok({ rows: opts.keyRow === null ? [] : [{ orderly_key: c.headers['orderly-key'], key_status: 'ACTIVE', scope: 'read,trading', expiration: Date.now() + 86_400_000, ip_restriction_status: 'ALLOW_ALL_IPS', ...(opts.keyRow ?? {}) }] });
    if (route === 'GET /v1/public/info/PERP_BTC_USDC') return ok({ symbol: 'PERP_BTC_USDC', base_tick: 0.0001, base_min: 0.0001, quote_tick: 0.1 });
    if (route === 'GET /v1/public/futures/PERP_BTC_USDC') return ok({ mark_price: 60000 });
    if (route === 'POST /v1/order') {
      const b = c.body;
      if (b.reduce_only) pos = null; else pos = { qty: b.side === 'BUY' ? b.order_quantity : -b.order_quantity, entry: 60010 };
      orders.set(b.client_order_id, { order_id: orders.size + 1, status: 'FILLED', total_executed_quantity: b.order_quantity, average_executed_price: 60010 });
      return ok({ order_id: orders.size, client_order_id: b.client_order_id });
    }
    if (route === 'POST /v1/algo/order') {
      if (opts.rejectStop) return json({ success: false, code: -1103, message: 'trigger price invalid' });
      if (!opts.dropStops) algos.push({ algo_type: 'POSITIONAL_TP_SL', child_orders: c.body.child_orders });
      return ok({ rows: [{ algo_order_id: 1 }] });
    }
    if (c.method === 'GET' && c.path.startsWith('/v1/client/order/')) { const o = orders.get(decodeURIComponent(c.path.split('/').pop()!)); return o ? ok(o) : json({ success: false, code: -1006, message: 'not found' }); }
    if (route === 'GET /v1/positions') return ok({ total_collateral_value: 1000, free_collateral: 900, rows: pos ? [{ symbol: 'PERP_BTC_USDC', position_qty: pos.qty, average_open_price: pos.entry, unsettled_pnl: 0 }] : [] });
    if (route === 'GET /v1/algo/orders') return ok({ rows: algos });
    if (route === 'DELETE /v1/orders') return ok({ status: 'CANCEL_ALL_SENT' });
    if (route === 'DELETE /v1/algo/orders') { algos = []; return ok({ status: 'CANCEL_ALL_SENT' }); }
    return json({ success: false, message: `no route ${route}` }, 404);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, get algos() { return algos; }, clearStops() { algos = []; }, setPosition(qty: number, entry = 60010) { pos = { qty, entry }; } };
}

// ---------------- Paradex ----------------
export function fakeParadex(opts: FakeOpts & { subkey?: Record<string, unknown> | null } = {}) {
  const calls: Call[] = [];
  let pos: { side: 'LONG' | 'SHORT'; size: number; entry: number } | null = null;
  let open: any[] = [];
  const orders = new Map<string, any>();
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const c = record(calls, url, init);
    const p = c.path.replace(/^\/v1/, ''), route = `${c.method} ${p}`;
    if (route === 'GET /system/config') return json({ starknet_chain_id: 'PRIVATE_SN_PARACLEAR_TESTNET' });
    if (c.method === 'POST' && p.startsWith('/auth/')) return c.headers['PARADEX-STARKNET-SIGNATURE'] ? json({ jwt_token: 'jwt-test' }) : json({ error: 'no sig' }, 401);
    if (c.method === 'GET' && p.startsWith('/account/keys/subkeys/')) {
      if (opts.subkey === null) return json({ error: 'NOT_FOUND', message: 'subkey not found' }, 404);
      return json({ public_key: p.split('/').pop(), name: 'bot', state: 'active', ...(opts.subkey ?? {}) });
    }
    if (route === 'GET /markets') return json({ results: [{ symbol: 'BTC-USD-PERP', order_size_increment: '0.001', price_tick_size: '0.1' }] });
    if (route === 'GET /markets/summary') return json({ results: [{ mark_price: '60000' }] });
    if (route === 'POST /orders') {
      const b = c.body;
      if (b.type === 'MARKET') {
        const size = Number(b.size);
        if (b.flags?.includes('REDUCE_ONLY')) pos = null; else pos = { side: b.side === 'BUY' ? 'LONG' : 'SHORT', size, entry: 60010 };
        orders.set(b.client_id, { id: `o${orders.size + 1}`, status: 'CLOSED', size: b.size, remaining_size: '0', avg_fill_price: '60010' });
        return json({ id: `o${orders.size}`, status: 'NEW' });
      }
      if (b.type === 'STOP_MARKET' && opts.rejectStop) return json({ error: 'INVALID_TRIGGER', message: 'bad trigger' }, 400);
      if (!opts.dropStops) open.push({ type: b.type, side: b.side, trigger_price: b.trigger_price, status: 'UNTRIGGERED' });
      return json({ id: 'trig', status: 'UNTRIGGERED' });
    }
    if (c.method === 'GET' && p.startsWith('/orders/by_client_id/')) { const o = orders.get(decodeURIComponent(p.split('/').pop()!)); return o ? json(o) : json({ error: 'NOT_FOUND' }, 404); }
    if (route === 'GET /orders') return json({ results: open });
    if (route === 'DELETE /orders') { open = []; return json({}); }
    if (route === 'GET /positions') return json({ results: pos ? [{ market: 'BTC-USD-PERP', side: pos.side, size: String(pos.side === 'SHORT' ? -pos.size : pos.size), average_entry_price: String(pos.entry), status: 'OPEN', unrealized_pnl: '0' }] : [] });
    if (route === 'GET /account') return json({ account_value: '1000', free_collateral: '900' });
    return json({ error: `no route ${route}` }, 404);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, get open() { return open; }, clearStops() { open = []; }, setPosition(side: 'LONG' | 'SHORT', size: number, entry = 60010) { pos = { side, size, entry }; } };
}

// ---------------- dYdX (indexer over fetch + chain seam) ----------------
export function fakeDydx(opts: FakeOpts & { authenticators?: DydxAuthenticator[] } = {}) {
  const calls: Call[] = [];
  const placed: DydxOrderParams[] = [];
  let pos: { side: 'LONG' | 'SHORT'; size: number; entry: number } | null = null;
  let orders: any[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const c = record(calls, url, init);
    const p = c.path.replace(/^\/v4/, '');
    if (p === '/perpetualMarkets') return json({ markets: { 'BTC-USD': { ticker: 'BTC-USD', oraclePrice: '60000', stepSize: '0.0001', tickSize: '1', nextFundingRate: '0.00001' } } });
    if (p === '/orders') { const st = c.query.get('status'); return json(orders.filter((o) => !st || o.status === st)); }
    if (p === '/fills') return json({ fills: orders.filter((o) => o.status === 'FILLED').map((o) => ({ orderId: o.id, size: o.size, price: '60010' })) });
    if (p === '/perpetualPositions') return json({ positions: pos ? [{ market: 'BTC-USD', side: pos.side, size: String(pos.side === 'SHORT' ? -pos.size : pos.size), entryPrice: String(pos.entry), unrealizedPnl: '0' }] : [] });
    if (p.startsWith('/addresses/')) return json({ subaccount: { equity: '1000', freeCollateral: '900' } });
    return json({ errors: [{ msg: `no route ${p}` }] }, 404);
  }) as unknown as typeof fetch;
  const chain: DydxChain = {
    async getAuthenticators() { return opts.authenticators ?? []; },
    async placeOrder(o) {
      placed.push(o);
      if (o.type === 'MARKET') {
        if (o.reduceOnly) pos = null; else pos = { side: o.side === 'BUY' ? 'LONG' : 'SHORT', size: o.size, entry: 60010 };
        orders.push({ id: `id${orders.length + 1}`, clientId: String(o.clientId), status: 'FILLED', totalFilled: String(o.size), size: String(o.size), type: 'MARKET', side: o.side });
        return { txHash: 'ab12' };
      }
      if (o.type === 'STOP_MARKET' && opts.rejectStop) throw new Error('broadcast failed: invalid trigger');
      if (!opts.dropStops) orders.push({ id: `id${orders.length + 1}`, clientId: String(o.clientId), status: 'UNTRIGGERED', type: o.type, side: o.side, triggerPrice: String(o.triggerPrice), orderFlags: '32', goodTilBlockTime: new Date(Date.now() + 86_400_000).toISOString() });
      return { txHash: 'cd34' };
    },
    async cancelOrder(c) { orders = orders.filter((o) => Number(o.clientId) !== c.clientId); }
  };
  return { fetchImpl, chain, calls, placed, clearStops() { orders = orders.filter((o) => o.status !== 'UNTRIGGERED'); }, setPosition(side: 'LONG' | 'SHORT', size: number, entry = 60010) { pos = { side, size, entry }; } };
}
