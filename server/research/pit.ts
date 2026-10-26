/**
 * Point-In-Time (PIT) Market Data Engine for Mpu Gandring.
 *
 * Guarantees zero lookahead bias for quantitative research and backtesting:
 * - Closed-Bar Strictness: An in-progress candlestick is never surfaced. Only candles with closedAt <= asOfMs are returned.
 * - Gap & Staleness Detection: Detects missing intervals and stale market data without fabricating fake numbers.
 * - Funding Rate Settlement Alignment: Tracks exact 8-hour or 1-hour settlement windows (00:00, 08:00, 16:00 UTC).
 */

export interface PITCandle {
  timestamp: number; // bar start timestamp in milliseconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closedAt: number; // exact bar close timestamp in milliseconds
}

export interface PITFundingRate {
  timestamp: number; // settlement timestamp in milliseconds (UTC)
  rate: number; // decimal rate (e.g. 0.0001 for 0.01%)
  intervalHours: number; // typically 8 hours (or 1 hour on select markets)
}

export type DataQualityStatus = 'OK' | 'STALE' | 'GAP_DETECTED' | 'EMPTY';

export interface PITFeedStatus {
  status: DataQualityStatus;
  lastClosedBarTime: number | null;
  gapCount: number;
  stalenessMs: number;
  totalBars: number;
  reason?: string;
}

export class PointInTimeFeed {
  private candles: PITCandle[] = [];
  private fundingRates: PITFundingRate[] = [];

  constructor(candles: PITCandle[] = [], fundingRates: PITFundingRate[] = []) {
    if (candles.length > 0) {
      this.loadCandles(candles);
    }
    if (fundingRates.length > 0) {
      this.loadFunding(fundingRates);
    }
  }

  /**
   * Loads and sorts candlestick bars by timestamp in ascending order.
   * Ensures closedAt is populated (defaults to timestamp + interval if omitted).
   */
  public loadCandles(candles: PITCandle[]): void {
    if (!Array.isArray(candles) || candles.length === 0) {
      this.candles = [];
      return;
    }

    const validated: PITCandle[] = [];
    for (const c of candles) {
      if (
        typeof c.timestamp === 'number' &&
        typeof c.open === 'number' &&
        typeof c.high === 'number' &&
        typeof c.low === 'number' &&
        typeof c.close === 'number' &&
        typeof c.volume === 'number'
      ) {
        validated.push({
          timestamp: c.timestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
          closedAt: typeof c.closedAt === 'number' ? c.closedAt : c.timestamp + 60_000,
        });
      }
    }

    validated.sort((a, b) => a.timestamp - b.timestamp);
    this.candles = validated;
  }

  /**
   * Loads and sorts funding rates by timestamp in ascending order.
   */
  public loadFunding(rates: PITFundingRate[]): void {
    if (!Array.isArray(rates)) {
      this.fundingRates = [];
      return;
    }
    const validated = rates.filter(
      r => typeof r.timestamp === 'number' && typeof r.rate === 'number'
    );
    validated.sort((a, b) => a.timestamp - b.timestamp);
    this.fundingRates = validated;
  }

  /**
   * Returns all candles strictly closed at or before asOfMs.
   * Never leaks the current open candle into the strategy context.
   */
  public asOf(asOfMs: number): PITCandle[] {
    if (this.candles.length === 0) return [];

    let left = 0;
    let right = this.candles.length - 1;
    let lastValidIdx = -1;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      if (this.candles[mid].closedAt <= asOfMs) {
        lastValidIdx = mid;
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }

    if (lastValidIdx === -1) return [];
    return this.candles.slice(0, lastValidIdx + 1);
  }

  /**
   * Retrieves the most recent closed candle at or before asOfMs.
   */
  public getLatestClosedBar(asOfMs: number): PITCandle | null {
    const available = this.asOf(asOfMs);
    if (available.length === 0) return null;
    return available[available.length - 1];
  }

  /**
   * Validates quality of data up to asOfMs: checks for time gaps and staleness.
   */
  public checkQuality(
    asOfMs: number,
    expectedIntervalMs: number = 60_000,
    maxAllowedStalenessMs: number = 300_000
  ): PITFeedStatus {
    const available = this.asOf(asOfMs);
    if (available.length === 0) {
      return {
        status: 'EMPTY',
        lastClosedBarTime: null,
        gapCount: 0,
        stalenessMs: 0,
        totalBars: 0,
        reason: 'No closed bars available for the given timestamp.',
      };
    }

    const lastBar = available[available.length - 1];
    const stalenessMs = Math.max(0, asOfMs - lastBar.closedAt);

    let gapCount = 0;
    for (let i = 1; i < available.length; i++) {
      const prev = available[i - 1];
      const curr = available[i];
      const delta = curr.timestamp - prev.timestamp;
      // Allow minor jitter, flag if missing more than 1.5x expected interval
      if (delta > expectedIntervalMs * 1.5) {
        gapCount++;
      }
    }

    if (gapCount > 0) {
      return {
        status: 'GAP_DETECTED',
        lastClosedBarTime: lastBar.closedAt,
        gapCount,
        stalenessMs,
        totalBars: available.length,
        reason: `Detected ${gapCount} interval gaps in candle stream.`,
      };
    }

    if (stalenessMs > maxAllowedStalenessMs) {
      return {
        status: 'STALE',
        lastClosedBarTime: lastBar.closedAt,
        gapCount: 0,
        stalenessMs,
        totalBars: available.length,
        reason: `Latest closed bar is stale by ${Math.round(stalenessMs / 1000)} seconds.`,
      };
    }

    return {
      status: 'OK',
      lastClosedBarTime: lastBar.closedAt,
      gapCount: 0,
      stalenessMs,
      totalBars: available.length,
    };
  }

  /**
   * Returns the funding rate active at or immediately prior to asOfMs.
   */
  public getFundingRateAt(asOfMs: number): PITFundingRate | null {
    if (this.fundingRates.length === 0) return null;

    let left = 0;
    let right = this.fundingRates.length - 1;
    let lastValidIdx = -1;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      if (this.fundingRates[mid].timestamp <= asOfMs) {
        lastValidIdx = mid;
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }

    if (lastValidIdx === -1) return null;
    return this.fundingRates[lastValidIdx];
  }

  /**
   * Helper: tests if timestamp falls exactly on an 8-hour funding settlement window (00:00, 08:00, 16:00 UTC).
   */
  public static isFundingSettlementWindow(timestampMs: number, intervalHours: number = 8): boolean {
    const date = new Date(timestampMs);
    const hour = date.getUTCHours();
    const minute = date.getUTCMinutes();
    const second = date.getUTCSeconds();
    return minute === 0 && second === 0 && hour % intervalHours === 0;
  }
}
