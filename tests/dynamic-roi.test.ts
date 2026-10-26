import { describe, expect, it } from 'vitest';
import { MinimalRoiEngine, DEFAULT_MINIMAL_ROI_TABLE } from '../server/research/roi-matrix.js';
import { DynamicTrailingStopEngine } from '../server/research/trailing-stop.js';
import { PerpBacktestEngine, type StrategyFn } from '../server/research/backtest.js';
import type { PITCandle } from '../server/research/pit.js';

describe('Minimal ROI Time-Decay Matrix & Dynamic Trailing Stop', () => {
  describe('MinimalRoiEngine', () => {
    it('returns expected required ROI across time duration thresholds', () => {
      const engine = new MinimalRoiEngine(DEFAULT_MINIMAL_ROI_TABLE);

      // Duration < 15 min: requires 3.5%
      expect(engine.getRequiredRoi(5)).toBe(3.5);
      expect(engine.shouldTakeProfit(5, 3.4)).toBe(false);
      expect(engine.shouldTakeProfit(5, 3.6)).toBe(true);

      // Duration 20 min (15 to 30 min tier): requires 2.2%
      expect(engine.getRequiredRoi(20)).toBe(2.2);
      expect(engine.shouldTakeProfit(20, 2.0)).toBe(false);
      expect(engine.shouldTakeProfit(20, 2.3)).toBe(true);

      // Duration 75 min (60 to 120 min tier): requires 0.8%
      expect(engine.getRequiredRoi(75)).toBe(0.8);
      expect(engine.shouldTakeProfit(75, 0.9)).toBe(true);

      // Duration 250 min (> 240 min tier): requires 0.0% (breakeven exit)
      expect(engine.getRequiredRoi(250)).toBe(0.0);
      expect(engine.shouldTakeProfit(250, 0.1)).toBe(true);
    });
  });

  describe('DynamicTrailingStopEngine', () => {
    it('maintains a one-way ratchet stop for LONG positions', () => {
      const engine = new DynamicTrailingStopEngine({
        activationRoiPct: 1.0, // activates at +1% profit
        fallbackDistancePct: 1.0, // 1% trailing distance
      });

      const state = engine.initializePosition('LONG', 100, 95);
      expect(state.currentStopPrice).toBe(95);
      expect(state.isActivated).toBe(false);

      // Price rises to 100.5 (+0.5%): not yet activated
      const step1 = engine.updateStop(state, 100.5);
      expect(step1.updated).toBe(false);
      expect(state.currentStopPrice).toBe(95);

      // Price rises to 102 (+2%): activates trailing stop!
      // Highest price seen = 102, distance = 1.02 -> Proposed stop = 102 - 1.02 = 100.98 > 95
      const step2 = engine.updateStop(state, 102);
      expect(step2.updated).toBe(true);
      expect(state.currentStopPrice).toBe(100.98);

      // Price pulls back to 101.5: stop price must NOT retreat!
      const step3 = engine.updateStop(state, 101.5);
      expect(step3.updated).toBe(false);
      expect(state.currentStopPrice).toBe(100.98);

      // Price rallies to 105: stop ratchets up again!
      // Highest = 105, distance = 1.05 -> Proposed stop = 105 - 1.05 = 103.95
      const step4 = engine.updateStop(state, 105);
      expect(step4.updated).toBe(true);
      expect(state.currentStopPrice).toBe(103.95);
    });
  });

  describe('Integration with PerpBacktestEngine', () => {
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

    it('exits via MINIMAL_ROI when time decay threshold is satisfied', () => {
      // 20 bars: trade enters at bar 0 (price 100), stays around 100.8 (+0.8% return, 5x leverage = 4.0% ROI)
      // At bar 16 (16 minutes duration), tier requires 2.2% ROI -> Triggers MINIMAL_ROI exit!
      const prices = [];
      prices.push({ open: 100, high: 101, low: 99, close: 100 });
      for (let i = 1; i < 20; i++) {
        prices.push({ open: 100.8, high: 101, low: 100.6, close: 100.8 });
      }
      const candles = makeCandles(prices);

      const engine = new PerpBacktestEngine({
        initialCapital: 1000,
        enableMinimalRoi: true,
        maxLeverage: 5,
        slippageBps: 0,
      });

      const strategy: StrategyFn = (feed, bar, openPositions) => {
        if (bar.timestamp === baseTime && openPositions.length === 0) {
          return { action: 'OPEN_LONG', symbol: 'BTCUSDT', stopPrice: 90, tpPrice: 120, sizeUsdt: 200, leverage: 5 };
        }
        return null;
      };

      const metrics = engine.run(candles, [], strategy);
      expect(metrics.totalTrades).toBe(1);
      expect(metrics.trades[0].exitReason).toBe('MINIMAL_ROI');
      expect(metrics.trades[0].netPnL).toBeGreaterThan(0);
    });

    it('exits via TRAILING_STOP when trailing stop is triggered', () => {
      // Price rises to 105, ratchets stop up, then pulls back and hits trailing stop
      const candles = makeCandles([
        { open: 100, high: 101, low: 99, close: 100 },
        { open: 100, high: 104, low: 100, close: 103 },
        { open: 103, high: 106, low: 103, close: 105 }, // Rallies to 105, trailing stop active
        { open: 105, high: 105, low: 102, close: 102.5 }, // Dips to 102, hits ratcheted stop (~103.95)
        { open: 102.5, high: 103, low: 101, close: 102 },
      ]);

      const engine = new PerpBacktestEngine({
        initialCapital: 1000,
        enableTrailingStop: true,
        trailingStopConfig: {
          activationRoiPct: 1.0,
          fallbackDistancePct: 1.0,
        },
        maxLeverage: 2,
        slippageBps: 0,
      });

      const strategy: StrategyFn = (feed, bar, openPositions) => {
        if (bar.timestamp === baseTime && openPositions.length === 0) {
          return { action: 'OPEN_LONG', symbol: 'BTCUSDT', stopPrice: 95, tpPrice: 120, sizeUsdt: 200, leverage: 2 };
        }
        return null;
      };

      const metrics = engine.run(candles, [], strategy);
      expect(metrics.totalTrades).toBe(1);
      expect(metrics.trades[0].exitReason).toBe('TRAILING_STOP');
      expect(metrics.trades[0].exitPrice).toBeGreaterThan(100); // Exited profitably above entry!
    });
  });
});
