import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { LiveExecutor } from '../server/live/executor.js';
import { MemoryAdapter } from './fakes.js';
import { Desk } from '../server/desk.js';
import { loadConfig } from '../server/config.js';
import { makeCaller } from '../server/providers/index.js';

function fixture() {
  const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEBATE_PACE_MS: '0' });
  const adapter = new MemoryAdapter();
  const executor = new LiveExecutor(adapter, 0);
  const desk = new Desk(cfg, makeCaller(cfg), { executor, reportsDir: null, learningsPath: null, killFile: null });
  const position = desk.book.open({ symbol: 'BTCUSDT', side: 'LONG', qty: 10, entry: 100, stop: 90, tp: 120, margin: 500, leverage: 2 });
  adapter.pos = [{ ...position, unrealizedPnl: 0 }];
  return { adapter, executor, desk, position };
}

describe('execution reconciliation', () => {
  it('keeps partial close remainder, margin and protection', async () => {
    const { adapter, desk } = fixture();
    vi.spyOn(adapter, 'closePosition').mockImplementation(async () => { adapter.pos[0].qty = 6; return { orderId: 'partial' }; });
    vi.spyOn(adapter, 'getOrder').mockImplementation(async (_s, clientId) => ({ clientId, orderId: 'partial', status: 'partial', filledQty: 4, avgPrice: 110 }));
    const cancel = vi.spyOn(adapter, 'cancelAll');
    const closed = await desk.executeClose('BTCUSDT', 999, 'test');
    expect(desk.book.positions[0]).toMatchObject({ qty: 6, margin: 300 });
    expect(closed[0]).toMatchObject({ qty: 4, exit: 110 });
    expect(cancel).not.toHaveBeenCalled();
  });
  it('does not cancel protection or flatten on a failed close', async () => {
    const { adapter, desk } = fixture();
    vi.spyOn(adapter, 'closePosition').mockRejectedValue(new Error('timeout'));
    const cancel = vi.spyOn(adapter, 'cancelAll');
    expect(await desk.executeClose('BTCUSDT', 110, 'test')).toEqual([]);
    expect(desk.book.positions[0].qty).toBe(10);
    expect(cancel).not.toHaveBeenCalled();
  });
  it('accounts cumulative fills on a cancelled order', async () => {
    const { adapter, executor } = fixture();
    vi.spyOn(adapter, 'closePosition').mockImplementation(async () => { adapter.pos[0].qty = 6; return { orderId: 'cancelled' }; });
    vi.spyOn(adapter, 'getOrder').mockImplementation(async (_s, clientId) => ({ clientId, orderId: 'cancelled', status: 'cancelled', filledQty: 4, avgPrice: 110 }));
    expect(await executor.close('BTCUSDT', 'LONG', 10)).toMatchObject({ ok: true, qty: 4, requestedQty: 10, remainingQty: 6 });
  });
  it('does not add estimated remote-close PnL to observed venue balance', async () => {
    const { adapter, desk } = fixture();
    adapter.pos = [];
    await desk.syncLive();
    expect(desk.book.balance).toBe(1000);
    expect(desk.book.closed[0].pnlStatus).toBe('unknown');
  });
  it('represents external exposure once without adopting it', async () => {
    const { adapter, desk } = fixture();
    desk.book.positions = [];
    await desk.syncLive();
    await desk.syncLive();
    expect(desk.book.positions).toHaveLength(1);
    expect(desk.book.positions[0].ownership).toBe('external');
    expect(adapter.closes).toBe(0);
  });
  it('applies late cumulative close fills once and preserves the incremental fill price', async () => {
    const { adapter, desk } = fixture();
    let filled = 4;
    vi.spyOn(adapter, 'closePosition').mockImplementation(async () => { adapter.pos[0].qty = 6; return { orderId: 'late' }; });
    vi.spyOn(adapter, 'getOrder').mockImplementation(async (_s, clientId) => ({ clientId, orderId: 'late', status: filled === 4 ? 'partial' : 'filled', filledQty: filled, avgPrice: filled === 4 ? 110 : 116 }));
    await desk.executeClose('BTCUSDT', 100, 'test');
    filled = 10; adapter.pos = [];
    await desk.syncLive(); await desk.syncLive();
    expect(desk.book.positions).toHaveLength(0);
    expect(desk.book.closed).toHaveLength(2);
    expect(desk.book.closed[0]).toMatchObject({ qty: 6, exit: 120 });
  });
  it('does not duplicate an unresolved close intent', async () => {
    const { adapter, desk } = fixture();
    const close = vi.spyOn(adapter, 'closePosition').mockRejectedValue(new Error('timeout'));
    await desk.executeClose('BTCUSDT', 100, 'test');
    await desk.executeClose('BTCUSDT', 100, 'test');
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('restart ownership', () => {
  it('recovers managed exposure and protection without sending another order', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mg-recovery-'));
    try {
      const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEBATE_PACE_MS: '0' });
      const adapter = new MemoryAdapter();
      const executor = new LiveExecutor(adapter, 0, path.join(dir, 'execution.json'));
      const d = new Desk(cfg, makeCaller(cfg), { executor, reportsDir: null });
      const result = await d.executeOpen('BTCUSDT', 'LONG', 70000, { sizeFactor: 1, leverage: 2, stopPct: 1.5 });
      expect(result.ok).toBe(true);
      const resumedExecutor = new LiveExecutor(adapter, 0, path.join(dir, 'execution.json'));
      const resumed = new Desk(cfg, makeCaller(cfg), { executor: resumedExecutor, reportsDir: null });
      await resumed.syncLive(); await resumed.syncLive();
      expect(resumed.book.positions).toHaveLength(1);
      expect(resumed.book.positions[0]).toMatchObject({ ownership: 'recovered', entry: 60005, protectionStatus: 'confirmed' });
      expect(adapter.placed).toHaveLength(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('review regressions', () => {
  it('defers a close while the entry remainder is unresolved', async () => {
    const { adapter, executor, desk, position } = fixture();
    executor.journal.intents.push({ clientId: 'entry', positionId: position.id, kind: 'open', symbol: 'BTCUSDT', side: 'LONG', requestedQty: 20, accountedQty: 10, accountedValue: 1000, record: { clientId: 'entry', orderId: 'e', status: 'partial', filledQty: 10, avgPrice: 100 }, at: Date.now() });
    await desk.executeClose('BTCUSDT', 110, 'test');
    expect(adapter.closes).toBe(0);
  });
  it('never sizes LIVE exposure from an unavailable venue account', async () => {
    const { adapter, desk } = fixture(); adapter.pos = []; desk.book.positions = [];
    vi.spyOn(adapter, 'balance').mockRejectedValue(new Error('unavailable'));
    const result = await desk.executeOpen('BTCUSDT', 'LONG', 60000, { sizeFactor: 1, leverage: 2, stopPct: 1.5 });
    expect(result.ok).toBe(false); expect(adapter.placed).toHaveLength(0);
  });
  it('serializes same-symbol entry checks inside the execution queue', async () => {
    const { adapter, desk } = fixture(); adapter.pos = []; desk.book.positions = [];
    const results = await Promise.all([desk.executeOpen('BTCUSDT', 'LONG', 60000, { sizeFactor: 1, leverage: 2, stopPct: 1.5 }), desk.executeOpen('BTCUSDT', 'LONG', 60000, { sizeFactor: 1, leverage: 2, stopPct: 1.5 })]);
    expect(results.filter((r) => r.ok)).toHaveLength(1); expect(adapter.placed).toHaveLength(1);
  });
  it('keeps remote exposure visible when kill cannot close it', async () => {
    const { adapter, desk } = fixture(); vi.spyOn(adapter, 'closePosition').mockRejectedValue(new Error('unavailable'));
    await desk.kill();
    expect(desk.killed).toBe(true); expect(desk.book.positions).toHaveLength(1);
  });
  it('does not invent an incremental fill price after an unknown first price', async () => {
    const { adapter, desk } = fixture(); let filled = 4;
    vi.spyOn(adapter, 'closePosition').mockImplementation(async () => { adapter.pos[0].qty = 6; return { orderId: 'later-price' }; });
    vi.spyOn(adapter, 'getOrder').mockImplementation(async (_s, clientId) => ({ clientId, orderId: 'later-price', status: filled === 4 ? 'partial' : 'filled', filledQty: filled, avgPrice: filled === 4 ? null : 116 }));
    await desk.executeClose('BTCUSDT', 100, 'test'); filled = 10; adapter.pos = []; await desk.syncLive();
    expect(desk.book.closed[0].pnlStatus).toBe('unknown');
  });
});

describe('recovery and protection review gates', () => {
  it('promotes temporarily unknown ownership after order history recovers', async () => {
    const { adapter, executor, desk } = fixture(); desk.book.positions = [];
    executor.journal.intents.push({ clientId: 'recover', kind: 'open', symbol: 'BTCUSDT', side: 'LONG', requestedQty: 10, stop: 90, leverage: 2, accountedQty: 0, accountedValue: 0, record: null, at: Date.now() });
    let readable = false;
    vi.spyOn(adapter, 'getOrder').mockImplementation(async (_s, clientId) => ({ clientId, orderId: 'e', status: readable ? 'filled' : 'unknown', filledQty: readable ? 10 : 0, avgPrice: readable ? 100 : null }));
    await desk.syncLive(); expect(desk.book.positions[0].ownership).toBe('external');
    readable = true; await desk.syncLive();
    expect(desk.book.positions[0]).toMatchObject({ ownership: 'recovered', id: 'recover' });
    expect(adapter.placed).toHaveLength(0);
  });
  it('restores a missing stop on a managed position without an entry order', async () => {
    const { adapter, desk, position } = fixture(); position.ownership = 'managed'; adapter.pos[0].stop = null;
    await desk.syncLive();
    expect(adapter.protects).toHaveLength(1); expect(adapter.placed).toHaveLength(0);
    expect(desk.book.positions[0]).toMatchObject({ protectionStatus: 'confirmed', stop: 90 });
  });
  it('does not overwrite a cumulative fill with an unavailable history response', async () => {
    const { adapter, executor } = fixture();
    executor.journal.intents.push({ clientId: 'known', kind: 'open', symbol: 'BTCUSDT', side: 'LONG', requestedQty: 20, accountedQty: 10, accountedValue: 1000, record: { clientId: 'known', orderId: 'e', status: 'partial', filledQty: 10, avgPrice: 100 }, at: 1 });
    vi.spyOn(adapter, 'getOrder').mockResolvedValue({ clientId: 'known', orderId: '', status: 'unknown', filledQty: 0, avgPrice: null });
    await executor.refreshPending();
    expect(executor.journal.intents[0].record?.filledQty).toBe(10);
  });
  it('kill waits for an in-flight entry before flattening the resulting exposure', async () => {
    const { adapter, desk } = fixture(); adapter.pos = []; desk.book.positions = [];
    const realPlace = adapter.placeOrder.bind(adapter);
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { release = r; });
    vi.spyOn(adapter, 'placeOrder').mockImplementation(async (order) => { entered(); await gate; return realPlace(order); });
    const opening = desk.executeOpen('BTCUSDT', 'LONG', 60000, { sizeFactor: 1, leverage: 2, stopPct: 1.5 });
    await enteredPromise;
    const killing = desk.kill(); release(); await opening; await killing;
    expect(adapter.pos).toHaveLength(0); expect(desk.book.positions).toHaveLength(0); expect(desk.killed).toBe(true);
  });
  it('only cancels known protective client IDs after a confirmed flat observation', async () => {
    const adapter = Object.assign(new MemoryAdapter(), { cancelOrder: vi.fn(async (_symbol: string, _id: string) => {}) });
    const executor = new LiveExecutor(adapter, 0);
    executor.journal.protectionClients.push({ symbol: 'BTCUSDT', clientId: 'owned' });
    vi.spyOn(adapter, 'getOrder').mockImplementation(async (_s, clientId) => ({ clientId, orderId: clientId, status: 'open', filledQty: 0, avgPrice: null }));
    await executor.cleanupProtection('BTCUSDT');
    expect(adapter.cancelOrder.mock.calls).toEqual([['BTCUSDT', 'owneds'], ['BTCUSDT', 'ownedt']]);
  });
});

describe('final reconciliation boundaries', () => {
  it('reconciles an entry stopped before its first position snapshot without inventing exit fills', async () => {
    const { adapter, desk, executor } = fixture(); adapter.pos = []; desk.book.positions = [];
    const result = await desk.executeOpen('BTCUSDT', 'LONG', 60000, { sizeFactor: 1, leverage: 2, stopPct: 1.5 });
    expect(result.ok).toBe(true);
    adapter.pos = []; // The exchange stop filled before the first position read.
    await desk.syncLive();
    expect(desk.book.positions).toHaveLength(1); // Allow a lagging snapshot once.
    await desk.syncLive(); await desk.syncLive();
    expect(desk.book.positions).toHaveLength(0);
    expect(desk.book.closed).toHaveLength(1);
    expect(desk.book.closed[0]).toMatchObject({ pnlStatus: 'unknown' });
    expect(executor.journal.intents[0].awaitingQty).toBeUndefined();
    expect(adapter.placed).toHaveLength(1); expect(adapter.closes).toBe(0);
  });
  it('retains a confirmed partial remainder when a venue snapshot lags the fill', async () => {
    const { adapter, desk } = fixture();
    vi.spyOn(adapter, 'closePosition').mockResolvedValue({ orderId: 'lag' });
    vi.spyOn(adapter, 'getOrder').mockImplementation(async (_s, clientId) => ({ clientId, orderId: 'lag', status: 'partial', filledQty: 4, avgPrice: 110 }));
    await desk.executeClose('BTCUSDT', 100, 'test');
    await desk.syncLive();
    expect(desk.book.positions[0].qty).toBe(6);
    expect(desk.venueAccount?.status).toBe('stale');
    adapter.pos[0].qty = 6; await desk.syncLive();
    expect(desk.book.positions[0].qty).toBe(6); expect(desk.venueAccount?.status).toBe('confirmed');
  });
  it('blocks opposite-side entries while an entry for the symbol is unresolved', async () => {
    const { executor } = fixture();
    executor.journal.intents.push({ clientId: 'unresolved', kind: 'open', symbol: 'BTCUSDT', side: 'LONG', requestedQty: 1, accountedQty: 0, accountedValue: 0, record: null, at: 1 });
    expect(executor.hasPending('BTCUSDT', 'SHORT', 'open')).toBe(true);
  });
  it('a paused desk does not send a new entry', async () => {
    const { desk, adapter } = fixture(); desk.book.positions = []; adapter.pos = []; desk.paused = true;
    const result = await desk.executeOpen('BTCUSDT', 'LONG', 60000, { sizeFactor: 1, leverage: 2, stopPct: 1.5 });
    expect(result.ok).toBe(false); expect(adapter.placed).toHaveLength(0);
  });
  it('does not adopt a manual addition into automatic position management', async () => {
    const { desk, adapter, position } = fixture(); position.ownership = 'managed'; adapter.pos[0].qty = 12;
    await desk.syncLive();
    expect(desk.book.positions[0]).toMatchObject({ ownership: 'external', qty: 12 });
  });
});
