import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadConfig } from '../server/config.js';
import { Desk } from '../server/desk.js';
import { AutoTrader } from '../server/auto.js';
import { makeCaller } from '../server/providers/index.js';
import { LiveExecutor } from '../server/live/executor.js';
import { MemoryAdapter } from './fakes.js';
import type { Candle, MarketSnapshot } from '../server/types.js';

vi.mock('../server/market/index.js', async (orig) => {
  const m = await orig<typeof import('../server/market/index.js')>();
  return { ...m, getSnapshot: async (s: string) => ({ ...(await m.getSnapshot(s, 'sample')), example: false }) };
});

const base = {
  TRADING_MODE: 'PAPER',
  MARKET_SOURCE: 'sample',
  DEBATE_PACE_MS: '0',
  AUTO_TRADING: 'on',
  AUTO_SYMBOLS: 'ETHUSDT,BTCUSDT,SOLUSDT',
  OPEN_ORDERS_N: '2'
};

const testnetDefaults = {
  EXCHANGE: 'bybit',
  BYBIT_TESTNET_API_KEY: 'tnKEY000000000001',
  BYBIT_TESTNET_API_SECRET: 'tnSECRETzzzzzzzzzzzzzzzz01'
};

const setupDesk = (
  extra: Record<string, string> = {},
  adapterOpts?: { balance?: number; withExecutor?: boolean }
) => {
  const isTestnet = extra.TRADING_MODE === 'TESTNET';
  const c = loadConfig({ ...base, ...(isTestnet ? testnetDefaults : {}), ...extra });
  const a = new MemoryAdapter();
  if (adapterOpts?.balance) {
    a.balance = async () => ({ equityUsdt: adapterOpts.balance!, availableUsdt: adapterOpts.balance! });
  }
  a.fillAt = (o) => (o.side === 'LONG' ? o.stop * 1.02 : o.stop * 0.98);
  a.closeAt = () => (a.placed.length ? a.fillAt(a.placed[a.placed.length - 1]) : 100);
  const useExecutor = adapterOpts?.withExecutor ?? isTestnet;
  const desk = new Desk(c, makeCaller(c), {
    reportsDir: null,
    executor: useExecutor ? new LiveExecutor(a, 0) : undefined
  });
  return { c, a, desk, auto: new AutoTrader(desk, 0) };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('Position-First Autonomous Trading Lifecycle (v0.0.0.3.20)', () => {
  it('1. N=2 with ETH and BTC open: both reviewed, no third entry', async () => {
    const { desk, auto } = setupDesk();
    desk.book.n = 2;
    desk.book.open({ symbol: 'ETHUSDT', side: 'SHORT', qty: 1, entry: 3100, stop: 3400, tp: 2600, margin: 100, leverage: 5 });
    desk.book.open({ symbol: 'BTCUSDT', side: 'LONG', qty: 0.1, entry: 67000, stop: 60000, tp: 75000, margin: 100, leverage: 5 });
    expect(desk.book.positions).toHaveLength(2);

    const result = await auto.cycle();
    expect(result.ran).toEqual(['ETHUSDT', 'BTCUSDT']);
    expect(desk.book.positions).toHaveLength(2);
    expect(desk.book.positions.map((p) => p.symbol)).toEqual(['ETHUSDT', 'BTCUSDT']);
    expect(desk.logs.some((l) => /CAPACITY_FULL \/ MANAGING_POSITIONS/.test(l.text))).toBe(true);
  });

  it('2. Two healthy positions: both HOLD, no forced closure', async () => {
    const { desk, auto } = setupDesk();
    desk.book.n = 2;
    desk.book.open({ symbol: 'ETHUSDT', side: 'SHORT', qty: 1, entry: 3100, stop: 3400, tp: 2600, margin: 100, leverage: 5 });
    desk.book.open({ symbol: 'BTCUSDT', side: 'LONG', qty: 0.1, entry: 67000, stop: 60000, tp: 75000, margin: 100, leverage: 5 });

    await auto.cycle();
    expect(desk.book.positions).toHaveLength(2);
    expect(desk.activity.filter((a) => a.kind === 'closed')).toHaveLength(0);
    const verdicts = desk.verdicts.filter((v) => v.symbol === 'ETHUSDT' || v.symbol === 'BTCUSDT');
    expect(verdicts.every((v) => v.action === 'HOLD')).toBe(true);
  });

  it('3. ETH closes completely: one confirmed free slot allows candidate entry', async () => {
    const { desk, auto } = setupDesk();
    desk.book.n = 2;
    desk.book.open({ symbol: 'ETHUSDT', side: 'LONG', qty: 1, entry: 3100, stop: 2800, tp: 3600, margin: 100, leverage: 5 });
    desk.book.open({ symbol: 'BTCUSDT', side: 'LONG', qty: 0.1, entry: 67000, stop: 60000, tp: 75000, margin: 100, leverage: 5 });

    // Mock invalidated method on desk to force structural invalidation on ETH
    const originalInvalidated = (desk as any).invalidated.bind(desk);
    (desk as any).invalidated = (side: 'LONG' | 'SHORT', rule: any) => {
      if (rule?.symbol === 'ETHUSDT' || desk.debate?.symbol === 'ETHUSDT') return true;
      return originalInvalidated(side, rule);
    };

    // Make Mock caller produce CLOSE for ETH
    const originalRun = (desk as any).run.bind(desk);
    (desk as any).run = async (agent: string, task: string, opts: any) => {
      const res = await originalRun(agent, task, opts);
      if (task === 'lead' && (opts.data?.symbol === 'ETHUSDT' || opts.context?.symbol === 'ETHUSDT')) {
        res.data.action = 'CLOSE';
        res.data.reason = 'Structural reversal confirmed below EMA21 with negative momentum.';
      }
      return res;
    };

    const res = await auto.cycle();
    expect(res.ran).toContain('ETHUSDT');
    expect(desk.book.positions.some((p) => p.symbol === 'ETHUSDT')).toBe(false);
    expect(desk.activity.some((a) => a.kind === 'closed' && a.symbol === 'ETHUSDT')).toBe(true);
  });

  it('4. BTC partial close: slot remains occupied', async () => {
    const { desk } = setupDesk();
    desk.book.n = 2;
    const p1 = desk.book.open({ symbol: 'ETHUSDT', side: 'SHORT', qty: 1, entry: 3100, stop: 3400, tp: 2600, margin: 100, leverage: 5 });
    const p2 = desk.book.open({ symbol: 'BTCUSDT', side: 'LONG', qty: 0.1, entry: 67000, stop: 60000, tp: 75000, margin: 100, leverage: 5 });

    // Execute partial close on BTC: close 0.04 out of 0.1
    const closed = desk.book.close(p2.id, 68000, 'partial take profit', { qty: 0.04 });
    expect(closed).not.toBeNull();
    expect(closed!.remainingQty).toBe(0.06);

    // Position remains in book
    expect(desk.book.positions).toHaveLength(2);
    const btc = desk.book.positions.find((p) => p.symbol === 'BTCUSDT');
    expect(btc).toBeDefined();
    expect(btc!.qty).toBe(0.06);

    // Free slots must be 0
    const slots = desk.availableSlots();
    expect(slots.freeSlots).toBe(0);
    expect(slots.canOpenNew).toBe(false);
  });

  it('5. Exchange stop triggers outside the application: reconciliation detects the freed slot', async () => {
    const { desk, a } = setupDesk({ TRADING_MODE: 'TESTNET' }, { withExecutor: true });
    desk.book.n = 2;
    // Two positions initially on venue
    a.pos = [
      { symbol: 'ETHUSDT', side: 'SHORT', qty: 1, entry: 3100, stop: 3400, tp: 2600, unrealizedPnl: 0 },
      { symbol: 'BTCUSDT', side: 'LONG', qty: 0.1, entry: 67000, stop: 60000, tp: 75000, unrealizedPnl: 0 }
    ];
    await desk.syncLive();
    expect(desk.book.positions).toHaveLength(2);
    expect(desk.availableSlots().freeSlots).toBe(0);

    // Outside the app, ETH stop triggers on the exchange, leaving only BTC
    a.pos = [
      { symbol: 'BTCUSDT', side: 'LONG', qty: 0.1, entry: 67000, stop: 60000, tp: 75000, unrealizedPnl: 0 }
    ];

    // Next sync reconciles that ETH is flat on exchange
    await desk.syncLive();
    expect(desk.book.positions).toHaveLength(1);
    expect(desk.book.positions[0].symbol).toBe('BTCUSDT');
    expect(desk.availableSlots().freeSlots).toBe(1);
    expect(desk.availableSlots().canOpenNew).toBe(true);
  });

  it('6. Pending CLOSE with unknown status: no premature slot release', async () => {
    const { desk, a } = setupDesk({ TRADING_MODE: 'TESTNET' }, { withExecutor: true });
    desk.book.n = 2;
    a.pos = [
      { symbol: 'ETHUSDT', side: 'SHORT', qty: 1, entry: 3100, stop: 3400, tp: 2600, unrealizedPnl: 0 },
      { symbol: 'BTCUSDT', side: 'LONG', qty: 0.1, entry: 67000, stop: 60000, tp: 75000, unrealizedPnl: 0 }
    ];
    await desk.syncLive();
    expect(desk.availableSlots().freeSlots).toBe(0);

    // Simulate an in-flight close intent on BTC that is not yet settled
    const ex = (desk as any).opts.executor as LiveExecutor;
    ex.journal.intents.push({
      symbol: 'BTCUSDT',
      side: 'LONG',
      qty: 0.1,
      requestedQty: 0.1,
      kind: 'close',
      clientId: 'cPendingTest',
      accountedQty: 0,
      accountedValue: 0,
      record: { clientId: 'cPendingTest', orderId: '', status: 'unknown', filledQty: 0, avgPrice: null },
      at: Date.now()
    });

    const slots = desk.availableSlots();
    expect(slots.freeSlots).toBe(0);
    expect(slots.canOpenNew).toBe(false);
  });

  it('7. New candidate APPROVE while slots full: no order submission', async () => {
    const { desk } = setupDesk();
    desk.book.n = 2;
    desk.book.open({ symbol: 'ETHUSDT', side: 'SHORT', qty: 1, entry: 3100, stop: 3400, tp: 2600, margin: 100, leverage: 5 });
    desk.book.open({ symbol: 'BTCUSDT', side: 'LONG', qty: 0.1, entry: 67000, stop: 60000, tp: 75000, margin: 100, leverage: 5 });

    // Attempt direct open while slots are full
    const openRes = await desk.executeOpen('SOLUSDT', 'LONG', 150, { sizeFactor: 1, leverage: 5, stopPct: 20 });
    expect(openRes.ok).toBe(false);
    expect(openRes.reason).toMatch(/All 2 slots occupied|Position limit reached|Already 2 open position/i);
    expect(desk.book.positions).toHaveLength(2);

    // Attempt debate on candidate SOLUSDT while slots full: converts to HOLD
    const verdict = await desk.runDebate('SOLUSDT');
    expect(verdict.action).toBe('HOLD');
    expect(verdict.executed).toBe(false);
    expect(verdict.reason).toMatch(/All N order slots are taken|Capacity full/i);
  });

  it('8. Sudden adverse momentum with confirmed structural invalidation: existing legitimate CLOSE flow remains available', async () => {
    const { desk } = setupDesk();
    desk.book.n = 2;
    desk.book.open({ symbol: 'ETHUSDT', side: 'LONG', qty: 1, entry: 3100, stop: 2800, tp: 3600, margin: 100, leverage: 5 });

    // Force strategy invalidation in rule
    const rule = {
      side: 'SHORT' as const,
      close: 2350,
      ema21: 2450,
      change5Pct: -3.5,
      barTime: Date.now(),
      ema9: 2400,
      adx: 25,
      regime: 'STRONG_DOWNTREND'
    };

    const isInvalid = (desk as any).invalidated('LONG', rule);
    expect(isInvalid).toBe(true);

    // Close position through executeClose
    const closed = await desk.executeClose('ETHUSDT', 2350, 'structural invalidation', true);
    expect(closed).toHaveLength(1);
    expect(closed[0].symbol).toBe('ETHUSDT');
    expect(closed[0].remainingQty).toBe(0);
    expect(desk.book.positions).toHaveLength(0);
  });

  it('9. Favorable momentum while position thesis remains valid: HOLD is not converted to CLOSE merely to free capacity', async () => {
    const { desk } = setupDesk();
    desk.book.n = 2;
    desk.book.open({ symbol: 'BTCUSDT', side: 'LONG', qty: 0.1, entry: 67000, stop: 60000, tp: 75000, margin: 100, leverage: 5 });

    // Favorable price above EMA21 with positive momentum for a long position
    const rule = {
      side: 'LONG' as const,
      close: 69000,
      ema21: 67500,
      change5Pct: 2.1,
      barTime: Date.now(),
      ema9: 68500,
      adx: 30,
      regime: 'STRONG_UPTREND'
    };

    const isInvalid = (desk as any).invalidated('LONG', rule);
    expect(isInvalid).toBe(false);

    // Run debate: position thesis remains valid, produces HOLD
    const verdict = await desk.runDebate('BTCUSDT');
    expect(verdict.action).toBe('HOLD');
    expect(desk.book.positions).toHaveLength(1);
  });

  it('10. External positions: count toward N, no unauthorized automated management', async () => {
    const { desk, auto } = setupDesk();
    desk.book.n = 2;
    // 1 managed position, 1 external position
    desk.book.open({ symbol: 'ETHUSDT', side: 'SHORT', qty: 1, entry: 3100, stop: 3400, tp: 2600, margin: 100, leverage: 5 });
    const pExt = desk.book.open({ symbol: 'BNBUSDT', side: 'LONG', qty: 2, entry: 550, stop: 520, tp: 600, margin: 100, leverage: 5 });
    pExt.ownership = 'external';

    // Slots must see 2 occupied
    const slots = desk.availableSlots();
    expect(slots.occupiedSlots).toBe(2);
    expect(slots.freeSlots).toBe(0);
    expect(slots.canOpenNew).toBe(false);

    // Auto cycle should only manage ETH, never external BNB
    const res = await auto.cycle();
    expect(res.ran).toEqual(['ETHUSDT']);
    expect(desk.book.positions).toHaveLength(2);
    expect(desk.book.positions.find((p) => p.symbol === 'BNBUSDT')?.ownership).toBe('external');
  });

  it('11. Stale venue data: no new entry from assumed capacity', async () => {
    const { desk, a } = setupDesk({ TRADING_MODE: 'TESTNET' }, { withExecutor: true });
    desk.book.n = 2;

    // Simulate venue reconciliation failure
    a.balance = async () => { throw new Error('Exchange balance request timed out'); };

    // Trigger reconciliation failure
    await desk.syncLive().catch(() => {});

    const slots = desk.availableSlots();
    expect(slots.freeSlots).toBe(0);
    expect(slots.canOpenNew).toBe(false);
    expect(slots.reason).toMatch(/Exchange account observation unverified or stale/);

    const openRes = await desk.executeOpen('ETHUSDT', 'LONG', 3100, { sizeFactor: 1, leverage: 5, stopPct: 20 });
    expect(openRes.ok).toBe(false);
    expect(openRes.reason).toMatch(/Exchange account observation unverified or stale|Could not confirm/i);
  });

  it('12. Concurrent manual and auto requests: cannot exceed N', async () => {
    const { desk } = setupDesk();
    desk.book.n = 2;
    desk.book.open({ symbol: 'ETHUSDT', side: 'SHORT', qty: 1, entry: 3100, stop: 3400, tp: 2600, margin: 100, leverage: 5 });
    expect(desk.book.positions).toHaveLength(1);

    // Dispatch two concurrent opens for different symbols
    const [res1, res2] = await Promise.all([
      desk.executeOpen('SOLUSDT', 'LONG', 150, { sizeFactor: 1, leverage: 5, stopPct: 20 }),
      desk.executeOpen('BTCUSDT', 'LONG', 67000, { sizeFactor: 1, leverage: 5, stopPct: 20 })
    ]);

    // Exactly one must succeed, the other must fail due to N limit
    const successCount = (res1.ok ? 1 : 0) + (res2.ok ? 1 : 0);
    expect(successCount).toBe(1);
    expect(desk.book.positions).toHaveLength(2);
    expect(desk.availableSlots().freeSlots).toBe(0);
  });

  it('13. Kill switch, pause, existing SL/TP, and owner trading parameters remain unchanged', async () => {
    const { desk, auto } = setupDesk();
    desk.book.n = 2;

    // Verify owner parameters remain as configured
    expect(desk.cfg.risk.defaultStopPct).toBe(20);
    expect(desk.cfg.risk.takeProfitPct).toBe(60);
    expect(desk.book.n).toBe(2);

    // Pause blocks cycle
    desk.paused = true;
    const pausedRes = await auto.cycle();
    expect(pausedRes.skipped).toBe('desk paused');

    desk.paused = false;
    expect(desk.paused).toBe(false);

    // Kill switch blocks cycle and flattens
    await desk.kill();
    expect(desk.killed).toBe(true);
    const killRes = await auto.cycle();
    expect(killRes.skipped).toBe('kill switch');
  });
});
