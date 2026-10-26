import { describe, expect, it } from 'vitest';
import {
  STANDARD_CONTRACTS,
  contractToQuestion,
  evaluateContract,
} from '../server/decision/jev-contracts.js';

describe('Jev Typed Contracts (Choice, NOUL, Score)', () => {
  it('defines standard contracts covering market regime, news, whale, score, and conflict', () => {
    expect(STANDARD_CONTRACTS.market_regime.type).toBe('choice');
    expect(STANDARD_CONTRACTS.news_relevance.type).toBe('noul');
    expect(STANDARD_CONTRACTS.whale_significance.type).toBe('noul');
    expect(STANDARD_CONTRACTS.setup_quality_score.type).toBe('score');
    expect(STANDARD_CONTRACTS.material_conflict.type).toBe('noul');
  });

  it('converts contract definitions to valid Jev Question schemas', () => {
    const noulQ = contractToQuestion(STANDARD_CONTRACTS.news_relevance);
    expect(noulQ.type).toBe('noul');
    expect(noulQ.instructions).toBeDefined();

    const choiceQ = contractToQuestion(STANDARD_CONTRACTS.market_regime);
    expect(choiceQ.type).toBe('choice');
    expect(choiceQ.criteria).toHaveProperty('TREND_UP');

    const scoreQ = contractToQuestion(STANDARD_CONTRACTS.setup_quality_score);
    expect(scoreQ.type).toBe('score');
    expect(scoreQ.criteria.length).toBe(5);
  });

  it('evaluates NOUL answers accurately and calculates confidence', () => {
    const contract = STANDARD_CONTRACTS.news_relevance;

    const validAnswer = { type: 'noul' as const, noul: 0.85 };
    const res = evaluateContract(contract, validAnswer);
    expect(res.valid).toBe(true);
    expect(res.normalizedValue).toBe(0.85);
    expect(res.confidence).toBeCloseTo(0.7, 2);

    const invalidAnswer = { type: 'choice' as const, choice: 'YES', probabilities: {}, confidence: 1 };
    const badRes = evaluateContract(contract, invalidAnswer as any);
    expect(badRes.valid).toBe(false);
    expect(badRes.error).toContain('does not match NOUL schema');
  });

  it('evaluates CHOICE answers and validates against allowed options', () => {
    const contract = STANDARD_CONTRACTS.market_regime;

    const validChoice = { type: 'choice' as const, choice: 'TREND_UP', probabilities: { TREND_UP: 0.8 }, confidence: 0.8 };
    const res = evaluateContract(contract, validChoice);
    expect(res.valid).toBe(true);
    expect(res.normalizedValue).toBe('TREND_UP');
    expect(res.confidence).toBe(0.8);

    const illegalChoice = { type: 'choice' as const, choice: 'SUPER_MOON', probabilities: {}, confidence: 0.9 };
    const badRes = evaluateContract(contract, illegalChoice);
    expect(badRes.valid).toBe(false);
    expect(badRes.error).toContain('not in valid options');
  });

  it('evaluates SCORE answers and bounds checks the rank', () => {
    const contract = STANDARD_CONTRACTS.setup_quality_score;

    const validScore = { type: 'score' as const, score: 4 };
    const res = evaluateContract(contract, validScore);
    expect(res.valid).toBe(true);
    expect(res.normalizedValue).toBe(4);

    const outOfBounds = { type: 'score' as const, score: 7 };
    const badRes = evaluateContract(contract, outOfBounds);
    expect(badRes.valid).toBe(false);
    expect(badRes.error).toContain('out of bounds');
  });
});
