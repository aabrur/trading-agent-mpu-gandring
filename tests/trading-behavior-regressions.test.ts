import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server/config.js';
import { runAgent } from '../server/agents/run.js';
import { saveTradingProfile } from '../server/setup/trading.js';
import { readEnv, setEnv } from '../cli/envfile.js';
import { DEFAULT_TRADING_SETTINGS, resolveTradingPreset, resolveTradingSettings, TRADING_PRESETS, TRADING_PRESET_IDS } from '../server/trading-settings.js';
import { planOrder } from '../server/money.js';
import { previewTicket } from '../server/sizing.js';
import { Desk } from '../server/desk.js';
import { makeCaller } from '../server/providers/index.js';
import * as market from '../server/market/index.js';
import { sampleSnapshot } from '../server/market/sample.js';

describe('Owner profile margin protection', () => {
  it.each(TRADING_PRESET_IDS)('%s uses its exact margin SL/TP for LONG and SHORT without equity risk resizing', (profile) => {
    const values = resolveTradingPreset(profile, DEFAULT_TRADING_SETTINGS);
    for (const side of ['LONG', 'SHORT'] as const) {
      const plan = planOrder({ balance: 1000, equity: 1, safetyNet: 200, n: 4, openPositions: 0, usedMargin: 0, price: 100, side, sizeFactor: 1, leverage: values.maxLeverage, stopPct: values.defaultStopPct, takeProfitPct: values.takeProfitPct, takeProfitR: 999, minStopPct: 99, maxStopPct: 0.01, maxLossPerTradePct: 0.001, minOrderUsdt: 5, takerFee: 0, rules: { qtyStep: 0.001, minQty: 0.001, tickSize: 0.00000001 } });
      expect(plan.ok).toBe(true);
      if (!plan.ok) continue;
      expect(plan.margin).toBe(200);
      expect(Math.abs(100 - plan.stop) * plan.qty).toBeCloseTo(200 * values.defaultStopPct / 100, 6);
      expect(Math.abs(plan.tp! - 100) * plan.qty).toBeCloseTo(200 * values.takeProfitPct! / 100, 2);
      expect(plan.notes).not.toEqual(expect.arrayContaining([expect.stringMatching(/size cut|loss cap|floor/i)]));
    }
  });

  it('accepts a 0.05% price stop below the removed 1.2% floor', () => {
    const plan = planOrder({ balance: 1000, safetyNet: 200, n: 4, openPositions: 0, usedMargin: 0, price: 100, side: 'LONG', sizeFactor: 1, leverage: 20, stopPct: 1, takeProfitPct: 60, minStopPct: 1.2, minOrderUsdt: 5 });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.stop).toBeCloseTo(99.95);
  });

  it('uses the active profile in preview and execution despite stale agent stop, TP and size choices', async () => {
    const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', TAKER_FEE: '0' });
    Object.assign(cfg.risk, resolveTradingPreset('profit', DEFAULT_TRADING_SETTINGS));
    const desk = new Desk(cfg, makeCaller(cfg), { reportsDir: null, killFile: null, learningsPath: null });
    try {
      const preview = previewTicket(cfg, { balance: 1000, equity: 1000, safetyNet: 200, n: 4, open: 0, used: 0, mode: 'PAPER' }, { symbol: 'BTCUSDT', side: 'LONG', entry: 100, stop: 99.99 }, null);
      const opened = await desk.executeOpen('BTCUSDT', 'LONG', 100, { sizeFactor: 0, leverage: 15, stopPct: 0.01, stop: 99.99, tp: 100.01, autonomous: true, confidence: 0.6 });
      expect(preview.ok).toBe(true);
      expect(opened.ok).toBe(true);
      expect(opened.order).toMatchObject({ stop: preview.data?.stop, tp: preview.data?.tp, leverage: 15, margin: 200 });
      expect(opened.order?.stop).not.toBe(99.99);
      expect(opened.order?.tp).not.toBe(100.01);
    } finally { desk.stop(); }
  });

  it('executes a 60% Lead entry without calling a second risk model or applying mood sizing', async () => {
    const snap = sampleSnapshot('BTCUSDT');
    snap.candles = Array.from({ length: 70 }, (_, i) => ({ t: Date.now() - (71 - i) * 900_000, o: 100 + i, h: 102 + i, l: 99 + i, c: 101 + i, v: 100 }));
    snap.last = 170; snap.bid = 170; snap.ask = 170; snap.fetchedAt = Date.now();
    const spy = vi.spyOn(market, 'getSnapshot').mockResolvedValue(snap);
    const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEBATE_PACE_MS: '0', DEBATE_ROUNDS: '1', TAKER_FEE: '0' });
    const base = makeCaller(cfg);
    const caller = vi.fn((request: Parameters<typeof base>[0]) => request.task === 'lead' ? Promise.resolve(JSON.stringify({ action: 'OPEN_LONG', confidence: 0.6, reason: 'Uptrend confirmed.' })) : base(request));
    const desk = new Desk(cfg, caller, { reportsDir: null, killFile: null, learningsPath: null });
    desk.agents.risk.mood = -2;
    desk.agents.lead.mood = -2;
    desk.book.safetyNet = 1;
    try {
      const verdict = await desk.runDebate('BTCUSDT');
      expect(verdict.action).toBe('OPEN_LONG');
      expect(verdict.executed).toBe(true);
      expect(caller.mock.calls.some(([request]) => request.task === 'risk')).toBe(false);
      const payload = caller.mock.calls.find(([request]) => request.task === 'lead')![0].user;
      expect(payload).toContain('order margin before fees');
      for (const legacyField of ['maxLossPerTradePct', 'minStopPct', 'takeProfitR', '"cautious"']) expect(payload).not.toContain(legacyField);
      expect(verdict.order?.leverage).toBe(5);
      expect(verdict.order?.margin).toBeGreaterThan(249);
      snap.last = 169; snap.bid = 169; snap.ask = 169;
      await desk.refreshTickers();
      expect(desk.book.unrealized).toBeLessThan(-0.625); // Past the removed auto-hedge trigger, above the profile stop.
      expect(desk.book.positions).toHaveLength(1);
    } finally { desk.stop(); spy.mockRestore(); }
  });
});

describe('saved trading intent', () => {
  it('keeps reviewed preset values across later preset changes and preserves manual settings', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mpu-intent-'));
    const file = path.join(dir, 'settings.env');
    const original = TRADING_PRESETS.profit.values.maxLeverage;
    try {
      setEnv(file, { MAINNET_DESK_MAX_LEVERAGE: '3' });
      const before = readEnv(file);
      const values = { ...DEFAULT_TRADING_SETTINGS, ...TRADING_PRESETS.profit.values, safetyNet: 2 };
      const saved = saveTradingProfile(file, { network: 'mainnet', profile: 'profit', values });
      TRADING_PRESETS.profit.values.maxLeverage = 9;
      expect(resolveTradingSettings(readEnv(file), DEFAULT_TRADING_SETTINGS, 'mainnet').values).toEqual(values);
      expect(saved.values).toEqual(values);
      expect(readEnv(file).MAINNET_DESK_MAX_LEVERAGE).toBe('3');
      expect(readEnv(file).AUTO_TRADING).toBe(before.AUTO_TRADING);
      expect(readEnv(file).TRADING_MODE).toBe(before.TRADING_MODE);
    } finally {
      TRADING_PRESETS.profit.values.maxLeverage = original;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Risk response handling', () => {
  const cfg = loadConfig({ TRADING_MODE: 'PAPER' });
  const input = { instruction: 'Gate this proposal.', data: {}, context: {} };
  it('accepts an explicit rejection without inventing an approval or requiring unused sizing', async () => {
    const result = await runAgent(cfg, async () => JSON.stringify({ decision: 'REJECT', reason: 'No available daily budget.' }), 'risk', 'risk', input);
    expect(result.fallback).toBe(false);
    expect(result.data).toMatchObject({ decision: 'REJECT', sizeFactor: 0 });
  });
  it.each([undefined, '2', null, 0, -1])('never fabricates a stop for an invalid approval: %s', async (stopPct) => {
    const result = await runAgent(cfg, async () => JSON.stringify({ decision: 'APPROVE', sizeFactor: 1, leverage: 2, stopPct, reason: 'Setup fits.' }), 'risk', 'risk', input);
    expect(result.fallback).toBe(true);
    expect(result.data.decision).toBe('REJECT');
    expect(result.data.reason).toContain('stopPct');
  });
});

describe('autonomous exits', () => {
  it.each(['CLOSE', 'OPEN_SHORT'] as const)('does not exit an intact LONG thesis on a model %s alone', async (action) => {
    const snap = sampleSnapshot('BTCUSDT');
    snap.candles = Array.from({ length: 70 }, (_, i) => {
      const c = 100 + i;
      return { t: Date.now() - (71 - i) * 900_000, o: c, h: c + 1, l: c - 1, c, v: 100 };
    });
    snap.last = 169; snap.bid = 169; snap.ask = 169; snap.fetchedAt = Date.now();
    const spy = vi.spyOn(market, 'getSnapshot').mockResolvedValue(snap);
    const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEBATE_PACE_MS: '0', DEBATE_ROUNDS: '1' });
    const base = makeCaller(cfg);
    const d = new Desk(cfg, (r) => r.task === 'lead' ? Promise.resolve(JSON.stringify({ action, confidence: 0.8, reason: 'Minor pullback, close now.' })) : base(r), { reportsDir: null, killFile: null, jevEnv: { JEV_ENABLED: 'false' } });
    d.book.open({ symbol: 'BTCUSDT', side: 'LONG', qty: 1, entry: 168, stop: 150, tp: 200, margin: 84, leverage: 2 });
    try {
      const verdict = await d.runDebate('BTCUSDT');
      expect(verdict.action).toBe('HOLD');
      expect(verdict.executed).toBe(false);
      expect(verdict.reason).toContain('structural reversal');
      expect(d.book.positions).toHaveLength(1);
    } finally { d.stop(); spy.mockRestore(); }
  });
  it.each(['LONG', 'SHORT'] as const)('allows a low-confidence CLOSE after a confirmed reversal of a %s', async (side) => {
    const snap = sampleSnapshot('BTCUSDT');
    snap.candles = Array.from({ length: 70 }, (_, i) => {
      const c = side === 'LONG' ? 200 - i : 100 + i;
      return { t: Date.now() - (71 - i) * 900_000, o: c, h: c + 1, l: c - 1, c, v: 100 };
    });
    snap.last = snap.candles.at(-1)!.c; snap.bid = snap.last; snap.ask = snap.last; snap.fetchedAt = Date.now();
    const spy = vi.spyOn(market, 'getSnapshot').mockResolvedValue(snap);
    const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEBATE_PACE_MS: '0', MIN_ENTRY_CONFIDENCE_PCT: '90' });
    const base = makeCaller(cfg);
    const d = new Desk(cfg, (r) => r.task === 'lead' ? Promise.resolve(JSON.stringify({ action: 'CLOSE', closeTrigger: 'MOMENTUM_REVERSAL', confidence: 0.1, reason: 'Confirmed reversal.' })) : base(r), { reportsDir: null, killFile: null, jevEnv: { JEV_ENABLED: 'false' } });
    d.book.open({ symbol: 'BTCUSDT', side, qty: 1, entry: 150, stop: side === 'LONG' ? 100 : 200, tp: null, margin: 75, leverage: 2 });
    try {
      const verdict = await d.runDebate('BTCUSDT');
      expect(verdict.action).toBe('CLOSE');
      expect(verdict.executed).toBe(true);
      expect(d.book.positions).toHaveLength(0);
    } finally { d.stop(); spy.mockRestore(); }
  });
});
