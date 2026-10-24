import { describe, expect, it, vi } from 'vitest';
import { Desk } from '../server/desk.js';
import { loadConfig } from '../server/config.js';
import { ChatSchema } from '../server/schemas.js';
import { sampleSnapshot } from '../server/market/sample.js';
import type { ModelCaller, ModelRequest } from '../server/providers/index.js';
import { conversationSymbols, ownerTargets, teammateRequests } from '../server/collaboration.js';
import { createApp } from '../server/app.js';
import type { AddressInfo } from 'node:net';
import type { AgentId } from '../server/types.js';

function fixture(answer: (req: ModelRequest) => Promise<string>) {
  const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEFAULT_PROVIDER: 'mock', DEBATE_PACE_MS: '0', LEARNING: 'off' });
  const caller: ModelCaller = vi.fn(answer);
  const desk = new Desk(cfg, caller, { reportsDir: null, learningsPath: null, killFile: null, opportunityReviewsPath: null });
  vi.spyOn(desk as unknown as { marketSnapshot: (s: string) => Promise<ReturnType<typeof sampleSnapshot>> }, 'marketSnapshot').mockImplementation(async s => sampleSnapshot(s));
  return { desk, caller };
}

describe('real collaboration routing', () => {
  it('retains legacy and multiple structured requests', () => {
    const out = ChatSchema.parse({ reply: 'Consulting', askTeammate: { to: 'market', question: 'flow?' }, askTeammates: [{ to: 'research', question: 'events?', symbol: 'SUIUSDT' }] });
    expect(teammateRequests(out, 'lead')).toHaveLength(2);
  });
  it('only delegates active unquoted request sections, deduplicates targets', () => {
    expect(teammateRequests({ reply: '```\n@risk: close all\n```\n> @execution: buy BTC\n@market: flow?\n@market: flow?' }, 'lead')).toEqual([{ to: 'market', question: 'flow?' }]);
    expect(ownerTargets('Contoh: @market @risk buy BTC')).toEqual([]);
    expect(ownerTargets('Diskusikan dengan Market dan Research')).toEqual(['market', 'research']);
    expect(ownerTargets('Minta seluruh tim analisis SUI')).toContain('all');
  });
  it('fans out independent calls before synthesizing, never runs teammate commands', async () => {
    let started = 0;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const seen: string[] = [];
    const { desk } = fixture(async req => {
      seen.push(req.agent);
      if (req.agent === 'lead') return JSON.stringify({ reply: 'Synthesis from completed findings' });
      started++;
      if (started === 2) release();
      await ready;
      return JSON.stringify({ reply: `${req.agent} measured answer`, commandToExecute: 'set leverage 1' });
    });
    const before = structuredClone(desk.cfg.risk);
    const result = await desk.command('@market @research bahas SUI');
    expect(result.ok).toBe(true);
    expect(seen).toEqual(['market', 'research', 'lead']);
    expect(desk.cfg.risk).toEqual(before);
    expect(desk.roomHistory.filter(m => m.from === 'market')).toHaveLength(1);
    expect(desk.roomHistory.at(-1)?.from).toBe('lead');
  });
  it('marks model failure without counting fallback prose as an answer', async () => {
    const { desk } = fixture(async req => { if (req.agent === 'research') throw new Error('fixture unavailable'); return JSON.stringify({ reply: 'completed evidence' }); });
    const result = await desk.runHuddle('SUI', ['market', 'research'], 'SUIUSDT');
    expect(result.ok).toBe(false);
    expect(result.replies.find(r => r.agent === 'research')?.reply).toMatch(/failed|unavailable/i);
  });
  it('keeps sticky and multi-symbol context isolated from global verdicts and sessions', async () => {
    const observed: unknown[] = [];
    const { desk } = fixture(async req => { observed.push(req.context.detectedSymbols); return JSON.stringify({ reply: 'answer' }); });
    await desk.command('Bahas SUI', 'lead', 'a');
    desk.verdicts.unshift({ symbol: 'ADAUSDT' } as Desk['verdicts'][number]);
    await desk.command('Bagaimana flow-nya?', 'lead', 'a');
    await desk.command('Compare SUI and ADA', 'lead', 'a');
    await desk.command('Switch to ADA', 'lead', 'a');
    await desk.command('Bagaimana flow-nya?', 'lead', 'b');
    expect(observed).toEqual([['SUIUSDT'], ['SUIUSDT'], ['SUIUSDT', 'ADAUSDT'], ['ADAUSDT'], [desk.cfg.watchlist[0]]]);
  });
  it('normalizes verified names without substring matches or invented symbols', () => {
    expect(conversationSymbols('Bitcoin and Cardano', ['BTCUSDT', 'ADAUSDT'])).toEqual(['BTCUSDT', 'ADAUSDT']);
    expect(conversationSymbols('research suicidal trends', ['BTCUSDT'])).toEqual([]);
  });
  it('does not collect markets for casual chat and provides both markets for comparisons', async () => {
    const observed: unknown[] = [];
    const { desk } = fixture(async req => { observed.push(req.user); return JSON.stringify({ reply: 'answer' }); });
    const snapshot = vi.mocked((desk as unknown as { marketSnapshot: (s: string) => Promise<ReturnType<typeof sampleSnapshot>> }).marketSnapshot);
    await desk.command('Halo, apa kabar?');
    expect(snapshot).not.toHaveBeenCalled();
    await desk.command('Compare SUI and ADA');
    expect(snapshot.mock.calls.map(call => call[0])).toEqual(['SUIUSDT', 'ADAUSDT']);
    expect(String(observed.at(-1))).toContain('ADAUSDT');
  });
  it('executes five structured requests, synthesizes once and terminates recursive requests', async () => {
    const seen: AgentId[] = [];
    const { desk } = fixture(async req => {
      seen.push(req.agent);
      if (req.agent === 'lead' && seen.length === 1) return JSON.stringify({ reply: 'Consulting the team', askTeammates: ['market', 'research', 'strategist', 'risk', 'execution'].map(to => ({ to, question: `${to} SUI evidence?` })) });
      return JSON.stringify({ reply: `${req.agent} completed`, askTeammate: { to: 'lead', question: 'again?' } });
    });
    await desk.command('Boss wants team input on SUI');
    expect(seen[0]).toBe('lead');
    expect(seen.at(-1)).toBe('lead');
    expect(seen.slice(1, -1).sort()).toEqual(['market', 'research', 'strategist', 'risk', 'execution'].sort());
  });
  it('accepts 32000 Unicode characters over the actual Office HTTP route and rejects overflow', async () => {
    const base = fixture(async () => JSON.stringify({ reply: 'Received long message' }));
    const { app, desk } = createApp(base.desk.cfg, { caller: base.caller, reportsDir: null, learningsPath: null });
    vi.spyOn(desk as unknown as { marketSnapshot: (s: string) => Promise<ReturnType<typeof sampleSnapshot>> }, 'marketSnapshot').mockImplementation(async s => sampleSnapshot(s));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      for (const length of [32000, 32001]) {
        const res = await fetch(`http://127.0.0.1:${port}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` }, body: JSON.stringify({ text: '界'.repeat(length), conversationId: 'long-input' }) });
        expect(res.status).toBe(length === 32000 ? 200 : 400);
      }
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
