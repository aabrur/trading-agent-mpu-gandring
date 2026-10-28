import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';

// Pretend the sample market is real exchange data, so the live executor path (which refuses
// sample data on purpose) can be exercised against the fake exchange.
vi.mock('../server/market/index.js', async (orig) => {
  const m = await orig<typeof import('../server/market/index.js')>();
  return { ...m, getSnapshot: async (s: string) => ({ ...(await m.getSnapshot(s, 'sample')), example: false }) };
});

const { loadConfig } = await import('../server/config.js');
const { Desk } = await import('../server/desk.js');
const { AutoTrader } = await import('../server/auto.js');
const { Reporter } = await import('../server/reports.js');
const { makeCaller } = await import('../server/providers/index.js');
const { LiveExecutor } = await import('../server/live/executor.js');
const { registerSecrets } = await import('../server/redact.js');
const { MemoryAdapter } = await import('./fakes.js');
const { armOpening } = await import('./opening-snapshot.js');

const base = { TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEBATE_PACE_MS: '0', AUTO_TRADING: 'on', AUTO_SYMBOLS: 'ETHUSDT' };
const mk = (extra: Record<string, string> = {}) => {
  const c = loadConfig({ ...base, ...extra });
  const a = new MemoryAdapter();
  // fill near the stop-implied price so the sample ETH numbers stay consistent
  a.fillAt = (o) => Math.round((o.side === 'LONG' ? o.stop * 1.015 : o.stop / 1.015) * 100) / 100;
  a.closeAt = () => a.placed.length ? a.fillAt(a.placed[a.placed.length - 1]) : 0;
  const desk = new Desk(c, makeCaller(c), { reportsDir: null, executor: new LiveExecutor(a, 0) });
  return { c, a, desk, auto: new AutoTrader(desk, 0) };
};
afterEach(() => { vi.useRealTimers(); });

describe('AUTO scheduler (fake exchange, no approval step)', () => {
  it('opens on its own and keeps the position past max holding time until an explicit close', async () => {
    const { a, desk, auto } = mk({ MAX_HOLD_HOURS: '0.0001' });
    // A complete setup is supplied explicitly; duration alone supplies no exit evidence.
    armOpening(desk, a);
    const r1 = await auto.cycle();
    expect(r1.ran).toEqual(['ETHUSDT']);
    expect(a.placed).toHaveLength(1);
    expect(a.placed[0].stop).toBeGreaterThan(0); // stop loss on every order
    expect(desk.book.positions).toHaveLength(1);
    expect(desk.activity.some((x) => x.kind === 'opened')).toBe(true);
    await new Promise((r) => setTimeout(r, 450)); // past 0.0001 h
    await auto.cycle();
    expect(a.closes).toBe(0);
    expect(desk.book.positions).toHaveLength(1);
    expect(desk.activity.some((x) => x.kind === 'closed' && /max holding time/.test(x.detail))).toBe(false);
    expect(desk.autoState.cycles).toBe(2);
    await desk.command('close all');
    expect(a.closes).toBe(1);
    expect(desk.book.positions).toHaveLength(0);
    // the Desk Lead keeps the journal (no separate reviewer agent)
    const journaled = () => desk.logs.some((l) => l.kind === 'info' && l.agent === 'lead' && /Journal: observed OWNER_MANUAL/.test(l.text));
    for (let i = 0; i < 40 && !journaled(); i++) await new Promise((r) => setTimeout(r, 25));
    expect(journaled()).toBe(true);
  });
  it('does nothing after the kill switch', async () => {
    const { a, desk, auto } = mk();
    await desk.kill();
    expect((await auto.cycle()).skipped).toBe('kill switch');
    expect(a.placed).toHaveLength(0);
  });
  it('daily loss stop pauses new orders until the next UTC day', async () => {
    const { a, desk, auto } = mk();
    await desk.syncLive();
    vi.spyOn(a, 'balance').mockResolvedValue({ equityUsdt: 670, availableUsdt: 670 });
    armOpening(desk, a);
    await auto.cycle();
    expect(a.placed).toHaveLength(0);
    expect(desk.activity.some((x) => x.kind === 'skipped' && /Daily loss stop/.test(x.detail))).toBe(true);
  });
});

describe('Desk Ops consolidation (single Max N path, explicit kill release)', () => {
  it('keeps book.n and cfg.paper.n in sync through /api/ops/auto and the command path', async () => {
    const { desk, auto } = mk();
    expect(desk.book.n).toBe(desk.cfg.paper.n);
    auto.configure({ n: 2 });
    expect(desk.book.n).toBe(2);
    expect(desk.cfg.paper.n).toBe(2);
    await desk.command('set n 3');
    expect(desk.book.n).toBe(3);
    expect(desk.cfg.paper.n).toBe(3);
  });
  it('rejects Auto ON while the kill switch is on without clearing the latch', async () => {
    const { loadConfig } = await import('../server/config.js');
    const d = mkdtempSync(path.join(tmpdir(), 'mg-ops-kill-'));
    const envFile = path.join(d, '.env');
    const built = createApp(loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', HOST: '127.0.0.1', DEBATE_PACE_MS: '0' }), { reportsDir: null, learningsPath: null, envFile });
    await new Promise<void>((r) => built.server.listen(0, '127.0.0.1', () => r()));
    try {
      const base = `http://127.0.0.1:${(built.server.address() as AddressInfo).port}`;
      await built.desk.kill();
      const r = await fetch(`${base}/api/ops/auto`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: true }) });
      expect(r.status).toBe(409);
      expect(built.desk.killed).toBe(true);
      expect(built.desk.autoState.on).toBe(false);
    } finally { built.desk.stop?.(); built.server.close(); }
  });
});

describe('reports', () => {
  it('are generated on the interval and written to reports/', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(path.join(tmpdir(), 'mg-rep-'));
    const { desk } = mk({ REPORT_INTERVAL_MIN: '30' });
    const rep = new Reporter(desk, dir);
    rep.start();
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(desk.reports).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(desk.reports).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(desk.reports).toHaveLength(2);
    rep.stop();
    const files = readdirSync(dir, { recursive: true }).map(String);
    expect(files.filter((f) => f.endsWith('.md'))).toHaveLength(2);
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(2);
    const r = desk.reports[0];
    for (const k of ['balance', 'safetyNet', 'moneyTrade', 'n', 'perOrder'] as const) expect(typeof r[k]).toBe('number');
    expect(r.text).toMatch(/Not financial advice/);
  });
  it('list positions, what opened and closed, and never contain a secret', async () => {
    const SECRET = 'tgSECRETabcdefghij0123456789';
    const { a, desk, auto } = mk({ TELEGRAM_BOT_TOKEN: SECRET, TELEGRAM_CHAT_ID: '42', BYBIT_API_KEY: 'byKEYzzzzzzzzzzzz9' });
    armOpening(desk, a);
    registerSecrets([SECRET, 'byKEYzzzzzzzzzzzz9']);
    const sent: string[] = [];
    const fakeFetch = (async (_u: string, init: RequestInit) => { sent.push(String(init.body)); return new Response('{"ok":true}'); }) as unknown as typeof fetch;
    const dir = mkdtempSync(path.join(tmpdir(), 'mg-rep-'));
    const reporter = new Reporter(desk, dir, undefined, fakeFetch);
    await auto.cycle();
    desk.note('skipped', 'BTCUSDT', `upstream said ${SECRET} and byKEYzzzzzzzzzzzz9`);
    const r = await reporter.generate();
    expect(r.positions).toHaveLength(1);
    expect(r.positions[0].stop).toBeGreaterThan(0);
    expect(r.opened).toHaveLength(1);
    expect(r.skipped.some((x) => x.symbol === 'BTCUSDT')).toBe(true);
    await new Promise((res) => setTimeout(res, 20));
    const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => /\.(md|json)$/.test(f));
    const all = [r.text, JSON.stringify(r), ...sent, ...files.map((f) => readFileSync(path.join(dir, f), 'utf8'))].join('\n');
    expect(sent).toHaveLength(1); // Telegram got one message
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain('byKEYzzzzzzzzzzzz9');
    expect(all).toMatch(/REDACTED/);
  });
});
