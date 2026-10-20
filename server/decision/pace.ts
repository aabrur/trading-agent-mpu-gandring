import type { Stance } from '../types.js';

export type DebateMode = 'normal' | 'fast';

export function parseDebateMode(raw: string | undefined): DebateMode {
  // Default to fast execution unless normal is explicitly requested
  if (/^(normal|slow|full)$/i.test((raw ?? '').trim())) return 'normal';
  return 'fast';
}

export function rebuttalRounds(mode: DebateMode, configuredRounds: number, input: {
  market: Stance | null;
  research: Stance | null;
  strategist: Stance | null;
  researchVote: string;
}): number {
  const rounds = Math.max(1, configuredRounds);
  if (input.researchVote === 'VETO') return 0;

  const stances = [input.market, input.research, input.strategist].filter((s): s is Stance => !!s);
  const longs = stances.filter((s) => s === 'LONG').length;
  const shorts = stances.filter((s) => s === 'SHORT').length;

  // Immediate execution path: if at least 2 seats already align on LONG or SHORT with zero opposite directional votes, skip rebuttals!
  if ((longs >= 2 && shorts === 0) || (shorts >= 2 && longs === 0)) {
    return 0;
  }

  if (mode !== 'fast') return rounds;
  if (longs === 0 && shorts === 0) return 0;
  if (longs > 0 && shorts === 0) return 0;
  if (shorts > 0 && longs === 0) return 0;

  // Only run 1 fast tie-breaker rebuttal when analysts are actively opposing each other (LONG vs SHORT)
  return 1;
}