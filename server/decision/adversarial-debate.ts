/**
 * Adversarial Bull vs Bear Debate Engine for Mpu Gandring.
 *
 * Clean-room TypeScript implementation inspired by TauricResearch/TradingAgents:
 * - Structured adversarial clashes between opposing market perspectives.
 * - Disagreement metrics measuring polarization and conviction delta.
 * - Dynamic fight detection triggering physical sprite punch events and heated dialogue.
 * - Synthesis of conflicting arguments into high-conviction verdicts or safe HOLD.
 */

import type { AgentId, Stance, Action } from '../types.js';

export interface DebaterPitch {
  agent: AgentId;
  name: string;
  stance: Stance;
  confidence: number; // 0.0 to 1.0
  argument: string;
  archetype?: string;
  keyLevel?: number;
}

export interface FightingPair {
  attacker: AgentId;
  defender: AgentId;
  intensity: number; // 0.0 to 1.0
  punches: number; // 1 to 4
  challenge: string;
}

export type AdversarialConsensus = 'BULL_CONSENSUS' | 'BEAR_CONSENSUS' | 'UNRESOLVED_BRAWL' | 'DIVIDED_TAPE';

export interface AdversarialDebateResult {
  symbol: string;
  timestamp: number;
  disagreement: number; // 0.0 to 1.0
  clashDetected: boolean;
  fightingPairs: FightingPair[];
  consensus: AdversarialConsensus;
  recommendedAction: Action;
  weightedScore: number; // -1.0 (strong short) to +1.0 (strong long)
  synthesisReason: string;
}

function stanceWeight(s: Stance): number {
  if (s === 'LONG') return 1;
  if (s === 'SHORT') return -1;
  return 0;
}

/**
 * Calculates quantitative polarization and conviction disagreement among debater pitches.
 */
export function computeDisagreement(pitches: DebaterPitch[]): { disagreement: number; weightedScore: number } {
  if (pitches.length === 0) return { disagreement: 0, weightedScore: 0 };

  let totalWeight = 0;
  let bullSum = 0;
  let bearSum = 0;
  let neutralSum = 0;

  for (const p of pitches) {
    const weight = Math.max(0.1, Math.min(1.0, p.confidence));
    totalWeight += weight;

    if (p.stance === 'LONG') bullSum += weight;
    else if (p.stance === 'SHORT') bearSum += weight;
    else neutralSum += weight;
  }

  if (totalWeight === 0) return { disagreement: 0, weightedScore: 0 };

  const bullRatio = bullSum / totalWeight;
  const bearRatio = bearSum / totalWeight;
  const weightedScore = (bullSum - bearSum) / totalWeight;

  // Polarization: maximum when 50% bull and 50% bear
  // 4 * bullRatio * bearRatio peaks at 1.0 when bullRatio == bearRatio == 0.5
  const polarization = 4 * bullRatio * bearRatio;

  // Add variance penalty if confidence is high on both sides
  const disagreement = Number(Math.min(1.0, polarization).toFixed(3));

  return { disagreement, weightedScore: Number(weightedScore.toFixed(3)) };
}

/**
 * Detects adversarial clashes and generates fighting pairs when disagreement exceeds threshold.
 */
export function detectFightingPairs(
  pitches: DebaterPitch[],
  fightThreshold: number = 0.35
): FightingPair[] {
  const { disagreement } = computeDisagreement(pitches);
  if (disagreement < fightThreshold) return [];

  const pairs: FightingPair[] = [];

  // Find opposing stances (LONG vs SHORT)
  for (let i = 0; i < pitches.length; i++) {
    for (let j = 0; j < pitches.length; j++) {
      if (i === j) continue;
      const p1 = pitches[i];
      const p2 = pitches[j];

      // Clash occurs when stances directly oppose each other
      if (stanceWeight(p1.stance) * stanceWeight(p2.stance) < 0) {
        const intensity = Math.min(1.0, Number((disagreement * (p1.confidence + p2.confidence) / 2).toFixed(3)));
        const punches = 1 + Math.round(intensity * 3); // 1 to 4 punches

        const challenge = p1.stance === 'LONG'
          ? `Bullish conviction on tape rejects ${p2.name}'s short bias! Liquidity absorbs your bids.`
          : `Bearish structure invalidates ${p2.name}'s breakout! You are buying straight into overhead supply.`;

        pairs.push({
          attacker: p1.agent,
          defender: p2.agent,
          intensity,
          punches,
          challenge,
        });
      }
    }
  }

  return pairs;
}

/**
 * Conducts complete adversarial debate synthesis.
 */
export function conductAdversarialDebate(
  symbol: string,
  pitches: DebaterPitch[],
  fightThreshold: number = 0.35
): AdversarialDebateResult {
  const { disagreement, weightedScore } = computeDisagreement(pitches);
  const fightingPairs = detectFightingPairs(pitches, fightThreshold);
  const clashDetected = fightingPairs.length > 0;

  let consensus: AdversarialConsensus;
  let recommendedAction: Action;
  let synthesisReason: string;

  if (clashDetected && disagreement >= 0.60) {
    consensus = 'UNRESOLVED_BRAWL';
    recommendedAction = 'HOLD';
    synthesisReason = `Severe adversarial brawl between opposing camps (disagreement ${disagreement.toFixed(2)}). Capital preservation rules mandate safe HOLD until structure clarifies.`;
  } else if (weightedScore >= 0.40) {
    consensus = 'BULL_CONSENSUS';
    recommendedAction = 'OPEN_LONG';
    synthesisReason = `Bullish thesis prevailed through adversarial debate (weighted score +${weightedScore.toFixed(2)}). Long expansion supported with acceptable contention.`;
  } else if (weightedScore <= -0.40) {
    consensus = 'BEAR_CONSENSUS';
    recommendedAction = 'OPEN_SHORT';
    synthesisReason = `Bearish thesis prevailed through adversarial debate (weighted score ${weightedScore.toFixed(2)}). Short distribution confirmed against counter-arguments.`;
  } else {
    consensus = 'DIVIDED_TAPE';
    recommendedAction = 'HOLD';
    synthesisReason = `Debaters divided or neutral (score ${weightedScore.toFixed(2)}, disagreement ${disagreement.toFixed(2)}). Insufficient conviction edge for directional commitment.`;
  }

  return {
    symbol,
    timestamp: Date.now(),
    disagreement,
    clashDetected,
    fightingPairs,
    consensus,
    recommendedAction,
    weightedScore,
    synthesisReason,
  };
}
