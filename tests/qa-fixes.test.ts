// Fixes from the end-to-end QA pass (fresh clone, new user, PAPER, no keys).
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { loadConfig } from '../server/config.js';
import { createApp } from '../server/app.js';
import { gb } from '../cli/gb.js';
import { BinanceAdapter } from '../server/exchange/binance.js';
import { verifyKey } from '../server/live/guard.js';
import { doctor } from '../server/setup/doctor.js';
import type { ExchangeAdapter } from '../server/exchange/types.js';

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });
async function boot(env: Record<string, string> = {}) {
  const d = mkdtempSync(path.join(tmpdir(), 'mg-qa-'));
  const built = createApp(loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', HOST: '127.0.0.1', DEBATE_PACE_MS: '0', ...env }), { reportsDir: null, learningsPath: null, envFile: path.join(d, '.env') });
  await new Promise<void>((r) => built.server.listen(0, '127.0.0.1', () => r())); servers.push(built.server);
  return { ...built, base: `http://127.0.0.1:${(built.server.address() as AddressInfo).port}` };
}

describe('CLI parity in local mode (no AGENT_EVENT_SECRET)', () => {
  it('gb open/positions/close/scan/lessons work through the localhost office routes, stop still required', async () => {
    const { base, desk } = await boot();
    await desk.refreshTickers();
    const env = { PORT: '1' } as NodeJS.ProcessEnv; // no secret
    const price = desk.tickers.BTCUSDT.last;
    expect((await gb(['open', 'BTCUSDT', 'LONG'], { env, baseUrl: base })).text).toMatch(/no stop/);
    const o = await gb(['open', 'BTCUSDT', 'LONG', '--stop', String(Math.round(price * 0.99))], { env, baseUrl: base });
    expect(o.text).not.toMatch(/AGENT_EVENT_SECRET/);
    expect(o.ok).toBe(true);
    expect((await gb(['positions'], { env, baseUrl: base })).text).toMatch(/BTCUSDT/);
    const wide = await gb(['open', 'ETHUSDT', 'LONG', '--stop', String(desk.tickers.ETHUSDT.last * 0.9)], { env, baseUrl: base });
    expect(wide.ok).toBe(false); // the same planner refuses a stop wider than DEFAULT_STOP_PCT
    expect((await gb(['close', 'BTCUSDT'], { env, baseUrl: base })).ok).toBe(true);
    expect((await gb(['scan'], { env, baseUrl: base })).ok).toBe(true);
    expect((await gb(['lessons', 'add', 'desk', 'Wait for a clean retest before entering'], { env, baseUrl: base })).ok).toBe(true);
    expect((await gb(['lessons', 'list'], { env, baseUrl: base })).text).toMatch(/clean retest/);
  });
  it('with AGENT_EVENT_SECRET set it still uses the authenticated Grok Bot routes', async () => {
    const { base } = await boot({ APP_MODE: 'grokbot', AGENT_EVENT_SECRET: 'x'.repeat(32) });
    expect((await gb(['scan'], { env: { AGENT_EVENT_SECRET: 'y'.repeat(32) } as NodeJS.ProcessEnv, baseUrl: base })).ok).toBe(false);
    expect((await gb(['scan'], { env: { AGENT_EVENT_SECRET: 'x'.repeat(32) } as NodeJS.ProcessEnv, baseUrl: base })).ok).toBe(true);
  });
});

describe('Setup wizard reads are not locked by the write limiter', () => {
  it('clicking through every venue and network (40 guide reads) stays 200; writes are still limited', async () => {
    const { base } = await boot();
    for (let i = 0; i < 40; i++) expect((await fetch(`${base}/api/setup/guide/bybit?network=testnet`)).status).toBe(200);
    expect((await fetch(`${base}/api/setup`)).status).toBe(200);
    const codes: number[] = [];
    for (let i = 0; i < 32; i++) codes.push((await fetch(`${base}/api/setup/venue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status);
    expect(codes).toContain(429);
  });
});

describe('Binance Demo Trading key check', () => {
  it('a key Demo Trading rejects is refused for TESTNET; an accepted key passes', async () => {
    const bad = (async () => json({ code: -2015, msg: 'Invalid API-key, IP, or permissions for action.' }, 401)) as unknown as typeof fetch;
    const r1 = await verifyKey(new BinanceAdapter('testnet', 'k', 's', bad));
    expect(r1.ok).toBe(false);
    const urls: string[] = [];
    const good = (async (u: string) => { urls.push(u); return json([{ asset: 'USDT', balance: '5000' }]); }) as unknown as typeof fetch;
    const r2 = await verifyKey(new BinanceAdapter('testnet', 'k', 's', good));
    expect(r2.ok).toBe(true);
    expect(urls[0]).toMatch(/^https:\/\/demo-fapi\.binance\.com\/fapi\/v2\/balance\?/);
  });
});

describe('small fixes', () => {
  it('refusal text has no double period', async () => {
    const a = { network: 'testnet', permissions: async () => ({ ok: false, canWithdraw: null, canTrade: false, verified: false, detail: 'register a subkey and use that.' }) } as unknown as ExchangeAdapter;
    expect((await verifyKey(a)).detail).not.toMatch(/\.\./);
  });
  it('doctor reports chat channels, not the old Telegram-only line', async () => {
    const lines = await doctor({ TRADING_MODE: 'PAPER', EXCHANGE: 'none', TELEGRAM_BOT_TOKEN: '123456789:' + 'A'.repeat(35), TELEGRAM_CHAT_ID: '1' } as NodeJS.ProcessEnv);
    const l = lines.find((x) => x.label === 'chat channels');
    expect(l?.detail).toMatch(/telegram; Desk Lead on; chat commands off/);
    expect(lines.some((x) => x.label === 'Telegram reports')).toBe(false);
  });
});

describe('npm run trade --service build PATH', () => {
  it('puts the running node folder first so npm is found under launchd/systemd', async () => {
    const { buildEnv } = await import('../cli/trade.js');
    const path = await import('node:path');
    const env = buildEnv({ PATH: '/usr/bin:/bin' }, '/opt/homebrew/bin/node');
    expect(env.PATH!.split(path.delimiter)[0]).toBe('/opt/homebrew/bin');
    expect(env.PATH).toContain('/usr/bin');
    expect(buildEnv({}, '/x/node').PATH).toBe('/x');
  });
});
