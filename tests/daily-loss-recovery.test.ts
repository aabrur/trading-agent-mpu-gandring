import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Desk } from '../server/desk.js';
import { loadConfig } from '../server/config.js';
import { makeCaller } from '../server/providers/index.js';
import { LiveExecutor } from '../server/live/executor.js';
import { MemoryAdapter } from './fakes.js';

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'mpu-daily-')); dirs.push(dir);
  const file = path.join(dir, 'journal.json');
  const adapter = new MemoryAdapter();
  const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEFAULT_PROVIDER: 'mock', DAILY_LOSS_LIMIT_PCT: '3' });
  const create = () => {
    const executor = new LiveExecutor(adapter, 0, file);
    const desk = new Desk(cfg, makeCaller(cfg), { executor, reportsDir: null, learningsPath: null, conversationsPath: null, killFile: null });
    return { executor, desk };
  };
  return { adapter, create };
}

describe('durable daily loss state', () => {
  it('keeps the confirmed baseline across restart and latches cumulative daily loss', async () => {
    const { adapter, create } = fixture();
    let equity = 1000;
    vi.spyOn(adapter, 'balance').mockImplementation(async () => ({ equityUsdt: equity, availableUsdt: equity }));
    const first = create();
    first.desk.book.balance = 50000;
    first.desk.checkDay();
    expect(first.executor.journal.dailyLoss).toBeNull();
    await first.desk.syncLive();
    equity = 980;
    const second = create(); await second.desk.syncLive();
    expect(second.desk.day).toMatchObject({ startEquity: 1000, lossHit: false });
    equity = 960; await second.desk.syncLive();
    expect(second.desk.day.lossHit).toBe(true);
    equity = 1100;
    const third = create(); await third.desk.syncLive();
    expect(third.desk.day).toMatchObject({ startEquity: 1000, lossHit: true });
    expect(adapter.placed).toHaveLength(0);
  });

  it('starts a fresh baseline only on the next UTC date', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-27T23:59:00Z'));
    const { adapter, create } = fixture();
    const first = create(); await first.desk.syncLive();
    vi.spyOn(adapter, 'balance').mockResolvedValue({ equityUsdt: 900, availableUsdt: 900 });
    await first.desk.syncLive(); expect(first.desk.day.lossHit).toBe(true);
    vi.setSystemTime(new Date('2026-10-28T00:01:00Z'));
    const next = create(); await next.desk.syncLive();
    expect(next.desk.day).toEqual({ key: '2026-10-28', startEquity: 900, lossHit: false });
    expect(next.executor.journal.dailyLoss).toEqual(next.desk.day);
  });

  it('keeps intended stop and target when reconciliation cannot read protection', async () => {
    const { adapter, create } = fixture();
    const { desk, executor } = create();
    const p = desk.book.open({ symbol: 'BTCUSDT', side: 'LONG', qty: 1, entry: 100, stop: 90, tp: 120, margin: 50, leverage: 2 });
    adapter.pos = [{ ...p, unrealizedPnl: 0 }];
    vi.spyOn(adapter, 'protection').mockResolvedValue({ stop: null, tp: null });
    vi.spyOn(executor, 'ensureOnExchange').mockResolvedValue({ ok: true, status: 'unknown', stop: null, tp: null, note: 'read timed out' });
    await desk.syncLive();
    expect(desk.book.positions[0]).toMatchObject({ stop: 90, tp: 120, protectionStatus: 'unknown' });
    expect(executor.journal.positions[0]).toMatchObject({ stop: 90, tp: 120, protectionStatus: 'unknown' });
    expect(adapter.closes).toBe(0);
  });
});
