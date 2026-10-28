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
  disagreement?: number;
  hasEvidenceConflict?: boolean;
}): number {
  const rounds = Math.max(1, configuredRounds);
  if (input.researchVote === 'VETO') return 0;

  const stances = [input.market, input.research, input.strategist].filter((s): s is Stance => !!s);
  const longs = stances.filter((s) => s === 'LONG').length;
  const shorts = stances.filter((s) => s === 'SHORT').length;

  if (mode !== 'fast') return rounds;
  if (longs === 0 && shorts === 0) return 0;

  const allAgree = (longs === 3 || shorts === 3) || (stances.length > 0 && (longs === stances.length || shorts === stances.length));
  const disagreement = input.disagreement ?? 0;
  const hasConflict = input.hasEvidenceConflict === true;
  if (allAgree && disagreement <= 0.05 && !hasConflict) {
    return 0;
  }

  // FAST keeps one targeted evidence challenge when material disagreement or evidence conflict exists.
  return 1;
}
