import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AsterAdapter } from '../server/exchange/aster.js';
import { LiveExecutor } from '../server/live/executor.js';
import type { ExchangeAdapter, OrderRecord, PlaceOrder, Protection, ProtectRequest, Side, VenuePosition } from '../server/exchange/types.js';

const main = '0x1111111111111111111111111111111111111111';
const agent = `0x${'22'.repeat(32)}`;
const ticket = { symbol: 'BTCUSDT', side: 'LONG' as const, qty: 4, stop: 90, tp: 120, leverage: 2 };
const limit = { type: 'LIMIT_GTC' as const, price: 100.09 };
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function asterHttp() {
  const calls: { method: string; path: string; q: URLSearchParams }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const u = new URL(String(input));
    calls.push({ method: init.method ?? 'GET', path: u.pathname, q: u.searchParams });
    const body = u.pathname.endsWith('/exchangeInfo') ? { symbols: [{ symbol: 'BTCUSDT', filters: [{ filterType: 'LOT_SIZE', stepSize: '0.1', minQty: '0.1' }, { filterType: 'PRICE_FILTER', tickSize: '0.1' }] }] } : { orderId: 123 };
    return new Response(JSON.stringify(body));
  }) as typeof fetch;
  return { calls, adapter: new AsterAdapter('testnet', main, agent, fetchImpl, 'https://aster.fixture', '') };
}

describe('Aster explicit resting LIMIT GTC contract', () => {
  it('sends LIMIT GTC at side-aware tick without attaching protection before a fill', async () => {
    const { adapter, calls } = asterHttp();
    await adapter.placeOrder({ ...ticket, clientId: 'explicit-limit', entry: limit });
    const orders = calls.filter(c => c.method === 'POST' && c.path.endsWith('/order'));
    expect(orders).toHaveLength(1);
    expect(Object.fromEntries(orders[0].q)).toMatchObject({ type: 'LIMIT', timeInForce: 'GTC', price: '100', quantity: '4', side: 'BUY' });
  });
  it('rounds a SHORT limit upward and leaves a legacy MARKET request unchanged', async () => {
    const { adapter, calls } = asterHttp();
    await adapter.placeOrder({ ...ticket, side: 'SHORT', stop: 110, tp: 80, clientId: 'short-limit', entry: limit });
    expect(calls.find(c => c.q.get('newClientOrderId') === 'short-limit')?.q.get('price')).toBe('100.1');
    await adapter.placeOrder({ ...ticket, clientId: 'legacy' });
    const market = calls.find(c => c.q.get('newClientOrderId') === 'legacy')!;
    expect(market.q.get('type')).toBe('MARKET');
    expect(market.q.has('price')).toBe(false);
    expect(market.q.has('timeInForce')).toBe(false);
    expect(calls.filter(c => c.q.get('newClientOrderId') === 'legacys')).toHaveLength(1);
  });
});

function venueFixture() {
  const records = new Map<string, OrderRecord>();
  let positionQty = 0;
  let protection: Protection = { stop: null, tp: null };
  const faults = { sendUnknown: false, readUnknown: false, protectionRead: false, dropProtection: false, protectionSend: false, cancelUnknown: false, closeUnknown: false, lateFill: false };
  const getOrder = vi.fn(async (_symbol: string, clientId: string): Promise<OrderRecord> => faults.readUnknown ? { clientId, orderId: '', status: 'unknown', filledQty: 0, avgPrice: null } : records.get(clientId) ?? { clientId, orderId: '', status: 'unknown', filledQty: 0, avgPrice: null });
  const placeOrder = vi.fn(async (o: PlaceOrder) => {
    records.set(o.clientId, { clientId: o.clientId, orderId: 'venue-entry', status: 'open', filledQty: 0, avgPrice: null });
    if (faults.sendUnknown) throw new Error('network timeout');
    return { orderId: 'venue-entry' };
  });
  const protect = vi.fn(async (p: ProtectRequest) => { if (faults.protectionSend) throw new Error('venue reject'); if (!faults.dropProtection) protection = { stop: p.stop, tp: p.tp }; });
  const closePosition = vi.fn(async (_symbol: string, _side: Side, qty: number, clientId: string) => {
    if (faults.closeUnknown) throw new Error('close timeout');
    positionQty = Math.max(0, positionQty - qty);
    records.set(clientId, { clientId, orderId: 'venue-close', status: 'filled', filledQty: qty, avgPrice: 100 });
    return { orderId: 'venue-close' };
  });
  const cancelOrder = vi.fn(async (_symbol: string, clientId: string) => {
    if (faults.cancelUnknown) throw new Error('cancel timeout');
    const rec = records.get(clientId)!;
    if (faults.lateFill) { rec.status = 'filled'; rec.filledQty = 4; rec.avgPrice = 100; positionQty = 4; }
    else if (rec.status !== 'filled') rec.status = 'cancelled';
  });
  const cancelAll = vi.fn(async () => { for (const r of records.values()) if (r.status === 'open' || r.status === 'partial') r.status = 'cancelled'; protection = { stop: null, tp: null }; });
  const adapter: ExchangeAdapter = {
    name: 'aster', network: 'testnet', restingLimitGtcEntry: true, exchangeStops: true,
    ping: async () => ({ ok: true, detail: 'fixture' }), permissions: async () => ({ ok: true, canWithdraw: false, canTrade: true, verified: true, detail: 'fixture' }),
    balance: async () => ({ equityUsdt: 1000, availableUsdt: 900 }), instrument: async symbol => ({ symbol, qtyStep: 0.1, minQty: 0.1, tickSize: 0.1 }), ticker: async () => 100,
    placeOrder, getOrder, protect, closePosition, cancelOrder, cancelAll,
    positions: async (): Promise<VenuePosition[]> => positionQty > 0 ? [{ symbol: 'BTCUSDT', side: 'LONG', qty: positionQty, entry: 100, stop: null, tp: null, unrealizedPnl: 0 }] : [],
    protection: async (_symbol, _side, requiredQty) => { if (faults.protectionRead) throw new Error('protection read timeout'); return requiredQty == null ? protection : { stopCoverage: 'net_position', ...protection }; }
  };
  const fill = (clientId: string, qty: number, status: OrderRecord['status'] = qty === 4 ? 'filled' : 'partial') => {
    records.set(clientId, { clientId, orderId: 'venue-entry', status, filledQty: qty, avgPrice: qty > 0 ? 100 : null }); positionQty = qty;
  };
  return { adapter, records, faults, fill, placeOrder, getOrder, protect, closePosition, cancelOrder, cancelAll, setProtection: (p: Protection) => { protection = p; }, setPosition: (qty: number) => { positionQty = qty; } };
}

const request = (clientId = 'owner-entry') => ({ ...ticket, entry: limit, clientId });
const journalFile = () => { const dir = mkdtempSync(path.join(os.tmpdir(), 'mpu-gtc-')); dirs.push(dir); return path.join(dir, 'execution.json'); };

describe('durable GTC lifecycle through LiveExecutor', () => {
  it('protectively closes only new late fills after a failed stop and ambiguous cancellation', async () => {
    const v = venueFixture(), ex = new LiveExecutor(v.adapter, 0);
    await ex.open(request()); v.faults.dropProtection = true; v.faults.cancelUnknown = true;
    v.fill('owner-entry', 1); await ex.refreshPending();
    expect(v.closePosition).toHaveBeenCalledTimes(1);
    v.fill('owner-entry', 4); v.setPosition(3); await ex.refreshPending(); await ex.refreshPending();
    expect(v.closePosition).toHaveBeenCalledTimes(2);
    expect(v.closePosition.mock.calls[1][2]).toBe(3);
    expect(v.placeOrder).toHaveBeenCalledTimes(1);
  });
  it('persists RESTING without inventing a fill, then protects 25% and 100% once', async () => {
    const v = venueFixture(), ex = new LiveExecutor(v.adapter, 0, journalFile());
    const resting = await ex.open(request());
    expect(resting).toMatchObject({ ok: false, qty: 0, remainingQty: 4, pending: true, entryState: 'RESTING' });
    expect(v.protect).not.toHaveBeenCalled();
    expect(ex.journal.intents[0]).toMatchObject({ venue: 'aster', network: 'testnet', limitPrice: 100, orderId: 'venue-entry', filledQty: 0, remainingQty: 4 });
    v.fill('owner-entry', 1); await ex.refreshPending();
    expect(ex.journal.intents[0]).toMatchObject({ entryState: 'PARTIAL', filledQty: 1, remainingQty: 3, protectionStatus: 'confirmed' });
    expect(v.protect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ qty: 1, stop: 90, clientId: 'owner-entry' }));
    v.fill('owner-entry', 4); await ex.refreshPending(); await ex.refreshPending();
    expect(ex.journal.intents[0]).toMatchObject({ entryState: 'FILLED', filledQty: 4, remainingQty: 0 });
    expect(v.protect).toHaveBeenCalledTimes(1);
    expect(v.placeOrder).toHaveBeenCalledTimes(1);
  });
  it('cancel after partial touches only the entry and preserves its resting stop', async () => {
    const v = venueFixture(), ex = new LiveExecutor(v.adapter, 0);
    await ex.open(request()); v.fill('owner-entry', 1); await ex.refreshPending();
    const result = await ex.cancelEntry('owner-entry');
    expect(result).toMatchObject({ entryState: 'CANCELLED', qty: 1, pending: false, protectionStatus: 'confirmed' });
    expect(v.cancelOrder).toHaveBeenCalledExactlyOnceWith('BTCUSDT', 'owner-entry');
    expect(v.cancelAll).not.toHaveBeenCalled();
    expect(await v.adapter.protection('BTCUSDT', 'LONG')).toEqual({ stop: 90, tp: 120 });
    await ex.cancelEntry('owner-entry'); expect(v.cancelOrder).toHaveBeenCalledTimes(1);
  });
  it('reconciles a late fill racing cancellation without losing protection', async () => {
    const v = venueFixture(), ex = new LiveExecutor(v.adapter, 0);
    await ex.open(request()); v.fill('owner-entry', 1); v.faults.lateFill = true;
    const result = await ex.cancelEntry('owner-entry');
    expect(result).toMatchObject({ entryState: 'FILLED', qty: 4, protectionStatus: 'confirmed' });
    expect(v.protect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ qty: 4 }));
    expect(v.placeOrder).toHaveBeenCalledTimes(1);
  });
  it('unknown send/read stays pending and a duplicate same client id never submits twice', async () => {
    const v = venueFixture(), ex = new LiveExecutor(v.adapter, 0);
    v.faults.sendUnknown = true; v.faults.readUnknown = true;
    const first = await ex.open(request());
    expect(first).toMatchObject({ entryState: 'UNKNOWN', ok: false, pending: true });
    await ex.open(request()); expect(v.placeOrder).toHaveBeenCalledTimes(1);
    v.faults.readUnknown = false; await ex.refreshPending();
    expect(ex.journal.intents[0].entryState).toBe('RESTING');
    expect(v.placeOrder).toHaveBeenCalledTimes(1);
    await expect(ex.open({ ...request(), qty: 3 })).rejects.toThrow('different ticket');
  });
  it('serializes concurrent identical submission and duplicate reconciliation callbacks', async () => {
    const v = venueFixture(), ex = new LiveExecutor(v.adapter, 0);
    await Promise.all([ex.open(request()), ex.open(request())]);
    v.fill('owner-entry', 1); await Promise.all([ex.refreshPending(), ex.refreshPending()]);
    expect(v.placeOrder).toHaveBeenCalledTimes(1); expect(v.protect).toHaveBeenCalledTimes(1);
  });
  it('recovers the same order and stop after journal crash/restart', async () => {
    const v = venueFixture(), file = journalFile();
    const first = new LiveExecutor(v.adapter, 0, file); await first.open(request());
    v.fill('owner-entry', 1);
    const recovered = new LiveExecutor(v.adapter, 0, file); await recovered.refreshPending();
    expect(recovered.journal.intents[0]).toMatchObject({ entryState: 'PARTIAL', protectionStatus: 'confirmed' });
    await recovered.open(request());
    expect(v.placeOrder).toHaveBeenCalledTimes(1); expect(v.protect).toHaveBeenCalledTimes(1);
  });
  it('expires only an explicitly selected deadline on reconciliation', async () => {
    const v = venueFixture(), ex = new LiveExecutor(v.adapter, 0);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    await ex.open({ ...request(), entry: { ...limit, expireAt: 2000 } });
    clock.mockReturnValue(2000); await ex.refreshPending();
    expect(ex.journal.intents[0].entryState).toBe('EXPIRED'); expect(v.cancelOrder).toHaveBeenCalledTimes(1);
    await ex.open(request('no-expiry')); clock.mockReturnValue(1e12); await ex.refreshPending();
    expect(ex.journal.intents.find(i => i.clientId === 'no-expiry')?.entryState).toBe('RESTING');
    expect(v.cancelOrder).toHaveBeenCalledTimes(1);
  });
  it('retains UNKNOWN cancellation across restart without a second cancel or entry', async () => {
    const v = venueFixture(), file = journalFile(), ex = new LiveExecutor(v.adapter, 0, file);
    await ex.open(request()); v.faults.cancelUnknown = true;
    await ex.cancelEntry('owner-entry');
    const recovered = new LiveExecutor(v.adapter, 0, file); await recovered.cancelEntry('owner-entry');
    expect(v.cancelOrder).toHaveBeenCalledTimes(1); expect(v.placeOrder).toHaveBeenCalledTimes(1);
    expect(recovered.journal.intents[0].cancelRequestedAt).toBeTypeOf('number');
  });
  it('records a venue rejection without retrying or creating a position', async () => {
    const v = venueFixture(), ex = new LiveExecutor(v.adapter, 0);
    v.placeOrder.mockImplementationOnce(async o => { v.records.set(o.clientId, { clientId: o.clientId, orderId: '', status: 'rejected', filledQty: 0, avgPrice: null }); throw new Error('venue rejected'); });
    expect(await ex.open(request())).toMatchObject({ entryState: 'REJECTED', ok: false, pending: false });
    await ex.open(request()); expect(v.placeOrder).toHaveBeenCalledTimes(1); expect(v.protect).not.toHaveBeenCalled();
  });
  it.each([0, NaN, -1])('rejects an invalid limit price %s before a venue write', async price => {
    const v = venueFixture(), ex = new LiveExecutor(v.adapter, 0);
    await expect(ex.open({ ...request(), entry: { type: 'LIMIT_GTC', price } })).rejects.toThrow();
    expect(v.placeOrder).not.toHaveBeenCalled(); expect(ex.journal.intents).toHaveLength(0);
  });
  it('rejects a wrong lot, stop geometry, past expiry or unsupported adapter before sending', async () => {
    const v = venueFixture(), ex = new LiveExecutor(v.adapter, 0);
    await expect(ex.open({ ...request(), qty: 0.15 })).rejects.toThrow('lot');
    await expect(ex.open({ ...request(), stop: 101 })).rejects.toThrow('geometry');
    await expect(ex.open({ ...request(), entry: { ...limit, expireAt: 1 } })).rejects.toThrow('expiration');
    const other = new LiveExecutor({ ...v.adapter, name: 'bybit' }, 0);
    await expect(other.open(request())).rejects.toThrow('unavailable'); expect(v.placeOrder).not.toHaveBeenCalled();
  });
  it('uses a verified existing net-position stop without stacking another', async () => {
    const v = venueFixture(), ex = new LiveExecutor(v.adapter, 0);
    await ex.open(request()); v.fill('owner-entry', 1); v.setProtection({ stop: 91, tp: 120 }); await ex.refreshPending();
    expect(ex.journal.intents[0].protectionStatus).toBe('confirmed'); expect(v.protect).not.toHaveBeenCalled();
  });
  it('does not treat an undersized existing quantity stop as net-position coverage or stack a second stop', async () => {
    const v = venueFixture(), ex = new LiveExecutor(v.adapter, 0);
    await ex.open(request()); v.fill('owner-entry', 4); v.setProtection({ stop: 91, tp: 120, stopCoverage: 'quantity', stopQty: 1 }); await ex.refreshPending();
    expect(ex.journal.intents[0].protectionStatus).toBe('missing'); expect(v.protect).not.toHaveBeenCalled();
    expect(v.closePosition).toHaveBeenCalledExactlyOnceWith('BTCUSDT', 'LONG', 4, expect.any(String));
  });
  it('preserves known fills on unknown/regressing readback and never reports unknown protection as confirmed', async () => {
    const v = venueFixture(), ex = new LiveExecutor(v.adapter, 0);
    await ex.open(request()); v.fill('owner-entry', 1); await ex.refreshPending();
    v.faults.readUnknown = true; v.faults.protectionRead = true; await ex.refreshPending();
    expect(ex.journal.intents[0]).toMatchObject({ entryState: 'UNKNOWN', filledQty: 1, protectionStatus: 'unknown' });
    expect(v.protect).toHaveBeenCalledTimes(1); expect(v.closePosition).not.toHaveBeenCalled();
  });
  it.each(['dropProtection', 'protectionSend'] as const)('cancels remainder and closes actual fill on confirmed missing stop (%s)', async fault => {
    const v = venueFixture(), ex = new LiveExecutor(v.adapter, 0);
    await ex.open(request()); v.fill('owner-entry', 1); v.faults[fault] = true; await ex.refreshPending(); await ex.refreshPending();
    expect(v.cancelOrder).toHaveBeenCalledExactlyOnceWith('BTCUSDT', 'owner-entry');
    expect(v.closePosition).toHaveBeenCalledExactlyOnceWith('BTCUSDT', 'LONG', 1, expect.any(String));
    expect(v.placeOrder).toHaveBeenCalledTimes(1); expect(v.protect).toHaveBeenCalledTimes(1);
  });
  it('does not create a second emergency close after an ambiguous close timeout', async () => {
    const v = venueFixture(), file = journalFile(), ex = new LiveExecutor(v.adapter, 0, file);
    await ex.open(request()); v.fill('owner-entry', 1); v.faults.dropProtection = true; v.faults.closeUnknown = true;
    await ex.refreshPending(); const recovered = new LiveExecutor(v.adapter, 0, file); await recovered.refreshPending();
    expect(v.closePosition).toHaveBeenCalledTimes(1);
  });
  it('allows manual reduce-only close while a GTC entry is pending without sweeping its protection', async () => {
    const v = venueFixture(), ex = new LiveExecutor(v.adapter, 0);
    await ex.open(request()); v.fill('owner-entry', 1); await ex.refreshPending();
    const result = await ex.close('BTCUSDT', 'LONG', 1);
    expect(result.ok).toBe(true); expect(v.cancelAll).not.toHaveBeenCalled();
    expect(v.closePosition).toHaveBeenCalledTimes(1);
  });
  it('kill cancels symbols with a resting no-fill entry and does not duplicate an unknown emergency flatten', async () => {
    const v = venueFixture(), ex = new LiveExecutor(v.adapter, 0);
    await ex.open(request()); await ex.killAll([]);
    expect(v.cancelAll).toHaveBeenCalledWith('BTCUSDT'); expect(v.closePosition).not.toHaveBeenCalled();
    v.setPosition(1); v.faults.closeUnknown = true;
    await ex.killAll([]); await ex.killAll([]); expect(v.closePosition).toHaveBeenCalledTimes(1);
  });
});
