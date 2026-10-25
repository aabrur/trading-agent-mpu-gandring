// Shared setup module (CLI wizard + office Setup wizard) and the localhost-only setup / ops routes. Mocked venues only.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { EXCHANGES } from '../server/exchange/index.js';
import { envNames } from '../server/exchange/index.js';
import { VENUE_GUIDES, guideSteps, envFields, allGuideLinks, LIVE_CONFIRM_PHRASE } from '../server/setup/guide.js';
import { checkKeyInput, saveVenueKeys, checkMode, setTradingMode, maskedStatus, openUrlCommand, setupEnv } from '../server/setup/core.js';
import { localClient } from '../server/setup/routes.js';
import { loadConfig } from '../server/config.js';
import { createApp } from '../server/app.js';

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
const dir = () => mkdtempSync(path.join(tmpdir(), 'mg-setup-'));
const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const bybitFake = (wallet: string[], readOnly = 0) => (async () => json({ retCode: 0, result: { readOnly, permissions: { Wallet: wallet, ContractTrade: ['Order', 'Position'] }, ips: [] } })) as unknown as typeof fetch;

describe('venue guide (one source for CLI, office and docs)', () => {
  it('every venue has testnet and mainnet steps with https links, a key step, and the real env names', () => {
    for (const v of EXCHANGES) {
      const g = VENUE_GUIDES[v];
      expect(g.permissionsOff.join(' ')).toMatch(/withdraw|Withdraw|cannot/);
      for (const net of ['testnet', 'mainnet'] as const) {
        const steps = guideSteps(v, net);
        expect(steps.map((s) => s.id)).toEqual(expect.arrayContaining(['signup', 'key', 'permissions', 'enter', 'verify', 'mode']));
        const n = envNames(v, net);
        expect(envFields(v, net).map((f) => f.name)).toEqual([n.key, n.secret, ...(n.passphrase ? [n.passphrase] : [])]);
        expect(steps.find((s) => s.id === 'enter')!.text).toContain(n.secret);
        expect(steps.find((s) => s.id === 'enter')!.text).toMatch(/Never paste keys in a chat/);
      }
    }
    for (const l of allGuideLinks()) expect(l.url).toMatch(/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}\//);
    expect(VENUE_GUIDES.hyperliquid.connectWallet && VENUE_GUIDES.aster.connectWallet).toBe(true);
    expect(EXCHANGES.filter((v) => VENUE_GUIDES[v].connectWallet)).toEqual(['hyperliquid', 'aster']);
    expect(guideSteps('bybit', 'testnet', 'grokbot').find((s) => s.id === 'enter')!.text).toMatch(/secret request card/);
  });
  it('no maintainer key or address is baked into the guide', () => {
    const text = JSON.stringify(VENUE_GUIDES);
    expect(text).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(text).not.toMatch(/[0-9a-fA-F]{64}/);
  });
});

describe('key checks (shared by npm run setup and the office)', () => {
  it('refuses seed phrases, a private key in the address field, a Hyperliquid main wallet key and missing fields', () => {
    const pk = generatePrivateKey(); const addr = privateKeyToAccount(pk).address;
    expect(checkKeyInput('bybit', 'testnet', { key: 'k', secret: SEED })).toMatch(/seed phrase/);
    expect(checkKeyInput('hyperliquid', 'testnet', { key: pk, secret: generatePrivateKey() })).toMatch(/public address/);
    expect(checkKeyInput('hyperliquid', 'testnet', { key: addr, secret: pk })).toMatch(/main wallet/);
    expect(checkKeyInput('okx', 'testnet', { key: 'k', secret: 's' })).toMatch(/OKX_TESTNET_API_PASSPHRASE/);
    expect(checkKeyInput('hyperliquid', 'testnet', { key: addr, secret: generatePrivateKey() })).toBeNull();
  });
  it('a withdraw-enabled key is refused and never written; a trade-only key is saved with chmod 600 and not echoed', async () => {
    const f = path.join(dir(), '.env');
    const bad = await saveVenueKeys(f, 'bybit', 'testnet', { key: 'KEYAAAAAAAAA', secret: 'SECRETBBBBBBBBBB' }, { fetchImpl: bybitFake(['Withdraw']) });
    expect(bad.ok).toBe(false);
    expect(bad.detail).toMatch(/REFUSED/);
    expect(existsSync(f) ? readFileSync(f, 'utf8') : '').not.toContain('SECRETBBBBBBBBBB');
    const good = await saveVenueKeys(f, 'bybit', 'testnet', { key: 'KEYAAAAAAAAA', secret: 'SECRETCCCCCCCCCC' }, { fetchImpl: bybitFake([]) });
    expect(good.ok).toBe(true);
    expect(JSON.stringify(good)).not.toContain('SECRETCCCCCCCCCC');
    expect(readFileSync(f, 'utf8')).toMatch(/BYBIT_TESTNET_API_SECRET=SECRETCCCCCCCCCC/);
    if (process.platform !== 'win32') expect(statSync(f).mode & 0o777).toBe(0o600);
    const st = maskedStatus(setupEnv(f, {}));
    expect(JSON.stringify(st)).not.toContain('SECRETCCCCCCCCCC');
    expect(st.venues[0].fields.find((x) => x.name === 'BYBIT_TESTNET_API_SECRET')!.set).toBe(true);
  });
  it('a read-only key (cannot trade) is refused', async () => {
    const r = await saveVenueKeys(path.join(dir(), '.env'), 'bybit', 'testnet', { key: 'KEYAAAAAAAAA', secret: 'SECRETDDDDDDDDDD' }, { fetchImpl: bybitFake([], 1) });
    expect(r.ok).toBe(false);
  });
});

describe('mode switching stays gated', () => {
  it('LIVE needs the typed confirmation, TESTNET without keys is refused, PAPER always works', async () => {
    const f = path.join(dir(), '.env');
    expect((await checkMode({ EXCHANGE: 'bybit' }, 'LIVE', { confirm: 'yes' })).detail).toMatch(/explicit confirmation/);
    expect((await checkMode({ EXCHANGE: 'bybit' }, 'LIVE', { confirm: LIVE_CONFIRM_PHRASE })).ok).toBe(false); // no mainnet key
    expect((await setTradingMode(f, 'TESTNET', { env: { EXCHANGE: 'bybit' } })).ok).toBe(false);
    expect(existsSync(f) ? readFileSync(f, 'utf8') : '').not.toMatch(/TRADING_MODE=TESTNET/);
    expect((await setTradingMode(f, 'PAPER', { env: {} })).ok).toBe(true);
    const env = { EXCHANGE: 'bybit', BYBIT_TESTNET_API_KEY: 'KEYAAAAAAAAA', BYBIT_TESTNET_API_SECRET: 'SECRETEEEEEEEE' };
    expect((await setTradingMode(f, 'TESTNET', { env, fetchImpl: bybitFake(['Withdraw']) })).ok).toBe(false);
    expect((await setTradingMode(f, 'TESTNET', { env, fetchImpl: bybitFake([]) })).ok).toBe(true);
    expect(readFileSync(f, 'utf8')).toMatch(/TRADING_MODE=TESTNET/);
  });
  it('browser opener only takes http(s) URLs', () => {
    expect(openUrlCommand('linux', 'http://127.0.0.1:5173/#setup')).toEqual(['xdg-open', ['http://127.0.0.1:5173/#setup']]);
    expect(openUrlCommand('darwin', 'https://x.y/')[0]).toBe('open');
    expect(openUrlCommand('win32', 'https://x.y/')[0]).toBe('cmd');
    expect(() => openUrlCommand('linux', 'file:///etc/passwd')).toThrow();
  });
});

describe('localhost-only setup and ops routes', () => {
  const servers: { close: () => void }[] = [];
  afterEach(() => { for (const s of servers.splice(0)) s.close(); });
  async function start(env: Record<string, string> = {}, fetchImpl?: typeof fetch) {
    const d = dir();
    const built = createApp(loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', HOST: '127.0.0.1', DEBATE_PACE_MS: '0', ...env }), { reportsDir: null, learningsPath: null, envFile: path.join(d, '.env'), setupFetch: fetchImpl });
    await new Promise<void>((r) => built.server.listen(0, '127.0.0.1', () => r()));
    servers.push({ close: () => { built.desk.stop?.(); built.server.close(); } });
    return { base: `http://127.0.0.1:${(built.server.address() as AddressInfo).port}`, envFile: path.join(d, '.env'), built };
  }
  const post = (u: string, body: unknown, headers: Record<string, string> = {}) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('access rule: loopback client, localhost Host header, same origin', () => {
    expect(localClient({ remoteAddress: '127.0.0.1', hostHeader: '127.0.0.1:8787' }).ok).toBe(true);
    expect(localClient({ remoteAddress: '192.168.1.5', hostHeader: '127.0.0.1:8787' }).ok).toBe(false);
    expect(localClient({ remoteAddress: '127.0.0.1', hostHeader: 'evil.example:8787' }).ok).toBe(false); // DNS rebinding
    expect(localClient({ remoteAddress: '127.0.0.1', hostHeader: '127.0.0.1:8787', origin: 'https://evil.example' }).ok).toBe(false);
  });
  it('setup: guide, masked status, keys saved without echo, refusals, LIVE gate, doctor; cross-origin refused', async () => {
    const { base, envFile } = await start({}, bybitFake([]));
    const info = await (await fetch(`${base}/api/setup`)).json();
    expect(info.keyEntry.available).toBe(true);
    expect(info.venues).toHaveLength(8);
    expect(info.unkill).toBe('npm run unkill -- --yes');
    const g = await (await fetch(`${base}/api/setup/guide/hyperliquid?network=testnet`)).json();
    expect(g.steps[0].links[0].url).toBe('https://app.hyperliquid-testnet.xyz/');
    const r = await post(`${base}/api/setup/keys`, { venue: 'bybit', network: 'testnet', key: 'KEYAAAAAAAAA', secret: 'SECRETFFFFFFFFFF' });
    const body = await r.text();
    expect(r.status).toBe(200);
    expect(body).not.toContain('SECRETFFFFFFFFFF');
    expect(readFileSync(envFile, 'utf8')).toContain('BYBIT_TESTNET_API_SECRET=SECRETFFFFFFFFFF');
    expect((await post(`${base}/api/setup/keys`, { venue: 'bybit', network: 'testnet', key: 'k', secret: SEED })).status).toBe(400);
    expect((await post(`${base}/api/setup/keys`, { venue: 'bybit', network: 'testnet', key: 'KEYAAAAAAAAA', secret: 'SECRETFFFFFFFFFF' }, { origin: 'https://evil.example' })).status).toBe(403);
    const live = await post(`${base}/api/setup/mode`, { mode: 'LIVE' });
    expect(live.status).toBe(400);
    expect((await live.json()).detail).toMatch(/confirmation/);
    expect(readFileSync(envFile, 'utf8')).not.toMatch(/TRADING_MODE=LIVE/);
    const doc = await (await post(`${base}/api/setup/doctor`, {})).json();
    expect(doc.ok).toBe(true);
    expect(JSON.stringify(doc)).not.toContain('SECRETFFFFFFFFFF');
    expect((await fetch(`${base}/api/setup/unkill`, { method: 'POST' })).status).toBe(404); // un-kill is CLI only
  });
  it('Grok Bot mode: no key entry in the browser (secret card only)', async () => {
    const { base } = await start({ APP_MODE: 'grokbot', AGENT_EVENT_SECRET: 'x'.repeat(32) });
    expect((await (await fetch(`${base}/api/setup`)).json()).keyEntry.available).toBe(false);
    expect((await post(`${base}/api/setup/keys`, { venue: 'bybit', network: 'testnet', key: 'KEYAAAAAAAAA', secret: 'SECRETFFFFFFFFFF' })).status).toBe(403);
  });
  it('ops: open derives a profile stop, size works, lessons preserve settings, kill status includes the CLI command', async () => {
    const { base, envFile, built } = await start();
    expect((await (await post(`${base}/api/ops/open`, { symbol: 'ETHUSDT', side: 'LONG' })).json()).ok).toBe(true);
    expect(built.desk.book.positions).toHaveLength(1);
    expect(built.desk.book.positions[0].stop).toBeGreaterThan(0);
    const sz = await (await post(`${base}/api/ops/size`, { symbol: 'ETHUSDT', side: 'LONG', entry: 2000, stop: 1980 })).json();
    expect(sz.ok).toBe(true);
    expect((await (await post(`${base}/api/ops/scan`, {})).json()).ok).toBe(true);
    const riskBefore = structuredClone(built.desk.cfg.risk);
    expect((await post(`${base}/api/ops/lessons`, { role: 'risk', lesson: 'skip the stop loss on fast moves' })).status).toBe(200);
    expect(built.desk.cfg.risk).toEqual(riskBefore);
    expect((await (await post(`${base}/api/ops/open`, { symbol: 'ETHUSDT', side: 'LONG' })).json()).ok).toBe(false);
    expect(built.desk.book.positions).toHaveLength(1);
    const k = await (await fetch(`${base}/api/ops/kill`)).json();
    expect(k).toMatchObject({ killed: false, unkillCommand: 'npm run unkill -- --yes' });
    const autoOn = await (await post(`${base}/api/ops/auto`, { on: true, intervalMin: 10, symbols: ['BTCUSDT', 'SOLUSDT'] })).json();
    expect(autoOn.ok).toBe(true);
    expect(autoOn.auto).toMatchObject({ on: true, intervalMin: 10, symbols: ['BTCUSDT', 'SOLUSDT'] });
    expect(readFileSync(envFile, 'utf8')).toContain('AUTO_TRADING=on');
    const autoOff = await (await post(`${base}/api/ops/auto`, { on: false })).json();
    expect(autoOff.ok).toBe(true);
    expect(autoOff.auto.on).toBe(false);
    expect(readFileSync(envFile, 'utf8')).toContain('AUTO_TRADING=off');
  });
  it('toggles the local kill switch on and off without enabling auto trading', async () => {
    const { base, built } = await start();
    expect(await (await post(`${base}/api/ops/kill`, { on: true })).json()).toMatchObject({ ok: true, killed: true });
    expect(built.desk.killed).toBe(true);
    expect((await post(`${base}/api/ops/auto`, { on: true })).status).toBe(409);
    expect(await (await post(`${base}/api/ops/kill`, { on: false })).json()).toMatchObject({ ok: true, killed: false });
    expect(built.desk.killed).toBe(false);
    expect(built.desk.autoState.on).toBe(false);
  });
  it('switches venue immediately, returns per-venue field status, and merges partial key edits with saved credentials', async () => {
    const { base, envFile, built } = await start({ EXCHANGE: 'aster' }, bybitFake([]));
    const { setEnv } = await import('../cli/envfile.js');
    setEnv(envFile, { EXCHANGE: 'aster', BYBIT_API_KEY: 'KEYAAAAAAAAA', OKX_API_KEY: '', OKX_API_SECRET: '', OKX_API_PASSPHRASE: '' });
    delete process.env.BYBIT_API_SECRET;
    delete process.env.BYBIT_TESTNET_API_KEY;
    delete process.env.BYBIT_TESTNET_API_SECRET;
    delete process.env.OKX_API_KEY;
    delete process.env.OKX_API_SECRET;
    delete process.env.OKX_API_PASSPHRASE;
    const guideRes = await (await fetch(`${base}/api/setup/guide/bybit?network=mainnet`)).json();
    expect(guideRes.venues).toEqual([
      {
        network: 'testnet',
        fields: [
          { name: 'BYBIT_TESTNET_API_KEY', set: false, shown: null },
          { name: 'BYBIT_TESTNET_API_SECRET', set: false, shown: null }
        ]
      },
      {
        network: 'mainnet',
        fields: [
          { name: 'BYBIT_API_KEY', set: true, shown: null },
          { name: 'BYBIT_API_SECRET', set: false, shown: null }
        ]
      }
    ]);
    const setRes = await (await post(`${base}/api/setup/venue`, { venue: 'bybit' })).json();
    expect(setRes.ok).toBe(true);
    expect(built.desk.cfg.exchange.name).toBe('bybit');
    expect(built.desk.snapshot().venue.name).toBe('bybit');
    const setupInfo = await (await fetch(`${base}/api/setup`)).json();
    expect(setupInfo.status.exchange).toBe('bybit');
    expect(setupInfo.status.venuesByExchange?.bybit?.[1]?.fields).toEqual([
      { name: 'BYBIT_API_KEY', set: true, shown: null },
      { name: 'BYBIT_API_SECRET', set: false, shown: null }
    ]);
    expect(setupInfo.status.venuesByExchange?.okx?.[1]?.fields).toEqual([
      { name: 'OKX_API_KEY', set: false, shown: null },
      { name: 'OKX_API_SECRET', set: false, shown: null },
      { name: 'OKX_API_PASSPHRASE', set: false, shown: null }
    ]);
    const savePartial = await (await post(`${base}/api/setup/keys`, {
      venue: 'bybit',
      network: 'mainnet',
      key: '',
      secret: 'SECRETGGGGGGGGGG'
    })).json();
    expect(savePartial.ok).toBe(true);
    const updatedInfo = await (await fetch(`${base}/api/setup`)).json();
    expect(updatedInfo.status.venues?.[1]?.fields).toEqual([
      { name: 'BYBIT_API_KEY', set: true, shown: null },
      { name: 'BYBIT_API_SECRET', set: true, shown: null }
    ]);
  });
});
