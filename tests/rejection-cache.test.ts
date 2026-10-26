import { describe, expect, it } from 'vitest';
import { CandidateRejectionCache } from '../server/decision/rejection-cache.js';

describe('Candidate Rejection Reason TTL Cache', () => {
  it('caches rejection verdicts and honors active TTL duration', () => {
    const cache = new CandidateRejectionCache(60_000, 2.0); // 1 minute TTL
    const now = 1_000_000;

    cache.reject('BTCUSDT', 'RISK_GATE_VETO', 'Stop loss wider than 3% cap', 100, 60_000, 2.0, now);

    // Active immediately
    expect(cache.isRejected('BTCUSDT', 100, now)).toBe(true);
    expect(cache.getRejection('BTCUSDT', now)?.reasonCode).toBe('RISK_GATE_VETO');

    // Still active at +30s
    expect(cache.isRejected('BTCUSDT', 100, now + 30_000)).toBe(true);

    // Expired at +61s
    expect(cache.isRejected('BTCUSDT', 100, now + 61_000)).toBe(false);
    expect(cache.getRejection('BTCUSDT', now + 61_000)).toBeNull();
  });

  it('invalidates cached rejection when price breaks out beyond threshold', () => {
    const cache = new CandidateRejectionCache(60_000, 2.0); // 2% invalidation threshold
    const now = 1_000_000;

    cache.reject('ETHUSDT', 'ADVERSE_REGIME', 'High chop in consolidation', 2000, 60_000, 2.0, now);

    // Minor fluctuation within 2% (e.g. 1.0% to 2020) preserves cache
    expect(cache.isRejected('ETHUSDT', 2020, now + 5_000)).toBe(true);

    // Breakout move > 2% (e.g. +2.5% to 2050) invalidates the rejection thesis!
    expect(cache.isRejected('ETHUSDT', 2050, now + 10_000)).toBe(false);
    // Verified that entry was deleted from cache
    expect(cache.getRejection('ETHUSDT')).toBeNull();
  });

  it('supports manual invalidation and reason code stats breakdown', () => {
    const cache = new CandidateRejectionCache();
    cache.reject('SOLUSDT', 'LOW_RR', 'Risk reward below 1.5', 100);
    cache.reject('BNBUSDT', 'CAPACITY_FULL', 'Max N positions in use', 500);
    cache.reject('ADAUSDT', 'LOW_RR', 'Risk reward below 1.5', 0.5);

    expect(cache.size()).toBe(3);
    const stats = cache.stats();
    expect(stats.total).toBe(3);
    expect(stats.byReason.LOW_RR).toBe(2);
    expect(stats.byReason.CAPACITY_FULL).toBe(1);

    // Manual override
    expect(cache.invalidate('SOLUSDT')).toBe(true);
    expect(cache.size()).toBe(2);
    expect(cache.isRejected('SOLUSDT')).toBe(false);
  });
});
