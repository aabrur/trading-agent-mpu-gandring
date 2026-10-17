// Regression checks for two reported Grok Bot-mode issues:
// 1. stances posted with `gb event` must not be wiped by a debate/auto cycle start;
// 2. a Desk Lead line whose free text contains "hold" (threshold, holding, "not a hold") must not act as a HOLD verdict.
//    Only the structured proposal field action=HOLD is a HOLD.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';

vi.mock('../server/market/index.js', async (orig) => {
  const m = await orig<typeof import('../server/market/index.js')>();
  return { ...m, getSnapshot: async (s: string) => ({ ...(await m.getSnapshot(s, 'sample')), example: false }) };
});

const { loadConfig } = await import('../server/config.js');
const { createApp } = await import('../server/app.js');
const { LiveExecutor } = await import('../server/live/executor.js');
const { MemoryAdapter } = await import('./fakes.js');
const { gb } = await import('../cli/gb.js');

const SECRET = 'gbSECRET-regress-0123456789abcdef';
const env = { TRADING_MODE: 'PAPER', APP_MODE: 'grokbot', AGENT_EVENT_SECRET: SECRET, MARKET_SOURCE: 'sample', DEBATE_PACE_MS: '0', AUTO_TRADING: 'on', MAX_LEVERAGE: '3' };
const adapter = new MemoryAdapter();
adapter.fillAt = (o) => Math.round((o.side === 'LONG' ? o.stop * 1.015 : o.stop / 1.015) * 100) / 100;
const built = createApp(loadConfig(env), { caller: async () => { throw new Error('model called'); }, reportsDir: null, executor: new LiveExecutor(adapter, 0), learningsPath: null });
let baseUrl = '';
beforeAll(async () => { await new Promise<void>((r) => built.server.listen(0, '127.0.0.1', () => r())); baseUrl = `http://127.0.0.1:${(built.server.address() as AddressInfo).port}`; });
afterAll(async () => { built.desk.stop(); await new Promise((r) => built.server.close(r)); });
const run = (...argv: string[]) => gb(argv, { env, baseUrl });

describe('Grok Bot mode regressions', () => {
  it('stances posted via gb event survive an auto cycle and a debate start attempt', async () => {
    expect((await run('event', 'market', 'Tape heavy.', '--stance', 'SHORT', '--confidence', '0.7')).ok).toBe(true);
    expect((await run('event', 'research', 'No news risk.', '--stance', 'NEUTRAL', '--confidence', '0.5')).ok).toBe(true);
    expect((await run('event', 'strategist', 'EMA rule short.', '--stance', 'SHORT', '--confidence', '0.8')).ok).toBe(true);
    await built.auto.cycle();
    await expect(built.desk.runDebate('ETHUSDT')).rejects.toThrow(/Grok Bot mode/);
    expect(built.desk.agents.market.stance).toBe('SHORT');
    expect(built.desk.agents.research.stance).toBe('NEUTRAL');
    expect(built.desk.agents.strategist.stance).toBe('SHORT');
    expect(built.desk.agents.strategist.confidence).toBe(0.8);
  });
  it('free text containing "hold" from the Desk Lead does not block a ticket', async () => {
    for (const t of ['Disagreement is under the threshold, go.', 'We are holding the line: short ETH.', 'This is not a hold. Short it.'])
      expect((await run('event', 'lead', t)).ok).toBe(true);
    const mk = (await run('market', 'ETHUSDT')).data as { last?: number; bid?: number | null };
    const stop = Math.round(Number(mk.bid ?? mk.last) * 1.012);
    const r = await run('open', 'ETHUSDT', 'SHORT', '--stop', String(stop), '--reason', 'Desk Lead: OPEN_SHORT, not a hold, threshold met.');
    expect(r.ok).toBe(true);
    expect(adapter.placed).toHaveLength(1);
    await run('close', 'all');
  });
  it('only the structured proposal action=HOLD is a HOLD, and it never sends', async () => {
    const before = adapter.placed.length;
    const h = await built.desk.onAgentEvent({ agent: 'lead', kind: 'proposal', symbol: 'ETHUSDT', action: 'HOLD', text: 'threshold not met' });
    expect(h).toEqual({ ok: true, reply: 'hold noted' });
    // A proposal without a valid action is refused, never treated as an open.
    const bad = await built.desk.onAgentEvent({ agent: 'lead', kind: 'proposal', symbol: 'ETHUSDT', text: 'OPEN_SHORT please' } as never);
    expect(bad.ok).toBe(false);
    const res = await fetch(`${baseUrl}/api/agent-event`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ agent: 'lead', kind: 'proposal', symbol: 'ETHUSDT', action: 'hold maybe' }) });
    expect(res.status).toBe(400);
    expect(adapter.placed.length).toBe(before);
  });
});
