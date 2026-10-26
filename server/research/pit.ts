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

export type DataQualityStatus = 'OK' | 'STALE' | 'GAP_DETECTED' | 'INVALID_DATA' | 'EMPTY';

export interface PITFeedStatus {
  status: DataQualityStatus;
  lastClosedBarTime: number | null;
  gapCount: number;
  stalenessMs: number;
  totalBars: number;
  invalidRecordCount: number;
  reason?: string;
}

export class PointInTimeFeed {
  private candles: PITCandle[] = [];
  private fundingRates: PITFundingRate[] = [];
  private invalidRecordCount = 0;
  private invalidCandleCount = 0;
  private invalidFundingCount = 0;

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
      this.invalidCandleCount = 0;
      this.invalidRecordCount = this.invalidFundingCount;
      return;
    }

    const validated: PITCandle[] = [];
    let invalidCount = 0;
    const timestamps = new Set<number>();
    for (const c of candles) {
      const values = [c?.timestamp, c?.open, c?.high, c?.low, c?.close, c?.volume, c?.closedAt];
      const valid = values.every(value => typeof value === 'number' && Number.isFinite(value))
        && Number.isSafeInteger(c.timestamp)
        && Number.isSafeInteger(c.closedAt)
        && c.timestamp >= 0
        && c.closedAt > c.timestamp
        && c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0
        && c.volume >= 0
        && c.high >= Math.max(c.open, c.close, c.low)
        && c.low <= Math.min(c.open, c.close, c.high)
        && !timestamps.has(c.timestamp);
      if (valid) {
        timestamps.add(c.timestamp);
        validated.push({
          timestamp: c.timestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
          closedAt: c.closedAt,
        });
      } else {
        invalidCount++;
      }
    }

    validated.sort((a, b) => a.timestamp - b.timestamp);
    this.candles = [];
    for (const candle of validated) {
      const previous = this.candles[this.candles.length - 1];
      if (previous && candle.closedAt <= previous.closedAt) {
        invalidCount++;
      } else {
        this.candles.push(candle);
      }
    }
    this.invalidCandleCount = invalidCount;
    this.invalidRecordCount = this.invalidCandleCount + this.invalidFundingCount;
  }

  /**
   * Loads and sorts funding rates by timestamp in ascending order.
   */
  public loadFunding(rates: PITFundingRate[]): void {
    if (!Array.isArray(rates)) {
      this.fundingRates = [];
      this.invalidFundingCount = 0;
      this.invalidRecordCount = this.invalidCandleCount;
      return;
    }
    const seen = new Set<string>();
    const validated = rates.filter(r => {
      const valid = Number.isSafeInteger(r?.timestamp)
        && r.timestamp >= 0
        && Number.isFinite(r?.rate)
        && Number.isInteger(r?.intervalHours)
        && r.intervalHours > 0
        && r.intervalHours <= 24;
      if (!valid) return false;
      const key = `${r.intervalHours}:${r.timestamp}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    this.invalidFundingCount = rates.length - validated.length;
    this.invalidRecordCount = this.invalidCandleCount + this.invalidFundingCount;
    validated.sort((a, b) => a.timestamp - b.timestamp);
    this.fundingRates = validated;
  }

  /**
   * Returns all candles strictly closed at or before asOfMs.
   * Never leaks the current open candle into the strategy context.
   */
  public asOf(asOfMs: number): PITCandle[] {
    if (!Number.isSafeInteger(asOfMs) || this.candles.length === 0) return [];

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

  public pointInTimeView(asOfMs: number): PointInTimeFeed {
    const view = new PointInTimeFeed(this.asOf(asOfMs));
    view.loadFunding(this.fundingRates.filter(rate => rate.timestamp <= asOfMs));
    return view;
  }

  /**
   * Validates quality of data up to asOfMs: checks for time gaps and staleness.
   */
  public checkQuality(
    asOfMs: number,
    expectedIntervalMs: number = 60_000,
    maxAllowedStalenessMs: number = 300_000
  ): PITFeedStatus {
    if (!Number.isSafeInteger(asOfMs)) {
      return {
        status: 'INVALID_DATA', lastClosedBarTime: null, gapCount: 0, stalenessMs: 0,
        totalBars: 0, invalidRecordCount: 1, reason: 'Invalid feed as-of timestamp.',
      };
    }
    if (!Number.isFinite(expectedIntervalMs) || expectedIntervalMs <= 0
      || !Number.isFinite(maxAllowedStalenessMs) || maxAllowedStalenessMs < 0) {
      return {
        status: 'INVALID_DATA', lastClosedBarTime: null, gapCount: 0, stalenessMs: 0,
        totalBars: 0, invalidRecordCount: 1, reason: 'Invalid feed quality interval settings.',
      };
    }
    const available = this.asOf(asOfMs);
    if (available.length === 0) {
      return {
        status: this.invalidRecordCount > 0 ? 'INVALID_DATA' : 'EMPTY',
        lastClosedBarTime: null,
        gapCount: 0,
        stalenessMs: 0,
        totalBars: 0,
        invalidRecordCount: this.invalidRecordCount,
        reason: this.invalidRecordCount > 0
          ? `Rejected ${this.invalidRecordCount} invalid or duplicate market data record(s).`
          : 'No closed bars available for the given timestamp.',
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
        gapCount += Math.max(1, Math.floor(delta / expectedIntervalMs) - 1);
      }
    }

    if (this.invalidRecordCount > 0) {
      return {
        status: 'INVALID_DATA', lastClosedBarTime: lastBar.closedAt, gapCount,
        stalenessMs, totalBars: available.length, invalidRecordCount: this.invalidRecordCount,
        reason: `Rejected ${this.invalidRecordCount} invalid or duplicate market data record(s).`,
      };
    }

    if (gapCount > 0) {
      return {
        status: 'GAP_DETECTED',
        lastClosedBarTime: lastBar.closedAt,
        gapCount,
        stalenessMs,
        totalBars: available.length,
        invalidRecordCount: this.invalidRecordCount,
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
        invalidRecordCount: this.invalidRecordCount,
        reason: `Latest closed bar is stale by ${Math.round(stalenessMs / 1000)} seconds.`,
      };
    }

    return {
      status: 'OK',
      lastClosedBarTime: lastBar.closedAt,
      gapCount: 0,
      stalenessMs,
      totalBars: available.length,
      invalidRecordCount: this.invalidRecordCount,
    };
  }

  /**
   * Returns the funding rate active at or immediately prior to asOfMs.
   */
  public getFundingRateAt(asOfMs: number, intervalHours?: number): PITFundingRate | null {
    for (let i = this.fundingRates.length - 1; i >= 0; i--) {
      const rate = this.fundingRates[i];
      if (rate.timestamp <= asOfMs && (intervalHours === undefined || rate.intervalHours === intervalHours)) return rate;
    }
    return null;
  }

  public fundingIntervals(fallbackIntervalHours: number): number[] {
    const intervals = [...new Set(this.fundingRates.map(rate => rate.intervalHours))];
    return intervals.length > 0 ? intervals : [fallbackIntervalHours];
  }

  /**
   * Helper: tests if timestamp falls exactly on an 8-hour funding settlement window (00:00, 08:00, 16:00 UTC).
   */
  public static isFundingSettlementWindow(timestampMs: number, intervalHours: number = 8): boolean {
    if (!Number.isSafeInteger(timestampMs) || !Number.isInteger(intervalHours)
      || intervalHours < 1 || intervalHours > 24) return false;
    const date = new Date(timestampMs);
    const hour = date.getUTCHours();
    const minute = date.getUTCMinutes();
    const second = date.getUTCSeconds();
    return minute === 0 && second === 0 && date.getUTCMilliseconds() === 0 && hour % intervalHours === 0;
  }
}
