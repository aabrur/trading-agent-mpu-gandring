import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { LiveExecutor } from '../server/live/executor.js';
import { sampleSnapshot } from '../server/market/sample.js';
import { gb } from '../cli/gb.js';
import { MemoryAdapter } from './fakes.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); vi.restoreAllMocks(); });

async function fixture(mode: 'grokbot' | 'local' = 'grokbot') {
  const env = { APP_MODE: mode, TRADING_MODE: 'PAPER', DEFAULT_PROVIDER: 'mock', MARKET_SOURCE: 'sample', AUTO_TRADING: 'off', OPEN_ORDERS_N: '2', MIN_ENTRY_CONFIDENCE_PCT: '70', JEV_ENABLED: 'false', ...(mode === 'grokbot' ? { AGENT_EVENT_SECRET: 'fixture-external-agent-secret' } : {}) };
  const cfg = loadConfig(env), adapter = new MemoryAdapter();
  const caller = vi.fn(async () => { throw new Error('External native agents do their own reasoning'); });
  const built = createApp(cfg, { caller, executor: new LiveExecutor(adapter, 0), reportsDir: null, learningsPath: null, conversationsPath: null, killFile: null, jevEnv: {} });
  await new Promise<void>(resolve => built.server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { built.desk.stop(); await new Promise<void>(resolve => built.server.close(() => resolve())); });
  const baseUrl = `http://127.0.0.1:${(built.server.address() as AddressInfo).port}`;
  cfg.tradingMode = 'LIVE';
  const snapshot = { ...sampleSnapshot('BTCUSDT'), source: 'bybit' as const, example: false, last: 108, bid: 108, ask: 108, fetchedAt: Date.now(), candles: Array.from({ length: 80 }, (_, i) => ({ t: Date.now() - (81 - i) * 900_000, o: 116 - i * .1, c: 116 - i * .1, h: 117 - i * .1, l: 115 - i * .1, v: 10 })) };
  vi.spyOn(built.desk, 'collectResearchData').mockImplementation(async () => ({ market: { ...snapshot, fetchedAt: Date.now() }, news: [], whale: { symbol: 'BTCUSDT', providerStatus: 'UNAVAILABLE', providerName: 'fixture', events: [], summary: 'Unavailable', observedAt: Date.now(), disclaimer: 'Fixture' }, trace: { symbol: 'BTCUSDT', route: 'PARALLEL', routedBy: 'default', routing: { status: 'not_requested', latencyMs: null, reason: 'fixture' }, startedAt: Date.now(), completedAt: Date.now(), feeds: {} } }));
  vi.spyOn(built.desk as unknown as { marketSnapshot(symbol: string, force?: boolean): Promise<typeof snapshot> }, 'marketSnapshot').mockImplementation(async () => ({ ...snapshot, fetchedAt: Date.now() }));
  for (const symbol of ['BTCUSDT', 'ETHUSDT']) {
    const p = built.desk.book.open({ symbol, side: 'LONG', qty: 1, entry: 108, stop: 90, tp: 130, margin: 108, leverage: 1 });
    p.ownership = 'managed'; p.invalidationLevel = 90;
  }
  adapter.pos = built.desk.book.positions.map(p => ({ ...p, mark: 108, unrealizedPnl: 0 }));
  adapter.closeAt = () => 108;
  const run = (...args: string[]) => gb(args, { env, baseUrl });
  return { ...built, env, cfg, adapter, caller, baseUrl, snapshot, run };
}

describe('native Grok Bot and Muse shared engine access', () => {
  it.each(['grokbot', 'local'] as const)('%s closes with a fresh typed trigger at full capacity without entry confidence', async mode => {
    const f = await fixture(mode);
    const settings = structuredClone({ risk: f.cfg.risk, paper: f.cfg.paper, agents: f.cfg.agents });
    const review = await f.run('close-review', 'BTCUSDT', '--trigger', 'MOMENTUM_REVERSAL');
    expect(review.ok).toBe(true);
    const data = review.data as { position: { id: string; qty: number }; closeTriggers: Array<{ reason: string }> };
    expect(review.data).toMatchObject({ intent: 'CLOSE_REVIEW', fresh: true, accountConfirmed: true, newEntryCapacity: { freeSlots: 0 }, ownerMinEntryConfidencePct: 70 });
    expect(data.closeTriggers.some(trigger => trigger.reason === 'MOMENTUM_REVERSAL')).toBe(true);
    const closed = await f.run('close', 'BTCUSDT', '--trigger', 'MOMENTUM_REVERSAL', '--position-id', data.position.id, '--expected-qty', String(data.position.qty), '--reason', 'Lead CLOSE, without changing kill state');
    expect(closed.ok, closed.text).toBe(true);
    expect(f.adapter.closes).toBe(1);
    expect(f.adapter.placed).toHaveLength(0);
    expect(f.desk.book.closed[0].exitCause).toBe('AI_DEBATE');
    expect(f.adapter.pos[0]).toMatchObject({ symbol: 'ETHUSDT', stop: 90, tp: 130 });
    expect({ risk: f.cfg.risk, paper: f.cfg.paper, agents: f.cfg.agents }).toEqual(settings);
    expect(f.caller).not.toHaveBeenCalled();
  });

  it.each(['wrong-trigger', 'changed-position', 'stale'] as const)('fails closed for %s without falling back to manual close', async failure => {
    const f = await fixture();
    const review = (await f.run('close-review', 'BTCUSDT')).data as { position: { id: string; qty: number } };
    if (failure === 'changed-position') f.adapter.pos[0].qty = .5;
    if (failure === 'stale') {
      const old = Date.now() - 40_000;
      const collected = await f.desk.collectResearchData('BTCUSDT');
      vi.mocked(f.desk.collectResearchData).mockResolvedValue({ ...collected, market: { ...f.snapshot, fetchedAt: old } });
      vi.mocked(f.desk as unknown as { marketSnapshot(s: string): Promise<typeof f.snapshot> }).marketSnapshot.mockResolvedValue({ ...f.snapshot, fetchedAt: old });
    }
    const result = await f.run('close', 'BTCUSDT', '--trigger', failure === 'wrong-trigger' ? 'SENTIMENT_REVERSAL' : 'MOMENTUM_REVERSAL', '--position-id', review.position.id, '--expected-qty', String(review.position.qty), '--reason', 'Lead exit review');
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/not verified|position changed/);
    expect(f.adapter.closes).toBe(0);
  });

  it.each(['grokbot', 'local'] as const)('%s agent entry requires Risk APPROVE and the active Owner confidence', async mode => {
    const f = await fixture(mode);
    f.desk.book.positions.splice(0); f.adapter.pos = [];
    vi.spyOn(f.adapter, 'ticker').mockResolvedValue(108); f.adapter.fillAt = () => 108;
    expect((await f.run('open', 'BTCUSDT', 'LONG', '--risk-approval', 'REJECT', '--confidence', '.9', '--reason', 'Entry rejected')).ok).toBe(false);
    const below = await f.run('open', 'BTCUSDT', 'LONG', '--risk-approval', 'APPROVE', '--confidence', '.69', '--reason', 'Lead entry');
    expect(below.ok).toBe(false);
    expect(below.text).toMatch(/confidence/i);
    expect(f.adapter.placed).toHaveLength(0);
    const valid = await f.run('open', 'BTCUSDT', 'LONG', '--risk-approval', 'APPROVE', '--confidence', '.7', '--reason', 'Lead entry, Risk APPROVE');
    expect(valid.ok, valid.text).toBe(true);
    expect(f.adapter.placed).toHaveLength(1);
    expect(f.desk.book.positions[0].decisionEvidence).toMatchObject({ confidence: .7, riskApproval: 'APPROVE', reason: 'Lead entry, Risk APPROVE' });
    expect(f.cfg.risk.minEntryConfidencePct).toBe(70);
    expect(f.desk.book.n).toBe(2);
  });

  it('serves the four existing reports and rejects unrelated commands and remote origins', async () => {
    const f = await fixture('local');
    for (const command of ['status', 'positions', 'scan', 'scorecard']) {
      const result = await f.run('summary', command);
      expect(result.ok).toBe(true);
      expect(result.text).toContain('Trading Agent Mpu Gandring');
    }
    expect((await f.run('summary', 'kill')).ok).toBe(false);
    expect((await fetch(`${f.baseUrl}/api/research/close-review?symbol=BTCUSDT`, { headers: { origin: 'https://untrusted.example' } })).status).toBe(403);
    expect((await fetch(`${f.baseUrl}/api/gb/agent-close`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404);
    expect(f.adapter.closes).toBe(0);
    expect(f.desk.killed).toBe(false);
  });

  it('keeps both install templates tied to the current six-role contract without stale entry/exit instructions', async () => {
    for (const file of ['grokbot/TEMPLATE.md', 'muse/muse-template.md']) {
      const text = await readFile(file, 'utf8');
      expect(text).toContain('docs/external-agent-operations.md');
      expect(text).toMatch(/five|other five/);
      expect(text).not.toMatch(/Lead analyzes alone|four subagents|below 0\.6|max holding time/);
      expect(text).not.toContain('Lead plus Execution');
    }
  });
});
