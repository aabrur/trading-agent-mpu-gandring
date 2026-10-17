import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { loadConfig } from '../server/config.js';
import { BybitAdapter } from '../server/exchange/bybit.js';
import { HyperliquidAdapter, floatToWire, hlPrice } from '../server/exchange/hyperliquid.js';
import { verifyKey } from '../server/live/guard.js';
import { roundTripCheck, checkKeyStep, type AdapterFactory } from '../server/live/steps.js';
import { LiveExecutor } from '../server/live/executor.js';
import { fakeBybit, MemoryAdapter } from './fakes.js';

const TESTNET_KEY = 'tnKEY000000000001', TESTNET_SECRET = 'tnSECRETzzzzzzzzzzzzzzzz01';
const MAIN_KEY = 'mnKEY000000000002', MAIN_SECRET = 'mnSECRETyyyyyyyyyyyyyyyy02';
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  env = { TRADING_MODE: 'PAPER', EXCHANGE: 'bybit', BYBIT_TESTNET_API_KEY: TESTNET_KEY, BYBIT_TESTNET_API_SECRET: TESTNET_SECRET, BYBIT_API_KEY: MAIN_KEY, BYBIT_API_SECRET: MAIN_SECRET };
});
const factoryFor = (testnet: ReturnType<typeof fakeBybit>, mainnet: ReturnType<typeof fakeBybit>): AdapterFactory =>
  (_n, net, c) => new BybitAdapter(net, c.key, c.secret, net === 'testnet' ? testnet.fetchImpl : mainnet.fetchImpl);

describe('trading modes: no confirmation, automatic guards only', () => {
  it('LIVE starts without any phrase or testnet record when the key is clean', async () => {
    const cfg = loadConfig({ ...env, TRADING_MODE: 'LIVE', HOST: '0.0.0.0' });
    expect(cfg.tradingMode).toBe('LIVE');
    expect(cfg.host).toBe('127.0.0.1'); // LIVE always binds locally
    const v = await verifyKey(new BybitAdapter('mainnet', MAIN_KEY, MAIN_SECRET, fakeBybit().fetchImpl));
    expect(v.ok).toBe(true);
  });
  it('TESTNET is a direct choice too', () => {
    expect(loadConfig({ ...env, TRADING_MODE: 'TESTNET' }).live).toMatchObject({ exchange: 'bybit', network: 'testnet' });
  });
  it('LIVE refuses a key with withdraw permission', async () => {
    const v = await verifyKey(new BybitAdapter('mainnet', MAIN_KEY, MAIN_SECRET, fakeBybit({ withdraw: true }).fetchImpl));
    expect(v.ok).toBe(false);
    expect(v.detail).toMatch(/REFUSED/);
    const step = await checkKeyStep(env, 'mainnet', { factory: factoryFor(fakeBybit(), fakeBybit({ withdraw: true })) });
    expect(step.ok).toBe(false);
  });
  it('refuses a read-only key (cannot trade)', async () => {
    expect((await checkKeyStep(env, 'mainnet', { factory: factoryFor(fakeBybit(), fakeBybit({ readOnly: 1 })) })).ok).toBe(false);
  });
  it('LIVE without exchange keys exits with code 2', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'server/index.ts'], { env: { ...process.env, TRADING_MODE: 'LIVE', EXCHANGE: 'bybit', BYBIT_API_KEY: '', BYBIT_API_SECRET: '', PORT: '0', DOTENV_CONFIG_PATH: '/nonexistent' }, encoding: 'utf8', timeout: 15000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/keys are missing/);
  });
  it('guards cannot be configured to zero', () => {
    expect(() => loadConfig({ ...env, TRADING_MODE: 'LIVE', SAFETY_NET: '0' })).toThrow(/SAFETY_NET/);
    expect(loadConfig({ ...env, DAILY_LOSS_LIMIT_PCT: '0' }).risk.dailyLossLimitPct).toBe(0.5);
    expect(() => loadConfig({ ...env, OPEN_ORDERS_N: '0' })).toThrow();
  });
  it('experimental adapters need ALLOW_EXPERIMENTAL_LIVE=yes, Bybit does not', () => {
    const okx = { ...env, EXCHANGE: 'okx', OKX_API_KEY: 'k'.repeat(10), OKX_API_SECRET: 's'.repeat(10), OKX_API_PASSPHRASE: 'p'.repeat(8), TRADING_MODE: 'LIVE' };
    expect(() => loadConfig(okx)).toThrow(/experimental/);
    expect(loadConfig({ ...okx, ALLOW_EXPERIMENTAL_LIVE: 'yes' }).live?.experimental).toBe(true);
  });
});

describe('optional testnet round trip (doctor --roundtrip, mocked Bybit testnet)', () => {
  it('places with a stop, reconciles, closes and cancels', async () => {
    const t = fakeBybit(), m = fakeBybit();
    const r = await roundTripCheck(env, { factory: factoryFor(t, m), reconcileDelayMs: 0 });
    expect(r.ok).toBe(true);
    const create = t.calls.filter((c) => c.path === '/v5/order/create');
    expect(create).toHaveLength(2);
    expect(Number(create[0].body.stopLoss)).toBeGreaterThan(0);
    expect(create[1].body.reduceOnly).toBe(true);
    expect(t.count('/v5/order/cancel-all')).toBe(1);
    expect(t.calls[0].headers['X-BAPI-SIGN']).toMatch(/^[0-9a-f]{64}$/);
    expect(m.calls).toHaveLength(0);
  });
  it('reports a failure when the entry never fills', async () => {
    expect((await roundTripCheck(env, { factory: factoryFor(fakeBybit({ failCreate: 'error' }), fakeBybit()), reconcileDelayMs: 0 })).ok).toBe(false);
  });
});

describe('Hyperliquid', () => {
  it('refuses the main wallet key and unapproved agents, accepts an approved agent', async () => {
    const mainPk = generatePrivateKey(), main = privateKeyToAccount(mainPk).address;
    const agentPk = generatePrivateKey(), agent = privateKeyToAccount(agentPk).address;
    const info = (list: unknown[]) => (async () => new Response(JSON.stringify(list), { status: 200 })) as unknown as typeof fetch;
    expect((await verifyKey(new HyperliquidAdapter('mainnet', main, mainPk, info([])))).ok).toBe(false);
    expect((await verifyKey(new HyperliquidAdapter('mainnet', main, agentPk, info([])))).ok).toBe(false);
    expect((await verifyKey(new HyperliquidAdapter('mainnet', main, agentPk, info([{ address: agent, name: 'desk', validUntil: null }])))).ok).toBe(true);
  });
  it('wire helpers', () => {
    expect(floatToWire(3100.5)).toBe('3100.5');
    expect(floatToWire(0.001)).toBe('0.001');
    expect(hlPrice(60123.456, 5)).toBe(60123);
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
      const r1 = await checkKeyStep(env, 'mainnet', { factory: (_n, net, c) => new BybitAdapter(net, c.key, c.secret, leaky) }).catch((e) => ({ detail: String(e.message) }));
      seen.push(JSON.stringify(r1));
      const { doctor } = await import('../cli/doctor.js');
      const lines = await doctor(env, leaky, { roundtrip: true });
      seen.push(JSON.stringify(lines));
      const t = await roundTripCheck(env, { factory: (_n, net, c) => new BybitAdapter(net, c.key, c.secret, leaky), reconcileDelayMs: 0 });
      seen.push(JSON.stringify(t));
    } finally { Object.assign(console, orig); }
    const all = seen.join('\n');
    for (const s of [MAIN_KEY, MAIN_SECRET, TESTNET_KEY, TESTNET_SECRET]) expect(all).not.toContain(s);
    expect(all).toMatch(/REDACTED/);
  });
});
