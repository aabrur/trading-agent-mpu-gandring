import { describe, expect, it } from 'vitest';
import { PointInTimeFeed, type PITCandle, type PITFundingRate } from '../server/research/pit.js';

describe('Point-In-Time (PIT) Market Data Engine', () => {
  const baseTime = 1700000000000;
  const sampleCandles: PITCandle[] = [
    { timestamp: baseTime, open: 100, high: 105, low: 99, close: 104, volume: 10, closedAt: baseTime + 60_000 },
    { timestamp: baseTime + 60_000, open: 104, high: 108, low: 103, close: 107, volume: 15, closedAt: baseTime + 120_000 },
    { timestamp: baseTime + 120_000, open: 107, high: 110, low: 106, close: 109, volume: 20, closedAt: baseTime + 180_000 },
    { timestamp: baseTime + 180_000, open: 109, high: 112, low: 108, close: 111, volume: 25, closedAt: baseTime + 240_000 },
  ];

  it('strictly enforces closed-bar availability and avoids lookahead bias', () => {
    const feed = new PointInTimeFeed(sampleCandles);

    // Before any candle has closed
    expect(feed.asOf(baseTime + 30_000)).toHaveLength(0);
    expect(feed.getLatestClosedBar(baseTime + 30_000)).toBeNull();

    // At exact close of first candle
    const atFirstClose = feed.asOf(baseTime + 60_000);
    expect(atFirstClose).toHaveLength(1);
    expect(atFirstClose[0].close).toBe(104);
    expect(feed.getLatestClosedBar(baseTime + 60_000)?.close).toBe(104);

    // During the second candle (second candle is still open)
    const midSecond = feed.asOf(baseTime + 90_000);
    expect(midSecond).toHaveLength(1);
    expect(midSecond[0].close).toBe(104);

    // After third candle closed
    const afterThird = feed.asOf(baseTime + 200_000);
    expect(afterThird).toHaveLength(3);
    expect(afterThird[2].close).toBe(109);
  });

  it('detects interval gaps without fabricating prices', () => {
    const gappedCandles: PITCandle[] = [
      { timestamp: baseTime, open: 100, high: 105, low: 99, close: 104, volume: 10, closedAt: baseTime + 60_000 },
      // Missing bar at baseTime + 60_000
      { timestamp: baseTime + 180_000, open: 107, high: 110, low: 106, close: 109, volume: 20, closedAt: baseTime + 240_000 },
    ];

    const feed = new PointInTimeFeed(gappedCandles);
    const quality = feed.checkQuality(baseTime + 240_000, 60_000);

    expect(quality.status).toBe('GAP_DETECTED');
    expect(quality.gapCount).toBe(1);
  });

  it('detects stale market data', () => {
    const feed = new PointInTimeFeed(sampleCandles);
    // Querying 10 minutes after last candle closed
    const quality = feed.checkQuality(baseTime + 240_000 + 600_000, 60_000, 300_000);

    expect(quality.status).toBe('STALE');
    expect(quality.stalenessMs).toBe(600_000);
  });

  it('correctly retrieves funding rates and recognizes settlement windows', () => {
    // 08:00 UTC = 8 * 3600 * 1000 = 28800000 ms from UTC midnight
    const fundingRates: PITFundingRate[] = [
      { timestamp: 1700000000000, rate: 0.0001, intervalHours: 8 },
      { timestamp: 1700028800000, rate: -0.00015, intervalHours: 8 },
    ];

    const feed = new PointInTimeFeed([], fundingRates);

    // Query before second funding settlement
    const f1 = feed.getFundingRateAt(1700010000000);
    expect(f1?.rate).toBe(0.0001);

    // Query after second funding settlement
    const f2 = feed.getFundingRateAt(1700030000000);
    expect(f2?.rate).toBe(-0.00015);

    // Settlement window detection
    // 00:00:00 UTC
    const utcMidnight = Date.UTC(2026, 9, 26, 0, 0, 0);
    expect(PointInTimeFeed.isFundingSettlementWindow(utcMidnight, 8)).toBe(true);

    // 08:00:00 UTC
    const utcEightAm = Date.UTC(2026, 9, 26, 8, 0, 0);
    expect(PointInTimeFeed.isFundingSettlementWindow(utcEightAm, 8)).toBe(true);

    // 04:30:00 UTC (not settlement)
    const utcFourThirty = Date.UTC(2026, 9, 26, 4, 30, 0);
    expect(PointInTimeFeed.isFundingSettlementWindow(utcFourThirty, 8)).toBe(false);
  });
});
