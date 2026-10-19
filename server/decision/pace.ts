import type { Stance } from '../types.js';

export type DebateMode = 'normal' | 'fast';

export function parseDebateMode(raw: string | undefined): DebateMode {
  return /^(fast)$/i.test((raw ?? '').trim()) ? 'fast' : 'normal';
}

export function rebuttalRounds(mode: DebateMode, configuredRounds: number, input: {
  market: Stance | null;
  research: Stance | null;
  strategist: Stance | null;
  researchVote: string;
}): number {
  const rounds = Math.max(1, configuredRounds);
  if (mode !== 'fast') return rounds;
  if (input.researchVote === 'VETO') return 0;
  const stances = [input.market, input.research, input.strategist].filter((s): s is Stance => !!s);
  const directional = stances.filter((s) => s === 'LONG' || s === 'SHORT');
  if (directional.length === 0) return 0;
  const first = directional[0];
  if (directional.every((s) => s === first)) return 0;
  return 1;
}
