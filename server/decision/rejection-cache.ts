/**
 * Candidate Rejection Reason TTL Cache for Mpu Gandring.
 *
 * Caches scan rejection verdicts to eliminate redundant LLM calls on dead setups:
 * - Configurable Time-To-Live (default 15 minutes).
 * - Price breakout invalidation: if price moves beyond a threshold (default 2%),
 *   the cached rejection is immediately invalidated so breakout moves are not missed.
 * - Explicit owner command override: manual analysis bypasses cached rejections.
 */

export interface RejectionRecord {
  symbol: string;
  reasonCode: string;
  reasonDetail: string;
  rejectedAt: number;
  expiresAt: number;
  priceAtRejection: number;
  invalidationThresholdPct: number;
}

export class CandidateRejectionCache {
  private cache = new Map<string, RejectionRecord>();
  private defaultTtlMs: number;
  private defaultInvalidationPct: number;

  constructor(defaultTtlMs: number = 15 * 60_000, defaultInvalidationPct: number = 2.0) {
    this.defaultTtlMs = defaultTtlMs;
    this.defaultInvalidationPct = defaultInvalidationPct;
  }

  /**
   * Caches a candidate rejection for a symbol.
   */
  public reject(
    symbol: string,
    reasonCode: string,
    reasonDetail: string,
    priceAtRejection: number,
    ttlMs?: number,
    invalidationPct?: number,
    now: number = Date.now()
  ): RejectionRecord {
    const sym = symbol.toUpperCase().trim();
    const duration = ttlMs ?? this.defaultTtlMs;
    const invalidationThresholdPct = invalidationPct ?? this.defaultInvalidationPct;

    const record: RejectionRecord = {
      symbol: sym,
      reasonCode,
      reasonDetail,
      rejectedAt: now,
      expiresAt: now + duration,
      priceAtRejection,
      invalidationThresholdPct,
    };

    this.cache.set(sym, record);
    return record;
  }

  /**
   * Checks whether a symbol has an active cached rejection.
   * If currentPrice is provided, evaluates whether a breakout has invalidated the cache.
   */
  public isRejected(symbol: string, currentPrice?: number, now: number = Date.now()): boolean {
    const sym = symbol.toUpperCase().trim();
    const record = this.cache.get(sym);
    if (!record) return false;

    // Check expiration
    if (now >= record.expiresAt) {
      this.cache.delete(sym);
      return false;
    }

    // Check price invalidation threshold if current price is supplied
    if (typeof currentPrice === 'number' && currentPrice > 0 && record.priceAtRejection > 0) {
      const priceDeltaPct = Math.abs((currentPrice - record.priceAtRejection) / record.priceAtRejection) * 100;
      if (priceDeltaPct >= record.invalidationThresholdPct) {
        // Price has moved sufficiently to invalidate the previous rejection thesis
        this.cache.delete(sym);
        return false;
      }
    }

    return true;
  }

  /**
   * Retrieves active rejection details if present.
   */
  public getRejection(symbol: string, now: number = Date.now()): RejectionRecord | null {
    const sym = symbol.toUpperCase().trim();
    const record = this.cache.get(sym);
    if (!record) return null;

    if (now >= record.expiresAt) {
      this.cache.delete(sym);
      return null;
    }

    return record;
  }

  /**
   * Explicitly clears rejection for a symbol (e.g. on manual owner request).
   */
  public invalidate(symbol: string): boolean {
    return this.cache.delete(symbol.toUpperCase().trim());
  }

  /**
   * Purges all expired entries.
   */
  public purgeExpired(now: number = Date.now()): number {
    let purged = 0;
    for (const [sym, record] of this.cache.entries()) {
      if (now >= record.expiresAt) {
        this.cache.delete(sym);
        purged++;
      }
    }
    return purged;
  }

  /**
   * Returns total count of cached rejections.
   */
  public size(): number {
    return this.cache.size;
  }

  /**
   * Returns diagnostic summary breakdown by reason code.
   */
  public stats(now: number = Date.now()): { total: number; byReason: Record<string, number> } {
    this.purgeExpired(now);
    const byReason: Record<string, number> = {};
    for (const record of this.cache.values()) {
      byReason[record.reasonCode] = (byReason[record.reasonCode] ?? 0) + 1;
    }
    return {
      total: this.cache.size,
      byReason,
    };
  }

  /**
   * Clears entire cache.
   */
  public clear(): void {
    this.cache.clear();
  }
}
