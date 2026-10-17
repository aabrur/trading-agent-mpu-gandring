// Exchange-side protection: every TESTNET/LIVE position must have its stop resting ON THE EXCHANGE.
import { describe, it, expect } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { LiveExecutor } from '../server/live/executor.js';
import { BybitAdapter } from '../server/exchange/bybit.js';
import { BinanceAdapter } from '../server/exchange/binance.js';
import { OkxAdapter } from '../server/exchange/okx.js';
import { HyperliquidAdapter } from '../server/exchange/hyperliquid.js';
import { pickProtection } from '../server/exchange/types.js';
import { fakeBybit, MemoryAdapter } from './fakes.js';

const order = { symbol: 'BTCUSDT', side: 'LONG' as const, qty: 0.01, stop: 58800, tp: 63000, leverage: 3 };
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });

describe('executor enforces exchange-side stops', () => {
  it('refuses to open on an adapter that cannot place an exchange-side stop', async () => {
    const a = new MemoryAdapter(); a.exchangeStops = false;
    const f = await new LiveExecutor(a, 0).open(order);
    expect(f.ok).toBe(false);
    expect(f.note).toMatch(/cannot place an exchange-side stop/);
    expect(a.placed.length).toBe(0);
  });
  it('re-places a stop the venue did not keep, once', async () => {
    const a = new MemoryAdapter(); a.dropStops = true;
    const f = await new LiveExecutor(a, 0).open(order);
    expect(f.ok).toBe(true);
    expect(a.protects).toHaveLength(1);
    expect(a.protects[0]).toMatchObject({ stop: 58800, tp: 63000 });
    expect(await a.protection('BTCUSDT', 'LONG')).toEqual({ stop: 58800, tp: 63000 });
  });
  it('closes the position (fail closed) when no exchange-side stop can be confirmed', async () => {
    const a = new MemoryAdapter(); a.dropStops = true; a.failProtect = true;
    const f = await new LiveExecutor(a, 0).open(order);
    expect(f.ok).toBe(false);
    expect(f.note).toMatch(/FAIL CLOSED/);
    expect(a.closes).toBe(1);
    expect(a.pos).toEqual([]);
  });
  it('a failed protection READ is not treated as missing (no stacking, no panic close)', async () => {
    const a = new MemoryAdapter();
    a.protection = async () => { throw new Error('timeout'); };
    const f = await new LiveExecutor(a, 0).open(order);
    expect(f.ok).toBe(true);
    expect(f.note).toMatch(/could not read/);
    expect(a.protects).toHaveLength(0);
    expect(a.closes).toBe(0);
  });
  it('startup reconcile places a fallback stop from the worse of entry and mark, keeps known stops', async () => {
    const a = new MemoryAdapter();
    a.pos = [{ symbol: 'BTCUSDT', side: 'LONG', qty: 0.01, entry: 61000, stop: null, tp: null, unrealizedPnl: 0 }, { symbol: 'ETHUSDT', side: 'SHORT', qty: 1, entry: 3000, stop: null, tp: null, unrealizedPnl: 0 }];
    a.ticker = async (s?: string) => (s === 'ETHUSDT' ? 3100 : 60000);
    const notes = await new LiveExecutor(a, 0).ensureProtection({ ETHUSDT: { stop: 3150, tp: 2800 } }, 3);
    expect(a.protects[0]).toMatchObject({ symbol: 'BTCUSDT', stop: 58200 }); // 3% under min(61000, 60000)
    expect(a.protects[1]).toMatchObject({ symbol: 'ETHUSDT', stop: 3150, tp: 2800 });
    expect(notes.every((n) => /protected on the exchange/.test(n))).toBe(true);
  });
  it('startup reconcile closes a position whose stop cannot be placed', async () => {
    const a = new MemoryAdapter(); a.failProtect = true;
    a.pos = [{ symbol: 'BTCUSDT', side: 'LONG', qty: 0.01, entry: 60000, stop: null, tp: null, unrealizedPnl: 0 }];
    const notes = await new LiveExecutor(a, 0).ensureProtection({}, 3);
    expect(notes[0]).toMatch(/FAIL CLOSED/);
    expect(a.pos).toEqual([]);
  });
  it('pickProtection picks the stop on the losing side and ignores the other position side', () => {
    expect(pickProtection('LONG', [{ price: 58000, kind: 'stop', closes: 'LONG' }, { price: 64000, kind: 'tp', closes: 'LONG' }, { price: 70000, kind: 'stop', closes: 'SHORT' }], 60000)).toEqual({ stop: 58000, tp: 64000 });
  });
});

describe('Bybit: attached position stop (trading-stop)', () => {
  it('opens with the stop attached on Bybit', async () => {
    const f = fakeBybit();
    const fill = await new LiveExecutor(new BybitAdapter('testnet', 'k0000000000000001', 's00000000000000000000001', f.fetchImpl), 0).open(order);
    expect(fill.ok).toBe(true);
    expect(f.count('/v5/position/trading-stop')).toBe(0); // already attached on the order
  });
  it('re-attaches a dropped stop through /v5/position/trading-stop', async () => {
    const f = fakeBybit({ ignoreStop: true });
    const fill = await new LiveExecutor(new BybitAdapter('testnet', 'k0000000000000001', 's00000000000000000000001', f.fetchImpl), 0).open(order);
    expect(fill.ok).toBe(true);
    const c = f.calls.find((x) => x.path === '/v5/position/trading-stop')!;
    expect(c.body).toMatchObject({ category: 'linear', symbol: 'BTCUSDT', tpslMode: 'Full', stopLoss: '58800', takeProfit: '63000' });
  });
  it('closes when Bybit refuses the stop', async () => {
    const f = fakeBybit({ ignoreStop: true, failTradingStop: true });
    const fill = await new LiveExecutor(new BybitAdapter('testnet', 'k0000000000000001', 's00000000000000000000001', f.fetchImpl), 0).open(order);
    expect(fill.ok).toBe(false);
    expect(f.calls.filter((c) => c.path === '/v5/order/create' && c.body.reduceOnly).length).toBe(1);
  });
});

describe('Binance: closePosition STOP_MARKET orders', () => {
  it('reads and places exchange-side stops', async () => {
    const open: any[] = [];
    const posted: URLSearchParams[] = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      const u = new URL(url);
      if (u.pathname === '/fapi/v1/exchangeInfo') return json({ symbols: [{ symbol: 'BTCUSDT', filters: [{ filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' }, { filterType: 'PRICE_FILTER', tickSize: '0.1' }] }] });
      if (u.pathname === '/fapi/v1/openOrders') return json(open);
      if (u.pathname === '/fapi/v1/order' && init.method === 'POST') { posted.push(u.searchParams); open.push({ type: u.searchParams.get('type'), side: u.searchParams.get('side'), stopPrice: u.searchParams.get('stopPrice') }); return json({ orderId: 1 }); }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const b = new BinanceAdapter('testnet', 'k', 's', fetchImpl);
    expect(await b.protection('BTCUSDT', 'SHORT')).toEqual({ stop: null, tp: null });
    await b.protect({ symbol: 'BTCUSDT', side: 'SHORT', qty: 0.01, stop: 61800, tp: null, clientId: 'mgp1' });
    expect(posted[0].get('type')).toBe('STOP_MARKET');
    expect(posted[0].get('side')).toBe('BUY');
    expect(posted[0].get('closePosition')).toBe('true');
    expect(await b.protection('BTCUSDT', 'SHORT')).toEqual({ stop: 61800, tp: null });
  });
});

describe('OKX: conditional algo orders (closeFraction 1, reduce only)', () => {
  it('reads and places exchange-side stops', async () => {
    const algos: any[] = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      const u = new URL(url);
      if (u.pathname === '/api/v5/public/instruments') return json({ code: '0', data: [{ ctVal: '0.01', lotSz: '1', minSz: '1', tickSz: '0.1' }] });
      if (u.pathname === '/api/v5/trade/orders-algo-pending') return json({ code: '0', data: u.searchParams.get('ordType') === 'conditional' ? algos : [] });
      if (u.pathname === '/api/v5/trade/order-algo') { algos.push(JSON.parse(String(init.body))); return json({ code: '0', data: [{ algoId: '1', sCode: '0' }] }); }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const o = new OkxAdapter('testnet', 'k', 's', 'p', fetchImpl);
    expect((await o.protection('BTCUSDT', 'LONG')).stop).toBeNull();
    await o.protect({ symbol: 'BTCUSDT', side: 'LONG', qty: 0.01, stop: 58800, tp: 63000, clientId: 'mgp1' });
    expect(algos[0]).toMatchObject({ instId: 'BTC-USDT-SWAP', side: 'sell', ordType: 'conditional', closeFraction: '1', reduceOnly: true, slTriggerPx: '58800' });
    expect(await o.protection('BTCUSDT', 'LONG')).toEqual({ stop: 58800, tp: 63000 });
  });
});

describe('Hyperliquid: reduce-only trigger orders', () => {
  it('reads and places exchange-side stops', async () => {
    const actions: any[] = [];
    const resting: any[] = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body));
      if (url.endsWith('/info')) {
        if (body.type === 'meta') return json({ universe: [{ name: 'BTC', szDecimals: 5 }] });
        if (body.type === 'frontendOpenOrders') return json(resting);
      }
      if (url.endsWith('/exchange')) {
        actions.push(body.action);
        for (const o of body.action.orders) resting.push({ coin: 'BTC', isTrigger: true, orderType: o.t.trigger.tpsl === 'sl' ? 'Stop Market' : 'Take Profit Market', triggerPx: o.t.trigger.triggerPx, side: o.b ? 'B' : 'A' });
        return json({ status: 'ok', response: { type: 'order', data: { statuses: body.action.orders.map(() => 'waitingForTrigger') } } });
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const user = privateKeyToAccount(generatePrivateKey()).address;
    const h = new HyperliquidAdapter('testnet', user, generatePrivateKey(), fetchImpl);
    await h.protect({ symbol: 'BTCUSDT', side: 'LONG', qty: 0.01, stop: 58800, tp: null, clientId: 'mgp1' });
    expect(actions[0].orders[0]).toMatchObject({ a: 0, b: false, r: true, t: { trigger: { isMarket: true, tpsl: 'sl', triggerPx: '58800' } } });
    expect(await h.protection('BTCUSDT', 'LONG')).toEqual({ stop: 58800, tp: null });
  });
});
