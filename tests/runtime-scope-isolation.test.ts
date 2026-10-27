import { describe, expect, it, vi } from 'vitest';
import { Desk } from '../server/desk.js';
import { loadConfig } from '../server/config.js';
import { makeCaller } from '../server/providers/index.js';
import { LiveExecutor } from '../server/live/executor.js';
import { fakeBybit, MemoryAdapter } from './fakes.js';

const paperEnv = { TRADING_MODE: 'PAPER', DEFAULT_PROVIDER: 'mock', MARKET_SOURCE: 'sample', AUTO_TRADING: 'off', TRADING_PROFILE: 'current' };
const testnetEnv = { ...paperEnv, TRADING_MODE: 'TESTNET', EXCHANGE: 'bybit', BYBIT_TESTNET_API_KEY: 'fixture-key', BYBIT_TESTNET_API_SECRET: 'fixture-secret' };
const ticket = { symbol: 'BTCUSDT', side: 'LONG' as const, qty: 1, entry: 100, stop: 90, margin: 50, leverage: 2 };
function paperDesk() {
  const cfg = loadConfig(paperEnv);
  return new Desk(cfg, makeCaller(cfg), { reportsDir: null, learningsPath: null, conversationsPath: null, killFile: null });
}

describe('runtime book scope isolation', () => {
  it('keeps paper positions and closed history out of the exchange scope and restores them on return', async () => {
    const desk = paperDesk();
    const completed = desk.book.open(ticket);
    desk.book.close(completed.id, 110, 'fixture');
    desk.book.open(ticket);
    desk.checkDay();
    const originalBook = desk.book;
    const originalDay = structuredClone(desk.day);
    const { fetchImpl } = fakeBybit();
    try {
      await desk.reloadRuntimeConfig(testnetEnv, fetchImpl);
      expect(desk.cfg.tradingMode).toBe('TESTNET');
      expect(desk.book).not.toBe(originalBook);
      expect(desk.book.positions).toHaveLength(0);
      expect(desk.book.closed).toHaveLength(0);
      expect(desk.book.autoExit).toBe(false);
      await desk.reloadRuntimeConfig({ ...paperEnv, PAPER_BALANCE: '9999' });
      expect(desk.book).toBe(originalBook);
      expect(desk.book.positions).toHaveLength(1);
      expect(desk.book.closed).toHaveLength(1);
      expect(desk.book.balance).not.toBe(9999);
      expect(desk.day).toEqual(originalDay);
      expect(desk.book.autoExit).toBe(true);
    } finally { desk.stop(); }
  });

  it('does not label testnet positions as live after changing network', async () => {
    const desk = paperDesk();
    const { fetchImpl } = fakeBybit();
    try {
      await desk.reloadRuntimeConfig(testnetEnv, fetchImpl);
      desk.book.open(ticket);
      await desk.reloadRuntimeConfig({ ...testnetEnv, TRADING_MODE: 'LIVE', BYBIT_API_KEY: 'fixture-key', BYBIT_API_SECRET: 'fixture-secret' }, fetchImpl);
      expect(desk.cfg.tradingMode).toBe('LIVE');
      expect(desk.cfg.live?.network).toBe('mainnet');
      expect(desk.book.positions).toHaveLength(0);
      expect(desk.book.closed).toHaveLength(0);
    } finally { desk.stop(); }
  });

  it('retains the current scope when the requested exchange cannot be constructed', async () => {
    const desk = paperDesk();
    desk.book.open(ticket);
    const originalBook = desk.book;
    const originalConfig = structuredClone(desk.cfg);
    try {
      await expect(desk.reloadRuntimeConfig({ TRADING_MODE: 'LIVE', EXCHANGE: 'bybit' })).rejects.toThrow('active scope was not changed');
      expect(desk.cfg).toEqual(originalConfig);
      expect(desk.book).toBe(originalBook);
      expect(desk.book.positions).toHaveLength(1);
    } finally { desk.stop(); }
  });

  it('waits for the outgoing reconciliation and checkpoints only its own venue positions', async () => {
    const cfg = loadConfig({ ...testnetEnv, TRADING_MODE: 'LIVE', BYBIT_API_KEY: 'fixture-key', BYBIT_API_SECRET: 'fixture-secret' });
    const adapter = new MemoryAdapter();
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(adapter, 'balance').mockImplementation(async () => {
      entered(); await blocked;
      return { equityUsdt: 1000, availableUsdt: 1000 };
    });
    const executor = new LiveExecutor(adapter, 0);
    const desk = new Desk(cfg, makeCaller(cfg), { executor, reportsDir: null, learningsPath: null, conversationsPath: null, killFile: null });
    const position = desk.book.open(ticket);
    adapter.pos = [{ ...position, unrealizedPnl: 0 }];
    try {
      const sync = desk.syncLive();
      await started;
      const switching = desk.reloadRuntimeConfig(paperEnv);
      await Promise.resolve();
      expect(desk.cfg.tradingMode).toBe('LIVE');
      release();
      await Promise.all([sync, switching]);
      expect(desk.cfg.tradingMode).toBe('PAPER');
      expect(desk.book.positions).toHaveLength(0);
      expect(executor.journal.positions).toHaveLength(1);
      expect(executor.journal.positions[0]?.id).toBe(position.id);
      desk.book.open({ ...ticket, symbol: 'ETHUSDT' });
      expect(executor.journal.positions.map(p => p.symbol)).toEqual(['BTCUSDT']);
    } finally { release(); desk.stop(); vi.restoreAllMocks(); }
  });
});
