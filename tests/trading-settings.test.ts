import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { gb } from '../cli/gb';
import { previewTicket } from '../server/sizing';
import { LiveExecutor } from '../server/live/executor';
import { MemoryAdapter } from './fakes';
import { saveTradingProfile } from '../server/setup/trading';
import { readEnv, setEnv } from '../cli/envfile';
import { Desk } from '../server/desk';
import { makeCaller } from '../server/providers/index';
import { loadConfig } from '../server/config';
import { DEFAULT_TRADING_SETTINGS, draftProfile, entryConfidenceReason, resolveTradingPreset, resolveTradingSettings, TRADING_PRESETS, TRADING_PRESET_IDS, tradingSettingsFromConfig, TradingSettingsSchema } from '../server/trading-settings';

describe('network trading settings', () => {
  it('saves only the chosen network without overwriting legacy settings or the other profile', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mpu-profile-')), file = path.join(dir, 'settings.env');
    try {
      setEnv(file, { TRADING_MODE: 'LIVE', MAX_LEVERAGE: '8', MAINNET_DESK_PROFILE: 'manual', MAINNET_DESK_MAX_LEVERAGE: '5' });
      saveTradingProfile(file, { network: 'testnet', profile: 'manual', values: { ...DEFAULT_TRADING_SETTINGS, minEntryConfidencePct: 72, maxLeverage: 2 } });
      const env = readEnv(file);
      expect(env).toMatchObject({ TRADING_MODE: 'LIVE', MAX_LEVERAGE: '8', MAINNET_DESK_PROFILE: 'manual', MAINNET_DESK_MAX_LEVERAGE: '5', TESTNET_DESK_PROFILE: 'manual', TESTNET_DESK_MIN_ENTRY_CONFIDENCE_PCT: '72' });
      saveTradingProfile(file, { network: 'testnet', profile: 'default' });
      expect(readEnv(file).TESTNET_DESK_MIN_ENTRY_CONFIDENCE_PCT).toBe('72');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('applies active-network limits without changing mode, book equity, open positions or a latched daily stop', async () => {
    const cfg = loadConfig({ TRADING_MODE: 'TESTNET', EXCHANGE: 'bybit', BYBIT_TESTNET_API_KEY: 'test-key', BYBIT_TESTNET_API_SECRET: 'test-secret', MARKET_SOURCE: 'sample' });
    const d = new Desk(cfg, makeCaller(cfg), { reportsDir: null });
    d.book.open({ symbol: 'ETHUSDT', side: 'SHORT', qty: 0.01, entry: 3000, stop: 3030, tp: null, margin: 15, leverage: 2 });
    const positions = structuredClone(d.book.positions);
    d.checkDay(); d.day.lossHit = true; const day = { ...d.day }, balance = d.book.balance;
    expect(await d.applyTradingSettings('mainnet', 'manual', { ...DEFAULT_TRADING_SETTINGS, maxLeverage: 2 })).toBe(false);
    expect(await d.applyTradingSettings('testnet', 'manual', { ...DEFAULT_TRADING_SETTINGS, safetyNet: 25, maxPositions: 2, maxLossPerTradePct: 0.4, minEntryConfidencePct: 70 })).toBe(true);
    expect(cfg.risk).toMatchObject({ maxLossPerTradePct: 0.4, minEntryConfidencePct: 70 });
    expect(cfg.tradingMode).toBe('TESTNET'); expect(d.day).toEqual(day); expect(d.book.balance).toBe(balance); expect(d.book.n).toBe(2);
    expect(d.book.positions).toEqual(positions);
  });
  it('turns low-confidence autonomous entries into HOLD without calling Risk, while leaving CLOSE available', async () => {
    const cfg = loadConfig({ MARKET_SOURCE: 'sample', DEBATE_PACE_MS: '0' }); cfg.risk.minEntryConfidencePct = 75;
    const base = makeCaller(cfg), caller = vi.fn((r: Parameters<typeof base>[0]) => r.task === 'lead' ? Promise.resolve(JSON.stringify({ action: 'OPEN_LONG', confidence: 0.74, reason: 'setup' })) : base(r));
    const d = new Desk(cfg, caller, { reportsDir: null });
    const verdict = await d.runDebate('BTCUSDT');
    expect(verdict.action).toBe('HOLD'); expect(verdict.reason).toContain('75%');
    expect(caller.mock.calls.some(([r]) => r.task === 'risk')).toBe(false);
    expect(caller.mock.calls.find(([r]) => r.task === 'lead')?.[0].user).toContain('minEntryConfidencePct');
    const p = d.book.open({ symbol: 'BTCUSDT', side: 'LONG', qty: 0.001, entry: 60000, stop: 59400, tp: null, margin: 30, leverage: 2 });
    caller.mockImplementation((r) => r.task === 'lead' ? Promise.resolve(JSON.stringify({ action: 'CLOSE', confidence: 0.1, reason: 'invalidated' })) : base(r));
    expect((await d.runDebate('BTCUSDT')).action).toBe('CLOSE');
    expect(d.book.positions.some((row) => row.id === p.id)).toBe(false);
  });
  it('preserves existing settings until a network profile is explicitly selected', () => {
    const env = { TRADING_MODE: 'PAPER', MAX_LEVERAGE: '7', DEFAULT_STOP_PCT: '3', SAFETY_NET: '20', OPEN_ORDERS_N: '2' };
    const before = { ...env }, base = tradingSettingsFromConfig(loadConfig(env));
    expect(resolveTradingSettings(env, base, 'mainnet')).toEqual({ profile: 'current', values: base });
    expect(env).toEqual(before);
  });
  it('keeps testnet and mainnet independent and restores the app preset explicitly', () => {
    const env = { TESTNET_DESK_PROFILE: 'manual', TESTNET_DESK_MAX_LEVERAGE: '2', MAINNET_DESK_PROFILE: 'default', MAINNET_DESK_MAX_LEVERAGE: '9' };
    const base = { ...DEFAULT_TRADING_SETTINGS, maxLeverage: 6 };
    expect(resolveTradingSettings(env, base, 'testnet').values.maxLeverage).toBe(2);
    expect(resolveTradingSettings(env, base, 'mainnet').values).toEqual(DEFAULT_TRADING_SETTINGS);
  });
  it('validates profile values and allows the 25% daily cap without a minimum stop constraint', () => {
    for (const patch of [{ dailyLossLimitPct: 0 }, { dailyLossLimitPct: 26 }, { maxLossPerTradePct: 0 }, { minEntryConfidencePct: 101 }, { safetyNet: -1 }]) {
      expect(TradingSettingsSchema.safeParse({ ...DEFAULT_TRADING_SETTINGS, ...patch }).success).toBe(false);
    }
    expect(TradingSettingsSchema.safeParse({ ...DEFAULT_TRADING_SETTINGS, dailyLossLimitPct: 25, minStopPct: 0 }).success).toBe(true);
    expect(TradingSettingsSchema.safeParse({ ...DEFAULT_TRADING_SETTINGS, minStopPct: 3, defaultStopPct: 1 }).success).toBe(true);
  });
  it('loads the selected network into the same risk and allocation configuration used by execution', () => {
    const env = { TRADING_MODE: 'TESTNET', EXCHANGE: 'bybit', BYBIT_TESTNET_API_KEY: 'test-key', BYBIT_TESTNET_API_SECRET: 'test-secret', TESTNET_DESK_PROFILE: 'manual', TESTNET_DESK_DAILY_LOSS_LIMIT_PCT: '2', TESTNET_DESK_MAX_LOSS_PER_TRADE_PCT: '0.6', TESTNET_DESK_MIN_ENTRY_CONFIDENCE_PCT: '75', TESTNET_DESK_SAFETY_NET: '25', TESTNET_DESK_OPEN_ORDERS_N: '2' };
    const cfg = loadConfig(env);
    expect(cfg.risk).toMatchObject({ dailyLossLimitPct: 2, maxLossPerTradePct: 0.6, minEntryConfidencePct: 75 });
    expect(cfg.paper).toMatchObject({ safetyNet: 25, n: 2 });
    expect(cfg.live?.network).toBe('testnet');
  });
  it('accepts the exact confidence boundary and requires evidence only when a floor is enabled', async () => {
    expect(entryConfidenceReason(75, 0.75)).toBeNull();
    expect(entryConfidenceReason(0)).toBeNull();
    expect(entryConfidenceReason(75)).toContain('unavailable');
    const cfg = loadConfig({ MARKET_SOURCE: 'sample', APP_MODE: 'grokbot', MIN_ENTRY_CONFIDENCE_PCT: '75' });
    const d = new Desk(cfg, makeCaller(cfg), { reportsDir: null });
    for (const confidence of [undefined, 0.74]) {
      expect((await d.gbOpen({ symbol: 'ETHUSDT', side: 'LONG', stop: 3000, confidence }, true)).ok).toBe(false);
    }
    expect(d.book.positions).toHaveLength(0);
    // At the boundary, the profile supplies the mandatory stop without an agent stop price.
    const opened = await d.gbOpen({ symbol: 'ETHUSDT', side: 'SHORT', confidence: 0.75 }, true);
    expect(opened.ok).toBe(true);
    expect(opened.order?.stop).toBeGreaterThan(opened.order?.entry ?? Infinity);
  });
  it('uses profile margin SL/TP and allocation, ignoring the legacy equity loss cap and ticket stop', async () => {
    const cfg = loadConfig({ TRADING_MODE: 'TESTNET', EXCHANGE: 'bybit', BYBIT_TESTNET_API_KEY: 'test-key', BYBIT_TESTNET_API_SECRET: 'test-secret', MARKET_SOURCE: 'sample' });
    const d = new Desk(cfg, makeCaller(cfg), { reportsDir: null });
    await d.applyTradingSettings('testnet', 'manual', { ...DEFAULT_TRADING_SETTINGS, maxLossPerTradePct: 0.2, maxLeverage: 2, safetyNet: 100, maxPositions: 2, takeProfitR: 3 });
    const result = previewTicket(cfg, { balance: d.book.balance, equity: d.book.balance + d.book.unrealized, safetyNet: d.book.safetyNet, n: d.book.n, open: 0, used: 0, mode: 'TESTNET' }, { symbol: 'ETHUSDT', side: 'LONG', entry: 3000, stop: 2970, leverage: 8 }, { qtyStep: 0.001, minQty: 0.001, tickSize: 0.01, minNotional: 5 });
    expect(result.ok).toBe(true); expect(result.data).toMatchObject({ leverage: 2, stop: 2700, tp: 3900, stopMarginPct: 20, takeProfitMarginPct: 60, split: { moneyTrade: 900, perOrder: 450 } });
    expect(Number(result.data?.riskAtStop)).toBeGreaterThan(89);
    expect(result.data).not.toHaveProperty('maxLoss');
  });
  it('does not replace an active profile allocation with legacy values during a settings reload', async () => {
    const cfg = loadConfig({ TRADING_MODE: 'TESTNET', EXCHANGE: 'bybit', BYBIT_TESTNET_API_KEY: 'test-key', BYBIT_TESTNET_API_SECRET: 'test-secret', MARKET_SOURCE: 'sample' });
    const d = new Desk(cfg, makeCaller(cfg), { reportsDir: null, killFile: null });
    await d.applyTradingSettings('testnet', 'manual', { ...DEFAULT_TRADING_SETTINGS, safetyNet: 25, maxPositions: 2 });
    d.book.balance = 900;
    d.reloadRuntimeConfig({ PAPER_BALANCE: '1000', SAFETY_NET: '200', OPEN_ORDERS_N: '4' });
    expect(d.book.balance).toBe(900); expect(d.book.safetyNet).toBe(25); expect(d.book.n).toBe(2);
    expect(cfg.tradingMode).toBe('TESTNET'); d.stop();
  });
  it('waits for an in-flight reconciliation before changing active settings', async () => {
    const cfg = loadConfig({ TRADING_MODE: 'TESTNET', EXCHANGE: 'bybit', BYBIT_TESTNET_API_KEY: 'test-key', BYBIT_TESTNET_API_SECRET: 'test-secret', MARKET_SOURCE: 'sample' });
    const adapter = new MemoryAdapter();
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>((r) => { entered = r; });
    const blocked = new Promise<void>((r) => { release = r; });
    const positions = adapter.positions.bind(adapter);
    vi.spyOn(adapter, 'positions').mockImplementationOnce(async () => { entered(); await blocked; return positions(); });
    const d = new Desk(cfg, makeCaller(cfg), { reportsDir: null, executor: new LiveExecutor(adapter, 0) });
    const sync = d.syncLive(); await waiting;
    const change = d.applyTradingSettings('testnet', 'manual', { ...DEFAULT_TRADING_SETTINGS, maxLeverage: 2 });
    await Promise.resolve(); expect(cfg.risk.maxLeverage).toBe(DEFAULT_TRADING_SETTINGS.maxLeverage);
    release(); await sync; expect(await change).toBe(true); expect(cfg.risk.maxLeverage).toBe(2);
    expect(adapter.placed).toHaveLength(0);
  });
  it('caps an already-computed agent gate against the profile active when execution starts', async () => {
    const cfg = loadConfig({ MARKET_SOURCE: 'sample' });
    cfg.risk.maxLeverage = 2; cfg.risk.minEntryConfidencePct = 75;
    const adapter = new MemoryAdapter();
    const d = new Desk(cfg, makeCaller(cfg), { reportsDir: null, executor: new LiveExecutor(adapter, 0) });
    const result = await d.executeOpen('BTCUSDT', 'LONG', 60000, { sizeFactor: 1, leverage: 8, stopPct: 1.5, autonomous: true, confidence: 0.8 });
    expect(result.ok).toBe(true); expect(adapter.placed[0]?.leverage).toBe(2);
  });
  it('serves saved profiles, rejects cross-origin/invalid writes and saves an inactive network without changing mode', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mpu-profile-http-')), file = path.join(dir, 'settings.env');
    const oldEnv = { ...process.env };
    const built = createApp(loadConfig({ MARKET_SOURCE: 'sample' }), { reportsDir: null, learningsPath: null, killFile: null, envFile: file });
    try {
      await new Promise<void>((r) => built.server.listen(0, '127.0.0.1', r));
      const url = `http://127.0.0.1:${(built.server.address() as AddressInfo).port}/api/setup/trading`;
      const body = { network: 'mainnet', profile: 'manual', values: { ...DEFAULT_TRADING_SETTINGS, minEntryConfidencePct: 75, safetyNet: 25 } };
      const post = (value: unknown, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) });
      expect((await post(body, { origin: 'https://evil.example' })).status).toBe(403);
      expect((await post({ ...body, values: { ...body.values, maxLossPerTradePct: 0 } })).status).toBe(400);
      expect(await (await post(body)).json()).toMatchObject({ ok: true, applied: false });
      const info = await (await fetch(url)).json();
      expect(info.networks.mainnet.manual).toMatchObject({ minEntryConfidencePct: 75, safetyNet: 25 });
      expect(info.networks.testnet.profile).toBe('current');
      expect(info.running).toMatchObject({ mode: 'PAPER', profile: 'current' });
      expect(readEnv(file).TRADING_MODE).toBe('PAPER'); expect(built.desk.book.positions).toHaveLength(0);
      built.desk.cfg.risk.minEntryConfidencePct = 75;
      const cli = await gb(['open', 'ETHUSDT', 'LONG', '--stop', '3000'], { env: { APP_MODE: 'local' }, baseUrl: url.replace('/api/setup/trading', '') });
      expect(cli.ok).toBe(false); expect(cli.text).toContain('confidence is unavailable');
    } finally {
      built.desk.stop(); await new Promise((r) => built.server.close(r));
      for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
      Object.assign(process.env, oldEnv); rmSync(dir, { recursive: true, force: true });
    }
  });
  it('defines four Owner presets with exact values and schema validity', () => {
    expect(TRADING_PRESET_IDS).toEqual(['default', 'balance', 'profit', 'aggressive']);
    const base = { ...DEFAULT_TRADING_SETTINGS, minOrderUsdt: 12, safetyNet: 350 };

    const def = resolveTradingPreset('default', base);
    expect(def).toMatchObject({
      dailyLossLimitPct: 10,
      maxLossPerTradePct: 20,
      minEntryConfidencePct: 60,
      maxLeverage: 5,
      defaultStopPct: 20,
      minStopPct: 0,
      takeProfitPct: 60,
      takeProfitR: 3.0,
      maxPositions: 3,
      minOrderUsdt: 12,
      safetyNet: 350
    });
    expect(TradingSettingsSchema.safeParse(def).success).toBe(true);
    expect(draftProfile('profit')).toBe('profit');
    expect(draftProfile('current')).toBe('manual');
    expect(draftProfile('manual')).toBe('manual');
    expect(draftProfile('aggressive')).toBe('aggressive');

    const bal = resolveTradingPreset('balance', base);
    expect(bal).toMatchObject({
      dailyLossLimitPct: 15,
      maxLossPerTradePct: 30,
      minEntryConfidencePct: 60,
      maxLeverage: 10,
      defaultStopPct: 30,
      minStopPct: 0,
      takeProfitPct: 60,
      takeProfitR: 2.0,
      maxPositions: 3,
      minOrderUsdt: 12,
      safetyNet: 350
    });
    expect(TradingSettingsSchema.safeParse(bal).success).toBe(true);

    const prof = resolveTradingPreset('profit', base);
    expect(prof).toMatchObject({
      dailyLossLimitPct: 20,
      maxLossPerTradePct: 40,
      minEntryConfidencePct: 60,
      maxLeverage: 15,
      defaultStopPct: 40,
      minStopPct: 0,
      takeProfitPct: 70,
      takeProfitR: 1.75,
      maxPositions: 2,
      minOrderUsdt: 12,
      safetyNet: 350
    });
    expect(TradingSettingsSchema.safeParse(prof).success).toBe(true);

    const hr = resolveTradingPreset('aggressive', base);
    expect(hr).toMatchObject({
      dailyLossLimitPct: 25,
      maxLossPerTradePct: 50,
      minEntryConfidencePct: 60,
      maxLeverage: 20,
      defaultStopPct: 50,
      minStopPct: 0,
      takeProfitPct: 80,
      takeProfitR: 1.6,
      maxPositions: 2,
      minOrderUsdt: 12,
      safetyNet: 350
    });
    expect(TradingSettingsSchema.safeParse(hr).success).toBe(true);
  });
  it('persists recommended presets per network, preserving capital settings and manual drafts without side effects', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mpu-presets-')), file = path.join(dir, 'settings.env');
    try {
      setEnv(file, {
        TRADING_MODE: 'PAPER',
        SAFETY_NET: '250',
        MIN_ORDER_USDT: '10',
        TESTNET_DESK_SAFETY_NET: '80',
        TESTNET_DESK_MIN_ORDER_USDT: '15',
        TESTNET_DESK_MAX_LEVERAGE: '7'
      });

      const savedTestnet = saveTradingProfile(file, { network: 'testnet', profile: 'balance' });
      expect(savedTestnet.profile).toBe('balance');
      expect(savedTestnet.values.maxLeverage).toBe(10);
      expect(savedTestnet.values.safetyNet).toBe(80);
      expect(savedTestnet.values.minOrderUsdt).toBe(15);
      expect(savedTestnet.values.maxPositions).toBe(3);

      const envAfterTestnet = readEnv(file);
      expect(envAfterTestnet.TESTNET_DESK_PROFILE).toBe('balance');
      expect(envAfterTestnet.TESTNET_DESK_MAX_LEVERAGE).toBe('7');
      expect(envAfterTestnet.MAINNET_DESK_PROFILE).toBeUndefined();

      const savedMainnet = saveTradingProfile(file, { network: 'mainnet', profile: 'aggressive' });
      expect(savedMainnet.profile).toBe('aggressive');
      expect(savedMainnet.values.maxLeverage).toBe(20);
      expect(savedMainnet.values.safetyNet).toBe(250);
      expect(savedMainnet.values.minOrderUsdt).toBe(10);
      expect(savedMainnet.values.maxPositions).toBe(2);

      const envAfterMainnet = readEnv(file);
      expect(envAfterMainnet.MAINNET_DESK_PROFILE).toBe('aggressive');
      expect(envAfterMainnet.TESTNET_DESK_PROFILE).toBe('balance');
      expect(envAfterMainnet.TRADING_MODE).toBe('PAPER');

      const savedManual = saveTradingProfile(file, {
        network: 'testnet',
        profile: 'manual',
        values: { ...DEFAULT_TRADING_SETTINGS, maxLeverage: 5, safetyNet: 80 }
      });
      expect(savedManual.profile).toBe('manual');
      expect(savedManual.values.maxLeverage).toBe(5);
      expect(readEnv(file).TESTNET_DESK_PROFILE).toBe('manual');

      const cfg = loadConfig({ TRADING_MODE: 'TESTNET', EXCHANGE: 'bybit', BYBIT_TESTNET_API_KEY: 'k', BYBIT_TESTNET_API_SECRET: 's', MARKET_SOURCE: 'sample' });
      const desk = new Desk(cfg, makeCaller(cfg), { reportsDir: null, killFile: null });
      const applied = await desk.applyTradingSettings('testnet', 'profit', savedMainnet.values);
      expect(applied).toBe(true);
      expect(cfg.tradingProfile).toBe('profit');
      expect(cfg.risk.maxLeverage).toBe(20);
      expect(desk.book.n).toBe(2);
      expect(cfg.tradingMode).toBe('TESTNET');
      expect(desk.book.positions).toHaveLength(0);
      desk.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
