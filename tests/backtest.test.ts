import { describe, expect, it } from 'vitest';
import { PerpBacktestEngine, type StrategyFn } from '../server/research/backtest.js';
import type { PITCandle, PITFundingRate } from '../server/research/pit.js';

describe('Deterministic Crypto-Perpetual Historical Simulator', () => {
  const baseTime = 1700000000000;

  function makeCandles(prices: { open: number; high: number; low: number; close: number }[]): PITCandle[] {
    return prices.map((p, idx) => ({
      timestamp: baseTime + idx * 60_000,
      open: p.open,
      high: p.high,
      low: p.low,
      close: p.close,
      volume: 100,
      closedAt: baseTime + (idx + 1) * 60_000,
    }));
  }

  it('executes a winning LONG trade, accounts for fees and slippage, and calculates metrics', () => {
    const candles = makeCandles([
      { open: 100, high: 101, low: 99, close: 100 },
      { open: 100, high: 105, low: 99.5, close: 104 },
      { open: 104, high: 110, low: 103, close: 108 }, // Triggers TP at 106
      { open: 108, high: 109, low: 107, close: 108 },
    ]);

    const engine = new PerpBacktestEngine({
      initialCapital: 1000,
      takerFeeRate: 0.0005,
      slippageBps: 10, // 0.1%
      maxLeverage: 5,
    });

    const strategy: StrategyFn = (feed, bar, openPositions) => {
      if (bar.timestamp === baseTime && openPositions.length === 0) {
        return {
          action: 'OPEN_LONG',
          symbol: 'BTCUSDT',
          stopPrice: 95,
          tpPrice: 106,
          sizeUsdt: 200,
          leverage: 5,
        };
      }
      return null;
    };

    const metrics = engine.run(candles, [], strategy);

    expect(metrics.totalTrades).toBe(1);
    expect(metrics.winningTrades).toBe(1);
    expect(metrics.winRatePct).toBe(100);
    expect(metrics.trades[0].side).toBe('LONG');
    expect(metrics.trades[0].exitReason).toBe('TAKE_PROFIT');
    expect(metrics.trades[0].exitPrice).toBe(106);
    expect(metrics.trades[0].grossPnL).toBeGreaterThan(0);
    expect(metrics.trades[0].feesPaid).toBeGreaterThan(0);
    expect(metrics.trades[0].slippagePaid).toBeGreaterThan(0);
    expect(metrics.netPnL).toBeGreaterThan(0);
    expect(metrics.finalEquity).toBeGreaterThan(1000);
  });

  it('executes a winning SHORT trade with price decline', () => {
    const candles = makeCandles([
      { open: 100, high: 101, low: 99, close: 100 },
      { open: 100, high: 100.5, low: 95, close: 96 },
      { open: 96, high: 97, low: 90, close: 91 }, // Triggers TP at 92
      { open: 91, high: 92, low: 90, close: 91 },
    ]);

    const engine = new PerpBacktestEngine({
      initialCapital: 1000,
      takerFeeRate: 0.0005,
      slippageBps: 0,
      maxLeverage: 3,
    });

    const strategy: StrategyFn = (feed, bar, openPositions) => {
      if (bar.timestamp === baseTime && openPositions.length === 0) {
        return {
          action: 'OPEN_SHORT',
          symbol: 'BTCUSDT',
          stopPrice: 105,
          tpPrice: 92,
          sizeUsdt: 200,
          leverage: 3,
        };
      }
      return null;
    };

    const metrics = engine.run(candles, [], strategy);

    expect(metrics.totalTrades).toBe(1);
    expect(metrics.winningTrades).toBe(1);
    expect(metrics.trades[0].side).toBe('SHORT');
    expect(metrics.trades[0].exitReason).toBe('TAKE_PROFIT');
    expect(metrics.trades[0].exitPrice).toBe(92);
    expect(metrics.netPnL).toBeGreaterThan(0);
  });

  it('triggers stop loss and applies gap slippage execution', () => {
    const candles = makeCandles([
      { open: 100, high: 101, low: 99, close: 100 },
      // Price gaps down sharply past the 96 stop loss to 92
      { open: 93, high: 94, low: 91, close: 92 },
      { open: 92, high: 93, low: 90, close: 91 },
    ]);

    const engine = new PerpBacktestEngine({
      initialCapital: 1000,
      slippageBps: 20, // 0.2%
      maxLeverage: 2,
    });

    const strategy: StrategyFn = (feed, bar, openPositions) => {
      if (bar.timestamp === baseTime && openPositions.length === 0) {
        return {
          action: 'OPEN_LONG',
          symbol: 'BTCUSDT',
          stopPrice: 96,
          sizeUsdt: 200,
          leverage: 2,
        };
      }
      return null;
    };

    const metrics = engine.run(candles, [], strategy);

    expect(metrics.totalTrades).toBe(1);
    expect(metrics.losingTrades).toBe(1);
    expect(metrics.trades[0].exitReason).toBe('STOP_LOSS');
    // Exit executed at gap open (93) with slippage, not idealized 96 stop
    expect(metrics.trades[0].exitPrice).toBeLessThan(93);
    expect(metrics.netPnL).toBeLessThan(0);
  });

  it('triggers liquidation when price breaches liquidation threshold', () => {
    const candles = makeCandles([
      { open: 100, high: 101, low: 99, close: 100 },
      // Extreme flash crash down to 75 (10x leverage liquidation is ~90.5)
      { open: 100, high: 100, low: 75, close: 76 },
      { open: 76, high: 77, low: 75, close: 76 },
    ]);

    const engine = new PerpBacktestEngine({
      initialCapital: 1000,
      maxLeverage: 10,
      maintenanceMarginRate: 0.005,
    });

    const strategy: StrategyFn = (feed, bar, openPositions) => {
      if (bar.timestamp === baseTime && openPositions.length === 0) {
        return {
          action: 'OPEN_LONG',
          symbol: 'BTCUSDT',
          stopPrice: 70, // Stop loss placed too low below liq price
          sizeUsdt: 300,
          leverage: 10,
        };
      }
      return null;
    };

    const metrics = engine.run(candles, [], strategy);

    expect(metrics.totalTrades).toBe(1);
    expect(metrics.trades[0].exitReason).toBe('LIQUIDATION');
    // The trade PnL includes the margin and the entry fee already deducted from cash.
    expect(metrics.trades[0].netPnL).toBeCloseTo(-301.65, 8);
    expect(metrics.trades[0].feesPaid).toBeCloseTo(1.65, 8);
    expect(metrics.trades[0].liquidationAdjustment).toBeLessThan(0);
    expect(metrics.finalEquity).toBe(698.35);
    expect(metrics.trades.reduce((sum, trade) => sum + trade.netPnL, 0)).toBeCloseTo(metrics.finalEquity - metrics.initialCapital, 8);
  });

  it('correctly processes periodic funding settlement payments', () => {
    // 08:00 UTC timestamp: 1700035200000
    const settlementTime = Date.UTC(2026, 9, 26, 8, 0, 0);
    const candles: PITCandle[] = [
      { timestamp: settlementTime - 120_000, open: 100, high: 101, low: 99, close: 100, volume: 10, closedAt: settlementTime - 60_000 },
      // Bar closing right at 08:00 UTC
      { timestamp: settlementTime - 60_000, open: 100, high: 101, low: 99, close: 100, volume: 10, closedAt: settlementTime },
      { timestamp: settlementTime, open: 100, high: 101, low: 99, close: 100, volume: 10, closedAt: settlementTime + 60_000 },
    ];

    const fundingRates: PITFundingRate[] = [
      { timestamp: settlementTime, rate: 0.001, intervalHours: 8 }, // 0.1% funding rate
    ];

    const engine = new PerpBacktestEngine({
      initialCapital: 1000,
      defaultFundingRate: 0.001,
      maxLeverage: 5,
    });

    const strategy: StrategyFn = (feed, bar, openPositions) => {
      if (bar.timestamp === settlementTime - 120_000 && openPositions.length === 0) {
        return {
          action: 'OPEN_LONG',
          symbol: 'BTCUSDT',
          stopPrice: 90,
          sizeUsdt: 200,
          leverage: 5, // Notional = 1000 USDT
        };
      }
      if (bar.timestamp === settlementTime && openPositions.length > 0) {
        return {
          action: 'CLOSE',
          symbol: 'BTCUSDT',
          stopPrice: 0,
        };
      }
      return null;
    };

    const metrics = engine.run(candles, fundingRates, strategy);

    expect(metrics.totalTrades).toBe(1);
    // Funding payment: 1000 USDT notional * 0.001 rate = 1 USDT
    expect(metrics.trades[0].fundingPaid).toBeGreaterThan(0.99);
  });

  it('reconciles entry and exit fees once in cash and final equity', () => {
    const candles = makeCandles([
      { open: 100, high: 100, low: 100, close: 100 },
      { open: 100, high: 100, low: 100, close: 100 },
    ]);
    const metrics = new PerpBacktestEngine({
      initialCapital: 1000,
      takerFeeRate: 0.001,
      slippageBps: 0,
      maxLeverage: 2,
    }).run(candles, [], (_feed, bar) => bar.timestamp === baseTime
      ? { action: 'OPEN_LONG', symbol: 'BTCUSDT', stopPrice: 90, sizeUsdt: 200, leverage: 2 }
      : { action: 'CLOSE', symbol: 'BTCUSDT', stopPrice: 0 });

    expect(metrics.finalEquity).toBeCloseTo(999.2, 8);
    expect(metrics.trades[0].netPnL).toBeCloseTo(-0.8, 8);
  });

  it('includes entry fees in available margin and reports costs for an open position', () => {
    const candles = makeCandles([{ open: 100, high: 100, low: 100, close: 100 }]);
    const metrics = new PerpBacktestEngine({
      initialCapital: 200, takerFeeRate: 0.001, slippageBps: 0, maxLeverage: 2,
    }).run(candles, [], () => ({
      action: 'OPEN_LONG', symbol: 'BTCUSDT', stopPrice: 90, sizeUsdt: 200, leverage: 2,
    }));

    expect(metrics.equityCurve[0].cashBalance).toBeCloseTo(0, 8);
    expect(metrics.totalFeesPaid).toBeCloseTo(0.3992, 4);
    expect(metrics.finalEquity).toBeCloseTo(199.6008, 4);
  });

  it('does not process ROI exits before intrabar liquidation protection', () => {
    const candles = makeCandles([
      { open: 100, high: 100, low: 100, close: 100 },
      { open: 100, high: 110, low: 40, close: 110 },
    ]);
    const metrics = new PerpBacktestEngine({
      initialCapital: 1000,
      takerFeeRate: 0,
      slippageBps: 0,
      maxLeverage: 2,
      enableMinimalRoi: true,
      minimalRoiTable: [{ minutes: 0, minRoiPct: 1 }],
    }).run(candles, [], (_feed, bar) => bar.timestamp === baseTime
      ? { action: 'OPEN_LONG', symbol: 'BTCUSDT', stopPrice: 30, sizeUsdt: 200, leverage: 2 }
      : null);

    expect(metrics.trades[0].exitReason).toBe('LIQUIDATION');
  });

  it('limits strategy feed history to bars closed as of the current decision', () => {
    const candles = makeCandles([
      { open: 100, high: 101, low: 99, close: 100 },
      { open: 200, high: 201, low: 199, close: 200 },
    ]);
    const observed: number[] = [];
    const metrics = new PerpBacktestEngine({ initialCapital: 1000 }).run(candles, [], feed => {
      observed.push(feed.asOf(Number.MAX_SAFE_INTEGER).length);
      return null;
    });

    expect(observed).toEqual([1, 2]);
    expect(metrics.dataQuality.status).toBe('OK');
  });

  it('resets all state when an engine instance is reused with empty input', () => {
    const engine = new PerpBacktestEngine({ initialCapital: 1000 });
    engine.run(makeCandles([{ open: 100, high: 100, low: 100, close: 100 }]), [], () => ({
      action: 'OPEN_LONG', symbol: 'BTCUSDT', stopPrice: 90, sizeUsdt: 200,
    }));
    const empty = engine.run([], [], () => null);

    expect(empty.finalEquity).toBe(1000);
    expect(empty.totalTrades).toBe(0);
    expect(empty.equityCurve).toEqual([]);
    expect(empty.totalFeesPaid).toBe(0);
    expect(empty.dataQuality.status).toBe('EMPTY');
  });

  it('charges every funding settlement crossed during a candle data gap', () => {
    const settlement0 = Date.UTC(2026, 9, 26, 0, 0, 0);
    const candles: PITCandle[] = [
      { timestamp: settlement0 - 60_000, open: 100, high: 101, low: 99, close: 100, volume: 10, closedAt: settlement0 },
      { timestamp: settlement0 + 16 * 60 * 60_000 - 60_000, open: 100, high: 101, low: 99, close: 100, volume: 10, closedAt: settlement0 + 16 * 60 * 60_000 },
    ];
    const rates: PITFundingRate[] = [8, 16].map(hour => ({
      timestamp: settlement0 + hour * 60 * 60_000,
      rate: 0.001,
      intervalHours: 8,
    }));
    const metrics = new PerpBacktestEngine({
      initialCapital: 1000, takerFeeRate: 0.001, slippageBps: 0, maxLeverage: 2,
    }).run(candles, rates, (_feed, bar) => bar.timestamp === candles[0].timestamp
      ? { action: 'OPEN_LONG', symbol: 'BTCUSDT', stopPrice: 90, sizeUsdt: 200, leverage: 2 }
      : { action: 'CLOSE', symbol: 'BTCUSDT', stopPrice: 0 });

    expect(metrics.trades[0].fundingPaid).toBeCloseTo(0.8, 8);
    expect(metrics.finalEquity).toBeCloseTo(998.4, 8);
    expect(metrics.totalFundingPaid).toBeCloseTo(0.8, 8);
  });

  it('uses only the active funding interval after a historical interval change', () => {
    const start = Date.UTC(2026, 9, 26);
    const hour = 3_600_000;
    const candles: PITCandle[] = [0.5, 9].map(h => ({ timestamp: start + h * hour - 60_000, closedAt: start + h * hour, open: 100, high: 100, low: 100, close: 100, volume: 1 }));
    const rates: PITFundingRate[] = [
      { timestamp: start + hour, rate: 0.001, intervalHours: 1 },
      { timestamp: start + 8 * hour, rate: 0.002, intervalHours: 8 },
    ];
    const result = new PerpBacktestEngine({ initialCapital: 1000, maxLeverage: 2, takerFeeRate: 0, slippageBps: 0, defaultFundingRate: 0 }).run(candles, rates, (_feed, bar) => bar.closedAt === candles[0].closedAt
      ? { action: 'OPEN_LONG', symbol: 'BTCUSDT', stopPrice: 90, sizeUsdt: 200, leverage: 2 }
      : { action: 'CLOSE', symbol: 'BTCUSDT', stopPrice: 0 });
    // Seven hourly settlements at 0.4 USDT, then one eight-hour settlement at 0.8 USDT.
    expect(result.totalFundingPaid).toBeCloseTo(3.6, 8);
    expect(result.finalEquity).toBeCloseTo(996.4, 8);
    expect(result.trades[0].netPnL).toBeCloseTo(-3.6, 8);
  });

  it('does not let a future interval record change the configured funding clock in the past', () => {
    const start = Date.UTC(2026, 9, 26), hour = 3_600_000;
    const candles: PITCandle[] = [7.5, 11].map(h => ({ timestamp: start + h * hour - 60_000, closedAt: start + h * hour, open: 100, high: 100, low: 100, close: 100, volume: 1 }));
    const result = new PerpBacktestEngine({ initialCapital: 1000, maxLeverage: 2, takerFeeRate: 0, slippageBps: 0, defaultFundingRate: 0.001, fundingIntervalHours: 8 }).run(candles,
      [{ timestamp: start + 10 * hour, rate: 0.002, intervalHours: 1 }],
      (_feed, bar) => bar.closedAt === candles[0].closedAt
        ? { action: 'OPEN_LONG', symbol: 'BTCUSDT', stopPrice: 90, sizeUsdt: 200, leverage: 2 }
        : { action: 'CLOSE', symbol: 'BTCUSDT', stopPrice: 0 });
    // Configured eight-hour clock at 08:00 costs 0.4; the observed hourly clock costs 0.8 at 10:00 and 11:00.
    expect(result.totalFundingPaid).toBeCloseTo(2, 8);
    expect(result.finalEquity).toBeCloseTo(998, 8);
  });

  it('reconciles funding cash debits for both sides without charging them again at close', () => {
    const settlement = Date.UTC(2026, 9, 26, 8, 0, 0);
    const candles: PITCandle[] = [
      { timestamp: settlement - 120_000, open: 100, high: 100, low: 100, close: 100, volume: 10, closedAt: settlement - 60_000 },
      { timestamp: settlement - 60_000, open: 100, high: 100, low: 100, close: 100, volume: 10, closedAt: settlement },
    ];
    const rates: PITFundingRate[] = [{ timestamp: settlement, rate: 0.01, intervalHours: 8 }];
    const runSide = (side: 'LONG' | 'SHORT') => new PerpBacktestEngine({
      initialCapital: 1000, takerFeeRate: 0.001, slippageBps: 0, maxLeverage: 2,
    }).run(candles, rates, (_feed, bar) => bar.timestamp === candles[0].timestamp
      ? { action: side === 'LONG' ? 'OPEN_LONG' : 'OPEN_SHORT', symbol: 'BTCUSDT', stopPrice: side === 'LONG' ? 90 : 110, sizeUsdt: 200, leverage: 2 }
      : { action: 'CLOSE', symbol: 'BTCUSDT', stopPrice: 0 });

    expect(runSide('LONG').finalEquity).toBeCloseTo(995.2, 8);
    expect(runSide('SHORT').finalEquity).toBeCloseTo(1003.2, 8);
  });

  it('is completely deterministic: 2 identical runs yield exact identical outputs', () => {
    const candles = makeCandles([
      { open: 100, high: 102, low: 98, close: 101 },
      { open: 101, high: 106, low: 100, close: 105 },
      { open: 105, high: 107, low: 103, close: 104 },
      { open: 104, high: 105, low: 99, close: 100 },
      { open: 100, high: 103, low: 97, close: 98 },
    ]);

    const engineA = new PerpBacktestEngine({ initialCapital: 1000 });
    const engineB = new PerpBacktestEngine({ initialCapital: 1000 });

    const strategy: StrategyFn = (feed, bar, openPositions) => {
      if (bar.timestamp === baseTime && openPositions.length === 0) {
        return { action: 'OPEN_LONG', symbol: 'BTCUSDT', stopPrice: 95, tpPrice: 106, sizeUsdt: 200 };
      }
      return null;
    };

    const metricsA = engineA.run(candles, [], strategy);
    const metricsB = engineB.run(candles, [], strategy);

    expect(metricsA.finalEquity).toBe(metricsB.finalEquity);
    expect(metricsA.netPnL).toBe(metricsB.netPnL);
    expect(metricsA.trades.length).toBe(metricsB.trades.length);
    expect(metricsA.trades[0].exitPrice).toBe(metricsB.trades[0].exitPrice);
  });
});
