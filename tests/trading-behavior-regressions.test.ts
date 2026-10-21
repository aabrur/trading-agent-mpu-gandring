import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server/config.js';
import { runAgent } from '../server/agents/run.js';
import { saveTradingProfile } from '../server/setup/trading.js';
import { readEnv, setEnv } from '../cli/envfile.js';
import { DEFAULT_TRADING_SETTINGS, resolveTradingSettings, TRADING_PRESETS } from '../server/trading-settings.js';
import { Desk } from '../server/desk.js';
import { makeCaller } from '../server/providers/index.js';
import * as market from '../server/market/index.js';
import { sampleSnapshot } from '../server/market/sample.js';

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
    const d = new Desk(cfg, (r) => r.task === 'lead' ? Promise.resolve(JSON.stringify({ action: 'CLOSE', confidence: 0.1, reason: 'Confirmed reversal.' })) : base(r), { reportsDir: null, killFile: null, jevEnv: { JEV_ENABLED: 'false' } });
    d.book.open({ symbol: 'BTCUSDT', side, qty: 1, entry: 150, stop: side === 'LONG' ? 100 : 200, tp: null, margin: 75, leverage: 2 });
    try {
      const verdict = await d.runDebate('BTCUSDT');
      expect(verdict.action).toBe('CLOSE');
      expect(verdict.executed).toBe(true);
      expect(d.book.positions).toHaveLength(0);
    } finally { d.stop(); spy.mockRestore(); }
  });
});
