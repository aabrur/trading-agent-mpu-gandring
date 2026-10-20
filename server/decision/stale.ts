import type { MarketSnapshot } from '../types.js';
import { strategyVote, type RuleVote } from '../strategy.js';

export interface RevalidateInput {
  original: MarketSnapshot;
  originalRule: RuleVote;
  side: 'LONG' | 'SHORT';
  now?: number;
  fresh: MarketSnapshot;
}

export interface RevalidateResult {
  ok: boolean;
  reason: string | null;
  quote: number;
  rule: RuleVote;
  usedFreshSnapshot: boolean;
}

export function snapshotIsFresh(snap: MarketSnapshot, now = Date.now(), maxAgeMs = 30_000): boolean {
  return Number.isFinite(snap.fetchedAt) && now - snap.fetchedAt <= maxAgeMs;
}

export function revalidateEntry(input: RevalidateInput): RevalidateResult {
  const quote = input.side === 'LONG'
    ? (input.fresh.ask ?? input.fresh.last)
    : (input.fresh.bid ?? input.fresh.last);
  const rule = strategyVote(input.fresh.candles);
  const usedFreshSnapshot = input.fresh.fetchedAt !== input.original.fetchedAt;

  if (!(quote > 0) || !Number.isFinite(quote)) {
    return { ok: false, reason: 'Execution quote unavailable after revalidation.', quote: 0, rule, usedFreshSnapshot };
  }
  if (input.fresh.example && !input.original.example) {
    return { ok: false, reason: 'Fresh market data fell back to sample data.', quote, rule, usedFreshSnapshot };
  }

  // Only abort if the closed-bar rule actively flipped to the OPPOSITE directional side (e.g., LONG flipped to SHORT).
  // Do NOT abort if the bar merely paused into ABSTAIN while whale/news/momentum consensus remains valid.
  const oppositeSide = input.side === 'LONG' ? 'SHORT' : 'LONG';
  if (rule.side === oppositeSide && rule.side !== input.originalRule.side) {
    return {
      ok: false,
      reason: `Hard reversal detected: closed-bar rule flipped to opposite side (${rule.side}).`,
      quote,
      rule,
      usedFreshSnapshot
    };
  }

  return { ok: true, reason: null, quote, rule, usedFreshSnapshot };
}