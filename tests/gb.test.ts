import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';

// Sample market dressed up as exchange data so the fake exchange path can run.
vi.mock('../server/market/index.js', async (orig) => {
  const m = await orig<typeof import('../server/market/index.js')>();
  return { ...m, getSnapshot: async (s: string) => ({ ...(await m.getSnapshot(s, 'sample')), example: false }) };
});

const { loadConfig } = await import('../server/config.js');
const { createApp } = await import('../server/app.js');
const { LiveExecutor } = await import('../server/live/executor.js');
const { MemoryAdapter } = await import('./fakes.js');
const { gb } = await import('../cli/gb.js');

const SECRET = 'gbSECRET-0123456789abcdefghij';
const env = { TRADING_MODE: 'PAPER', APP_MODE: 'grokbot', AGENT_EVENT_SECRET: SECRET, MARKET_SOURCE: 'sample', DEBATE_PACE_MS: '0', AUTO_TRADING: 'on', MAX_LEVERAGE: '3' };
let modelCalls = 0;
const adapter = new MemoryAdapter();
adapter.fillAt = (o) => Math.round((o.side === 'LONG' ? o.stop * 1.015 : o.stop / 1.015) * 100) / 100;
adapter.closeAt = () => (adapter.placed.length ? adapter.fillAt(adapter.placed[adapter.placed.length - 1]) : 0);
const cfg = loadConfig(env);
const built = createApp(cfg, { caller: async () => { modelCalls++; throw new Error('model called'); }, reportsDir: null, executor: new LiveExecutor(adapter, 0), learningsPath: null });
let baseUrl = '';
beforeAll(async () => { await new Promise<void>((r) => built.server.listen(0, '127.0.0.1', () => r())); baseUrl = `http://127.0.0.1:${(built.server.address() as AddressInfo).port}`; });
afterAll(async () => { built.desk.stop(); await new Promise((r) => built.server.close(r)); });
const run = (...argv: string[]) => gb(argv, { env, baseUrl });

describe('npm run gb (keyless agent CLI, fake exchange)', () => {
  it('market, candles, split and size work without any model key', async () => {
    expect((await run('market', 'ETHUSDT')).ok).toBe(true);
    const c = await run('candles', 'BTCUSDT', '1h', '--limit', '20');
    expect(c.ok).toBe(true);
    expect((c.data as { candles: unknown[] }).candles.length).toBeGreaterThan(5);
    const sp = await run('split', '--balance', '1000', '--safety', '200', '--n', '4');
    expect(sp.data).toMatchObject({ moneyTrade: 800, perOrder: 200 });
    const sz = await run('size', 'ETHUSDT', 'SHORT', '3100', '3140');
    expect(sz.ok).toBe(true);
    expect((sz.data as { stop: number }).stop).toBe(3140);
  });
  it('event lines show in the office as Grok Bot agents speaking', async () => {
    const r = await run('event', 'market', 'ETH tape is heavy, sellers in control.', '--stance', 'SHORT', '--confidence', '0.7');
    expect(r.ok).toBe(true);
    expect(built.desk.logs.some((l) => l.kind === 'speech' && l.agent === 'market' && /tape is heavy/.test(l.text))).toBe(true);
    expect(built.desk.agents.market.stance).toBe('SHORT');
  });
  it('open goes through the risk gate caps, money split and mandatory stop; close all flattens', async () => {
    // A stop wider than DEFAULT_STOP_PCT is refused, never tightened or moved, and nothing reaches the exchange.
    const wide = await run('open', 'ETHUSDT', 'SHORT', '--confidence', '0.8', '--stop', '3600', '--leverage', '50', '--reason', 'Desk Lead: short ETH, stop far above the range.');
    expect(wide.ok).toBe(false);
    expect(wide.text).toMatch(/wider than the 1.5% limit/);
    expect(adapter.placed).toHaveLength(0);
    const mk = (await run('market', 'ETHUSDT')).data as { last?: number; bid?: number | null };
    const px = Number(mk.bid ?? mk.last);
    const stop = Math.round(px * 1.012); // 1.2% above the bid, inside the 1.5% limit, on the fake tick
    const r = await run('open', 'ETHUSDT', 'SHORT', '--confidence', '0.8', '--stop', String(stop), '--leverage', '50', '--reason', 'Desk Lead: short ETH, stop above the range.');
    expect(r.ok).toBe(true);
    const notes = (r.data as { notes: string[] }).notes.join(' ');
    expect(notes).toMatch(/capped to 3x/);
    expect(adapter.placed).toHaveLength(1);
    expect(adapter.placed[0].leverage).toBeLessThanOrEqual(3);
    // The given stop is used exactly (already on the tick), never moved.
    expect(adapter.placed[0].stop).toBe(stop);
    const pos = await run('positions');
    expect((pos.data as unknown[]).length).toBe(1);
    const acc = await run('account');
    expect((acc.data as { appMode: string }).appMode).toBe('grokbot');
    const dup = await run('open', 'ETHUSDT', 'SHORT', '--confidence', '0.8', '--stop', '3200');
    expect(dup.ok).toBe(false);
    const cl = await run('close', 'all');
    expect(cl.ok).toBe(true);
    expect(adapter.closes).toBe(1);
  });
  it('refuses a stop on the wrong side', async () => {
    const r = await run('open', 'SOLUSDT', 'LONG', '--confidence', '0.8', '--stop', '999999');
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/wrong side/);
  });
  it('write commands need the secret', async () => {
    const r = await gb(['open', 'ETHUSDT', 'LONG'], { env: { ...env, AGENT_EVENT_SECRET: 'nope-nope-nope-nope-nope-1' }, baseUrl });
    expect(r.ok).toBe(false);
    await expect(gb(['scan'], { env: { ...env, AGENT_EVENT_SECRET: '' }, baseUrl })).rejects.toThrow(/AGENT_EVENT_SECRET/);
  });
  it('scan and lessons add|list (advice leaves active settings intact) with JSON-friendly output', async () => {
    const s = await run('scan');
    expect(s.ok).toBe(true);
    expect(Array.isArray(s.data)).toBe(true);
    const bad = await run('lessons', 'add', 'risk', 'use', '10x', 'leverage', 'on', 'strong', 'signals');
    expect(bad.ok).toBe(true);
    expect(built.desk.cfg.risk.maxLeverage).toBe(3);
    for (let i = 0; i < 3; i++) await run('lessons', 'add', 'market', 'No stance on stale prices, say NEUTRAL', '--kind', 'scan', '--cause', 'feed lag');
    const list = await run('lessons', 'list');
    expect(list.text).toMatch(/RULE market: No stance on stale prices/);
  });
  it('report includes the Desk Lead scorecard and lessons this period', async () => {
    const r = await run('report');
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/Scorecard \(Desk Lead\)/);
    expect(r.text).toMatch(/Lessons this period/);
    expect(r.text).not.toContain(SECRET);
  });
  it('Grok Bot mode makes no model calls and the internal debate engine is off', async () => {
    const res = await fetch(`${baseUrl}/api/debate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ symbol: 'BTCUSDT' }) });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Grok Bot mode/);
    await built.desk.command('hello there', 'risk');
    built.auto.start(); // stays off in Grok Bot mode
    expect(built.desk.autoState.on).toBe(false);
    for (let i = 0; i < 20 && !built.desk.logs.some((l) => /Journal: grade/.test(l.text)); i++) await new Promise((r) => setTimeout(r, 25));
    expect(built.desk.logs.some((l) => /Journal: grade/.test(l.text))).toBe(true); // journal without a model
    expect(modelCalls).toBe(0);
    expect(built.desk.snapshot().agents.lead.provider).toBe('grokbot');
  });
});
