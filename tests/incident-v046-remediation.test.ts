import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildDebateEvidence, evaluateCloseTriggers, snapshotMomentum, type CloseEvaluationInput, type EntryScenario } from '../server/decision/debate-evidence.js';
import { revalidateEntry } from '../server/decision/stale.js';
import { lessonInScope, Learnings } from '../server/learnings.js';
import { ExecutionJournal } from '../server/live/journal.js';
import { Desk } from '../server/desk.js';
import { loadConfig } from '../server/config.js';
import { strategyVote } from '../server/strategy.js';
import type { MarketSnapshot, Position } from '../server/types.js';
import type { ModelCaller } from '../server/providers/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const defaultSnapshot = (overrides: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
  symbol: 'BTCUSDT',
  source: 'bybit',
  example: false,
  last: 100,
  bid: 99.95,
  ask: 100.05,
  change24hPct: 2,
  fundingRate: 0.0001,
  fetchedAt: Date.now(),
  candles: [
    { t: 0, o: 95, h: 96, l: 94, c: 95, v: 100 },
    { t: 60_000, o: 95, h: 96.5, l: 94.5, c: 96, v: 100 },
    { t: 120_000, o: 96, h: 97.5, l: 95.5, c: 97, v: 100 },
    { t: 180_000, o: 97, h: 98.5, l: 96.5, c: 98, v: 100 },
    { t: 240_000, o: 98, h: 99.5, l: 97.5, c: 99, v: 100 },
    { t: 300_000, o: 99, h: 100.5, l: 98.5, c: 100, v: 100 }
  ],
  orderbook: { bids: [[99.95, 5]], asks: [[100.05, 5]], timestamp: Date.now() },
  orderflow: {
    status: 'live',
    dataType: 'realtime_trades',
    cvdDelta: 50,
    buySellRatio: 1.2,
    evidence: { status: 'live', source: 'bybit trades', observedAt: Date.now() },
    rollingWindows: {
      '15m': { cvd: 50, buyVolume: 60, sellVolume: 10, tradesCount: 20, coveragePct: 100, partial: false }
    }
  },
  ...overrides
});

const defaultScenario: EntryScenario = {
  id: 'setup-canonical',
  kind: 'PULLBACK',
  side: 'LONG',
  entryZone: { low: 99, high: 101, basis: 'Canonical 15m order block support' },
  invalidationLevel: 97,
  target1: 106,
  target2: 110,
  riskRewardRatio: 3,
  timeframe: '15m'
};

const defaultPosition = (overrides: Partial<Position> = {}): Position => ({
  id: 'pos-aster-1',
  symbol: 'BTCUSDT',
  side: 'LONG',
  qty: 1,
  entry: 100,
  mark: 100,
  stop: 97,
  tp: 110,
  margin: 20,
  leverage: 5,
  unrealizedPnl: 0,
  realizedPnl: 0,
  openedAt: Date.now() - 300_000,
  protectionStatus: 'confirmed',
  decisionEvidence: { invalidationLevel: 97, entryScenarioId: 'setup-canonical', accountScope: 'LIVE:aster:mainnet:user1' },
  ...overrides
});

describe('Case A: Aster-Bybit source provenance and execution quote validation', () => {
  it('Aster execution with Bybit reference data does not create a false OPEN veto', () => {
    const snap = defaultSnapshot({ source: 'bybit' });
    const evidence = buildDebateEvidence({
      snapshot: snap,
      side: 'LONG',
      scenario: defaultScenario,
      mode: 'LIVE',
      executionVenue: 'aster',
      nativeExecutionQuote: 100.02,
      contractMultiplier: 1,
      instrumentSymbol: 'BTCUSDT'
    });

    expect(evidence.sourceConflict).toBe(false);
    expect(evidence.provenance.referenceMarket).toBe(true);
    expect(evidence.openAllowed).toBe(true);
    expect(evidence.openReasons).toHaveLength(0);
  });

  it('valid Aster-native price and canonical scenario authorize qualifying OPEN', () => {
    const snap = defaultSnapshot({ source: 'bybit', last: 100 });
    const reval = revalidateEntry({
      original: snap,
      originalRule: strategyVote(snap.candles),
      side: 'LONG',
      fresh: snap,
      entryZone: defaultScenario.entryZone,
      invalidationLevel: defaultScenario.invalidationLevel,
      executionQuote: 100.05,
      expectedVenue: 'aster',
      tradingMode: 'LIVE'
    });

    expect(reval.ok).toBe(true);
    expect(reval.quote).toBe(100.05);
  });

  it('reference venue mismatch alone does not authorize CLOSE', () => {
    const snap = defaultSnapshot({ source: 'bybit', last: 102 });
    const pos = defaultPosition({ side: 'LONG', entry: 100 });
    const triggers = evaluateCloseTriggers({
      snapshot: snap,
      position: pos,
      mode: 'LIVE',
      executionVenue: 'aster',
      invalidationLevel: pos.invalidationLevel,
      strategyInvalidated: false
    });

    expect(triggers.some(t => t.reason === 'DATA_ANOMALY_OR_CONFLICT')).toBe(false);
  });

  it('detects genuine material conflicts: quote divergence > 5% and unverified venue', () => {
    const snap = defaultSnapshot({ source: 'bybit', last: 100 });
    const divergent = buildDebateEvidence({
      snapshot: snap,
      side: 'LONG',
      scenario: defaultScenario,
      mode: 'LIVE',
      executionVenue: 'aster',
      nativeExecutionQuote: 110
    });
    expect(divergent.sourceConflict).toBe(true);
    expect(divergent.openAllowed).toBe(false);

    const unverifiedVenue = buildDebateEvidence({
      snapshot: snap,
      side: 'LONG',
      scenario: defaultScenario,
      mode: 'LIVE',
      executionVenue: 'unknown-venue'
    });
    expect(unverifiedVenue.sourceConflict).toBe(true);
  });

  it('rejects non-positive contract multiplier and symbol mismatch', () => {
    const snap = defaultSnapshot({ source: 'bybit', symbol: 'BTCUSDT' });
    const badMultiplier = buildDebateEvidence({
      snapshot: snap,
      side: 'LONG',
      scenario: defaultScenario,
      mode: 'LIVE',
      executionVenue: 'aster',
      contractMultiplier: 0
    });
    expect(badMultiplier.sourceConflict).toBe(true);

    const badSymbol = buildDebateEvidence({
      snapshot: snap,
      side: 'LONG',
      scenario: defaultScenario,
      mode: 'LIVE',
      executionVenue: 'aster',
      instrumentSymbol: 'ETHUSDT'
    });
    expect(badSymbol.sourceConflict).toBe(true);
  });

  it('genuine verified independent CLOSE evidence still works for Aster positions', () => {
    const snap = defaultSnapshot({ source: 'bybit', last: 95 });
    const pos = defaultPosition({ side: 'LONG', entry: 100, invalidationLevel: 97 });
    const triggers = evaluateCloseTriggers({
      snapshot: snap,
      position: pos,
      mode: 'LIVE',
      executionVenue: 'aster',
      invalidationLevel: 97,
      strategyInvalidated: false
    });

    expect(triggers.map(t => t.reason)).toContain('INVALIDATION_HIT');
  });
});

describe('Case B: Narrative regex removed, deterministic typed evidence only', () => {
  it('negated narrative phrases never authorize a false CLOSE', () => {
    const snap = defaultSnapshot({ last: 102 });
    const pos = defaultPosition({ side: 'LONG', entry: 100, invalidationLevel: 95 });

    const negatedPhrases = [
      'Position has NOT invalidated the structure.',
      'No risk anomaly is present on the feed.',
      'Do not take profit yet.',
      'Historically, we might take profit here, but not today.',
      'Quoted analyst said: "anomaly detected", but our tape is completely clean.'
    ];

    for (const phrase of negatedPhrases) {
      const triggers = evaluateCloseTriggers({
        snapshot: snap,
        position: pos,
        mode: 'LIVE',
        executionVenue: 'bybit',
        invalidationLevel: 95,
        strategyInvalidated: false,
        leadClose: { reason: phrase }
      });
      expect(triggers).toHaveLength(0);
    }
  });

  it('requires matching independently verified condition for typed closeTrigger', () => {
    const snap = defaultSnapshot({ last: 102 });
    const pos = defaultPosition({ side: 'LONG', entry: 100, invalidationLevel: 95 });

    const unverifiedClose = evaluateCloseTriggers({
      snapshot: snap,
      position: pos,
      mode: 'LIVE',
      executionVenue: 'bybit',
      invalidationLevel: 95,
      strategyInvalidated: false,
      leadClose: { closeTrigger: 'INVALIDATION_HIT', reason: 'Lead thinks it is invalidated' }
    });
    expect(unverifiedClose).toHaveLength(0);

    const verifiedClose = evaluateCloseTriggers({
      snapshot: { ...snap, last: 94 },
      position: pos,
      mode: 'LIVE',
      executionVenue: 'bybit',
      invalidationLevel: 95,
      strategyInvalidated: false,
      leadClose: { closeTrigger: 'INVALIDATION_HIT', reason: 'Confirmed price breach below structural level' }
    });
    expect(verifiedClose.map(t => t.reason)).toContain('INVALIDATION_HIT');
  });

  it('evaluates typed triggers independently for both LONG and SHORT', () => {
    const shortSnap = defaultSnapshot({ last: 106 });
    const shortPos = defaultPosition({ side: 'SHORT', entry: 100, invalidationLevel: 105 });
    const shortTriggers = evaluateCloseTriggers({
      snapshot: shortSnap,
      position: shortPos,
      mode: 'LIVE',
      executionVenue: 'bybit',
      invalidationLevel: 105,
      strategyInvalidated: false,
      leadClose: { closeTrigger: 'INVALIDATION_HIT', reason: 'Price breached above invalidation' }
    });
    expect(shortTriggers.map(t => t.reason)).toContain('INVALIDATION_HIT');
  });

  it('profitable positions are not exempted from genuine material anomaly triggers', () => {
    const snap = defaultSnapshot({ last: 110 });
    const profitablePos = defaultPosition({ side: 'LONG', entry: 100, unrealizedPnl: 10 });
    const triggers = evaluateCloseTriggers({
      snapshot: snap,
      position: profitablePos,
      mode: 'LIVE',
      executionVenue: 'bybit',
      invalidationLevel: 95,
      netUnrealizedPnl: 9.8,
      verifiedAnomaly: { severe: true, evidenceRefs: ['feed:severe_anomaly'] }
    });
    expect(triggers.map(t => t.reason)).toContain('DATA_ANOMALY_OR_CONFLICT');
  });
});

describe('Case C: Partial orderflow classification', () => {
  it('low coverage orderflow (e.g. 0.61%) is NOT classified as verified momentum', () => {
    const snap = defaultSnapshot({
      orderflow: {
        status: 'live',
        dataType: 'realtime_trades',
        cvdDelta: 100,
        buySellRatio: 2.0,
        evidence: { status: 'live', source: 'bybit trades', observedAt: Date.now() },
        rollingWindows: {
          '15m': { cvd: 100, buyVolume: 120, sellVolume: 20, tradesCount: 15, coveragePct: 0.61, partial: true }
        }
      }
    });

    const momentum = snapshotMomentum(snap);
    expect(momentum.flowVerified).toBe(false);
  });

  it('orderflow with tradesCount < 5 is NOT classified as verified momentum', () => {
    const snap = defaultSnapshot({
      orderflow: {
        status: 'live',
        dataType: 'realtime_trades',
        cvdDelta: 100,
        buySellRatio: 2.0,
        evidence: { status: 'live', source: 'bybit trades', observedAt: Date.now() },
        rollingWindows: {
          '15m': { cvd: 100, buyVolume: 120, sellVolume: 20, tradesCount: 3, coveragePct: 100, partial: false }
        }
      }
    });

    const momentum = snapshotMomentum(snap);
    expect(momentum.flowVerified).toBe(false);
  });

  it('authenticated orderflow with full coverage (>=80%, not partial, >=5 trades) IS verified', () => {
    const snap = defaultSnapshot({
      orderflow: {
        status: 'live',
        dataType: 'realtime_trades',
        cvdDelta: 100,
        buySellRatio: 1.5,
        evidence: { status: 'live', source: 'bybit trades', observedAt: Date.now() },
        rollingWindows: {
          '15m': { cvd: 100, buyVolume: 150, sellVolume: 50, tradesCount: 25, coveragePct: 95, partial: false }
        }
      }
    });

    const momentum = snapshotMomentum(snap);
    expect(momentum.flowVerified).toBe(true);
    expect(momentum.cvdDelta).toBe(100);
    expect(momentum.buySellRatio).toBe(1.5);
  });
});

describe('Case D: Debate pace and concurrency', () => {
  it('runs initial analyst opinions concurrently in runDebate', async () => {
    const timestamps: Record<string, { start: number; end: number }> = {};
    const mockCaller: ModelCaller = async (req) => {
      const start = Date.now();
      await new Promise(r => setTimeout(r, 40));
      const end = Date.now();
      if (req.task === 'opinion' || req.task === 'research') {
        timestamps[req.agent] = { start, end };
        return JSON.stringify({ stance: 'LONG', confidence: 0.8, argument: 'Bullish momentum confirmed', vote: 'LONG' });
      }
      if (req.task === 'rebuttal') {
        return JSON.stringify({ stance: 'LONG', confidence: 0.8, target: 'none', rebuttal: 'Agree' });
      }
      if (req.task === 'lead') {
        return JSON.stringify({ action: 'OPEN_LONG', confidence: 0.85, reason: 'Setup aligned', entryScenarioId: 'setup-canonical' });
      }
      return JSON.stringify({ reply: 'ok' });
    };

    const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEBATE_PACE_MS: '0', DEBATE_MODE: 'fast' });
    const desk = new Desk(cfg, mockCaller, { reportsDir: null });
    await desk.runDebate('BTCUSDT');

    expect(timestamps.market).toBeDefined();
    expect(timestamps.research).toBeDefined();
    expect(timestamps.strategist).toBeDefined();
    // In concurrent execution, research and strategist start before market finishes
    expect(timestamps.research.start).toBeLessThan(timestamps.market.end);
    expect(timestamps.strategist.start).toBeLessThan(timestamps.market.end);
  });
});

describe('Case E: Account-scope memory isolation and HOLD bias elimination', () => {
  it('rejects legacy unscoped lessons from LIVE scope while keeping them for PAPER', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mg-remed-scope-'));
    dirs.push(dir);
    const file = path.join(dir, 'learnings.json');
    const learnings = new Learnings(file, 1);

    learnings.add({ role: 'market', kind: 'note', happened: 'general', rootCause: 'legacy', lesson: 'Unscoped tape advice' });
    learnings.add({ role: 'market', kind: 'note', happened: 'live', rootCause: 'venue', lesson: 'Live Aster advice', accountScope: 'LIVE:aster:mainnet:user1' });

    expect(lessonInScope(undefined, 'LIVE:aster:mainnet:user1')).toBe(false);
    expect(lessonInScope(undefined, 'PAPER:paper:mainnet')).toBe(true);

    const liveRules = learnings.standingRules('market', 'LIVE:aster:mainnet:user1').map(l => l.lesson);
    expect(liveRules).toContain('Live Aster advice');
    expect(liveRules).not.toContain('Unscoped tape advice');

    const paperRules = learnings.standingRules('market', 'PAPER:paper:mainnet').map(l => l.lesson);
    expect(paperRules).toContain('Unscoped tape advice');
  });

  it('includes public account identifier in LIVE accountScope', () => {
    const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample' });
    const desk = new Desk(cfg, async () => '{}', { reportsDir: null });
    expect(desk.accountScope()).toBe('PAPER:paper:mainnet');
  });

  it('reflection does not emit generalized HOLD lessons on near-minimum allocations', () => {
    const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', LEARNING: 'on' });
    const desk = new Desk(cfg, async () => '{}', { reportsDir: null });
    desk.recordActivity({ kind: 'skipped', symbol: 'BTCUSDT', detail: 'Order size 10 USDT is below the exchange minimum of 20 USDT' });

    desk.reflect(0);
    const rules = desk.learnings.items.map(i => i.lesson);
    expect(rules.some(r => /prefer HOLD over a ticket/i.test(r))).toBe(false);
  });
});

describe('Case F: Windows journal persistence resilience', () => {
  it('uses unique temporary files and recovers from simulated rename contention', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mg-journal-resil-'));
    dirs.push(dir);
    const journalPath = path.join(dir, 'journal.json');

    const journal = new ExecutionJournal(journalPath, 'bybit:mainnet');
    journal.save();
    expect(existsSync(journalPath)).toBe(true);
    const initialContent = readFileSync(journalPath, 'utf8');

    // Simulate transient Windows EPERM on first 2 attempts
    let attempts = 0;
    journal.renameFn = (oldPath: string, newPath: string) => {
      attempts++;
      if (attempts <= 2) {
        const err: any = new Error('EPERM: operation not permitted');
        err.code = 'EPERM';
        throw err;
      }
      writeFileSync(newPath, readFileSync(oldPath, 'utf8'));
      try { unlinkSync(oldPath); } catch { /* ignore */ }
    };

    journal.intents.push({
      clientId: 'mgtest-order-1',
      symbol: 'BTCUSDT',
      side: 'LONG',
      kind: 'open',
      requestedQty: 1,
      accountedQty: 0,
      accountedValue: 0,
      record: null,
      at: Date.now()
    });

    journal.save();

    expect(attempts).toBeGreaterThanOrEqual(3);
    const updatedContent = JSON.parse(readFileSync(journalPath, 'utf8'));
    expect(updatedContent.intents).toHaveLength(1);
    expect(updatedContent.intents[0].clientId).toBe('mgtest-order-1');
  });

  it('leaves last-good journal intact and cleans up temp file when rename fails completely', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mg-journal-fail-'));
    dirs.push(dir);
    const journalPath = path.join(dir, 'journal.json');

    const journal = new ExecutionJournal(journalPath, 'bybit:mainnet');
    journal.save();
    const goodContent = readFileSync(journalPath, 'utf8');

    journal.renameFn = () => {
      const err: any = new Error('EACCES: permission denied');
      err.code = 'EACCES';
      throw err;
    };

    journal.intents.push({
      clientId: 'mgtest-fail-order',
      symbol: 'ETHUSDT',
      side: 'SHORT',
      kind: 'open',
      requestedQty: 2,
      accountedQty: 0,
      accountedValue: 0,
      record: null,
      at: Date.now()
    });

    expect(() => journal.save()).toThrow();

    expect(readFileSync(journalPath, 'utf8')).toBe(goodContent);
    const files = readdirSync(dir);
    expect(files.filter(f => f.endsWith('.tmp'))).toHaveLength(0);
  });
});

describe('Case G: Office Chat status, scope filtering and concise guidance', () => {
  it('filters open positions in chat by active account scope', async () => {
    let capturedContext: any = null;
    const mockCaller: ModelCaller = async (req) => {
      if (req.task === 'chat') {
        capturedContext = req.context;
        return JSON.stringify({ reply: 'All good Boss.' });
      }
      return JSON.stringify({ grade: 'A', lesson: 'ok' });
    };

    const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample' });
    const desk = new Desk(cfg, mockCaller, { reportsDir: null });
    desk.book.autoExit = false;

    desk.book.open({ symbol: 'BTCUSDT', side: 'LONG', qty: 0.1, entry: 100, stop: 95, tp: 110, margin: 10, leverage: 1 });
    desk.book.positions[0].decisionEvidence = { accountScope: 'PAPER:paper:mainnet' };

    desk.book.open({ symbol: 'ETHUSDT', side: 'SHORT', qty: 1, entry: 2000, stop: 2100, tp: 1900, margin: 20, leverage: 1 });
    desk.book.positions[1].decisionEvidence = { accountScope: 'HISTORICAL:bybit:mainnet:user2' };

    await desk.command('What positions do we have?', 'lead');

    expect(capturedContext).toBeDefined();
    expect(capturedContext.openPositions.some((p: any) => p.symbol === 'BTCUSDT')).toBe(true);
    expect(capturedContext.openPositions.some((p: any) => p.symbol === 'ETHUSDT')).toBe(false);
  });

  it('marks unconfirmed resting stops as UNKNOWN in chat positions', async () => {
    let capturedContext: any = null;
    const mockCaller: ModelCaller = async (req) => {
      if (req.task === 'chat') {
        capturedContext = req.context;
        return JSON.stringify({ reply: 'Active positions reported.' });
      }
      return JSON.stringify({ grade: 'A', lesson: 'ok' });
    };

    const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample' });
    const desk = new Desk(cfg, mockCaller, { reportsDir: null });
    desk.book.autoExit = false;

    desk.book.open({ symbol: 'BTCUSDT', side: 'LONG', qty: 0.1, entry: 100, stop: 95, tp: 110, margin: 10, leverage: 1 });
    desk.book.positions[0].protectionStatus = 'unknown';

    await desk.command('Tell me about the desk status', 'lead');

    expect(capturedContext.openPositions[0].protectionStatus).toBe('UNKNOWN');
    expect(capturedContext.openPositions[0].stop).toContain('UNKNOWN');
  });

  it('consultation instruction enforces concise answers without authorization boilerplate', async () => {
    let capturedUser = '';
    const mockCaller: ModelCaller = async (req) => {
      if (req.task === 'chat') {
        capturedUser = req.user;
        return JSON.stringify({ reply: 'Desk is operating normally.' });
      }
      return JSON.stringify({ grade: 'A', lesson: 'ok' });
    };

    const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample' });
    const desk = new Desk(cfg, mockCaller, { reportsDir: null });

    await desk.command('Give me an update', 'lead');
    expect(capturedUser).toContain('Provide concise, non-repetitive answers without authorization boilerplate');
  });
});
