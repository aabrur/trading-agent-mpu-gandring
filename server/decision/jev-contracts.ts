/**
 * Jev Typed Contracts Engine for Mpu Gandring.
 *
 * Implements formal decision contracts across three typed categories:
 * - NOUL: Normalized Outcome Uncertainty Likelihood [0.0, 1.0].
 * - CHOICE: Multi-option categorical distribution with confidence weights.
 * - SCORE: Ordinal numeric evaluation ranking.
 */

import { z } from 'zod';
import {
  type Question,
  type Answer,
  NoulQuestionSchema,
  ChoiceQuestionSchema,
  ScoreQuestionSchema,
  NoulAnswerSchema,
  ChoiceAnswerSchema,
  ScoreAnswerSchema,
} from './schemas.js';

export interface TypedContractDefinition<T extends 'noul' | 'choice' | 'score'> {
  id: string;
  type: T;
  instructions: string;
  criteria: T extends 'noul'
    ? { true?: string; false?: string }
    : T extends 'choice'
    ? Record<string, string | null>
    : string[];
}

export interface ContractEvaluationResult {
  contractId: string;
  valid: boolean;
  type: 'noul' | 'choice' | 'score';
  normalizedValue: number | string;
  confidence?: number;
  error?: string;
}

/**
 * Standard Mpu Gandring Jev Decision Contracts.
 */
export const STANDARD_CONTRACTS: Record<string, TypedContractDefinition<'noul' | 'choice' | 'score'>> = {
  market_regime: {
    id: 'market_regime',
    type: 'choice',
    instructions: 'Classify the prevailing market regime from quantitative indicators.',
    criteria: {
      TREND_UP: 'Sustained higher highs/lows with positive volume delta',
      TREND_DOWN: 'Sustained lower highs/lows with negative volume delta',
      RANGING: 'Mean-reverting price action inside defined bounds',
      BREAKOUT: 'Expansion outside previous ATR bands',
      VOLATILE: 'Elevated ATR with erratic directional momentum',
      UNCERTAIN: 'Conflicting or insufficient indicator evidence'
    }
  },
  news_relevance: {
    id: 'news_relevance',
    type: 'noul',
    instructions: 'Determine whether observed news headlines directly impact the traded asset.',
    criteria: {
      true: 'Headlines describe verified catalysts affecting asset demand or protocol solvency',
      false: 'Generic market commentary, unrelated asset news, or speculative rumors'
    }
  },
  whale_significance: {
    id: 'whale_significance',
    type: 'noul',
    instructions: 'Evaluate whether whale on-chain flows represent material institutional repositioning.',
    criteria: {
      true: 'Confirmed high-value exchange inflow/outflow with high attribution confidence',
      false: 'Internal wallet churn, small transactions, or unverified claims'
    }
  },
  setup_quality_score: {
    id: 'setup_quality_score',
    type: 'score',
    instructions: 'Rank the overall trading setup quality from 1 (untradeable) to 5 (prime asymmetric alpha).',
    criteria: [
      '1 - Disordered tape, unfavorable risk/reward, high liquidation hazard',
      '2 - Weak edge, mixed factor signals, unconvincing momentum',
      '3 - Acceptable technical setup, standard risk/reward, neutral catalyst',
      '4 - Strong confluence of SMC structure, positive alpha factor, and favorable delta',
      '5 - Exceptional confluence: pristine PRZ/Order Block, high volume breakout, strong catalyst'
    ]
  },
  material_conflict: {
    id: 'material_conflict',
    type: 'noul',
    instructions: 'Detect whether a fundamental clash exists between market evidence and research evidence.',
    criteria: {
      true: 'Hard contradiction between tape direction and research findings',
      false: 'Aligned or complementary evidence across all desks'
    }
  }
};

/**
 * Converts a typed contract definition into a Jev Question schema object.
 */
export function contractToQuestion(contract: TypedContractDefinition<'noul' | 'choice' | 'score'>): Question {
  if (contract.type === 'noul') {
    return NoulQuestionSchema.parse({
      type: 'noul',
      instructions: contract.instructions,
      criteria: contract.criteria,
    });
  } else if (contract.type === 'choice') {
    return ChoiceQuestionSchema.parse({
      type: 'choice',
      instructions: contract.instructions,
      criteria: contract.criteria,
    });
  } else {
    return ScoreQuestionSchema.parse({
      type: 'score',
      instructions: contract.instructions,
      criteria: contract.criteria,
    });
  }
}

/**
 * Evaluates an incoming Answer against its contract specification.
 */
export function evaluateContract(
  contract: TypedContractDefinition<'noul' | 'choice' | 'score'>,
  answer: Answer | undefined
): ContractEvaluationResult {
  if (!answer) {
    return {
      contractId: contract.id,
      valid: false,
      type: contract.type,
      normalizedValue: 0,
      error: 'Missing answer for contract',
    };
  }

  if (contract.type === 'noul') {
    const parsed = NoulAnswerSchema.safeParse(answer);
    if (!parsed.success) {
      return { contractId: contract.id, valid: false, type: 'noul', normalizedValue: 0, error: 'Answer does not match NOUL schema' };
    }
    const val = Math.max(0, Math.min(1, parsed.data.noul));
    return {
      contractId: contract.id,
      valid: true,
      type: 'noul',
      normalizedValue: val,
      confidence: Math.abs(val - 0.5) * 2, // 0.0 at 0.5 (maximum uncertainty), 1.0 at 0 or 1
    };
  } else if (contract.type === 'choice') {
    const parsed = ChoiceAnswerSchema.safeParse(answer);
    if (!parsed.success) {
      return { contractId: contract.id, valid: false, type: 'choice', normalizedValue: '', error: 'Answer does not match CHOICE schema' };
    }
    const validChoices = Object.keys(contract.criteria);
    const isValidChoice = validChoices.includes(parsed.data.choice);
    return {
      contractId: contract.id,
      valid: isValidChoice,
      type: 'choice',
      normalizedValue: parsed.data.choice,
      confidence: Math.max(0, Math.min(1, parsed.data.confidence)),
      error: isValidChoice ? undefined : `Choice ${parsed.data.choice} not in valid options [${validChoices.join(', ')}]`,
    };
  } else {
    const parsed = ScoreAnswerSchema.safeParse(answer);
    if (!parsed.success) {
      return { contractId: contract.id, valid: false, type: 'score', normalizedValue: 0, error: 'Answer does not match SCORE schema' };
    }
    const score = parsed.data.score;
    const maxScore = (contract.criteria as string[]).length;
    const isValidScore = score >= 1 && score <= maxScore;
    return {
      contractId: contract.id,
      valid: isValidScore,
      type: 'score',
      normalizedValue: score,
      confidence: parsed.data.confidence ?? (score / maxScore),
      error: isValidScore ? undefined : `Score ${score} out of bounds [1..${maxScore}]`,
    };
  }
}
