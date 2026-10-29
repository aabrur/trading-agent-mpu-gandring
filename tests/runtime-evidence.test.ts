import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { captureRuntimeIdentity, runtimeEvidence } from '../server/runtime-evidence.js';
import { loadConfig } from '../server/config.js';
import { createApp } from '../server/app.js';
import { DEFAULT_TRADING_SETTINGS } from '../server/trading-settings.js';
import { readEnv, setEnv } from '../cli/envfile.js';
import { LiveExecutor } from '../server/live/executor.js';
import { sampleSnapshot } from '../server/market/sample.js';
import { MemoryAdapter } from './fakes.js';

const dirs: string[] = [];
const apps: ReturnType<typeof createApp>[] = [];
const directory = () => { const dir = mkdtempSync(path.join(tmpdir(), 'mpu-runtime-evidence-')); dirs.push(dir); return dir; };
afterEach(async () => {
  for (const app of apps.splice(0)) {
    app.auto.stop(); app.reporter.stop(); app.lead.stop(); app.desk.stop();
    if (app.server.listening) await new Promise<void>(resolve => app.server.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

describe('read-only runtime identity', () => {
  it('hashes canonical files but leaves installed native profiles and phase unknown', () => {
    const dir = directory(); mkdirSync(path.join(dir, 'grokbot', 'roles'), { recursive: true });
    writeFileSync(path.join(dir, 'grokbot', 'roles', 'head-of-trading.md'), 'source role');
    vi.spyOn(Date, 'now').mockReturnValue(100_000); vi.spyOn(process, 'uptime').mockReturnValue(10);
    const identity = captureRuntimeIdentity(dir);
    const cfg = loadConfig({ APP_MODE: 'grokbot', MARKET_SOURCE: 'sample', DEBATE_INTERVAL_MIN: '30' });
    const result = runtimeEvidence(cfg, identity);
    expect(result.processStartedAt).toBe(90_000);
    expect(result.canonicalProfiles[0]).toMatchObject({ sha256: createHash('sha256').update('source role').digest('hex') });
    expect(result.installedProfiles).toMatchObject({ status: 'UNAVAILABLE', version: null });
    expect(result.routine).toMatchObject({ ownerCadenceMin: 30, scheduler: 'native_platform', serverAutoDisabled: true, phaseStatus: 'UNKNOWN', lastRunAt: null, nextRunAt: null });
    expect(result.repository.sha).toBeNull();
  });

  it('compares saved and active thresholds without applying the file or leaking secrets', () => {
    const cfg = loadConfig({ MARKET_SOURCE: 'sample', MIN_ENTRY_CONFIDENCE_PCT: '60' });
    const before = structuredClone(cfg), identity = captureRuntimeIdentity(directory());
    const result = runtimeEvidence(cfg, identity, { MIN_ENTRY_CONFIDENCE_PCT: '70', API_KEY: 'do-not-export-this-secret', DISCORD_ALLOWED_USER_IDS: 'do-not-export-user' });
    expect(result.active).toMatchObject({ source: 'running_cfg', values: { minEntryConfidencePct: 60 } });
    expect(result.saved).toMatchObject({ source: 'saved_file_only', minEntryConfidencePct: 70, matchesActive: false });
    expect(cfg).toEqual(before);
    expect(JSON.stringify(result)).not.toContain('do-not-export');
    expect(runtimeEvidence(cfg, identity, { MIN_ENTRY_CONFIDENCE_PCT: 'invalid' }).saved.status).toBe('unavailable');
    expect(cfg.risk.minEntryConfidencePct).toBe(60);
  });

  it('existing Setup hot-apply retains Owner 60% through reload/reconstruction and entry uses that boundary', async () => {
    const dir = directory(), file = path.join(dir, 'settings.env');
    const env = { TRADING_MODE: 'TESTNET', EXCHANGE: 'bybit', BYBIT_TESTNET_API_KEY: 'fixture-trade-key', BYBIT_TESTNET_API_SECRET: 'fixture-trade-secret', MARKET_SOURCE: 'sample', DEFAULT_PROVIDER: 'mock', MIN_ENTRY_CONFIDENCE_PCT: '70', AUTO_TRADING: 'off' };
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    setEnv(file, env);
    const adapter = new MemoryAdapter(), app = createApp(loadConfig(env), { executor: new LiveExecutor(adapter, 0), envFile: file, reportsDir: null, learningsPath: null, killFile: null }); apps.push(app);
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const response = await fetch(base + '/api/setup/trading', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ network: 'testnet', profile: 'manual', values: { ...DEFAULT_TRADING_SETTINGS, minEntryConfidencePct: 60 } }) });
    expect(await response.json()).toMatchObject({ ok: true, applied: true });
    expect(app.desk.cfg.risk.minEntryConfidencePct).toBe(60);
    await app.desk.reloadRuntimeConfig({});
    expect(app.desk.cfg.risk.minEntryConfidencePct).toBe(60);
    expect(loadConfig({ ...readEnv(file), TRADING_MODE: 'TESTNET' }).risk.minEntryConfidencePct).toBe(60);
    const snapshot = { ...sampleSnapshot('BTCUSDT'), source: 'bybit' as const, example: false, last: 60000, bid: 60000, ask: 60000, fetchedAt: Date.now() };
    vi.spyOn(app.desk as unknown as { marketSnapshot(symbol: string): Promise<typeof snapshot> }, 'marketSnapshot').mockImplementation(async () => ({ ...snapshot, fetchedAt: Date.now() }));
    expect(await app.desk.gbOpen({ symbol: 'BTCUSDT', side: 'LONG', confidence: .59, riskApproval: 'APPROVE' }, true)).toMatchObject({ ok: false, reply: expect.stringContaining('60%') });
    expect(adapter.placed).toHaveLength(0);
    const accepted = await app.desk.gbOpen({ symbol: 'BTCUSDT', side: 'LONG', confidence: .60, riskApproval: 'APPROVE' }, true);
    expect(accepted.ok, accepted.reply).toBe(true);
    expect(adapter.placed).toHaveLength(1);
    const context = await (await fetch(base + '/api/state')).json();
    expect(context.runtime.active.values.minEntryConfidencePct).toBe(60);
    expect(context.runtime.saved).toMatchObject({ minEntryConfidencePct: 60, matchesActive: true });
  });

  it('documents the existing cadence and measured phase separately without a permanent 15m template', () => {
    const bootstrap = readFileSync('grokbot/BOOTSTRAP.md', 'utf8'), operations = readFileSync('grokbot/OPERATIONS.md', 'utf8');
    expect(bootstrap).toContain("Owner's saved `DEBATE_INTERVAL_MIN` cadence");
    expect(bootstrap).not.toContain('**Trading loop, every 15 minutes:**');
    expect(operations).toContain('08:08:34');
    expect(operations).toContain('8 minutes 34 seconds');
    expect(operations).toContain('UNKNOWN until platform readback');
  });
});
