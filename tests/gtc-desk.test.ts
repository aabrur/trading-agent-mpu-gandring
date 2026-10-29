import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { LiveExecutor } from '../server/live/executor.js';
import { sampleSnapshot } from '../server/market/sample.js';
import type { ExchangeAdapter, OrderRecord, PlaceOrder, Protection, VenuePosition } from '../server/exchange/types.js';

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) { app.desk.stop(); await new Promise<void>(resolve => app.server.close(() => resolve())); }
  vi.restoreAllMocks();
});

async function fixture() {
  const records = new Map<string, OrderRecord>(), placed: PlaceOrder[] = [];
  let position: VenuePosition | null = null, protection: Protection = { stop: null, tp: null }, closes = 0;
  const adapter: ExchangeAdapter = {
    name: 'aster', network: 'testnet', exchangeStops: true, restingLimitGtcEntry: true,
    ping: async () => ({ ok: true, detail: 'fixture' }),
    permissions: async () => ({ ok: true, canWithdraw: false, canTrade: true, verified: true, detail: 'fixture' }),
    balance: async () => ({ equityUsdt: 1000, availableUsdt: 900 }),
    instrument: async symbol => ({ symbol, qtyStep: .1, minQty: .1, tickSize: .1 }), ticker: async () => 100,
    placeOrder: async order => { placed.push(order); records.set(order.clientId, { clientId: order.clientId, orderId: 'fixture-order', status: 'open', filledQty: 0, avgPrice: null }); return { orderId: 'fixture-order' }; },
    getOrder: async (_symbol, id) => records.get(id) ?? { clientId: id, orderId: '', status: 'unknown', filledQty: 0, avgPrice: null },
    positions: async () => position ? [{ ...position }] : [],
    protect: async request => { protection = { stop: request.stop, tp: request.tp, stopCoverage: 'net_position' }; },
    protection: async () => protection,
    cancelOrder: async (_symbol, id) => { const record = records.get(id)!; if (record.status !== 'filled') record.status = 'cancelled'; },
    cancelAll: async () => { for (const record of records.values()) if (record.status === 'open' || record.status === 'partial') record.status = 'cancelled'; },
    closePosition: async (_symbol, _side, qty, id) => { closes++; position = null; records.set(id, { clientId: id, orderId: 'fixture-close', status: 'filled', filledQty: qty, avgPrice: 100 }); return { orderId: 'fixture-close' }; }
  };
  const cfg = loadConfig({ MARKET_SOURCE: 'sample', APP_MODE: 'grokbot', AGENT_EVENT_SECRET: 'fixture-gtc-desk-secret-0123456789', OPEN_ORDERS_N: '2', MIN_ENTRY_CONFIDENCE_PCT: '60', DEBATE_PACE_MS: '0' });
  cfg.tradingMode = 'TESTNET'; cfg.live = { exchange: 'aster', network: 'testnet', experimental: true };
  const executor = new LiveExecutor(adapter, 0);
  const app = createApp(cfg, { executor, reportsDir: null, learningsPath: null, conversationsPath: null, killFile: null, jevEnv: {} }); apps.push(app);
  vi.spyOn(app.desk as unknown as { marketSnapshot(symbol: string): Promise<ReturnType<typeof sampleSnapshot>> }, 'marketSnapshot').mockImplementation(async symbol => ({ ...sampleSnapshot(symbol), last: 100, bid: 100, ask: 100, source: 'aster', example: false }));
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const post = async (route: string, body: unknown, origin?: string) => {
    const response = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-gtc-desk-secret-0123456789', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  return { app, cfg, executor, placed, post, closes: () => closes, fill: (fraction: number) => {
    const order = placed[0], qty = order.qty * fraction;
    records.set(order.clientId, { clientId: order.clientId, orderId: 'fixture-order', status: fraction === 1 ? 'filled' : 'partial', filledQty: qty, avgPrice: 100 });
    position = { symbol: order.symbol, side: order.side, qty, entry: 100, stop: null, tp: null, leverage: order.leverage, unrealizedPnl: 0 };
  } };
}
const ticket = { symbol: 'BTCUSDT', side: 'LONG', confidence: .6, riskApproval: 'APPROVE', reason: 'Owner-selected limit', entry: { type: 'LIMIT_GTC', price: 100.09 }, clientId: 'owner-gtc-desk' };

describe('GTC through normal authenticated desk admission', () => {
  it('frees exchange-confirmed flat slots without settling an unresolved CLOSE record', async () => {
    const f = await fixture();
    f.app.desk.book.n = 3;
    const intent = { clientId: 'unresolved-close', symbol: 'HYPEUSDT', side: 'SHORT' as const, kind: 'close' as const, requestedQty: 1,
      accountedQty: 0, accountedValue: 0, record: null, at: Date.now() };
    f.executor.journal.intents.push(intent);
    await f.app.desk.syncLive();
    expect(f.app.desk.availableSlots()).toMatchObject({ configuredN: 3, occupiedSlots: 0, freeSlots: 3, pendingOpenCount: 0,
      breakdown: { exchangePositions: [], unresolvedCloses: [{ clientId: intent.clientId }] } });
    expect(f.executor.journal.intents).toContain(intent);
    expect(f.executor.journal.settled(intent)).toBe(false);
    expect(f.placed).toHaveLength(0);
  });

  it('counts unresolved entry exposure once per symbol and side and preserves terminal accounting evidence', async () => {
    const f = await fixture();
    const makeIntent = (clientId: string) => ({ clientId, symbol: 'HYPEUSDT', side: 'LONG' as const, kind: 'open' as const, requestedQty: 1,
      accountedQty: 0, accountedValue: 0, record: null, at: Date.now() });
    f.executor.journal.intents.push(makeIntent('unknown-entry-1'), makeIntent('unknown-entry-2'), {
      ...makeIntent('terminal-entry'), symbol: 'SOLUSDT', record: { clientId: 'terminal-entry', orderId: 'filled-entry', status: 'filled', filledQty: 1, avgPrice: 100 }
    });
    await f.app.desk.syncLive();
    expect(f.app.desk.availableSlots()).toMatchObject({ occupiedSlots: 1, pendingOpenCount: 1, freeSlots: 1,
      breakdown: { pendingEntries: [{ clientId: 'unknown-entry-1' }, { clientId: 'unknown-entry-2' }] } });
    expect(f.executor.journal.intents).toHaveLength(3);
    expect(f.executor.hasPending('HYPEUSDT', 'LONG', 'open')).toBe(true);
  });

  it('counts resting and partial entry as one Owner slot and does not invent a filled verdict', async () => {
    const f = await fixture(), original = structuredClone({ risk: f.cfg.risk, n: f.app.desk.book.n });
    const first = await f.post('/api/gb/agent-open', ticket);
    expect(first.data).toMatchObject({ ok: true, pending: { state: 'RESTING', filledQty: 0 } });
    expect(f.app.desk.book.positions).toHaveLength(0);
    expect(f.app.desk.verdicts[0].executed).toBe(false);
    expect(f.app.desk.availableSlots()).toMatchObject({ occupiedSlots: 1, freeSlots: 1 });
    expect((await f.post('/api/gb/agent-open', ticket)).data.ok).toBe(true);
    expect(f.placed).toHaveLength(1);
    f.fill(.25); await f.app.desk.syncLive();
    expect(f.app.desk.book.positions).toHaveLength(1);
    expect(f.app.desk.availableSlots()).toMatchObject({ occupiedSlots: 1, freeSlots: 1 });
    expect(f.app.desk.book.positions[0].protectionStatus).toBe('confirmed');
    expect({ risk: f.cfg.risk, n: f.app.desk.book.n }).toEqual(original);
    expect(f.app.desk.executionCapabilities().restingLimitGtcEntry).toMatchObject({ implementation: 'IMPLEMENTED', liveVerification: 'UNVERIFIED_LIVE' });
  });
  it('allows manual CLOSE while a partial entry is pending and preserves N and entry confidence', async () => {
    const f = await fixture(); await f.post('/api/gb/agent-open', ticket); f.fill(.25); await f.app.desk.syncLive();
    const result = await f.post('/api/gb/close', { symbol: 'BTCUSDT', reason: 'Owner manual close' });
    expect(result.data.ok).toBe(true); expect(f.closes()).toBe(1);
    expect(f.app.desk.pendingEntries()[0].state).toBe('CANCELLED');
    expect(f.cfg.risk.minEntryConfidencePct).toBe(60); expect(f.app.desk.book.n).toBe(2);
  });
  it('cancels only the requested remainder through the authenticated API and refuses remote local-origin use', async () => {
    const f = await fixture(); await f.post('/api/gb/agent-open', ticket);
    expect((await f.post('/api/ops/cancel-entry', { clientId: ticket.clientId }, 'https://untrusted.example')).status).toBe(403);
    expect((await f.post('/api/gb/cancel-entry', { clientId: ticket.clientId })).data.ok).toBe(true);
    expect(f.closes()).toBe(0);
    expect((await f.post('/api/gb/agent-open', { ...ticket, entry: { type: 'MARKET', price: 100 } })).status).toBe(400);
  });
});
