import type { MarketSnapshot } from '../types.js';
import { strategyVote, type RuleVote } from '../strategy.js';
import { snapshotMomentum } from './debate-evidence.js';

export interface RevalidateInput {
  original: MarketSnapshot;
  originalRule: RuleVote;
  side: 'LONG' | 'SHORT';
  now?: number;
  fresh: MarketSnapshot;
  entryZone?: { low: number; high: number; basis: string } | null;
  invalidationLevel?: number | null;
  executionQuote?: number;
  expectedVenue?: string | null;
  tradingMode?: 'PAPER' | 'TESTNET' | 'LIVE';
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
  const quote = input.executionQuote ?? (input.side === 'LONG'
    ? (input.fresh.ask ?? input.fresh.last)
    : (input.fresh.bid ?? input.fresh.last));
  const rule = strategyVote(input.fresh.candles, { orderflow: snapshotMomentum(input.fresh).flowVerified ? input.fresh.orderflow : undefined });
  const usedFreshSnapshot = input.fresh.fetchedAt !== input.original.fetchedAt;

  if (!(quote > 0) || !Number.isFinite(quote)) {
    return { ok: false, reason: 'Execution quote unavailable after revalidation.', quote: 0, rule, usedFreshSnapshot };
  }
  if (input.fresh.example && !input.original.example) {
    return { ok: false, reason: 'Fresh market data fell back to sample data.', quote, rule, usedFreshSnapshot };
  }
  if (input.tradingMode && input.tradingMode !== 'PAPER' && input.fresh.example) {
    return { ok: false, reason: 'Sample market data cannot authorize an exchange entry.', quote, rule, usedFreshSnapshot };
  }
  if (input.expectedVenue && input.tradingMode !== 'PAPER' && input.fresh.source !== input.expectedVenue) {
    return { ok: false, reason: `Market source conflict: ${input.fresh.source} data differs from execution venue ${input.expectedVenue}.`, quote, rule, usedFreshSnapshot };
  }
  if (input.entryZone !== undefined) {
    const zone = input.entryZone;
    const invalidation = input.invalidationLevel;
    if (!zone || ![zone.low, zone.high].every(value => Number.isFinite(value) && value > 0) || zone.low > zone.high || !zone.basis.trim()) {
      return { ok: false, reason: 'Binding entry zone is unavailable or invalid.', quote, rule, usedFreshSnapshot };
    }
    if (quote < zone.low || quote > zone.high) {
      return { ok: false, reason: 'Execution quote is outside the binding entry zone; wait for the setup pullback or retest.', quote, rule, usedFreshSnapshot };
    }
    if (invalidation == null || !Number.isFinite(invalidation) || invalidation <= 0 || (input.side === 'LONG' ? invalidation >= Math.min(quote, zone.low) : invalidation <= Math.max(quote, zone.high))) {
      return { ok: false, reason: 'Structural invalidation must remain strictly beyond the entry in the proposed loss direction.', quote, rule, usedFreshSnapshot };
    }
    const exhaustion = input.fresh.tacticalTradePlan?.exhaustion;
    if (exhaustion?.present && exhaustion.direction === (input.side === 'LONG' ? 'BUYER' : 'SELLER')) {
      return { ok: false, reason: 'Confirmed tactical exhaustion opposes entry at the current quote.', quote, rule, usedFreshSnapshot };
    }
  }
  const momentum = snapshotMomentum(input.fresh), sign = input.side === 'LONG' ? 1 : -1;
  const opposingMomentum = [momentum.change5Pct, momentum.roc5].some(value => value != null && Number.isFinite(value) && value * sign < 0);
  const opposingFlow = momentum.flowVerified && ((momentum.cvdDelta != null && momentum.cvdDelta * sign < 0) || (momentum.buySellRatio != null && (momentum.buySellRatio - 1) * sign < 0));
  if (opposingMomentum || opposingFlow) {
    return { ok: false, reason: 'Measured momentum or authenticated order flow opposes the proposed entry direction.', quote, rule, usedFreshSnapshot };
  }

  // Only abort if the closed-bar rule actively flipped to the OPPOSITE directional side (e.g., LONG flipped to SHORT).
  // Do NOT abort if the bar merely paused into ABSTAIN while whale/news/momentum consensus remains valid.
  const oppositeSide = input.side === 'LONG' ? 'SHORT' : 'LONG';
  if (input.entryZone === undefined && rule.side === oppositeSide && rule.side !== input.originalRule.side) {
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
