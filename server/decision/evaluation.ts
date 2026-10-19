import type { Question } from './schemas.js';
import type { DecisionsResponse } from './schemas.js';
import type { JevCallResult } from './jev.js';

export const REGIME_CRITERIA = {
  TREND_UP: 'Sustained higher highs/lows from the supplied indicators',
  TREND_DOWN: 'Sustained lower highs/lows from the supplied indicators',
  RANGING: 'Mean-reverting or sideways from the supplied indicators',
  BREAKOUT: 'Leaving a defined range on the supplied indicators',
  VOLATILE: 'Unusually wide range versus recent ATR/returns',
  UNCERTAIN: 'Insufficient or conflicting indicator evidence'
};

export function preAnalysisQuestions(): Record<string, Question> {
  return {
    market_regime: {
      type: 'choice',
      instructions: 'Classify the market regime using only the supplied indicator values. Do not invent prices or recompute indicators.',
      criteria: REGIME_CRITERIA
    },
    news_relevant: {
      type: 'noul',
      instructions: 'Are the supplied headlines relevant to the selected trading symbol?',
      criteria: { true: 'Directly about the symbol or its chain/market', false: 'Unrelated or too generic' }
    },
    news_needs_research: {
      type: 'noul',
      instructions: 'Should the Research Analyst spend extra attention on these headlines?',
      criteria: { true: 'Material, symbol-relevant, and not already stale', false: 'Noise or already classified' }
    },
    news_false_critical: {
      type: 'noul',
      instructions: 'Do the headlines look like keyword-only critical claims rather than verified events?',
      criteria: { true: 'Keyword claim without verification metadata', false: 'Evidence status is verified or not critical' }
    },
    whale_significant: {
      type: 'noul',
      instructions: 'Given only authenticated provider observations, is there a symbol-relevant large transfer worth noting? Do not invent hashes, owners, or USD values.',
      criteria: { true: 'Observed large transfer relevant to the symbol', false: 'None, unavailable, or not relevant' }
    }
  };
}

export function conflictQuestions(): Record<string, Question> {
  return {
    material_conflict: {
      type: 'noul',
      instructions: 'Is there a material contradiction among market evidence, research evidence, the strategy rule, and the Desk Lead verdict? Do not invent disagreements.',
      criteria: { true: 'A concrete contradiction in the supplied facts', false: 'No material contradiction' }
    }
  };
}

export function boundedPreState(input: {
  symbol: string;
  last?: number;
  rsi?: number;
  atr?: number;
  change24hPct?: number;
  volumeRatio?: number;
  news?: { title: string; evidenceStatus: string; freshness: string; category: string }[];
  whale?: { classification: string; usdValueOrNull: number | null; confirmationStatus: string; attributionConfidence: string }[];
}) {
  return {
    symbol: input.symbol,
    indicators: {
      last: input.last ?? null,
      rsi: input.rsi ?? null,
      atr: input.atr ?? null,
      change24hPct: input.change24hPct ?? null,
      volumeRatio: input.volumeRatio ?? null
    },
    news: (input.news ?? []).slice(0, 4),
    whale: (input.whale ?? []).slice(0, 3)
  };
}

export function boundedPostState(input: {
  symbol: string;
  marketStance?: string | null;
  researchVote?: string | null;
  strategySide?: string | null;
  leadAction?: string | null;
  criticalVetoFound?: boolean;
  criticalClaimFound?: boolean;
}) {
  return {
    symbol: input.symbol,
    marketStance: input.marketStance ?? null,
    researchVote: input.researchVote ?? null,
    strategySide: input.strategySide ?? null,
    leadAction: input.leadAction ?? null,
    criticalVetoFound: !!input.criticalVetoFound,
    criticalClaimFound: !!input.criticalClaimFound
  };
}

export interface JevInterpretation {
  marketRegime: string | null;
  newsRelevant: number | null;
  newsNeedsResearch: number | null;
  newsFalseCritical: number | null;
  whaleSignificant: number | null;
  materialConflict: number | null;
  model: string | null;
  confidence: number | null;
}

export function interpretAnswers(response: DecisionsResponse | null): JevInterpretation {
  const answers = response?.answers ?? {};
  const noul = (id: string) => answers[id]?.type === 'noul' ? answers[id].noul : null;
  const choice = (id: string) => answers[id]?.type === 'choice' ? answers[id].choice : null;
  const conf = answers.market_regime?.type === 'choice' ? answers.market_regime.confidence : null;
  return {
    marketRegime: choice('market_regime'),
    newsRelevant: noul('news_relevant'),
    newsNeedsResearch: noul('news_needs_research'),
    newsFalseCritical: noul('news_false_critical'),
    whaleSignificant: noul('whale_significant'),
    materialConflict: noul('material_conflict'),
    model: response?.model ?? null,
    confidence: conf
  };
}

export function jevMayEnrichAgents(effectiveMode: string) {
  return effectiveMode === 'assist';
}

export function recordFromResult(kind: 'pre' | 'post', result: JevCallResult, interpretation: JevInterpretation) {
  return {
    kind,
    at: Date.now(),
    ok: result.ok,
    health: result.health,
    cached: result.cached,
    latencyMs: result.latencyMs,
    model: result.response?.model ?? null,
    inputTokens: result.response?.usage?.input_tokens ?? null,
    cost: result.response?.usage?.cost ?? null,
    error: result.error,
    interpretation
  };
}
