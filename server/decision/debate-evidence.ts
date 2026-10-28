import type { MarketSnapshot, Position } from '../types.js';
import { eventRelevantToSymbol, newsFreshness, type NewsBriefing, type NormalizedNewsEvent } from '../market/news.js';
import type { WhaleBriefing, NormalizedWhaleEvent } from '../market/whale.js';

export type EvidenceStatus = 'SUPPORTING' | 'NEUTRAL' | 'UNKNOWN' | 'VERIFIED_OPPOSING';
export type TradeSide = 'LONG' | 'SHORT';
export interface EntryZone { low: number; high: number; basis: string }
export interface EntryScenario {
  id?: string;
  kind?: string;
  side: TradeSide;
  entryZone: EntryZone | null;
  invalidationLevel: number | null;
  target1?: number | null;
  target2?: number | null;
}
export interface EvidenceDimension { status: EvidenceStatus; basis: string; evidenceRefs: string[] }
export interface WhalePolicy { minUsd: number; maxAgeMs: number }
export interface JevEvidence {
  available: boolean;
  fallback: boolean;
  origin?: 'remote' | 'heuristic' | 'cache' | 'unavailable';
  regime: string | null;
  materialConflict?: boolean;
  evidenceRefs?: string[];
}
export interface MomentumEvidence {
  change5Pct: number | null;
  roc5: number | null;
  cvdDelta?: number | null;
  buySellRatio?: number | null;
  flowVerified?: boolean;
}
export interface DebateEvidence {
  side: TradeSide;
  symbol: string;
  observedAt: number;
  snapshotId: string | null;
  dimensions: Record<'structure' | 'tape' | 'catalyst' | 'jev', EvidenceDimension>;
  sourceConflict: boolean;
  provenance: { marketSource: string; executionVenue: string | null; example: boolean; proxySources: string[]; conflicts: string[]; referenceMarket?: boolean };
  momentum: MomentumEvidence;
  scenario: EntryScenario | null;
  openAllowed: boolean;
  openReasons: string[];
}
export interface DebateEvidenceInput {
  snapshot: MarketSnapshot;
  side: TradeSide;
  scenario?: EntryScenario | null;
  mode?: 'PAPER' | 'TESTNET' | 'LIVE';
  executionVenue?: string | null;
  nativeExecutionQuote?: number | null;
  contractMultiplier?: number | null;
  instrumentSymbol?: string | null;
  news?: NewsBriefing | null;
  whale?: WhaleBriefing | null;
  whalePolicy?: WhalePolicy;
  jev?: JevEvidence | null;
  momentum?: MomentumEvidence;
  now?: number;
}

const finite = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value);
const positive = (value: number | null | undefined): value is number => finite(value) && value > 0;
const direction = (side: TradeSide) => side === 'LONG' ? 1 : -1;
const dimension = (status: EvidenceStatus, basis: string, evidenceRefs: string[] = []): EvidenceDimension => ({ status, basis, evidenceRefs });

/** A structural setup is binding at submission; no RSI, ATR or ROI cutoff is added. */
export function validateEntryGeometry(side: TradeSide, quote: number, scenario?: EntryScenario | null, tolerance = 0.002): { ok: boolean; reason: string | null } {
  if (!positive(quote)) return { ok: false, reason: 'Execution quote unavailable.' };
  const zone = scenario?.entryZone;
  if (!scenario || scenario.side !== side || !zone || !positive(zone.low) || !positive(zone.high) || zone.low > zone.high || !zone.basis.trim()) {
    return { ok: false, reason: 'A valid side-specific entry zone with structural basis is required.' };
  }
  const invalidation = scenario.invalidationLevel;
  if (!positive(invalidation) || (side === 'LONG' ? invalidation >= Math.min(quote, zone.low) : invalidation <= Math.max(quote, zone.high))) {
    return { ok: false, reason: 'Structural invalidation is on the wrong side of the entry zone or quote.' };
  }
  if (quote < zone.low * (1 - tolerance) || quote > zone.high * (1 + tolerance)) return { ok: false, reason: `Execution quote ${quote} is outside the binding ${side} entry zone [${zone.low}, ${zone.high}]; wait for the setup retest.` };
  return { ok: true, reason: null };
}

/** These are different observed windows. Neither may mask an opposing reading in the other. */
export function snapshotMomentum(snapshot: MarketSnapshot): MomentumEvidence {
  const closes = snapshot.candles.map(candle => candle.c);
  const last = closes.at(-1), fourBack = closes.at(-5), fiveBack = closes.at(-6);
  const flow = snapshot.orderflow;
  const flowWindow = flow?.rollingWindows?.['15m'] ?? flow?.rollingWindows?.['5m'];
  const partial = flowWindow ? flowWindow.partial : (flow as { partial?: boolean })?.partial === true;
  const coveragePct = flowWindow?.coveragePct ?? (flow as { coveragePct?: number })?.coveragePct;
  const tradesCount = flowWindow?.tradesCount ?? flow?.tradesCount;
  const adequateCoverage = typeof coveragePct === 'number' && Number.isFinite(coveragePct) && coveragePct >= 80 && !partial && typeof tradesCount === 'number' && Number.isFinite(tradesCount) && tradesCount >= 5;
  const flowVerified = !!flow && (snapshot.example || flow.evidence?.status === 'live') && flow.dataType !== 'external_proxy' && (!flow.actualDataVenue || flow.actualDataVenue === snapshot.source) && adequateCoverage;
  return {
    change5Pct: positive(last) && positive(fourBack) ? (last - fourBack) / fourBack * 100 : null,
    roc5: positive(last) && positive(fiveBack) ? (last - fiveBack) / fiveBack * 100 : null,
    cvdDelta: finite(flow?.cvdDelta) ? flow.cvdDelta : null,
    buySellRatio: finite(flow?.buySellRatio) ? flow.buySellRatio : null,
    flowVerified,
  };
}

function tapeDimension(input: DebateEvidenceInput, momentum: MomentumEvidence): EvidenceDimension {
  const sign = direction(input.side);
  const priceValues = [momentum.change5Pct, momentum.roc5].filter(finite);
  const refs = ['market.closedBars.change5Pct', 'market.closedBars.roc5'];
  const flowOpposing = momentum.flowVerified && ((finite(momentum.cvdDelta) && momentum.cvdDelta * sign < 0) || (positive(momentum.buySellRatio) && (input.side === 'LONG' ? momentum.buySellRatio < 1 : momentum.buySellRatio > 1)));
  if (flowOpposing) refs.push('market.orderflow');
  if (priceValues.some(value => value * sign < 0) || flowOpposing) return dimension('VERIFIED_OPPOSING', 'A measured price-momentum window or authenticated directional order flow opposes this side; conflicting windows are not combined with OR.', refs);
  const volumeObserved = input.snapshot.candles.slice(-5).some(candle => finite(candle.v) && candle.v > 0);
  const priceAligned = priceValues.length === 2 && priceValues.every(value => value * sign > 0);
  if (priceAligned && (volumeObserved || momentum.flowVerified)) return dimension('SUPPORTING', `Both price-momentum windows align with ${input.side}; ${momentum.flowVerified ? 'authenticated observed taker flow' : 'closed-bar traded volume (not inferred taker flow)'} supplies tape evidence.`, [...refs, volumeObserved ? 'market.closedBars.volume' : 'market.orderflow']);
  if (!priceValues.length) return dimension('UNKNOWN', 'Price momentum is unavailable; no tape support is invented.');
  return dimension('NEUTRAL', 'Observed momentum is flat or lacks independent traded-volume/flow confirmation.', refs);
}

function verifiedNews(input: Pick<DebateEvidenceInput, 'snapshot' | 'news' | 'now'>): NormalizedNewsEvent[] {
  if (input.news?.providerStatus !== 'CONFIGURED_LIVE') return [];
  const now = input.now ?? Date.now();
  return input.news.events.filter(event => !event.example && event.provider !== 'sample' && event.evidenceStatus === 'VERIFIED' && event.freshness === 'fresh' && newsFreshness(event.publishedAt, now) === 'fresh' && eventRelevantToSymbol(event, input.snapshot.symbol));
}

function significantWhales(input: Pick<DebateEvidenceInput, 'snapshot' | 'whale' | 'whalePolicy' | 'now'>): NormalizedWhaleEvent[] {
  const policy = input.whalePolicy;
  if (input.whale?.providerStatus !== 'CONFIGURED_LIVE' || !policy || !positive(policy.minUsd) || !positive(policy.maxAgeMs)) return [];
  const now = input.now ?? Date.now();
  const coin = input.snapshot.symbol.replace(/USDT?$|USDC$/i, '').toUpperCase();
  return input.whale.events.filter(event => event.confirmationStatus === 'confirmed' && event.attributionConfidence === 'high' && positive(event.usdValueOrNull) && event.usdValueOrNull >= policy.minUsd && positive(event.timestamp) && event.timestamp <= now && now - event.timestamp <= policy.maxAgeMs && event.tokenSymbol.toUpperCase() === coin && !!event.txHash && finite(event.blockNumber));
}

function catalystDimension(input: DebateEvidenceInput): EvidenceDimension {
  const news = verifiedNews(input);
  const whale = significantWhales(input);
  const adverseNews = news.filter(event => event.sentiment === 'severe' || (input.side === 'LONG' ? event.sentiment === 'bearish' : event.sentiment === 'bullish'));
  const adverseWhale = whale.filter(event => input.side === 'LONG' ? event.classification === 'EXCHANGE_INFLOW' : event.classification === 'EXCHANGE_OUTFLOW');
  if (adverseNews.length || adverseWhale.length) return dimension('VERIFIED_OPPOSING', 'Fresh symbol-relevant verified catalyst or confirmed significant high-confidence opposing whale flow.', [...adverseNews.map(event => `news:${event.id}`), ...adverseWhale.map(event => `whale:${event.txHash}`)]);
  const positiveNews = news.filter(event => input.side === 'LONG' ? event.sentiment === 'bullish' : event.sentiment === 'bearish');
  const positiveWhale = whale.filter(event => input.side === 'LONG' ? event.classification === 'EXCHANGE_OUTFLOW' : event.classification === 'EXCHANGE_INFLOW');
  if (positiveNews.length || positiveWhale.length) return dimension('SUPPORTING', 'Fresh verified catalyst or significant confirmed flow aligns with the side. A transfer is flow evidence, not proof of a completed market trade.', [...positiveNews.map(event => `news:${event.id}`), ...positiveWhale.map(event => `whale:${event.txHash}`)]);
  if (news.length || whale.length) return dimension('NEUTRAL', 'Verified optional evidence is directionally neutral.');
  return dimension('UNKNOWN', 'No fresh verified relevant optional catalyst/whale evidence. Unverified claims and unavailable feeds neither veto nor support entry.');
}

function jevDimension(input: DebateEvidenceInput): EvidenceDimension {
  const jev = input.jev;
  if (!jev?.available || jev.fallback || (jev.origin !== 'remote' && jev.origin !== 'cache')) return dimension('UNKNOWN', 'Remote JEV evaluation is unavailable or heuristic; it is not counted as remote probabilistic support.');
  const refs = jev.evidenceRefs ?? ['jev.market_regime'];
  const opposing = input.side === 'LONG' ? jev.regime === 'TREND_DOWN' : jev.regime === 'TREND_UP';
  if (opposing || jev.materialConflict) return dimension('VERIFIED_OPPOSING', `Remote JEV identifies ${opposing ? `the opposing ${jev.regime} regime` : 'a material evidence conflict'}.`, refs);
  if (input.side === 'LONG' ? jev.regime === 'TREND_UP' : jev.regime === 'TREND_DOWN') return dimension('SUPPORTING', `Remote JEV ${jev.origin === 'cache' ? 'cached ' : ''}regime evaluation aligns with the side.`, refs);
  return dimension('NEUTRAL', 'JEV is available but does not supply directional support.', refs);
}

export function isRecognizedReferenceMarket(source: string, executionVenue?: string | null): boolean {
  if (!executionVenue || source.toLowerCase() === executionVenue.toLowerCase()) return true;
  const s = source.toLowerCase(), e = executionVenue.toLowerCase();
  if (e === 'aster' && (s === 'bybit' || s === 'binance')) return true;
  if (e === 'hyperliquid' && (s === 'bybit' || s === 'binance')) return true;
  if (e === 'dydx' && (s === 'bybit' || s === 'binance')) return true;
  if (e === 'paradex' && (s === 'bybit' || s === 'binance')) return true;
  if (e === 'orderly' && (s === 'bybit' || s === 'binance')) return true;
  return false;
}

export function buildDebateEvidence(input: DebateEvidenceInput): DebateEvidence {
  const { snapshot, side } = input;
  const venue = input.executionVenue ?? null;
  const live = input.mode === 'LIVE' || input.mode === 'TESTNET';
  const conflicts: string[] = [];
  if (live && (snapshot.example || snapshot.source === 'sample')) conflicts.push('Sample/example data cannot authorize TESTNET or LIVE entry.');
  if (live && !['bybit', 'binance', 'hyperliquid', 'aster', 'dydx', 'paradex', 'orderly'].includes(snapshot.source)) conflicts.push(`Market price source ${snapshot.source} is unverified for ${live ? 'live' : 'testnet'} trading.`);
  if (live && venue && snapshot.source !== venue && !isRecognizedReferenceMarket(snapshot.source, venue)) {
    conflicts.push(`Market price source ${snapshot.source} does not match execution venue ${venue}.`);
  }
  if (input.contractMultiplier !== undefined && input.contractMultiplier !== null && !(input.contractMultiplier > 0)) conflicts.push('Invalid contract multiplier for execution venue.');
  if (input.instrumentSymbol && input.instrumentSymbol.toUpperCase() !== snapshot.symbol.toUpperCase()) conflicts.push(`Execution instrument ${input.instrumentSymbol} incompatible with market symbol ${snapshot.symbol}.`);
  if (input.nativeExecutionQuote !== undefined && input.nativeExecutionQuote !== null) {
    if (!(input.nativeExecutionQuote > 0) || !Number.isFinite(input.nativeExecutionQuote)) conflicts.push('Execution-native quote is unavailable or invalid.');
    else if (positive(snapshot.last)) {
      const divergence = Math.abs(input.nativeExecutionQuote - snapshot.last) / snapshot.last;
      if (divergence > 0.05) conflicts.push(`Execution quote ${input.nativeExecutionQuote} diverges by ${(divergence * 100).toFixed(1)}% from reference market price ${snapshot.last}.`);
    }
  }
  const proxySources = [snapshot.orderbook, snapshot.orderflow].filter(item => item?.dataType === 'external_proxy').map(item => `${item!.requestedVenue ?? snapshot.source} <- ${item!.actualDataVenue ?? 'unknown'} (external_proxy)`);
  if (live && snapshot.evidence) {
    for (const [key, evidence] of Object.entries(snapshot.evidence)) {
      if ((key === 'market' || key.startsWith('candles_')) && evidence.status === 'live' && !['bybit', 'binance', 'hyperliquid', 'aster', 'dydx', 'paradex', 'orderly', 'sample'].includes(evidence.source)) conflicts.push(`${key} price basis ${evidence.source} is unrecognized.`);
    }
  }
  const scenario = input.scenario ?? null;
  const refQuote = side === 'LONG' ? snapshot.ask ?? snapshot.last : snapshot.bid ?? snapshot.last;
  const quote = positive(input.nativeExecutionQuote) ? input.nativeExecutionQuote : refQuote;
  const geometry = validateEntryGeometry(side, quote, scenario);
  const exhaustion = snapshot.tacticalTradePlan?.exhaustion;
  const opposingExhaustion = !!exhaustion?.present && (side === 'LONG' ? exhaustion.direction === 'BUYER' : exhaustion.direction === 'SELLER');
  const structure = !geometry.ok
    ? dimension('UNKNOWN', geometry.reason ?? 'Structural geometry is unavailable.')
    : opposingExhaustion
      ? dimension('VERIFIED_OPPOSING', 'The supplied tactical plan confirms buyer/seller exhaustion against this entry.', ['market.tactical.exhaustion'])
      : dimension('SUPPORTING', 'The execution quote respects the side-specific structural entry zone and invalidation.', [`scenario:${scenario?.id ?? scenario?.kind ?? 'selected'}`]);
  const momentum = input.momentum ?? snapshotMomentum(snapshot);
  const dimensions = { structure, tape: tapeDimension(input, momentum), catalyst: catalystDimension(input), jev: jevDimension(input) };
  const isCrossVenue = Boolean(live && venue && snapshot.source.toLowerCase() !== venue.toLowerCase());
  const nativeQuoteMissing = isCrossVenue && !positive(input.nativeExecutionQuote);
  const openReasons = [...conflicts];
  if (nativeQuoteMissing) openReasons.push(`Execution-native quote is required to authorize OPEN on execution venue ${venue}.`);
  if (!geometry.ok) openReasons.push(geometry.reason!);
  for (const [name, item] of Object.entries(dimensions)) if (item.status === 'VERIFIED_OPPOSING') openReasons.push(`${name}: ${item.basis}`);
  if (dimensions.tape.status !== 'SUPPORTING') openReasons.push('Opening a directional position requires valid supporting tape momentum alignment.');
  // "Multi-dimensional" requires structure and at least one distinct supporting
  // evidence family, never four votes copied from the same EMA series.
  if (structure.status === 'SUPPORTING' && ![dimensions.tape, dimensions.catalyst, dimensions.jev].some(item => item.status === 'SUPPORTING')) openReasons.push('The structural setup lacks a distinct supporting tape, verified catalyst, or remote probabilistic dimension.');
  return { side, symbol: snapshot.symbol, observedAt: snapshot.fetchedAt, snapshotId: snapshot.snapshotId ?? null, dimensions, sourceConflict: conflicts.length > 0, provenance: { marketSource: snapshot.source, executionVenue: venue, referenceMarket: !!venue && snapshot.source !== venue, example: snapshot.example, proxySources, conflicts }, momentum, scenario, openAllowed: openReasons.length === 0, openReasons };
}

export const CLOSE_TRIGGER_REASONS = ['INVALIDATION_HIT', 'MOMENTUM_REVERSAL', 'SENTIMENT_REVERSAL', 'OPPOSING_NEWS', 'WHALE_EXIT', 'EXCHANGE_STOP_OR_TP', 'EARLY_TAKE_PROFIT', 'DATA_ANOMALY_OR_CONFLICT', 'GUARD_THREATENED'] as const;
export type CloseTriggerReason = typeof CLOSE_TRIGGER_REASONS[number];
export interface VerifiedCloseTrigger { reason: CloseTriggerReason; verified: true; evidenceRefs: string[]; basis: string }
export interface CloseEvaluationInput extends Omit<DebateEvidenceInput, 'side' | 'scenario'> {
  position: Position;
  evidence?: DebateEvidence;
  invalidationLevel?: number | null;
  strategyInvalidated?: boolean;
  conviction?: { opposing: boolean; verified: boolean; evidenceRefs: string[] };
  leadClose?: { closeTrigger?: CloseTriggerReason | null; reason?: string | null; exitSignal?: { kind: 'momentum_exhaustion' | 'target_complete'; evidenceRefs: string[] } | null };
  netUnrealizedPnl?: number | null;
  targetLevel?: number | null;
  targetScenarioId?: string | null;
  verifiedAnomaly?: { severe: boolean; evidenceRefs: string[] };
  guards?: { dailyLossHit?: boolean; equity?: number | null; safetyNet?: number | null; protectionUnrestorable?: boolean };
}

export function exitEvidenceRefs(snapshot: MarketSnapshot, scenarioId?: string | null) {
  return {
    exhaustion: `${snapshot.snapshotId ?? `${snapshot.symbol}:${snapshot.fetchedAt}`}:exhaustion`,
    target: scenarioId ? `${scenarioId}:target_complete` : null,
  };
}

/** Same round-trip fee estimate the paper book already uses. LIVE and TESTNET
 * pass it through so early take-profit can see net profit. Null when the mark cannot be priced. */
export function estimatedNetUnrealized(input: { unrealizedPnl: number; entry: number; mark: number; qty: number; takerFee: number }): number | null {
  const { unrealizedPnl, entry, mark, qty, takerFee } = input;
  if (!Number.isFinite(unrealizedPnl) || !Number.isFinite(entry) || !Number.isFinite(mark) || !Number.isFinite(qty) || !Number.isFinite(takerFee)) return null;
  if (qty < 0 || takerFee < 0 || mark <= 0) return null;
  return unrealizedPnl - (entry + mark) * qty * takerFee;
}

/** Each returned trigger independently authorizes CLOSE. Opinions alone cannot
 * manufacture a verified trigger, and UNKNOWN protection is never absence. */
export function evaluateCloseTriggers(input: CloseEvaluationInput): VerifiedCloseTrigger[] {
  const { snapshot, position } = input;
  const triggers: VerifiedCloseTrigger[] = [];
  const add = (reason: CloseTriggerReason, basis: string, evidenceRefs: string[]) => triggers.push({ reason, verified: true, basis, evidenceRefs });
  const price = positive(input.nativeExecutionQuote) ? input.nativeExecutionQuote : snapshot.last;
  const sign = direction(position.side);
  const now = input.now ?? Date.now();
  const live = input.mode === 'LIVE' || input.mode === 'TESTNET';
  const isFresh = Number.isFinite(snapshot.fetchedAt) && (now - snapshot.fetchedAt <= 30_000) && (snapshot.fetchedAt <= now + 5000);
  const marketVerified = !live || (!snapshot.example && snapshot.source !== 'sample' && isRecognizedReferenceMarket(snapshot.source, input.executionVenue) && isFresh);
  const savedInvalidation = input.invalidationLevel ?? (typeof position.decisionEvidence?.invalidationLevel === 'number' ? position.decisionEvidence.invalidationLevel : null);
  const breach = positive(savedInvalidation) && positive(price) && (position.side === 'LONG' ? price <= savedInvalidation : price >= savedInvalidation);
  const structuralBreak = snapshot.tacticalTradePlan?.smc?.lastBreak;
  const opposingChoch = structuralBreak && structuralBreak.timestamp >= position.openedAt && structuralBreak.type === (position.side === 'LONG' ? 'BEARISH_CHOCH' : 'BULLISH_CHOCH');
  if (marketVerified && (breach || opposingChoch || input.strategyInvalidated)) add('INVALIDATION_HIT', breach ? 'Observed price breached the persisted structural invalidation.' : opposingChoch ? 'A post-entry opposing SMC ChoCH is confirmed.' : 'Structural invalidation confirmed below/above key moving averages.', [breach ? 'position.invalidationLevel' : opposingChoch ? 'market.smc.lastBreak' : 'rule.strategyInvalidated']);
  const momentum = input.momentum ?? snapshotMomentum(snapshot);
  const priceReversed = finite(momentum.change5Pct) && finite(momentum.roc5) && momentum.change5Pct * sign < 0 && momentum.roc5 * sign < 0;
  const flowImbalanceReversed = positive(momentum.buySellRatio) && (position.side === 'LONG' ? momentum.buySellRatio <= 0.8 : momentum.buySellRatio >= 1.25);
  const flowCvdReversed = finite(momentum.cvdDelta) && momentum.cvdDelta * sign < 0 && Math.abs(momentum.cvdDelta) >= 50;
  const flowReversed = momentum.flowVerified && (flowCvdReversed || flowImbalanceReversed);
  if (marketVerified && priceReversed) {
    add('MOMENTUM_REVERSAL', 'Measured price-momentum windows have reversed against the position.', ['market.closedBars.change5Pct', 'market.closedBars.roc5']);
  } else if (marketVerified && flowReversed) {
    add('MOMENTUM_REVERSAL', 'Authenticated directional order flow strongly opposes the position.', ['market.orderflow']);
  }
  if (marketVerified && (priceReversed || flowReversed || breach || opposingChoch) && input.conviction?.opposing && input.conviction.verified && input.conviction.evidenceRefs.length) add('SENTIMENT_REVERSAL', 'Completed specialist conviction has flipped against the position thesis.', input.conviction.evidenceRefs);
  const adverseNews = verifiedNews(input).filter(event => event.sentiment === 'severe' || (position.side === 'LONG' ? event.sentiment === 'bearish' : event.sentiment === 'bullish'));
  if (adverseNews.length) add('OPPOSING_NEWS', 'Fresh verified symbol-relevant adverse news contradicts the position.', adverseNews.map(event => `news:${event.id}`));
  const adverseWhale = significantWhales(input).filter(event => position.side === 'LONG' ? event.classification === 'EXCHANGE_INFLOW' : event.classification === 'EXCHANGE_OUTFLOW');
  if (adverseWhale.length) add('WHALE_EXIT', 'Significant confirmed high-confidence flow opposes the position; transfer motive is not claimed as a completed trade.', adverseWhale.map(event => `whale:${event.txHash}`));
  const stopBreached = positive(position.stop) && positive(price) && (position.side === 'LONG' ? price <= position.stop : price >= position.stop);
  const tpBreached = positive(position.tp) && positive(price) && (position.side === 'LONG' ? price >= position.tp : price <= position.tp);
  if (marketVerified && position.protectionStatus === 'confirmed' && (stopBreached || tpBreached)) add('EXCHANGE_STOP_OR_TP', 'Observed price breached confirmed exchange stop or take profit; reconcile before any reduce-only submission.', ['position.exchangeProtection']);
  const exhaustion = snapshot.tacticalTradePlan?.exhaustion;
  const exhausted = !!exhaustion?.present && (position.side === 'LONG' ? exhaustion.direction === 'BUYER' : exhaustion.direction === 'SELLER');
  const targetComplete = positive(input.targetLevel) && positive(price) && (position.side === 'LONG' ? price >= input.targetLevel : price <= input.targetLevel);
  const exitSignal = input.leadClose?.exitSignal;
  const expectedExitRefs = exitEvidenceRefs(snapshot, input.targetScenarioId ?? (typeof position.decisionEvidence?.entryScenarioId === 'string' ? position.decisionEvidence.entryScenarioId : null));
  const referencedExhaustion = exitSignal?.kind === 'momentum_exhaustion' && exitSignal.evidenceRefs.includes(expectedExitRefs.exhaustion);
  const referencedTarget = exitSignal?.kind === 'target_complete' && expectedExitRefs.target !== null && exitSignal.evidenceRefs.includes(expectedExitRefs.target);
  const leadRequestedTp = input.leadClose?.closeTrigger === 'EARLY_TAKE_PROFIT';
  const specialistExitVerified = exitSignal && ((referencedExhaustion && exhausted) || (referencedTarget && targetComplete));
  const leadTpVerified = leadRequestedTp && (exhausted || targetComplete);
  if (marketVerified && positive(input.netUnrealizedPnl) && (specialistExitVerified || leadTpVerified)) add('EARLY_TAKE_PROFIT', 'Net profit is confirmed and structured specialist exit signal or observed exhaustion/target authorizes taking profit.', exitSignal?.evidenceRefs ?? ['market.takeProfit']);
  const anomaly = input.verifiedAnomaly?.severe && input.verifiedAnomaly.evidenceRefs.length;
  const deltaDivergence = marketVerified && snapshot.orderflow?.deltaDivergence && momentum.flowVerified && flowReversed;
  const leadRequestedAnomaly = input.leadClose?.closeTrigger === 'DATA_ANOMALY_OR_CONFLICT';
  const genuineConflict = !!input.evidence?.sourceConflict;
  if (anomaly || deltaDivergence || genuineConflict || (leadRequestedAnomaly && (anomaly || deltaDivergence || genuineConflict))) add('DATA_ANOMALY_OR_CONFLICT', 'A verified severe source conflict, anomaly, or opposing delta divergence threatens the position.', input.verifiedAnomaly?.evidenceRefs ?? [genuineConflict ? 'market.provenance' : 'market.orderflow.deltaDivergence']);
  const guards = input.guards;
  const safetyThreat = finite(guards?.equity) && finite(guards?.safetyNet) && guards.equity <= guards.safetyNet;
  if (guards?.dailyLossHit || safetyThreat || guards?.protectionUnrestorable) add('GUARD_THREATENED', 'An actual Owner-configured daily loss/safety floor or confirmed unrestorable protection condition is reached.', [guards?.dailyLossHit ? 'account.dailyLossHit' : safetyThreat ? 'account.safetyNet' : 'position.protectionUnrestorable']);
  return triggers;
}

export function closeAuthorized(triggers: VerifiedCloseTrigger[], requested?: CloseTriggerReason | null): boolean {
  return requested ? triggers.some(trigger => trigger.reason === requested) : triggers.length > 0;
}
