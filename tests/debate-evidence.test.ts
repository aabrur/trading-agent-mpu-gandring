import { describe, expect, it } from 'vitest';
import type { MarketSnapshot, Position } from '../server/types.js';
import type { NewsBriefing, NormalizedNewsEvent } from '../server/market/news.js';
import type { NormalizedWhaleEvent, WhaleBriefing } from '../server/market/whale.js';
import { buildDebateEvidence, closeAuthorized, estimatedNetUnrealized, evaluateCloseTriggers, exitEvidenceRefs, validateEntryGeometry, type CloseEvaluationInput, type CloseTriggerReason, type EntryScenario } from '../server/decision/debate-evidence.js';

const now = Date.UTC(2026, 9, 27, 12);
const scenario: EntryScenario = { id: 'setup-1', side: 'LONG', entryZone: { low: 99, high: 101, basis: 'Confirmed support retest' }, invalidationLevel: 95, target1: 110, target2: 120 };
const whalePolicy = { minUsd: 500_000, maxAgeMs: 24 * 3600 * 1000 };
function snapshot(): MarketSnapshot {
  return {
    snapshotId: 'snap-1', symbol: 'BTCUSDT', source: 'bybit', example: false, last: 100, change24hPct: 4, fundingRate: null, bid: 100, ask: 100, fetchedAt: now,
    candles: Array.from({ length: 6 }, (_, index) => ({ t: now - (6 - index) * 900_000, o: 94 + index, h: 96 + index, l: 93 + index, c: 95 + index, v: 100 })),
    orderflow: { cvdDelta: 10, buySellRatio: 1.2, takerBuyVol: 60, takerSellVol: 50, deltaDivergence: false, tradesCount: 12, actualDataVenue: 'bybit', requestedVenue: 'bybit', dataType: 'native', evidence: { status: 'live', source: 'bybit trades', observedAt: now } },
  };
}
function position(): Position {
  return { id: 'position-1', symbol: 'BTCUSDT', side: 'LONG', qty: 1, entry: 100, stop: 90, tp: 120, margin: 50, leverage: 2, mark: 100, unrealizedPnl: 0, openedAt: now - 900_000, ownership: 'managed', protectionStatus: 'confirmed' };
}
function newsEvent(overrides: Partial<NormalizedNewsEvent> = {}): NormalizedNewsEvent {
  return { id: 'news-1', title: 'Verified relevant event', source: 'Authoritative source', sourceUrl: 'https://example.test/event', publishedAt: now - 1000, observedAt: now, affectedAssets: ['BTC'], category: 'exchange_status', evidenceStatus: 'VERIFIED', impactAssessment: 'Adverse catalyst', sentiment: 'bearish', freshness: 'fresh', duplicateGroup: null, provider: 'bybit', example: false, ...overrides };
}
function news(events: NormalizedNewsEvent[], overrides: Partial<NewsBriefing> = {}): NewsBriefing {
  return { symbol: 'BTCUSDT', providerStatus: 'CONFIGURED_LIVE', events, criticalVetoFound: false, criticalClaimFound: false, vetoReason: null, summary: 'Fixture', observedAt: now, ...overrides };
}
function whaleEvent(overrides: Partial<NormalizedWhaleEvent> = {}): NormalizedWhaleEvent {
  return { chainId: 'bitcoin', txHash: 'tx-1', blockNumber: 1, timestamp: now - 1000, tokenAddress: null, tokenSymbol: 'BTC', rawAmount: '100', normalizedAmount: 100, usdValueOrNull: 1_000_000, fromAddress: 'fixture-source', toAddress: 'fixture-destination', fromEntityOrNull: 'Verified whale', toEntityOrNull: 'Bybit', attributionConfidence: 'high', confirmationStatus: 'confirmed', source: 'authenticated-indexer', classification: 'EXCHANGE_INFLOW', interpretation: 'Confirmed opposing flow, market sale not proven.', ...overrides };
}
function whales(events: NormalizedWhaleEvent[]): WhaleBriefing {
  return { symbol: 'BTC', providerStatus: 'CONFIGURED_LIVE', providerName: 'fixture', events, summary: 'Fixture', observedAt: now, disclaimer: 'Transfers are not executions.' };
}
const open = (overrides: Partial<Parameters<typeof buildDebateEvidence>[0]> = {}) => buildDebateEvidence({ snapshot: snapshot(), side: 'LONG', scenario, mode: 'LIVE', executionVenue: 'bybit', now, ...overrides });
const close = (overrides: Partial<CloseEvaluationInput> = {}) => evaluateCloseTriggers({ snapshot: snapshot(), position: position(), mode: 'LIVE', executionVenue: 'bybit', now, ...overrides });

describe('Owner OPEN evidence contract', () => {
  it('accepts a binding structural setup with independently measured tape while optional feeds are unknown', () => {
    const evidence = open();
    expect(evidence.openAllowed).toBe(true);
    expect(evidence.dimensions.structure.status).toBe('SUPPORTING');
    expect(evidence.dimensions.tape.status).toBe('SUPPORTING');
    expect(evidence.dimensions.catalyst.status).toBe('UNKNOWN');
    expect(evidence.dimensions.jev.status).toBe('UNKNOWN');
  });

  it.each([
    { change5Pct: -1, roc5: 0.01, cvdDelta: 10, buySellRatio: 1.2, flowVerified: true },
    { change5Pct: 1, roc5: -0.01, cvdDelta: 10, buySellRatio: 1.2, flowVerified: true },
    { change5Pct: 1, roc5: 0.01, cvdDelta: -10, buySellRatio: 0.8, flowVerified: true },
  ])('rejects a contradictory momentum window or authenticated opposing flow: %j', momentum => {
    const evidence = open({ momentum });
    expect(evidence.dimensions.tape.status).toBe('VERIFIED_OPPOSING');
    expect(evidence.openAllowed).toBe(false);
  });

  it('does not count a favorable 24h price change as confluence without tape, catalyst or remote evidence', () => {
    const snap = snapshot(); snap.candles = []; snap.orderflow = null;
    const evidence = open({ snapshot: snap });
    expect(evidence.openAllowed).toBe(false);
    expect(evidence.dimensions.tape.status).toBe('UNKNOWN');
  });

  it('a single fresh verified opposing catalyst cancels an otherwise aligned OPEN', () => {
    const evidence = open({ news: news([newsEvent()]) });
    expect(evidence.dimensions.catalyst.status).toBe('VERIFIED_OPPOSING');
    expect(evidence.openAllowed).toBe(false);
  });

  it.each([
    { evidenceStatus: 'REPORTED' as const },
    { freshness: 'unknown' as const },
    { freshness: 'stale' as const, publishedAt: now - 7 * 3600 * 1000 },
    { publishedAt: null },
    { affectedAssets: ['ETH'] },
    { example: true, provider: 'sample' as const },
  ])('does not veto a reported, stale, unrelated or sample claim: %j', override => {
    const evidence = open({ news: news([newsEvent(override)], { criticalClaimFound: true }) });
    expect(evidence.dimensions.catalyst.status).toBe('UNKNOWN');
    expect(evidence.openAllowed).toBe(true);
  });

  it.each([
    { confirmationStatus: 'unverified' as const },
    { attributionConfidence: 'medium' as const },
    { usdValueOrNull: 100 },
    { timestamp: now - whalePolicy.maxAgeMs - 1 },
    { timestamp: null },
    { tokenSymbol: 'ETH' },
  ])('does not turn raw unverified or insignificant whale flow into a veto: %j', override => {
    const evidence = open({ whale: whales([whaleEvent(override)]), whalePolicy });
    expect(evidence.dimensions.catalyst.status).toBe('UNKNOWN');
    expect(evidence.openAllowed).toBe(true);
  });

  it('uses existing provider significance and freshness policy for confirmed high-confidence opposing whale flow', () => {
    const evidence = open({ whale: whales([whaleEvent()]), whalePolicy });
    expect(evidence.openAllowed).toBe(false);
    expect(evidence.dimensions.catalyst.evidenceRefs).toEqual(['whale:tx-1']);
    expect(open({ whale: whales([whaleEvent()]) }).dimensions.catalyst.status).toBe('UNKNOWN');
  });

  it('separates remote regime opposition from a heuristic fallback', () => {
    const remote = open({ jev: { available: true, fallback: false, origin: 'remote', regime: 'TREND_DOWN' } });
    const fallback = open({ jev: { available: true, fallback: true, origin: 'heuristic', regime: 'TREND_DOWN' } });
    expect(remote.openAllowed).toBe(false);
    expect(remote.dimensions.jev.status).toBe('VERIFIED_OPPOSING');
    expect(fallback.openAllowed).toBe(true);
    expect(fallback.dimensions.jev.status).toBe('UNKNOWN');
  });

  it('rejects example LIVE data and a different venue price basis while surfacing optional proxy provenance', () => {
    const sample = snapshot(); sample.example = true;
    expect(open({ snapshot: sample }).sourceConflict).toBe(true);
    expect(open({ executionVenue: 'aster' }).sourceConflict).toBe(true);
    const proxy = snapshot(); proxy.orderflow!.dataType = 'external_proxy'; proxy.orderflow!.actualDataVenue = 'binance';
    const evidence = open({ snapshot: proxy });
    expect(evidence.provenance.proxySources).toEqual(['bybit <- binance (external_proxy)']);
    expect(evidence.momentum.flowVerified).toBe(false);
  });

  it('binds LONG and SHORT entry zones and strictly opposing invalidation without price-chasing caps', () => {
    expect(validateEntryGeometry('LONG', 102, scenario).ok).toBe(false);
    expect(validateEntryGeometry('LONG', 100, scenario).ok).toBe(true);
    expect(validateEntryGeometry('LONG', 100, { ...scenario, invalidationLevel: 100 }).ok).toBe(false);
    const short: EntryScenario = { ...scenario, side: 'SHORT', invalidationLevel: 105 };
    expect(validateEntryGeometry('SHORT', 98, short).ok).toBe(false);
    expect(validateEntryGeometry('SHORT', 100, short).ok).toBe(true);
    expect(validateEntryGeometry('SHORT', 100, { ...short, invalidationLevel: 100 }).ok).toBe(false);
  });
});

describe('Owner CLOSE evidence contract', () => {
  const individual: Array<{ reason: CloseTriggerReason; input: () => Partial<CloseEvaluationInput> }> = [
    { reason: 'INVALIDATION_HIT', input: () => ({ snapshot: { ...snapshot(), last: 94 }, invalidationLevel: 95 }) },
    { reason: 'MOMENTUM_REVERSAL', input: () => ({ momentum: { change5Pct: -1, roc5: -0.01, cvdDelta: -10, buySellRatio: 0.8, flowVerified: true } }) },
    { reason: 'SENTIMENT_REVERSAL', input: () => ({ conviction: { opposing: true, verified: true, evidenceRefs: ['agent:market', 'agent:strategist'] } }) },
    { reason: 'OPPOSING_NEWS', input: () => ({ news: news([newsEvent()]) }) },
    { reason: 'WHALE_EXIT', input: () => ({ whale: whales([whaleEvent()]), whalePolicy }) },
    { reason: 'EXCHANGE_STOP_OR_TP', input: () => ({ snapshot: { ...snapshot(), last: 89 } }) },
    { reason: 'EARLY_TAKE_PROFIT', input: () => ({ snapshot: { ...snapshot(), last: 110 }, targetLevel: 110, targetScenarioId: 'setup-1', netUnrealizedPnl: 9, leadClose: { closeTrigger: 'EARLY_TAKE_PROFIT', exitSignal: { kind: 'target_complete', evidenceRefs: ['setup-1:target_complete'] } } }) },
    { reason: 'DATA_ANOMALY_OR_CONFLICT', input: () => ({ netUnrealizedPnl: -1, verifiedAnomaly: { severe: true, evidenceRefs: ['feed:conflict'] } }) },
    { reason: 'GUARD_THREATENED', input: () => ({ guards: { equity: 200, safetyNet: 200 } }) },
  ];
  it.each(individual)('$reason independently authorizes CLOSE', ({ reason, input }) => {
    const triggers = close(input());
    expect(triggers.map(trigger => trigger.reason)).toEqual([reason]);
    expect(closeAuthorized(triggers, reason)).toBe(true);
    expect(closeAuthorized(triggers)).toBe(true);
  });

  it('does not authorize a model-declared trigger without its observed evidence', () => {
    expect(close({ leadClose: { closeTrigger: 'EARLY_TAKE_PROFIT', exitSignal: { kind: 'target_complete', evidenceRefs: ['invented'] } }, netUnrealizedPnl: 10 })).toHaveLength(0);
    expect(closeAuthorized([], 'MOMENTUM_REVERSAL')).toBe(false);
  });

  it('requires actual net profit and matching target references for early take profit', () => {
    const input: Partial<CloseEvaluationInput> = { snapshot: { ...snapshot(), last: 110 }, targetLevel: 110, targetScenarioId: 'setup-1', leadClose: { exitSignal: { kind: 'target_complete', evidenceRefs: ['setup-1:target_complete'] } } };
    expect(close(input)).toHaveLength(0);
    expect(close({ ...input, netUnrealizedPnl: -0.1 })).toHaveLength(0);
    expect(close({ ...input, netUnrealizedPnl: 1 })[0].reason).toBe('EARLY_TAKE_PROFIT');
    expect(close({ ...input, netUnrealizedPnl: 1, leadClose: { exitSignal: { kind: 'target_complete', evidenceRefs: ['another:target_complete'] } } })).toHaveLength(0);
    expect(exitEvidenceRefs(snapshot(), 'setup-1')).toEqual({ exhaustion: 'snap-1:exhaustion', target: 'setup-1:target_complete' });
  });

  it('does not pre-empt Owner guards at arbitrary percentages or interpret UNKNOWN stops as absent', () => {
    expect(close({ guards: { dailyLossHit: false, equity: 201, safetyNet: 200 }, position: { ...position(), protectionStatus: 'unknown' } })).toHaveLength(0);
    expect(close({ guards: { dailyLossHit: true } })[0].reason).toBe('GUARD_THREATENED');
    expect(close({ guards: { protectionUnrestorable: true } })[0].reason).toBe('GUARD_THREATENED');
  });

  it('does not close from holding duration or an unverified adverse claim', () => {
    expect(close({ position: { ...position(), openedAt: now - 365 * 86400_000 }, news: news([newsEvent({ evidenceStatus: 'REPORTED' })], { criticalClaimFound: true }) })).toHaveLength(0);
  });

  it('does not claim sample or cross-venue prices verify a LIVE structural or exchange stop breach', () => {
    expect(close({ snapshot: { ...snapshot(), example: true, last: 80 }, invalidationLevel: 95 })).toHaveLength(0);
    expect(close({ snapshot: { ...snapshot(), source: 'binance', last: 80 }, invalidationLevel: 95 })).toHaveLength(0);
  });
});

describe('estimated net unrealized', () => {
  it('uses the existing paper round-trip fee formula and refuses an unpriced mark', () => {
    expect(estimatedNetUnrealized({ unrealizedPnl: 10, entry: 100, mark: 105, qty: 2, takerFee: 0.001 })).toBeCloseTo(9.59);
    expect(estimatedNetUnrealized({ unrealizedPnl: 10, entry: 100, mark: 0, qty: 2, takerFee: 0.001 })).toBeNull();
    expect(estimatedNetUnrealized({ unrealizedPnl: Number.NaN, entry: 100, mark: 105, qty: 1, takerFee: 0.001 })).toBeNull();
  });
});
