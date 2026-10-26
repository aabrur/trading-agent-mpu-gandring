import { describe, expect, it } from 'vitest';
import {
  computeDisagreement,
  detectFightingPairs,
  conductAdversarialDebate,
  type DebaterPitch,
} from '../server/decision/adversarial-debate.js';

describe('Bull-Bear Adversarial Debate Engine', () => {
  it('computes low disagreement when debaters are aligned on Bullish stance', () => {
    const pitches: DebaterPitch[] = [
      { agent: 'market', name: 'Market Analyst', stance: 'LONG', confidence: 0.8, argument: 'Strong breakout' },
      { agent: 'research', name: 'Research Analyst', stance: 'LONG', confidence: 0.7, argument: 'Catalyst confirmed' },
      { agent: 'strategist', name: 'Strategist', stance: 'LONG', confidence: 0.9, argument: 'Alpha factors positive' },
    ];

    const { disagreement, weightedScore } = computeDisagreement(pitches);
    expect(disagreement).toBe(0);
    expect(weightedScore).toBe(1);

    const result = conductAdversarialDebate('BTCUSDT', pitches);
    expect(result.consensus).toBe('BULL_CONSENSUS');
    expect(result.recommendedAction).toBe('OPEN_LONG');
    expect(result.clashDetected).toBe(false);
    expect(result.fightingPairs.length).toBe(0);
  });

  it('triggers fight events and punches when debaters directly clash (LONG vs SHORT)', () => {
    const pitches: DebaterPitch[] = [
      { agent: 'market', name: 'Market Analyst', stance: 'LONG', confidence: 0.85, argument: 'Breakout above swing high' },
      { agent: 'research', name: 'Research Analyst', stance: 'SHORT', confidence: 0.85, argument: 'Massive exchange inflow' },
    ];

    const { disagreement } = computeDisagreement(pitches);
    expect(disagreement).toBeGreaterThan(0.5);

    const fightingPairs = detectFightingPairs(pitches, 0.35);
    expect(fightingPairs.length).toBe(2); // Each challenges the other

    const marketPunch = fightingPairs.find(f => f.attacker === 'market');
    expect(marketPunch).toBeDefined();
    expect(marketPunch?.defender).toBe('research');
    expect(marketPunch?.punches).toBeGreaterThanOrEqual(1);
    expect(marketPunch?.punches).toBeLessThanOrEqual(4);
    expect(marketPunch?.challenge).toContain('Bullish conviction');

    const researchPunch = fightingPairs.find(f => f.attacker === 'research');
    expect(researchPunch).toBeDefined();
    expect(researchPunch?.defender).toBe('market');
    expect(researchPunch?.challenge).toContain('Bearish structure');
  });

  it('declares UNRESOLVED_BRAWL and safe HOLD when severe polarization cannot be reconciled', () => {
    const pitches: DebaterPitch[] = [
      { agent: 'market', name: 'Market Analyst', stance: 'LONG', confidence: 0.9, argument: 'Bull momentum' },
      { agent: 'research', name: 'Research Analyst', stance: 'SHORT', confidence: 0.9, argument: 'Bear distribution' },
    ];

    const result = conductAdversarialDebate('ETHUSDT', pitches, 0.35);
    expect(result.clashDetected).toBe(true);
    expect(result.consensus).toBe('UNRESOLVED_BRAWL');
    expect(result.recommendedAction).toBe('HOLD');
    expect(result.synthesisReason).toContain('Severe adversarial brawl');
  });

  it('recommends OPEN_SHORT when Bear conviction dominates despite minor objection', () => {
    const pitches: DebaterPitch[] = [
      { agent: 'market', name: 'Market Analyst', stance: 'SHORT', confidence: 0.85, argument: 'Trend breakdown' },
      { agent: 'research', name: 'Research Analyst', stance: 'SHORT', confidence: 0.80, argument: 'Fierce macro headwinds' },
      { agent: 'strategist', name: 'Strategist', stance: 'NEUTRAL', confidence: 0.20, argument: 'Uncertain' },
    ];

    const result = conductAdversarialDebate('SOLUSDT', pitches);
    expect(result.consensus).toBe('BEAR_CONSENSUS');
    expect(result.recommendedAction).toBe('OPEN_SHORT');
    expect(result.weightedScore).toBeLessThan(-0.4);
  });
});
