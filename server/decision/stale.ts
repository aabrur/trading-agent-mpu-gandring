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

export function snapshotIsFresh(snap: MarketSnapshot, now = Date.now(), maxAgeMs = 15_000): boolean {
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
  if (rule.side !== input.side && rule.side !== 'ABSTAIN' && rule.side !== input.originalRule.side) {
    return { ok: false, reason: `Stale signal: closed-bar rule flipped from ${input.originalRule.side} to ${rule.side}.`, quote, rule, usedFreshSnapshot };
  }
  if (input.originalRule.side === input.side && rule.side === 'ABSTAIN') {
    return { ok: false, reason: `Stale signal: original ${input.side} thesis is no longer present on closed bars.`, quote, rule, usedFreshSnapshot };
  }
  return { ok: true, reason: null, quote, rule, usedFreshSnapshot };
}
