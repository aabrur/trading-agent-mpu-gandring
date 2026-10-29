import { afterEach, expect, it, vi } from 'vitest';
import { Desk } from '../server/desk.js';
import { loadConfig } from '../server/config.js';
import { sampleSnapshot } from '../server/market/sample.js';
import type { ModelCaller } from '../server/providers/index.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
it('measures independent phases and uses max(rebuttals), not their sum', async () => {
  vi.useFakeTimers();
  const thresholds: Array<{ agent: string; data: unknown; context: unknown }> = [];
  const call: ModelCaller = async req => {
    thresholds.push({ agent: req.agent, data: JSON.parse(req.user.match(/<<<UNTRUSTED_DATA desk>>>\n([\s\S]*?)\n<<<END_UNTRUSTED_DATA desk>>>/)?.[1] ?? '{}').ownerMinEntryConfidencePct, context: req.context.ownerMinEntryConfidencePct });
    const delay = req.task === 'lead' ? 100 : req.agent === 'risk' ? 150 : req.agent === 'execution' ? 250 : req.agent === 'market' ? 100 : req.agent === 'research' ? 200 : 300;
    await new Promise(resolve => setTimeout(resolve, delay));
    const stance = req.agent === 'research' ? 'SHORT' : 'LONG';
    if (req.task === 'research') return JSON.stringify({ vote: stance, confidence: .8, argument: 'Conflicting observed evidence.', sources: [] });
    if (req.task === 'opinion') return JSON.stringify({ stance, confidence: .8, argument: 'Role observation.' });
    if (req.task === 'rebuttal') return JSON.stringify({ stance, confidence: .8, target: 'none', rebuttal: 'Targeted evidence challenge.' });
    if (req.task === 'risk_assessment') return '{"decision":"APPROVE","sizeFactor":1,"leverage":1,"stopPct":10,"reason":"Reviewed all actual rebuttals."}';
    if (req.task === 'lead') return '{"action":"HOLD","confidence":0.7,"reason":"Explicitly waiting for the setup."}';
    return '{"reply":"Actual instrument readiness reviewed."}';
  };
  const d = new Desk(loadConfig({ TRADING_MODE: 'PAPER', DEFAULT_PROVIDER: 'mock', MARKET_SOURCE: 'sample', DEBATE_MODE: 'fast', DEBATE_PACE_MS: '0', JEV_ENABLED: 'false', MIN_ENTRY_CONFIDENCE_PCT: '73' }), call, { reportsDir: null, conversationsPath: null, learningsPath: null, killFile: null, opportunityReviewsPath: null, jevEnv: {} });
  const diagnostics = vi.spyOn(d, 'diagnostic');
  vi.spyOn(d, 'collectResearchData').mockResolvedValue({ market: sampleSnapshot('BTCUSDT'), news: [], whale: { symbol: 'BTCUSDT', providerStatus: 'UNAVAILABLE', providerName: 'fixture', summary: 'Unavailable', observedAt: Date.now(), events: [], disclaimer: 'Fixture' }, trace: { symbol: 'BTCUSDT', route: 'PARALLEL', routedBy: 'default', routing: { status: 'not_requested', latencyMs: null, reason: 'fixture' }, startedAt: Date.now(), completedAt: Date.now(), feeds: {} } });
  const run = d.runDebate('BTCUSDT');
  await vi.runAllTimersAsync();
  const result = await run;
  expect(result.timing).toMatchObject({ marketAnalyst: 100, researchAnalyst: 200, strategist: 300, rebuttals: 300, riskManager: 150, executionTrader: 250, deskLead: 100, total: 950 });
  expect(new Set(thresholds.map(t => t.agent)).size).toBe(6);
  expect(thresholds.every(t => t.context === 73 && t.data === 73)).toBe(true);
  const completion = d.logs.find(line => line.text.startsWith('Debate BTCUSDT completed'))!;
  for (const agent of ['market', 'research', 'strategist', 'risk', 'execution', 'lead']) expect(completion.text.match(new RegExp(`\\b${agent}\\b`, 'g'))).toHaveLength(1);
  const participants = diagnostics.mock.calls.map(([input]) => input).find(input => input.eventName === 'debate.verdict')?.details?.participants;
  expect(participants).toEqual(expect.arrayContaining([
    expect.objectContaining({ agent: 'risk', status: 'completed', modelDurationMs: 150 }),
    expect.objectContaining({ agent: 'execution', status: 'completed', modelDurationMs: 250 })
  ]));
});
