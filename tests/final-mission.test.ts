import { afterEach, describe, expect, it, vi } from 'vitest';
import { Desk } from '../server/desk.js';
import { loadConfig } from '../server/config.js';
import { LiveExecutor } from '../server/live/executor.js';
import { buildReport } from '../server/reports.js';
import { MemoryAdapter } from './fakes.js';
import type { ModelCaller } from '../server/providers/index.js';
import type { MarketSnapshot } from '../server/types.js';

afterEach(() => vi.restoreAllMocks());

function fixture(min = 60, confidence = .7, veto = false) {
  const cfg = loadConfig({ TRADING_MODE: 'PAPER', DEFAULT_PROVIDER: 'mock', MARKET_SOURCE: 'sample', DEBATE_PACE_MS: '0', LEARNING: 'off', JEV_ENABLED: 'false' });
  cfg.tradingMode = 'LIVE'; cfg.exchange.name = 'aster';
  cfg.live = { exchange: 'aster', network: 'mainnet', experimental: true };
  cfg.risk.minEntryConfidencePct = min;
  const adapter = new MemoryAdapter();
  Object.defineProperty(adapter, 'name', { value: 'aster' });
  vi.spyOn(adapter, 'ticker').mockResolvedValue(108);
  adapter.fillAt = () => 108;
  const scenario = { id: 'pullback', kind: 'PULLBACK_CONTINUATION' as const, side: 'LONG' as const, entryZone: { low: 104, high: 105, basis: 'reference support' }, invalidationLevel: 100, target1: 120, target2: 130, evidence: ['structure'], missingEvidence: [] };
  const snapshot: MarketSnapshot = { symbol: 'BTCUSDT', source: 'bybit', example: false, last: 108, bid: 108, ask: 108, change24hPct: 1, fundingRate: null, fetchedAt: Date.now(), candles: Array.from({ length: 80 }, (_, i) => ({ t: Date.now() - (81-i)*900000, o: 100+i*.1, c: 100+i*.1, h: 101+i*.1, l: 99+i*.1, v: 10 })), tacticalTradePlan: { symbol: 'BTCUSDT', timestamp: Date.now(), marketRegime: 'STRONG_UPTREND', scenarios: [scenario], exhaustion: { present: false, direction: 'NONE', evidence: [] } } };
  const call: ModelCaller = vi.fn(async req => {
    if (req.task === 'opinion') return JSON.stringify({ stance: 'LONG', confidence, argument: 'Observed price supports entry.', ...scenario, entryScenarioId: scenario.id });
    if (req.task === 'research') return JSON.stringify({ vote: 'ABSTAIN', confidence: .5, argument: 'Optional evidence unavailable.', sources: [] });
    if (req.task === 'risk_assessment') return JSON.stringify({ decision: veto ? 'REJECT' : 'APPROVE', sizeFactor: veto ? 0 : 1, leverage: cfg.risk.maxLeverage, stopPct: cfg.risk.defaultStopPct, reason: veto ? 'Observed liquidity risk is unacceptable.' : 'Observed exposure and current evidence support Owner allocation.' });
    if (req.task === 'lead') return JSON.stringify({ action: 'OPEN_LONG', confidence, reason: 'Risk-approved market entry.', entryScenarioId: scenario.id });
    if (req.task === 'rebuttal') return JSON.stringify({ stance: 'LONG', confidence, target: 'none', rebuttal: 'No unresolved conflict.' });
    return JSON.stringify({ reply: 'Instrument and venue readiness reviewed.' });
  });
  const executor = new LiveExecutor(adapter, 0);
  const desk = new Desk(cfg, call, { executor, reportsDir: null, learningsPath: null, conversationsPath: null, opportunityReviewsPath: null, killFile: null, jevEnv: {} });
  vi.spyOn(desk, 'collectResearchData').mockImplementation(async () => ({ market: snapshot, news: [], whale: { symbol: 'BTCUSDT', providerStatus: 'UNAVAILABLE', providerName: 'fixture', events: [], summary: 'Unavailable', observedAt: Date.now(), disclaimer: 'Fixture' }, trace: { symbol: 'BTCUSDT', route: 'PARALLEL', routedBy: 'default', routing: { status: 'not_requested', latencyMs: null, reason: 'fixture' }, startedAt: Date.now(), completedAt: Date.now(), feeds: {} } }));
  vi.spyOn(desk as unknown as { marketSnapshot(s: string): Promise<MarketSnapshot> }, 'marketSnapshot').mockImplementation(async () => ({ ...snapshot, fetchedAt: Date.now() }));
  return { desk, adapter, executor, cfg, call, snapshot };
}

describe('Final mission decision integrity', () => {
  it('T1/T4 sends one Aster order using native price despite a discretionary pullback zone', async () => {
    const { desk, adapter, cfg, call } = fixture();
    const saved = structuredClone({ risk: cfg.risk, paper: cfg.paper });
    const result = await desk.runDebate('BTCUSDT');
    expect(result, result.reason).toMatchObject({ action: 'OPEN_LONG', riskDecision: 'APPROVE', executed: true });
    expect(adapter.placed).toHaveLength(1);
    expect(vi.mocked(call).mock.calls.some(([req]) => req.agent === 'risk' && req.task === 'risk_assessment')).toBe(true);
    expect(vi.mocked(call).mock.calls.some(([req]) => req.agent === 'execution')).toBe(true);
    expect({ risk: cfg.risk, paper: cfg.paper }).toEqual(saved);
    expect(adapter.pos[0].stop).toBeGreaterThan(0);
  });
  it.each([[60, .599, false], [60, .6, true], [70, .69, false], [70, .7, true], [90, .899, false], [90, .9, true]])('T2 Owner %s and confidence %s: open=%s', async (min, confidence, open) => {
    const { desk, adapter } = fixture(Number(min), Number(confidence));
    const result = await desk.runDebate('BTCUSDT');
    expect(result.executed).toBe(open);
    expect(adapter.placed).toHaveLength(open ? 1 : 0);
    if (!open) expect(result.reason).toMatch(/confidence/i);
  });
  it('meaningful Risk veto prevents a Lead OPEN', async () => {
    const { desk, adapter } = fixture(60, .7, true);
    const result = await desk.runDebate('BTCUSDT');
    expect(result.riskDecision).toBe('REJECT');
    expect(result.reason).toMatch(/liquidity risk/i);
    expect(adapter.placed).toHaveLength(0);
  });
  it('Risk judgment cannot impose the legacy 50% sizing-schema cap on an Owner-selected 60% stop', async () => {
    const { desk, cfg } = fixture();
    cfg.risk.defaultStopPct = 60;
    const result = await desk.runDebate('BTCUSDT');
    expect(result, result.reason).toMatchObject({ riskDecision: 'APPROVE', executed: true });
    expect(cfg.risk.defaultStopPct).toBe(60);
  });
  it('T3 rejects unsupported PEPE before model work without an alias', async () => {
    const { desk, adapter, call } = fixture();
    vi.spyOn(adapter, 'instrument').mockRejectedValue(new Error('unknown symbol PEPEUSDT'));
    await expect(desk.runDebate('PEPEUSDT')).rejects.toThrow(/INVALID_SYMBOL/);
    expect(call).not.toHaveBeenCalled();
    expect(adapter.placed).toHaveLength(0);
  });

  it('T4 missing native quote preserves AI OPEN and reports price unavailable', async () => {
    const { desk, adapter } = fixture();
    vi.spyOn(adapter, 'ticker').mockRejectedValue(new Error('native price unavailable'));
    const result = await desk.runDebate('BTCUSDT');
    expect(result).toMatchObject({ aiDecision: 'OPEN_LONG', action: 'OPEN_LONG', executed: false, executionOutcome: 'PRICE_UNAVAILABLE' });
    expect(adapter.placed).toHaveLength(0);
  });

  it('T5 model-only reversal cannot close a newly opened position', async () => {
    const { desk, adapter, call } = fixture();
    const original = vi.mocked(call).getMockImplementation()!;
    vi.mocked(call).mockImplementation(async req => req.task === 'lead' ? JSON.stringify({ action: 'CLOSE', confidence: .9, closeTrigger: 'SENTIMENT_REVERSAL', reason: 'Models disagree with entry.' }) : original(req));
    const pos = desk.book.open({ symbol: 'BTCUSDT', side: 'LONG', qty: 1, entry: 108, stop: 90, tp: 130, margin: 108, leverage: 1 });
    pos.ownership = 'managed'; pos.invalidationLevel = 100;
    adapter.pos = [{ ...pos, unrealizedPnl: 0 }];
    expect((await desk.runDebate('BTCUSDT')).executed).toBe(false);
    expect(adapter.closes).toBe(0);
  });

  it.each([2, 3])('closes a verified position with all %s slots occupied despite entry rejection and low confidence', async n => {
    const { desk, adapter, cfg, call } = fixture(70, .2, true);
    desk.book.n = n;
    const original = vi.mocked(call).getMockImplementation()!;
    vi.mocked(call).mockImplementation(async req => req.task === 'lead'
      ? JSON.stringify({ action: 'CLOSE', confidence: .2, closeTrigger: 'INVALIDATION_HIT', reason: 'Persisted invalidation breached.' })
      : req.task === 'risk_assessment' ? JSON.stringify({ decision: 'REJECT', reason: 'CAPACITY_FULL: additional entry has no slot or margin.' }) : original(req));
    for (let i = 0; i < n; i++) {
      const pos = desk.book.open({ symbol: i ? `ALT${i}USDT` : 'BTCUSDT', side: 'LONG', qty: 1, entry: 108, stop: 90, tp: 130, margin: 108, leverage: 1 });
      pos.ownership = 'managed'; pos.invalidationLevel = 110;
    }
    adapter.pos = desk.book.positions.map(pos => ({ ...pos, unrealizedPnl: 0 }));
    vi.spyOn(adapter, 'balance').mockResolvedValue({ equityUsdt: 1000, availableUsdt: 0 });
    adapter.closeAt = () => 108;
    const saved = structuredClone({ risk: cfg.risk, paper: cfg.paper, n: desk.book.n });
    const result = await desk.runDebate('BTCUSDT');
    expect(result, result.reason).toMatchObject({ action: 'CLOSE', executed: true, closeTrigger: 'INVALIDATION_HIT', riskDecision: 'REJECT' });
    expect(adapter.closes).toBe(1);
    expect(adapter.placed).toHaveLength(0);
    expect(adapter.pos).toHaveLength(n - 1);
    expect(adapter.pos.every(pos => pos.stop === 90 && pos.tp === 130)).toBe(true);
    const risk = vi.mocked(call).mock.calls.find(([req]) => req.task === 'risk_assessment')![0];
    const execution = vi.mocked(call).mock.calls.find(([req]) => req.agent === 'execution')![0];
    expect(risk.context).toMatchObject({ intent: 'CLOSE_REVIEW', newEntryCapacity: { freeSlots: 0, canOpenNew: false }, closeEligibility: { eligible: true }, protection: { status: 'confirmed', stop: 90, tp: 130 } });
    expect(execution.context.accountSnapshot).toEqual(risk.context.accountSnapshot);
    expect(execution.context.intent).toBe(risk.context.intent);
    expect(execution.context.newEntryCapacity).toEqual(risk.context.newEntryCapacity);
    expect({ risk: cfg.risk, paper: cfg.paper, n: desk.book.n }).toEqual(saved);
  });

  it.each([true, false])('opposite OPEN becomes only a verified CLOSE, trigger valid=%s', async valid => {
    const { desk, adapter, call } = fixture(70, .2);
    const pos = desk.book.open({ symbol: 'BTCUSDT', side: 'SHORT', qty: 1, entry: 108, stop: 120, tp: 80, margin: 108, leverage: 1 });
    pos.ownership = 'managed'; pos.invalidationLevel = valid ? 105 : 120;
    adapter.pos = [{ ...pos, unrealizedPnl: 0 }];
    const original = vi.mocked(call).getMockImplementation()!;
    vi.mocked(call).mockImplementation(async req => req.task === 'lead'
      ? JSON.stringify({ action: 'OPEN_LONG', confidence: .2, closeTrigger: valid ? 'INVALIDATION_HIT' : 'SENTIMENT_REVERSAL', reason: 'Opposite signal.' }) : original(req));
    const result = await desk.runDebate('BTCUSDT');
    expect(result.executed, result.reason).toBe(valid);
    expect(result.action).toBe(valid ? 'CLOSE' : 'HOLD');
    expect(adapter.closes).toBe(valid ? 1 : 0);
    expect(adapter.placed).toHaveLength(0);
    if (!valid) expect(result.reason).toMatch(/No verified CLOSE trigger/);
  });

  it('scopes a protected full-capacity position without exit evidence to MANAGE_EXISTING', async () => {
    const { desk, adapter, call } = fixture(70, .2, true);
    desk.book.n = 2;
    for (const symbol of ['BTCUSDT', 'ALTUSDT']) {
      const pos = desk.book.open({ symbol, side: 'LONG', qty: 1, entry: 108, stop: 90, tp: 130, margin: 108, leverage: 1 });
      pos.ownership = 'managed'; pos.invalidationLevel = 90;
    }
    adapter.pos = desk.book.positions.map(pos => ({ ...pos, unrealizedPnl: 0 }));
    const original = vi.mocked(call).getMockImplementation()!;
    vi.mocked(call).mockImplementation(async req => req.task === 'lead' ? JSON.stringify({ action: 'HOLD', confidence: .2, reason: 'Existing thesis and protection remain valid.' }) : original(req));
    const result = await desk.runDebate('BTCUSDT');
    const context = vi.mocked(call).mock.calls.find(([req]) => req.task === 'risk_assessment')![0].context;
    expect(context).toMatchObject({ intent: 'MANAGE_EXISTING', closeEligibility: { eligible: false, closeTriggers: [] }, newEntryCapacity: { freeSlots: 0 }, protection: { status: 'confirmed', stop: 90, tp: 130 } });
    expect(result).toMatchObject({ action: 'HOLD', reason: 'Existing thesis and protection remain valid.', executed: false });
    expect(adapter.closes).toBe(0);
  });

  it.each(['absent', 'increased', 'reduced', 'side'] as const)('does not close when the exchange position is %s after the verdict', async change => {
    const { desk, adapter, call } = fixture(70, .2);
    const pos = desk.book.open({ symbol: 'BTCUSDT', side: 'LONG', qty: 1, entry: 108, stop: 90, tp: 130, margin: 108, leverage: 1 });
    pos.ownership = 'managed'; pos.invalidationLevel = 110;
    adapter.pos = [{ ...pos, unrealizedPnl: 0 }];
    const original = vi.mocked(call).getMockImplementation()!;
    vi.mocked(call).mockImplementation(async req => {
      if (req.task !== 'lead') return original(req);
      if (change === 'absent') adapter.pos = [];
      else if (change === 'side') adapter.pos = [{ ...adapter.pos[0], side: 'SHORT', stop: 120, tp: 80 }];
      else adapter.pos[0].qty = change === 'increased' ? 2 : .5;
      return JSON.stringify({ action: 'CLOSE', confidence: .2, closeTrigger: 'INVALIDATION_HIT', reason: 'Persisted invalidation breached.' });
    });
    const result = await desk.runDebate('BTCUSDT');
    expect(result.executed).toBe(false);
    expect(result.reason).toMatch(/position.*changed|position already closed/);
    expect(adapter.closes).toBe(0);
    expect(adapter.placed).toHaveLength(0);
  });

  it('rejects CLOSE without a position with the actual reason', async () => {
    const { desk, adapter, call } = fixture();
    const original = vi.mocked(call).getMockImplementation()!;
    vi.mocked(call).mockImplementation(async req => req.task === 'lead' ? JSON.stringify({ action: 'CLOSE', confidence: .2, reason: 'Close it.' }) : original(req));
    expect(await desk.runDebate('BTCUSDT')).toMatchObject({ action: 'HOLD', executed: false, reason: expect.stringMatching(/No.*position/i) });
    expect(adapter.closes).toBe(0);
  });

  it('reports stale venue evidence as unknown CLOSE eligibility and protection', async () => {
    const { desk, adapter, call } = fixture();
    const pos = desk.book.open({ symbol: 'BTCUSDT', side: 'LONG', qty: 1, entry: 108, stop: 90, tp: 130, margin: 108, leverage: 1 });
    pos.ownership = 'managed'; pos.invalidationLevel = 110; pos.protectionStatus = 'confirmed';
    vi.spyOn(adapter, 'balance').mockRejectedValue(new Error('fixture account unavailable'));
    await desk.runDebate('BTCUSDT');
    const context = vi.mocked(call).mock.calls.find(([req]) => req.task === 'risk_assessment')![0].context;
    expect(context).toMatchObject({ positionObservation: 'unknown', closeEligibility: { eligible: false }, protection: { status: 'unknown' } });
    expect(adapter.closes).toBe(0);
  });

  it('revalidates net profit before an EARLY_TAKE_PROFIT close', async () => {
    const { desk, adapter, call, snapshot } = fixture(70, .2);
    snapshot.tacticalTradePlan!.exhaustion = { present: true, direction: 'BUYER', evidence: ['observed exhaustion'] };
    const pos = desk.book.open({ symbol: 'BTCUSDT', side: 'LONG', qty: 1, entry: 100, stop: 90, tp: 130, margin: 100, leverage: 1 });
    pos.ownership = 'managed'; pos.invalidationLevel = 90;
    adapter.pos = [{ ...pos, mark: 108, unrealizedPnl: 8 }];
    const original = vi.mocked(call).getMockImplementation()!;
    vi.mocked(call).mockImplementation(async req => {
      if (req.task !== 'lead') return original(req);
      adapter.pos[0].unrealizedPnl = -1; adapter.pos[0].mark = 99;
      return JSON.stringify({ action: 'CLOSE', confidence: .2, closeTrigger: 'EARLY_TAKE_PROFIT', reason: 'Observed exhaustion in profit.' });
    });
    const result = await desk.runDebate('BTCUSDT');
    expect(result).toMatchObject({ action: 'CLOSE', executed: false, executionOutcome: 'EXECUTION_BLOCKED' });
    expect(adapter.closes).toBe(0);
    expect(adapter.pos[0]).toMatchObject({ stop: 90, tp: 130 });
  });

  it('T6 Owner kill persists its cause and never creates a strategy-loss lesson', async () => {
    const { desk, adapter, executor } = fixture();
    const pos = desk.book.open({ symbol: 'XRPUSDT', side: 'SHORT', qty: 1, entry: 108, stop: 120, tp: 80, margin: 108, leverage: 1 });
    pos.ownership = 'managed'; pos.openedAt = Date.now() - 90_000;
    adapter.pos = [{ ...pos, unrealizedPnl: 0 }]; adapter.closeAt = () => 108;
    await Promise.all([desk.kill(), desk.kill()]);
    expect(adapter.closes).toBe(1);
    expect(desk.book.closed[0]).toMatchObject({ exitCause: 'OWNER_KILL', pnlStatus: 'estimated' });
    expect(executor.journal.intents.find(i => i.kind === 'close')?.exitCause).toBe('OWNER_KILL');
    expect(buildReport(desk, -1).closed.some(activity => activity.detail.includes('OWNER_KILL'))).toBe(true);
    expect(desk.learnings.recent(20, desk.accountScope())).toHaveLength(0);
    desk.unkill();
    expect(desk.cfg.auto.on).toBe(false);
    expect(adapter.placed).toHaveLength(0);
  });
});
