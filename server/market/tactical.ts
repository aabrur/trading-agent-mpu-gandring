import type { MarketSnapshot } from '../types.js';
import { calculateSwingLevels } from '../strategy.js';

export interface TacticalTradePlan {
  symbol: string;
  timestamp: number;
  marketRegime: string;
  scenarios: Array<{
    kind: 'PULLBACK_CONTINUATION' | 'BREAKDOWN_CONTINUATION' | 'FAILED_BREAKDOWN_REVERSAL' | 'BREAKOUT_CONTINUATION' | 'FAILED_BREAKOUT_REVERSAL';
    side: 'LONG' | 'SHORT';
    entryZone: { low: number; high: number; basis: string } | null;
    invalidationLevel: number | null;
    target1: number | null;
    target2: number | null;
    evidence: string[];
    missingEvidence: string[];
  }>;
  exhaustion: {
    present: boolean;
    direction: 'SELLER' | 'BUYER' | 'NONE';
    evidence: string[];
  };
}

const SCENARIO_KINDS: TacticalTradePlan['scenarios'][number]['kind'][] = [
  'PULLBACK_CONTINUATION',
  'BREAKDOWN_CONTINUATION',
  'FAILED_BREAKDOWN_REVERSAL',
  'BREAKOUT_CONTINUATION',
  'FAILED_BREAKOUT_REVERSAL'
];

const valid = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

function confirmedLevelFailure(candles: MarketSnapshot['candles'], level: number | null | undefined, direction: 'breakdown' | 'breakout'): boolean {
  if (!valid(level) || candles.length < 2) return false;
  const previous = candles.at(-2)!;
  const confirmation = candles.at(-1)!;
  return direction === 'breakdown'
    ? (previous.l < level || previous.c < level) && confirmation.c > level
    : (previous.h > level || previous.c > level) && confirmation.c < level;
}

function zone(levels: Array<[number | null | undefined, string]>): TacticalTradePlan['scenarios'][number]['entryZone'] {
  const usable = levels.filter(([value]) => valid(value));
  if (!usable.length) return null;
  const values = usable.map(([value]) => value as number);
  return {
    low: Math.min(...values),
    high: Math.max(...values),
    basis: usable.map(([, label]) => label).join(' and ')
  };
}

export function buildTacticalTradePlan(snapshot: MarketSnapshot): TacticalTradePlan {
  const technical = snapshot.technicalSummary;
  const trend = technical?.mtfTrend['15m'];
  const profile = technical?.volumeProfile;
  const swings = technical?.swingLevels;
  const ema9 = trend?.ema9 ?? null;
  const ema21 = trend?.ema21 ?? null;
  const ema50 = trend?.ema50 ?? null;
  const vwap = profile?.sessionVwap ?? null;
  const poc = profile?.poc ?? null;
  const vah = profile?.vah ?? null;
  const val = profile?.val ?? null;
  const swingHigh = swings?.recentSwingHigh ?? null;
  const swingLow = swings?.recentSwingLow ?? null;
  const continuationSwing = snapshot.candles.length >= 21
    ? calculateSwingLevels(snapshot.candles.slice(-21, -1))
    : null;
  const reversalSwing = snapshot.candles.length >= 22
    ? calculateSwingLevels(snapshot.candles.slice(-22, -2))
    : null;
  const continuationHigh = continuationSwing?.recentSwingHigh ?? swingHigh;
  const continuationLow = continuationSwing?.recentSwingLow ?? swingLow;
  const rsi = technical?.momentum.rsi14_15m ?? null;
  const bullish = trend?.regime === 'STRONG_UPTREND' || trend?.regime === 'SQUEEZE_BREAKOUT';
  const bearish = trend?.regime === 'STRONG_DOWNTREND';
  const marketRegime = trend?.regime ?? 'UNKNOWN';
  const profileBasis = technical?.derivation?.volumeProfile ?? 'Candle-based volume profile is approximate, not tick-accurate.';
  const flowWindows = snapshot.orderflow?.rollingWindows;
  const completeFlowWindows = flowWindows
    ? (Object.entries(flowWindows) as Array<[string, NonNullable<typeof flowWindows['1m']>]>).filter(([, window]) =>
      Number.isFinite(window.coveragePct) && window.coveragePct >= 95 && !window.partial && window.tradesCount >= 2 && Number.isFinite(window.delta))
    : [];
  const flowHistoryAvailable = completeFlowWindows.length > 0;
  const flowCoverage = flowWindows
    ? Object.entries(flowWindows).map(([window, item]) => `${window} ${item.coveragePct}%${item.partial ? ' partial' : ' complete'}`).join(', ')
    : null;
  const missingShared = [
    ...(technical ? [] : ['TechnicalSummary is unavailable, so indicator-based confirmation is incomplete.']),
    ...(flowHistoryAvailable ? [] : [flowCoverage
      ? `Chronological order-flow/CVD history is incomplete; observed rolling coverage: ${flowCoverage}.`
      : 'Chronological order-flow/CVD history is unavailable; a single snapshot cannot establish divergence or persistence.']),
    'Market depth history is unavailable; a single book snapshot cannot establish liquidity behavior.'
  ];

  const scenarios = SCENARIO_KINDS.map((kind): TacticalTradePlan['scenarios'][number] => {
    const side = kind === 'BREAKDOWN_CONTINUATION' || kind === 'FAILED_BREAKOUT_REVERSAL'
      ? 'SHORT'
      : kind === 'FAILED_BREAKDOWN_REVERSAL' || kind === 'BREAKOUT_CONTINUATION'
        ? 'LONG'
        : bullish ? 'LONG' : 'SHORT';
    const evidence: string[] = [];
    const missingEvidence = [...missingShared];
    let entryZone: TacticalTradePlan['scenarios'][number]['entryZone'] = null;
    let invalidationLevel: number | null = null;
    let target1: number | null = null;
    let target2: number | null = null;

    if (kind === 'PULLBACK_CONTINUATION') {
      if (bullish || bearish) evidence.push(`${trend?.regime} on 15m supports ${side.toLowerCase()} continuation.`);
      else missingEvidence.push('A directional 15m trend regime is unavailable.');
      entryZone = side === 'LONG'
        ? zone([[ema9, 'EMA9'], [ema21, 'EMA21']])
        : zone([[ema9, 'EMA9'], [ema21, 'EMA21'], [vwap, 'session VWAP']]);
      if (entryZone) evidence.push(`Candidate pullback zone uses supplied ${entryZone.basis}; VWAP/profile values are approximate where candle-derived.`, profileBasis);
      else missingEvidence.push('No valid EMA9, EMA21 or VWAP values are available for a pullback zone.');
      invalidationLevel = valid(side === 'LONG' ? swingLow : swingHigh) ? (side === 'LONG' ? swingLow : swingHigh) as number : null;
      target1 = valid(side === 'LONG' ? vah : val) ? (side === 'LONG' ? vah : val) as number : null;
      target2 = valid(side === 'LONG' ? swingHigh : swingLow) ? (side === 'LONG' ? swingHigh : swingLow) as number : null;
    } else if (kind === 'BREAKDOWN_CONTINUATION') {
      if (valid(continuationSwing?.recentSwingLow) && snapshot.candles.at(-1)!.c < continuationSwing.recentSwingLow) evidence.push(`Closed-candle price is below prior-20 swing low ${continuationSwing.recentSwingLow}.`);
      else missingEvidence.push('Confirmed trade below the supplied recent swing low is unavailable.');
      if (bearish) evidence.push('15m regime is strongly bearish.');
      else missingEvidence.push('Strong bearish 15m trend confirmation is unavailable.');
      entryZone = valid(continuationLow) ? zone([[continuationLow, continuationSwing ? 'prior swing low retest' : 'reported recent swing low retest']]) : null;
      invalidationLevel = valid(continuationHigh) ? continuationHigh : null;
      target1 = valid(val) ? val : null;
      target2 = valid(poc) ? poc : null;
    } else if (kind === 'FAILED_BREAKDOWN_REVERSAL') {
      if (confirmedLevelFailure(snapshot.candles, reversalSwing?.recentSwingLow, 'breakdown')) evidence.push(`The previous candle broke below prior-20 swing low ${reversalSwing!.recentSwingLow} and the latest closed candle reclaimed it.`);
      else missingEvidence.push('A prior closed-candle breakdown and subsequent reclaim of the supplied swing low are unconfirmed.');
      entryZone = valid(reversalSwing?.recentSwingLow) ? zone([[reversalSwing!.recentSwingLow, 'reclaimed prior swing low']]) : (valid(swingLow) ? zone([[swingLow, 'recent swing low']]) : null);
      invalidationLevel = valid(reversalSwing?.recentSwingLow) ? reversalSwing!.recentSwingLow : null;
      target1 = valid(vwap) ? vwap : (valid(poc) ? poc : null);
      target2 = valid(vah) ? vah : (valid(swingHigh) ? swingHigh : null);
      if (snapshot.orderflow?.deltaDivergence) evidence.push('The current order-flow snapshot flags delta divergence; chronological confirmation is still missing.');
      if (snapshot.derivatives?.oiDelta1hPct !== null && snapshot.derivatives?.oiDelta1hPct !== undefined) evidence.push(`Supplied 1h open-interest change: ${snapshot.derivatives.oiDelta1hPct}%.`);
      else missingEvidence.push('Open-interest change context is unavailable.');
      if (snapshot.fundingRate !== null) evidence.push(`Supplied funding rate: ${snapshot.fundingRate}.`);
      else missingEvidence.push('Funding context is unavailable.');
    } else if (kind === 'BREAKOUT_CONTINUATION') {
      if (valid(continuationSwing?.recentSwingHigh) && snapshot.candles.at(-1)!.c > continuationSwing.recentSwingHigh) evidence.push(`Closed-candle price is above prior-20 swing high ${continuationSwing.recentSwingHigh}.`);
      else missingEvidence.push('Confirmed trade above the supplied recent swing high is unavailable.');
      if (bullish) evidence.push('15m regime supports bullish continuation.');
      else missingEvidence.push('Strong bullish 15m trend confirmation is unavailable.');
      entryZone = valid(continuationHigh) ? zone([[continuationHigh, continuationSwing ? 'prior swing high retest' : 'reported recent swing high retest']]) : null;
      invalidationLevel = valid(continuationLow) ? continuationLow : null;
      target1 = valid(vah) && vah > snapshot.last ? vah : null;
      target2 = valid(swingHigh) && swingHigh > snapshot.last ? swingHigh : null;
    } else {
      if (confirmedLevelFailure(snapshot.candles, reversalSwing?.recentSwingHigh, 'breakout')) evidence.push(`The previous candle broke above prior-20 swing high ${reversalSwing!.recentSwingHigh} and the latest closed candle rejected below it.`);
      else missingEvidence.push('A prior closed-candle breakout and subsequent rejection below the supplied swing high are unconfirmed.');
      entryZone = valid(reversalSwing?.recentSwingHigh) ? zone([[reversalSwing!.recentSwingHigh, 'rejected prior swing high']]) : (valid(swingHigh) ? zone([[swingHigh, 'recent swing high']]) : null);
      invalidationLevel = valid(reversalSwing?.recentSwingHigh) ? reversalSwing!.recentSwingHigh : null;
      target1 = valid(vwap) ? vwap : (valid(poc) ? poc : null);
      target2 = valid(val) ? val : (valid(swingLow) ? swingLow : null);
    }

    if (entryZone) {
      const favorable = (target: number | null) => target !== null && (side === 'LONG' ? target > entryZone.high : target < entryZone.low) ? target : null;
      target1 = favorable(target1);
      target2 = favorable(target2);
      if (invalidationLevel !== null && (side === 'LONG' ? invalidationLevel >= entryZone.low : invalidationLevel <= entryZone.high)) invalidationLevel = null;
    } else {
      target1 = null;
      target2 = null;
      invalidationLevel = null;
    }
    if (flowHistoryAvailable && snapshot.orderflow) {
      const flow = completeFlowWindows[0][1];
      evidence.push(`Observed ${completeFlowWindows[0][0]} taker-flow window: delta ${flow.delta} across ${flow.tradesCount} trades (${flow.coveragePct}% coverage).`);
    }
    return { kind, side, entryZone, invalidationLevel, target1, target2, evidence, missingEvidence };
  });

  const exhaustionEvidence: string[] = [];
  let exhaustion: TacticalTradePlan['exhaustion'] = { present: false, direction: 'NONE', evidence: exhaustionEvidence };
  const latestCandle = snapshot.candles.at(-1);
  const oneMinuteFlow = flowWindows?.['1m'];
  const confirmedFlowDivergence = Boolean(
    oneMinuteFlow && !oneMinuteFlow.partial && oneMinuteFlow.coveragePct >= 95 && oneMinuteFlow.tradesCount >= 2 && snapshot.orderflow?.deltaDivergence
  );
  if (valid(rsi) && rsi <= 25 && confirmedFlowDivergence && latestCandle && latestCandle.c > latestCandle.o && oneMinuteFlow!.delta > 0) {
    exhaustion = { present: true, direction: 'SELLER', evidence: [`15m RSI ${rsi} is oversold, complete 1m order flow diverges positively, and the latest closed candle confirms upward price response.`] };
  } else if (valid(rsi) && rsi >= 75 && confirmedFlowDivergence && latestCandle && latestCandle.c < latestCandle.o && oneMinuteFlow!.delta < 0) {
    exhaustion = { present: true, direction: 'BUYER', evidence: [`15m RSI ${rsi} is overbought, complete 1m order flow diverges negatively, and the latest closed candle confirms downward price response.`] };
  } else if (valid(rsi) && (rsi <= 25 || rsi >= 75)) {
    exhaustion = { present: false, direction: 'NONE', evidence: [`15m RSI ${rsi} is extreme, but chronological flow divergence and matching closed-candle price confirmation are not both present.`] };
  } else if (rsi === null || rsi === undefined) {
    exhaustion = { present: false, direction: 'NONE', evidence: ['15m RSI is unavailable; no exhaustion claim is supported.'] };
  } else {
    exhaustion = { present: false, direction: 'NONE', evidence: [`15m RSI ${rsi} does not meet the stated exhaustion thresholds.`] };
  }

  return { symbol: snapshot.symbol, timestamp: snapshot.fetchedAt, marketRegime, scenarios, exhaustion };
}
