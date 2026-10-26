#!/usr/bin/env tsx
/**
 * CLI Backtest Runner for Mpu Gandring.
 *
 * Usage:
 *   npm run backtest -- --symbol BTCUSDT [--capital 1000] [--leverage 5] [--slippage 5] [--strategy simple_momentum] [--json]
 */

import { PerpBacktestEngine, type StrategyFn } from '../server/research/backtest.js';
import { getSnapshot } from '../server/market/index.js';
import { normSymbol } from '../server/commands.js';
import type { PITCandle } from '../server/research/pit.js';

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : 'true') : fallback;
};

const symbol = normSymbol(flag('symbol', 'BTCUSDT')!);
const capital = parseFloat(flag('capital', '1000')!);
const leverage = parseFloat(flag('leverage', '5')!);
const slippageBps = parseFloat(flag('slippage', '5')!);
const strategyName = flag('strategy', 'simple_momentum')!;
const json = flag('json') === 'true';

const source = (flag('source', 'sample') ?? 'sample') as any;
const snapshot = await getSnapshot(symbol, source, false);
const candles: PITCandle[] = snapshot.candles.map(c => ({
  timestamp: c.t,
  open: c.o,
  high: c.h,
  low: c.l,
  close: c.c,
  volume: c.v,
  closedAt: c.t + 60_000
}));

const engine = new PerpBacktestEngine({
  initialCapital: capital,
  maxLeverage: leverage,
  slippageBps
});

const strategyFn: StrategyFn = (feed, bar, openPositions) => {
  const history = feed.asOf(bar.closedAt);
  if (history.length < 5) return null;

  if (strategyName === 'buy_and_hold') {
    if (openPositions.length === 0) {
      return {
        action: 'OPEN_LONG',
        symbol,
        stopPrice: bar.close * 0.90,
        tpPrice: bar.close * 1.50
      };
    }
    return null;
  }

  // Momentum SMA 5 vs SMA 20
  const closes = history.map(c => c.close);
  const sma5 = closes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const sma20 = closes.length >= 20
    ? closes.slice(-20).reduce((a, b) => a + b, 0) / 20
    : sma5;

  if (openPositions.length === 0) {
    if (sma5 > sma20) {
      return {
        action: 'OPEN_LONG',
        symbol,
        stopPrice: bar.close * 0.98,
        tpPrice: bar.close * 1.04
      };
    } else if (sma5 < sma20) {
      return {
        action: 'OPEN_SHORT',
        symbol,
        stopPrice: bar.close * 1.02,
        tpPrice: bar.close * 0.96
      };
    }
  }
  return null;
};

const metrics = engine.run(candles, [], strategyFn);

if (json) {
  console.log(JSON.stringify({ symbol, strategy: strategyName, metrics }, null, 2));
} else {
  console.log(`\n========================================================`);
  console.log(`  MPU GANDRING PERPETUAL BACKTEST REPORT: ${symbol}`);
  console.log(`  Strategy: ${strategyName} | Leverage: ${leverage}x | Slippage: ${slippageBps} bps`);
  console.log(`========================================================`);
  console.log(`Initial Capital:     ${metrics.initialCapital} USDT`);
  console.log(`Final Equity:        ${metrics.finalEquity.toFixed(2)} USDT`);
  console.log(`Net PnL:             ${metrics.netPnL >= 0 ? '+' : ''}${metrics.netPnL.toFixed(2)} USDT (${metrics.roiPct.toFixed(2)}%)`);
  console.log(`Profit Factor:       ${metrics.profitFactor}`);
  console.log(`Win Rate:            ${metrics.winRatePct}% (${metrics.winningTrades}W / ${metrics.losingTrades}L / ${metrics.breakEvenTrades}BE)`);
  console.log(`Total Trades:        ${metrics.totalTrades}`);
  console.log(`Expectancy:          ${metrics.expectancyUsdt} USDT / trade`);
  console.log(`Max Drawdown:        ${metrics.maxDrawdownUsdt.toFixed(2)} USDT (${metrics.maxDrawdownPct.toFixed(2)}%)`);
  console.log(`Sharpe Ratio:        ${metrics.sharpeRatio}`);
  console.log(`Sortino Ratio:       ${metrics.sortinoRatio}`);
  console.log(`Total Fees Paid:     ${metrics.totalFeesPaid.toFixed(2)} USDT`);
  console.log(`Total Funding Paid:  ${metrics.totalFundingPaid.toFixed(2)} USDT`);
  console.log(`Total Slippage:      ${metrics.totalSlippagePaid.toFixed(2)} USDT`);
  console.log(`========================================================\n`);
}

process.exit(0);
