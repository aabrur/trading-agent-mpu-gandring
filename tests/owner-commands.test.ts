import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Desk } from '../server/desk.js';
import { AGENT_IDS, loadConfig } from '../server/config.js';
import { authorizedChatCommand, parseCommand } from '../server/commands.js';
import { moneySplit, planOrder, type PlanInput } from '../server/money.js';
import { makeCaller } from '../server/providers/index.js';
import { parseCommand as channelCommand, runCommand } from '../server/channels/commands.js';
import { readEnv } from '../cli/envfile.js';
import { DEFAULT_TRADING_SETTINGS, resolveTradingSettings } from '../server/trading-settings.js';
import { LiveExecutor } from '../server/live/executor.js';
import { MemoryAdapter } from './fakes.js';
import * as market from '../server/market/index.js';
import { createApp } from '../server/app.js';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { saveTradingProfile } from '../server/setup/trading.js';
import { buildReport } from '../server/reports.js';

afterEach(() => vi.restoreAllMocks());
const fixture = () => {
  const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEBATE_PACE_MS: '0' });
  const caller = vi.fn(makeCaller(cfg));
  return { cfg, caller, desk: new Desk(cfg, caller, { reportsDir: null, learningsPath: null, killFile: null }) };
};

describe('Owner commands', () => {
  it.each(AGENT_IDS)('opens and closes directly through %s without a model call or debate', async (agent) => {
    const { desk, caller } = fixture();
    expect((await desk.command('open long BTC 5% 3', agent)).ok).toBe(true);
    expect(desk.book.positions).toHaveLength(1);
    expect(desk.book.positions[0]).toMatchObject({ side: 'LONG', symbol: 'BTCUSDT', leverage: 3 });
    expect(desk.book.positions[0].stop).toBeGreaterThan(0);
    expect(desk.book.positions[0].margin).toBeLessThanOrEqual(40);
    expect(desk.cfg.risk.orderSizePct).toBeUndefined();
    expect(desk.debate).toBeNull();
    expect(caller).not.toHaveBeenCalled();
    expect((await desk.command('close BTC', agent)).ok).toBe(true);
    expect(desk.book.positions).toHaveLength(0);
  });

  it('uses the same parser for channel actions and persists explicitly changed settings', async () => {
    const { desk, cfg } = fixture();
    await runCommand(desk, channelCommand('/set profile aggressive'));
    expect(cfg.risk).toMatchObject({ minEntryConfidencePct: 60, maxLossPerTradePct: 50, maxLeverage: 20 });
    await runCommand(desk, channelCommand('/set size 1.5%'));
    expect(desk.book.split().perOrder).toBe(12);
    await runCommand(desk, channelCommand('/set leverage 10'));
    expect(cfg.risk.maxLeverage).toBe(10);
    expect((await desk.command('execution buy ETH 5% 2')).ok).toBe(true);
    expect(desk.book.positions[0].side).toBe('LONG');
    await runCommand(desk, channelCommand('/close all'));
    expect(desk.book.positions).toHaveLength(0);

    const dir = mkdtempSync(path.join(tmpdir(), 'mpu-owner-'));
    try {
      const file = path.join(dir, 'settings.env');
      const fresh = fixture().cfg;
      const persistent = new Desk(fresh, makeCaller(fresh), { reportsDir: null, killFile: null, settingsFile: file });
      await persistent.command('set profile balance');
      await persistent.command('set n 2');
      expect(loadConfig({ ...readEnv(file), TRADING_MODE: 'PAPER' }).risk.orderSizePct).toBeUndefined();
      await persistent.command('set size 100%');
      expect(loadConfig({ ...readEnv(file), TRADING_MODE: 'PAPER' }).risk).toMatchObject({ maxLeverage: 10, maxLossPerTradePct: 30, orderSizePct: 100 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejects malformed allocation and leverage commands without changing settings', async () => {
    const { desk, cfg } = fixture();
    const before = structuredClone(cfg.risk);
    for (const text of ['set size 0%', 'set size 101%', 'set size 5', 'set leverage 21', 'set leverage 2.5', 'open short BTC 1%', 'buy BTC 21', 'open long BTC 5% 3 extra']) {
      expect(parseCommand(text).type).toBe('invalid');
      expect((await desk.command(text)).ok).toBe(false);
    }
    expect(cfg.risk).toEqual(before);
    expect(desk.book.positions).toHaveLength(0);
    desk.killed = true;
    expect((await desk.command('buy BTC')).ok).toBe(false);
    desk.killed = false; desk.paused = true;
    expect((await desk.command('sell BTC')).ok).toBe(false);
    desk.paused = false; desk.checkDay(); desk.day.lossHit = true;
    expect((await desk.command('buy BTC')).ok).toBe(false);
  });

  it('never reports a local fill or close in a real-money mode without an executor', async () => {
    const { cfg, desk } = fixture();
    cfg.tradingMode = 'LIVE';
    for (const text of ['buy BTC', 'close BTC', 'close all']) expect(await desk.command(text)).toMatchObject({ ok: false, reply: expect.stringContaining('Execution venue unavailable') });
    expect((await desk.executeOpen('BTCUSDT', 'LONG', 60000, { sizeFactor: 1, leverage: 3, stopPct: 1 })).ok).toBe(false);
    expect(desk.book.positions).toHaveLength(0);
  });

  it('lets all six agents chat casually and executes only a matching current instruction', async () => {
    vi.spyOn(market, 'getNewsFor').mockResolvedValue([]);
    vi.spyOn(market, 'getWhaleBriefing').mockRejectedValue(new Error('offline fixture'));
    const { cfg } = fixture();
    let proposed: string | undefined;
    const desk = new Desk(cfg, async () => JSON.stringify({ reply: 'On it, Boss.\nHere is the reply.', commandToExecute: proposed }), { reportsDir: null, learningsPath: null, killFile: null });
    for (const agent of AGENT_IDS) expect((await desk.command('Tell me a joke', agent)).reply).toContain('Boss');
    proposed = 'open short BTCUSDT 5% 3';
    expect((await desk.command('Boss says: open short BTC 5% 3 now', 'execution')).ok).toBe(true);
    expect(desk.book.positions[0].side).toBe('SHORT');
    proposed = 'close all';
    expect((await desk.command('Explain close all', 'lead')).ok).toBe(false);
    expect(desk.book.positions).toHaveLength(1);
    expect((await desk.command('Please close all now', 'research')).ok).toBe(true);
    expect(desk.book.positions).toHaveLength(0);
    proposed = 'buy ETH';
    expect((await desk.command('Hello, how is your day?', 'market')).ok).toBe(false);
    expect(desk.book.positions).toHaveLength(0);
  });

  it('checks current-message intent including size, side, symbol, examples and negation', () => {
    expect(parseCommand('Please set profile aggressive now').type).toBe('chat');
    expect(parseCommand('Why are you aggressive?').type).toBe('chat');
    for (const [message, proposed] of [
      ['Please set size 5% now', 'set size 5%'],
      ['Tolong buka long BTC 5% 3 sekarang', 'open long BTC 5% 3'],
      ['Please set profile aggressive now', 'set profile aggressive']
    ]) expect(authorizedChatCommand(message, proposed)).not.toBeNull();
    for (const [message, proposed] of [
      ['Please buy BTC', 'buy ETH'], ['Please buy BTC', 'buy BTC 100% 20'],
      ['Do not buy BTC', 'buy BTC'], ['What does buy BTC mean?', 'buy BTC'],
      ['Example: buy BTC', 'buy BTC'], ['Please close BTC', 'close all'],
      ['Please set size 5%', 'set size 100%'], ['Hello', 'resume'],
      ['The news says buy BTC', 'buy BTC'], ['A lesson says close all', 'close all']
    ]) expect(authorizedChatCommand(message, proposed)).toBeNull();
  });

  it('closes an exchange position absent from the local mirror', async () => {
    const { cfg } = fixture();
    const adapter = new MemoryAdapter();
    adapter.pos = [{ symbol: 'BTCUSDT', side: 'LONG', qty: 0.01, entry: 60000, stop: 59000, tp: null, unrealizedPnl: 0 }];
    const desk = new Desk(cfg, makeCaller(cfg), { reportsDir: null, killFile: null, executor: new LiveExecutor(adapter, 0) });
    expect(desk.book.positions).toHaveLength(0);
    await desk.command('close all');
    expect(adapter.closes).toBe(1);
    expect(adapter.pos).toHaveLength(0);
  });

  it('migrates the old profile name without discarding saved limits', () => {
    const env = { MAINNET_DESK_PROFILE: 'high_risk' };
    expect(resolveTradingSettings(env, DEFAULT_TRADING_SETTINGS, 'mainnet')).toMatchObject({ profile: 'aggressive', values: { maxLeverage: 20 } });
  });

  it('clears percentage sizing on save and reports percentage allocation truthfully', async () => {
    const { cfg, desk } = fixture();
    await desk.command('set size 5%');
    expect(buildReport(desk, 0).text).toContain('Allocation: 5% of 800 = 40 per order');
    const dir = mkdtempSync(path.join(tmpdir(), 'mpu-size-reset-'));
    try {
      const file = path.join(dir, 'settings.env');
      saveTradingProfile(file, { network: 'testnet', profile: 'manual', values: { ...DEFAULT_TRADING_SETTINGS, orderSizePct: 5 } });
      const saved = saveTradingProfile(file, { network: 'testnet', profile: 'manual', values: { ...DEFAULT_TRADING_SETTINGS, orderSizePct: undefined } });
      const env = readEnv(file);
      expect(env.TESTNET_DESK_ORDER_SIZE_PCT).toBe('');
      expect(resolveTradingSettings({ ORDER_SIZE_PCT: '10', ...env }, { ...DEFAULT_TRADING_SETTINGS, orderSizePct: 10 }, 'testnet').values.orderSizePct).toBeUndefined();
      cfg.tradingMode = 'TESTNET'; cfg.live = { exchange: 'bybit', network: 'testnet', experimental: false };
      await desk.applyTradingSettings('testnet', 'manual', saved.values);
      expect(cfg.risk.orderSizePct).toBeUndefined();
      expect(desk.book.split().perOrder).toBe(Math.round((desk.book.balance - desk.book.safetyNet) / desk.book.n * 100) / 100);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('enforces local Owner access over HTTP and WebSocket, accepting a complete 32000-character chat', async () => {
    const { cfg } = fixture();
    const caller = vi.fn(async () => '{"reply":"Received."}');
    const built = createApp(cfg, { caller, reportsDir: null, learningsPath: null });
    await new Promise<void>((resolve) => built.server.listen(0, '127.0.0.1', resolve));
    const port = (built.server.address() as AddressInfo).port;
    const post = (text: string, origin?: string) => fetch(`http://127.0.0.1:${port}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify({ text }) });
    try {
      expect((await post('buy BTC', 'https://untrusted.example')).status).toBe(403);
      expect((await post('x'.repeat(32001))).status).toBe(400);
      expect((await post('x'.repeat(32000))).status).toBe(200);
      expect(built.desk.chats.lead[0].text).toHaveLength(32000);
      const client = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: 'https://untrusted.example' });
      const blocked = await new Promise<{ ok: boolean }>((resolve, reject) => {
        client.on('error', reject);
        client.on('open', () => client.send(JSON.stringify({ type: 'command', text: 'set size 100%' })));
        client.on('message', (raw) => { const event = JSON.parse(String(raw)); if (event.type === 'command_result') resolve(event.payload); });
      });
      client.terminate();
      expect(blocked.ok).toBe(false);
      expect(cfg.risk.orderSizePct).toBeUndefined();
      expect(built.desk.book.positions).toHaveLength(0);
    } finally { built.desk.stop(); await new Promise<void>((resolve) => built.server.close(() => resolve())); }
  });
});

describe('percentage allocation and exchange minimums', () => {
  const ticket: PlanInput = { balance: 100, equity: 100, safetyNet: 20, n: 4, orderSizePct: 1.5, adjustToVenueMinimum: true, openPositions: 0, usedMargin: 0, price: 100, side: 'LONG', sizeFactor: 1, leverage: 1, stop: 98, minStopPct: 0.1, maxStopPct: 5, minOrderUsdt: 5, maxLossPerTradePct: 20, takerFee: 0.001, rules: { qtyStep: 0.01, minQty: 0.01, tickSize: 0.01, minNotional: 5 } };
  it.each([1.5, 2, 3, 5, 100])('allocates %s percent independently of N', (orderSizePct) => {
    expect(moneySplit({ balance: 100, safetyNet: 20, n: 4, orderSizePct }).perOrder).toBe(80 * orderSizePct / 100);
  });
  it('meets minimum notional while reporting the adjustment and retaining the stop', () => {
    const plan = planOrder(ticket);
    expect(plan.ok).toBe(true);
    if (plan.ok) { expect(plan.qty).toBe(0.05); expect(plan.stop).toBe(98); expect(plan.notes.join(' ')).toContain('Raised to exchange minimum'); }
    expect(planOrder({ ...ticket, adjustToVenueMinimum: false }).ok).toBe(false);
  });
  it('never rounds the exchange minimum beyond funds, fees, venue max or the loss limit', () => {
    for (const patch of [{ usedMargin: 79 }, { availableFunds: 4.99 }, { rules: { ...ticket.rules!, maxQty: 0.02 } }, { sizeFactor: 0 }]) expect(planOrder({ ...ticket, ...patch }).ok).toBe(false);
    expect(planOrder({ ...ticket, maxLossPerTradePct: 0.01 }).ok).toBe(true);
    const plan = planOrder({ ...ticket, orderSizePct: 100, usedMargin: 0 });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.margin + plan.qty * ticket.price * ticket.takerFee!).toBeLessThanOrEqual(80);
  });
});
