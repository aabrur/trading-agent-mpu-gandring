import { afterEach, describe, expect, it, vi } from 'vitest';
import { Desk } from '../server/desk.js';
import { loadConfig } from '../server/config.js';
import { LiveExecutor } from '../server/live/executor.js';
import { revalidateEntry } from '../server/decision/stale.js';
import { strategyVote } from '../server/strategy.js';
import type { MarketSnapshot } from '../server/types.js';
import type { ModelCaller } from '../server/providers/index.js';
import type { CloseTriggerReason } from '../server/decision/debate-evidence.js';
import { MemoryAdapter } from './fakes.js';

const desks: Desk[] = [];
afterEach(() => { for (const desk of desks.splice(0)) desk.stop(); vi.restoreAllMocks(); });
const scenario = {
  id: 'fixture-pullback', kind: 'PULLBACK_CONTINUATION' as const, side: 'LONG' as const,
  entryZone: { low: 107, high: 109, basis: 'observed pullback support' },
  invalidationLevel: 100, target1: 120, target2: 130, evidence: ['closed-bar structure'], missingEvidence: [],
};
function market(): MarketSnapshot {
  return {
    symbol: 'BTCUSDT', snapshotId: 'fixture-snapshot', source: 'bybit', example: false,
    last: 108, bid: 108, ask: 108, change24hPct: 1, fundingRate: null, fetchedAt: Date.now(),
    candles: Array.from({ length: 80 }, (_, i) => ({ t: Date.now() - (81 - i) * 900_000, o: 100 + i * 0.1, c: 100 + i * 0.1, h: 100.1 + i * 0.1, l: 99.9 + i * 0.1, v: 100 })),
    tacticalTradePlan: { symbol: 'BTCUSDT', timestamp: Date.now(), marketRegime: 'STRONG_UPTREND', scenarios: [scenario], exhaustion: { present: false, direction: 'NONE', evidence: [] } },
  };
}
function fixture(options: { closeTrigger?: CloseTriggerReason; shortConviction?: boolean; moveQuoteAfterVerdict?: number } = {}) {
  const cfg = loadConfig({ TRADING_MODE: 'PAPER', DEFAULT_PROVIDER: 'mock', MARKET_SOURCE: 'sample', TRADING_PROFILE: 'current', DEBATE_PACE_MS: '0', LEARNING: 'off', PROACTIVE_SCAN: 'off', AUTO_TRADING: 'off', JEV_ENABLED: 'false' });
  cfg.tradingMode = 'LIVE'; cfg.exchange.name = 'bybit'; cfg.live = { exchange: 'bybit', network: 'mainnet', experimental: false };
  Object.assign(cfg.risk, { maxLeverage: 4, defaultStopPct: 12, takeProfitPct: 24, maxOrderUsdt: 0, minEntryConfidencePct: 0 });
  cfg.paper.safetyNet = 200; cfg.paper.n = 4;
  const adapter = new MemoryAdapter();
  adapter.fillAt = () => 108; adapter.closeAt = () => 100;
  const ticker = vi.spyOn(adapter, 'ticker').mockResolvedValue(108);
  const snapshot = market();
  const caller: ModelCaller = vi.fn(async request => {
    const side = options.shortConviction ? 'SHORT' : 'LONG';
    if (request.task === 'opinion') return JSON.stringify({ stance: side, confidence: 0.8, argument: 'Measured role evidence.', ...(request.agent === 'strategist' ? { entryScenarioId: scenario.id, entryZone: scenario.entryZone, invalidationLevel: scenario.invalidationLevel } : {}) });
    if (request.task === 'research') return JSON.stringify({ vote: 'ABSTAIN', confidence: 0.1, argument: 'Optional source unavailable.', sources: [] });
    if (request.task === 'rebuttal') return JSON.stringify({ stance: side, confidence: 0.8, target: 'none', rebuttal: 'Measured role evidence remains unchanged.' });
    if (request.task === 'lead') {
      if (request.context.hasPosition) return JSON.stringify(options.closeTrigger ? { action: 'CLOSE', closeTrigger: options.closeTrigger, confidence: 0.8, reason: 'A structured verified exit is selected.' } : { action: 'HOLD', confidence: 0.8, reason: 'No new exit evidence.' });
      if (options.moveQuoteAfterVerdict !== undefined) ticker.mockResolvedValue(options.moveQuoteAfterVerdict);
      return JSON.stringify({ action: 'OPEN_LONG', confidence: 0.8, reason: 'The supplied dimensions align.', entryScenarioId: scenario.id, entryZone: scenario.entryZone, invalidationLevel: scenario.invalidationLevel });
    }
    if (request.task === 'risk_assessment') return JSON.stringify({ decision: 'APPROVE', sizeFactor: 1, leverage: cfg.risk.maxLeverage, stopPct: cfg.risk.defaultStopPct, reason: 'Fixture risk assessment accepts the supplied evidence and Owner exposure.' });
    if (request.task === 'review') return '{"lesson":"Fixture outcome recorded.","grade":"B"}';
    return '{"reply":"Fixture response."}';
  });
  const executor = new LiveExecutor(adapter, 0);
  const desk = new Desk(cfg, caller, { executor, reportsDir: null, learningsPath: null, conversationsPath: null, killFile: null, opportunityReviewsPath: null, jevEnv: {} }); desks.push(desk);
  const trace: Awaited<ReturnType<Desk['collectResearchData']>>['trace'] = { symbol: snapshot.symbol, route: 'PARALLEL', routedBy: 'default', routing: { status: 'not_requested', latencyMs: null, reason: 'offline fixture' }, startedAt: Date.now(), completedAt: Date.now(), feeds: {} };
  vi.spyOn(desk, 'collectResearchData').mockImplementation(async () => ({ market: snapshot, news: [], whale: { symbol: snapshot.symbol, providerStatus: 'UNAVAILABLE', providerName: 'Fixture', events: [], summary: 'Unavailable optional feed.', observedAt: Date.now(), disclaimer: 'No optional support inferred.' }, trace }));
  vi.spyOn(desk as unknown as { marketSnapshot: (symbol: string) => Promise<MarketSnapshot> }, 'marketSnapshot').mockImplementation(async () => snapshot);
  return { desk, adapter, executor, cfg, snapshot, caller };
}

describe('Desk binding debate contract with a mocked exchange', () => {
  it.each(['OPEN_LONG', 'HOLD'] as const)('lets Risk and Lead choose %s outside an advisory zone', async action => {
    const { desk, adapter, snapshot, caller } = fixture();
    snapshot.last = 110; snapshot.ask = 110; snapshot.bid = 110;
    vi.mocked(adapter.ticker).mockResolvedValue(110);
    const base = vi.mocked(caller).getMockImplementation()!;
    vi.mocked(caller).mockImplementation(async request => {
      if (request.task === 'risk_assessment') expect(request.context.debateEvidence).toMatchObject({ openAllowed: true, dimensions: { structure: { status: 'NEUTRAL' } } });
      if (request.task === 'lead' && action === 'HOLD') return JSON.stringify({ action, confidence: .8, reason: 'Wait for the recommended retest.' });
      return base(request);
    });
    const verdict = await desk.runDebate('BTCUSDT');
    expect(verdict).toMatchObject({ action, executed: action === 'OPEN_LONG' });
    expect(adapter.placed).toHaveLength(action === 'OPEN_LONG' ? 1 : 0);
  });

  it('revalidates an advisory-zone deviation without requiring AI to bypass a binding gate', () => {
    const snapshot = market();
    const result = revalidateEntry({ original: snapshot, fresh: snapshot, originalRule: strategyVote(snapshot.candles), side: 'LONG',
      entryZone: scenario.entryZone, invalidationLevel: scenario.invalidationLevel, executionQuote: 110, expectedVenue: 'bybit', tradingMode: 'LIVE' });
    expect(result).toMatchObject({ ok: true, quote: 110 });
    expect(revalidateEntry({ original: snapshot, fresh: snapshot, originalRule: strategyVote(snapshot.candles), side: 'LONG',
      entryZone: scenario.entryZone, invalidationLevel: 111, executionQuote: 110, aiApproved: true })).toMatchObject({ ok: false });
  });

  it('opens inside the selected structural zone while preserving Owner allocation, leverage and profile SL/TP', async () => {
    const { desk, adapter, cfg } = fixture();
    const before = structuredClone({ risk: cfg.risk, paper: cfg.paper });
    const verdict = await desk.runDebate('BTCUSDT');
    expect(verdict).toMatchObject({ action: 'OPEN_LONG', riskDecision: 'APPROVE', executed: true });
    expect(adapter.placed).toHaveLength(1);
    expect(adapter.placed[0]).toMatchObject({ side: 'LONG', leverage: 4, qty: 7.407, stop: 104.8, tp: 114.4 });
    expect(desk.book.positions[0]).toMatchObject({ entryScenarioId: scenario.id, entryZone: scenario.entryZone, invalidationLevel: 100 });
    expect(desk.book.positions[0].stop).not.toBe(scenario.invalidationLevel);
    expect(desk.book.positions[0].margin).toBeLessThanOrEqual(200);
    expect(desk.book.positions[0].margin).toBeGreaterThan(200 - 108 * 0.001 / 4);
    expect({ risk: cfg.risk, paper: cfg.paper }).toEqual(before);
    expect(verdict.debateEvidence?.dimensions.catalyst.status).toBe('UNKNOWN');
    expect(verdict.debateEvidence?.dimensions.jev.status).toBe('UNKNOWN');
  });

  it('blocks material cross-venue quote divergence without rewriting the AI OPEN', async () => {
    const { desk, adapter } = fixture({ moveQuoteAfterVerdict: 120 });
    Object.defineProperty(adapter, 'name', { value: 'aster' });
    const verdict = await desk.runDebate('BTCUSDT');
    expect(verdict.executed).toBe(false);
    expect(verdict.reason).toMatch(/diverges/i);
    expect(verdict.action).toBe('OPEN_LONG');
    expect(adapter.placed).toHaveLength(0);
    expect(desk.book.positions).toHaveLength(0);
  });

  it('lets Risk weigh opposing flow without a separate silent system HOLD', async () => {
    const { desk, adapter, snapshot } = fixture();
    snapshot.orderflow = { cvdDelta: -10, buySellRatio: 0.8, takerBuyVol: 80, takerSellVol: 100, deltaDivergence: false, dataType: 'native', actualDataVenue: 'bybit', coveragePct: 100, tradesCount: 20, evidence: { source: 'bybit', observedAt: Date.now(), status: 'live' } };
    const verdict = await desk.runDebate('BTCUSDT');
    expect(verdict).toMatchObject({ action: 'OPEN_LONG', executed: true });
    expect(verdict.debateEvidence?.dimensions.tape.status).toBe('VERIFIED_OPPOSING');
    expect(adapter.placed).toHaveLength(1);
  });

  it.each<CloseTriggerReason>(['INVALIDATION_HIT', 'GUARD_THREATENED'])('executes CLOSE on the single selected %s trigger without parsing Lead prose', async trigger => {
    const { desk, adapter, snapshot } = fixture({ closeTrigger: trigger, shortConviction: trigger === 'SENTIMENT_REVERSAL' });
    const position = desk.book.open({ symbol: 'BTCUSDT', side: 'LONG', qty: 1, entry: 108, stop: 60, tp: 200, leverage: 4, margin: 27 });
    position.ownership = 'managed'; position.protectionStatus = 'confirmed';
    if (trigger === 'INVALIDATION_HIT') position.invalidationLevel = 105;
    snapshot.last = 100; snapshot.bid = 100; snapshot.ask = 100;
    adapter.pos = [{ ...position, mark: 100, unrealizedPnl: -8 }];
    if (trigger === 'GUARD_THREATENED') vi.spyOn(adapter, 'balance').mockResolvedValue({ equityUsdt: 150, availableUsdt: 150 });
    const verdict = await desk.runDebate('BTCUSDT');
    expect(verdict).toMatchObject({ action: 'CLOSE', closeTrigger: trigger, executed: true, executionStatus: 'closed' });
    expect(adapter.closes).toBe(1);
    expect(desk.book.positions).toHaveLength(0);
    expect(adapter.placed).toHaveLength(0);
  });

  it('keeps a position after the configured duration when no verified exit trigger exists', async () => {
    const { desk, adapter } = fixture();
    desk.cfg.auto.maxHoldHours = 0.0001;
    const position = desk.book.open({ symbol: 'BTCUSDT', side: 'LONG', qty: 1, entry: 108, stop: 60, tp: 200, leverage: 4, margin: 27 });
    position.openedAt = Date.now() - 86400_000; position.ownership = 'managed';
    adapter.pos = [{ ...position, unrealizedPnl: 0 }];
    expect(await desk.closeStale()).toBe(0);
    const verdict = await desk.runDebate('BTCUSDT');
    expect(verdict).toMatchObject({ action: 'HOLD', executed: false });
    expect(adapter.closes).toBe(0);
    expect(desk.book.positions).toHaveLength(1);
  });
});
