import type { MarketSnapshot } from '../types.js';
import { strategyVote, type RuleVote } from '../strategy.js';
import { snapshotMomentum, isRecognizedReferenceMarket } from './debate-evidence.js';

export interface RevalidateInput {
  aiApproved?: boolean;
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
  return Number.isFinite(snap.fetchedAt) && snap.fetchedAt <= now + 5000 && now - snap.fetchedAt <= maxAgeMs;
}

export function revalidateEntry(input: RevalidateInput): RevalidateResult {
  const now = input.now ?? Date.now();
  const rule = strategyVote(input.fresh.candles, { orderflow: snapshotMomentum(input.fresh).flowVerified ? input.fresh.orderflow : undefined });
  const usedFreshSnapshot = input.fresh.fetchedAt !== input.original.fetchedAt;

  if (!snapshotIsFresh(input.fresh, now)) {
    return {
      ok: false,
      reason: `Fresh market snapshot is stale (${Math.max(0, Math.round((now - input.fresh.fetchedAt) / 1000))}s old; max 30s).`,
      quote: 0,
      rule,
      usedFreshSnapshot
    };
  }

  const isCrossVenue = Boolean(input.expectedVenue && input.tradingMode !== 'PAPER' && input.fresh.source.toLowerCase() !== input.expectedVenue.toLowerCase());
  if (isCrossVenue && !isRecognizedReferenceMarket(input.fresh.source, input.expectedVenue)) {
    return { ok: false, reason: `Market source conflict: reference source ${input.fresh.source} does not match execution venue ${input.expectedVenue}.`, quote: 0, rule, usedFreshSnapshot };
  }
  if (input.expectedVenue && input.tradingMode !== 'PAPER' && (input.executionQuote == null || !(input.executionQuote > 0) || !Number.isFinite(input.executionQuote))) {
    return { ok: false, reason: `Execution-native quote is required for cross-venue execution on ${input.expectedVenue}.`, quote: 0, rule, usedFreshSnapshot };
  }

  const quote = input.executionQuote ?? (input.side === 'LONG'
    ? (input.fresh.ask ?? input.fresh.last)
    : (input.fresh.bid ?? input.fresh.last));

  if (!(quote > 0) || !Number.isFinite(quote)) {
    return { ok: false, reason: 'Execution quote unavailable after revalidation.', quote: 0, rule, usedFreshSnapshot };
  }
  if (input.fresh.example && !input.original.example) {
    return { ok: false, reason: 'Fresh market data fell back to sample data.', quote, rule, usedFreshSnapshot };
  }
  if (input.tradingMode && input.tradingMode !== 'PAPER' && input.fresh.example) {
    return { ok: false, reason: 'Sample market data cannot authorize an exchange entry.', quote, rule, usedFreshSnapshot };
  }
  if (!input.aiApproved && input.entryZone !== undefined) {
    const zone = input.entryZone;
    const invalidation = input.invalidationLevel;
    if (!zone || ![zone.low, zone.high].every(value => Number.isFinite(value) && value > 0) || zone.low > zone.high || !zone.basis.trim()) {
      return { ok: false, reason: 'Structural entry recommendation is unavailable or invalid.', quote, rule, usedFreshSnapshot };
    }
    // Advisory zone deviation is analysis. Only an explicit Owner LIMIT_GTC
    // ticket binds an entry price, enforced by the shared executor and adapter.
    if (invalidation == null || !Number.isFinite(invalidation) || invalidation <= 0 || (input.side === 'LONG' ? invalidation >= Math.min(quote, zone.low) : invalidation <= Math.max(quote, zone.high))) {
      return { ok: false, reason: 'Structural invalidation must remain strictly beyond the entry in the proposed loss direction.', quote, rule, usedFreshSnapshot };
    }
    const exhaustion = input.fresh.tacticalTradePlan?.exhaustion;
    if (exhaustion?.present && exhaustion.direction === (input.side === 'LONG' ? 'BUYER' : 'SELLER')) {
      return { ok: false, reason: 'Confirmed tactical exhaustion opposes entry at the current quote.', quote, rule, usedFreshSnapshot };
    }
  }
  if (input.expectedVenue && input.tradingMode !== 'PAPER') {
    if (input.executionQuote !== undefined && (!(input.executionQuote > 0) || !Number.isFinite(input.executionQuote))) {
      return { ok: false, reason: 'Execution-native quote unavailable for execution venue.', quote: 0, rule, usedFreshSnapshot };
    }
    if (input.fresh.source !== input.expectedVenue && input.fresh.last > 0 && quote > 0) {
      const divergence = Math.abs(quote - input.fresh.last) / input.fresh.last;
      if (divergence > 0.05) {
        return { ok: false, reason: `Execution quote ${quote} diverges by ${(divergence * 100).toFixed(1)}% from reference market price ${input.fresh.last}.`, quote, rule, usedFreshSnapshot };
      }
    }
  }
  const momentum = snapshotMomentum(input.fresh), sign = input.side === 'LONG' ? 1 : -1;
  const opposingMomentum = [momentum.change5Pct, momentum.roc5].some(value => value != null && Number.isFinite(value) && value * sign < -0.05);
  const opposingFlow = momentum.flowVerified && ((momentum.cvdDelta != null && Math.abs(momentum.cvdDelta) >= 10 && momentum.cvdDelta * sign < 0) || (momentum.buySellRatio != null && Math.abs(momentum.buySellRatio - 1) >= 0.02 && (momentum.buySellRatio - 1) * sign < 0));
  if (!input.aiApproved && (opposingMomentum || opposingFlow)) {
    return { ok: false, reason: 'Measured momentum or authenticated order flow opposes the proposed entry direction.', quote, rule, usedFreshSnapshot };
  }

  // Only abort if the closed-bar rule actively flipped to the OPPOSITE directional side (e.g., LONG flipped to SHORT).
  // Do NOT abort if the bar merely paused into ABSTAIN while whale/news/momentum consensus remains valid.
  const oppositeSide = input.side === 'LONG' ? 'SHORT' : 'LONG';
  if (!input.aiApproved && input.entryZone === undefined && rule.side === oppositeSide && rule.side !== input.originalRule.side) {
    return {
      ok: false,
      reason: `Hard reversal detected: closed-bar rule flipped to opposite side (${rule.side}).`,
      quote,
      rule,
      usedFreshSnapshot
    };
  }

  if (input.invalidationLevel != null && (!(input.invalidationLevel > 0) || (input.side === 'LONG' ? input.invalidationLevel >= quote : input.invalidationLevel <= quote))) return { ok: false, reason: 'Structural invalidation is on the wrong side of the executable quote.', quote, rule, usedFreshSnapshot };
  return { ok: true, reason: null, quote, rule, usedFreshSnapshot };
}
