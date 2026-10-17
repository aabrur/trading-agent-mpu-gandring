import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { loadConfig, ConfigError } from '../server/config.js';
import { BybitAdapter } from '../server/exchange/bybit.js';
import { HyperliquidAdapter, floatToWire, hlPrice } from '../server/exchange/hyperliquid.js';
import { checkLiveUnlock, CONFIRM_PHRASE, readState } from '../server/live/state.js';
import { testnetStep, checkKeyStep, unlockStep, type AdapterFactory } from '../server/live/steps.js';
import { LiveExecutor } from '../server/live/executor.js';
import { fakeBybit, MemoryAdapter } from './fakes.js';

const TESTNET_KEY = 'tnKEY000000000001', TESTNET_SECRET = 'tnSECRETzzzzzzzzzzzzzzzz01';
const MAIN_KEY = 'mnKEY000000000002', MAIN_SECRET = 'mnSECRETyyyyyyyyyyyyyyyy02';
let dir: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'mg-live-'));
  env = { TRADING_MODE: 'PAPER', EXCHANGE: 'bybit', BYBIT_TESTNET_API_KEY: TESTNET_KEY, BYBIT_TESTNET_API_SECRET: TESTNET_SECRET, BYBIT_API_KEY: MAIN_KEY, BYBIT_API_SECRET: MAIN_SECRET, MG_STATE_DIR: dir };
});
const factoryFor = (testnet: ReturnType<typeof fakeBybit>, mainnet: ReturnType<typeof fakeBybit>): AdapterFactory =>
  (_n, net, c) => new BybitAdapter(net, c.key, c.secret, net === 'testnet' ? testnet.fetchImpl : mainnet.fetchImpl);

async function fullUnlock() {
  const t = fakeBybit(), m = fakeBybit();
  const f = factoryFor(t, m);
  expect((await testnetStep(env, dir, { factory: f, reconcileDelayMs: 0 })).ok).toBe(true);
  expect((await checkKeyStep(env, dir, { factory: f })).ok).toBe(true);
  return unlockStep(env, dir, CONFIRM_PHRASE, { factory: f });
}

describe('LIVE stays locked by default', () => {
  it('LIVE without the unlock throws a ConfigError with exit code 2', () => {
    try { loadConfig({ ...env, TRADING_MODE: 'LIVE' }); throw new Error('should not get here'); }
    catch (e) { expect(e).toBeInstanceOf(ConfigError); expect((e as ConfigError).exitCode).toBe(2); expect((e as Error).message).toMatch(/testnet/); }
  });
  it('a hand-written LIVE_CONFIRMED does not unlock, and the server exits 2', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'server/index.ts'], { env: { ...process.env, ...env, TRADING_MODE: 'LIVE', LIVE_CONFIRMED: 'a'.repeat(64), PORT: '0' }, encoding: 'utf8', timeout: 15000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/LIVE is locked/);
    expect(r.stderr + r.stdout).not.toContain(MAIN_SECRET);
  });
});

describe('testnet round trip (mocked Bybit testnet)', () => {
  it('places with a stop, reconciles, closes, cancels and records a signed pass', async () => {
    const t = fakeBybit(), m = fakeBybit();
    const r = await testnetStep(env, dir, { factory: factoryFor(t, m), reconcileDelayMs: 0 });
    expect(r.ok).toBe(true);
    const create = t.calls.filter((c) => c.path === '/v5/order/create');
    expect(create).toHaveLength(2);
    expect(Number(create[0].body.stopLoss)).toBeGreaterThan(0);
    expect(create[1].body.reduceOnly).toBe(true);
    expect(t.count('/v5/order/cancel-all')).toBe(1);
    expect(t.calls[0].headers['X-BAPI-SIGN']).toMatch(/^[0-9a-f]{64}$/);
    expect(m.calls).toHaveLength(0); // mainnet untouched
    expect(readState(dir).testnet?.exchange).toBe('bybit');
  });
  it('records nothing when the entry never fills', async () => {
    const t = fakeBybit({ failCreate: 'error' }), m = fakeBybit();
    const r = await testnetStep(env, dir, { factory: factoryFor(t, m), reconcileDelayMs: 0 });
    expect(r.ok).toBe(false);
    expect(readState(dir).testnet).toBeUndefined();
  });
});

describe('withdraw permission', () => {
  it('refuses a Bybit key with Withdraw and records nothing', async () => {
    const t = fakeBybit(), m = fakeBybit({ withdraw: true });
    const r = await checkKeyStep(env, dir, { factory: factoryFor(t, m) });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/REFUSED/);
    expect(readState(dir).permission).toBeUndefined();
  });
  it('refuses a read-only key (cannot trade)', async () => {
    const r = await checkKeyStep(env, dir, { factory: factoryFor(fakeBybit(), fakeBybit({ readOnly: 1 })) });
    expect(r.ok).toBe(false);
  });
  it('Hyperliquid: refuses the main wallet key and unapproved agents, accepts an approved agent', async () => {
    const mainPk = generatePrivateKey(), main = privateKeyToAccount(mainPk).address;
    const agentPk = generatePrivateKey(), agent = privateKeyToAccount(agentPk).address;
    const info = (list: unknown[]) => (async () => new Response(JSON.stringify(list), { status: 200 })) as unknown as typeof fetch;
    expect((await new HyperliquidAdapter('mainnet', main, mainPk, info([])).permissions()).ok).toBe(false);
    expect((await new HyperliquidAdapter('mainnet', main, agentPk, info([])).permissions()).ok).toBe(false);
    const ok = await new HyperliquidAdapter('mainnet', main, agentPk, info([{ address: agent, name: 'desk', validUntil: null }])).permissions();
    expect(ok).toMatchObject({ ok: true, canWithdraw: false, verified: true });
  });
  it('Hyperliquid wire helpers', () => {
    expect(floatToWire(3100.5)).toBe('3100.5');
    expect(floatToWire(0.001)).toBe('0.001');
    expect(hlPrice(60123.456, 5)).toBe(60123);
  });
});

describe('unlock chain', () => {
  it('wrong phrase keeps LIVE locked', async () => {
    const t = fakeBybit(), m = fakeBybit(); const f = factoryFor(t, m);
    await testnetStep(env, dir, { factory: f, reconcileDelayMs: 0 });
    await checkKeyStep(env, dir, { factory: f });
    await expect(unlockStep(env, dir, 'i understand', { factory: f })).rejects.toThrow(/phrase/);
  });
  it('unlock needs the testnet pass first', async () => {
    await checkKeyStep(env, dir, { factory: factoryFor(fakeBybit(), fakeBybit()) });
    await expect(unlockStep(env, dir, CONFIRM_PHRASE, { factory: factoryFor(fakeBybit(), fakeBybit()) })).rejects.toThrow(/testnet/);
  });
  it('all three steps unlock LIVE, and config accepts it', async () => {
    const r = await fullUnlock();
    const liveEnv = { ...env, ...r.env };
    expect(checkLiveUnlock(liveEnv, dir)).toMatchObject({ ok: true });
    const cfg = loadConfig(liveEnv);
    expect(cfg.tradingMode).toBe('LIVE');
    expect(cfg.host).toBe('127.0.0.1');
  });
  it('editing the state file by hand breaks the unlock', async () => {
    const r = await fullUnlock();
    const p = path.join(dir, 'live-state.json');
    const s = JSON.parse(readFileSync(p, 'utf8'));
    s.permission.checkedAt += 1;
    writeFileSync(p, JSON.stringify(s));
    const c = checkLiveUnlock({ ...env, ...r.env }, dir);
    expect(c.ok).toBe(false);
    expect(c.reasons.join(' ')).toMatch(/signature is invalid/);
  });
  it('swapping in a different mainnet key breaks the unlock', async () => {
    const r = await fullUnlock();
    const c = checkLiveUnlock({ ...env, ...r.env, BYBIT_API_KEY: 'otherKEY0000000003' }, dir);
    expect(c.ok).toBe(false);
  });
  it('experimental adapters need ALLOW_EXPERIMENTAL_LIVE=yes on top', () => {
    const c = checkLiveUnlock({ ...env, EXCHANGE: 'okx', OKX_API_KEY: 'k'.repeat(10), OKX_API_SECRET: 's'.repeat(10), OKX_API_PASSPHRASE: 'p'.repeat(8) }, dir);
    expect(c.reasons.join(' ')).toMatch(/experimental/);
  });
});

describe('live executor', () => {
  it('one send, no blind retry: a timed out send is reconciled from the exchange record', async () => {
    const ex = fakeBybit({ failCreate: 'timeout', createStillFills: true });
    const e = new LiveExecutor(new BybitAdapter('testnet', TESTNET_KEY, TESTNET_SECRET, ex.fetchImpl), 0);
    const f = await e.open({ symbol: 'BTCUSDT', side: 'LONG', qty: 0.002, stop: 59000, tp: 62000, leverage: 2 });
    expect(ex.count('/v5/order/create')).toBe(1);
    expect(f.ok).toBe(true);
    expect(f.note).toMatch(/exchange record/);
  });
  it('a failed send that did not fill is reported, not retried', async () => {
    const a = new MemoryAdapter(undefined, true);
    const f = await new LiveExecutor(a, 0).open({ symbol: 'BTCUSDT', side: 'SHORT', qty: 0.002, stop: 61000, tp: null, leverage: 2 });
    expect(a.placed).toHaveLength(1);
    expect(f.ok).toBe(false);
    expect(f.note).toMatch(/Not retried/);
  });
  it('refuses an entry without a stop', async () => {
    const a = new MemoryAdapter();
    const f = await new LiveExecutor(a, 0).open({ symbol: 'BTCUSDT', side: 'LONG', qty: 0.002, stop: 0, tp: null, leverage: 2 });
    expect(f.ok).toBe(false); expect(a.placed).toHaveLength(0);
  });
});

describe('no secrets in logs', () => {
  it('testnet, key check and doctor output never contain a key or secret', async () => {
    const seen: string[] = [];
    const orig = { log: console.log, error: console.error, warn: console.warn };
    console.log = console.error = console.warn = (...a: unknown[]) => { seen.push(a.map(String).join(' ')); };
    try {
      // an exchange that echoes the key back inside an error
      const leaky = (async () => new Response(JSON.stringify({ retCode: 10003, retMsg: `invalid api key ${MAIN_KEY} secret ${MAIN_SECRET}` }), { status: 200 })) as unknown as typeof fetch;
      loadConfig(env); // registers secrets with the redactor
      const r1 = await checkKeyStep(env, dir, { factory: (_n, net, c) => new BybitAdapter(net, c.key, c.secret, leaky) }).catch((e) => ({ detail: String(e.message) }));
      seen.push(JSON.stringify(r1));
      const { doctor } = await import('../cli/doctor.js');
      const lines = await doctor(env, leaky);
      seen.push(JSON.stringify(lines));
      const t = await testnetStep(env, dir, { factory: (_n, net, c) => new BybitAdapter(net, c.key, c.secret, leaky), reconcileDelayMs: 0 });
      seen.push(JSON.stringify(t));
    } finally { Object.assign(console, orig); }
    const all = seen.join('\n');
    for (const s of [MAIN_KEY, MAIN_SECRET, TESTNET_KEY, TESTNET_SECRET]) expect(all).not.toContain(s);
    expect(all).toMatch(/REDACTED/);
  });
  it('the state file holds fingerprints, not keys', async () => {
    await fullUnlock();
    const text = readFileSync(path.join(dir, 'live-state.json'), 'utf8');
    for (const s of [MAIN_KEY, MAIN_SECRET, TESTNET_KEY, TESTNET_SECRET]) expect(text).not.toContain(s);
    expect(existsSync(path.join(dir, 'install.key'))).toBe(true);
  });
});
