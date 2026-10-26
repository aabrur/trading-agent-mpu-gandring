/**
 * Deterministic Crypto-Perpetual Historical Simulator and Backtester for Mpu Gandring.
 *
 * Implements institutional-grade clean-room perpetual accounting:
 * - Deterministic: 100% reproducible execution without random seeds or network I/O.
 * - Dual-direction parity: Realistic Long and Short mechanics.
 * - Fees & Funding: Configurable maker/taker fee rates and periodic 8h/1h funding settlements.
 * - Realistic Slippage & Gap Execution: Stop loss execution accounts for gap-through slippage.
 * - Margin & Liquidation: Isolated margin accounting with maintenance margin requirement (MMR).
 * - Comprehensive Metrics: Net PnL, Profit Factor, Win Rate, Expectancy, Max Drawdown, Sharpe/Sortino.
 */

import type { PITCandle, PITFundingRate } from './pit.js';
import { PointInTimeFeed } from './pit.js';
import { MinimalRoiEngine, type MinimalRoiTable } from './roi-matrix.js';
import { DynamicTrailingStopEngine, type TrailingStopConfig, type TrailingPositionState } from './trailing-stop.js';

export interface BacktestConfig {
  initialCapital: number; // in USDT (default 1000)
  takerFeeRate?: number; // e.g. 0.00055 for 0.055%
  makerFeeRate?: number; // e.g. 0.0002 for 0.02%
  slippageBps?: number; // e.g. 5 bps = 0.05%
  maintenanceMarginRate?: number; // e.g. 0.005 for 0.5%
  fundingIntervalHours?: number; // default 8
  defaultFundingRate?: number; // default 0.0001 (0.01%)
  maxLeverage?: number; // default 5
  enableMinimalRoi?: boolean;
  minimalRoiTable?: MinimalRoiTable;
  enableTrailingStop?: boolean;
  trailingStopConfig?: TrailingStopConfig;
}

export type ExitReason = 'STOP_LOSS' | 'TAKE_PROFIT' | 'MINIMAL_ROI' | 'TRAILING_STOP' | 'SIGNAL_CLOSE' | 'LIQUIDATION' | 'TIME_EXIT';

export interface BacktestPosition {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  qty: number;
  leverage: number;
  initialMargin: number;
  stopPrice: number;
  tpPrice?: number;
  entryTime: number;
  liquidationPrice: number;
  accumulatedFunding: number;
  entrySlippagePaid: number;
  trailingState?: TrailingPositionState;
}

export interface BacktestTrade {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  qty: number;
  leverage: number;
  initialMargin: number;
  entryTime: number;
  exitTime: number;
  durationMs: number;
  grossPnL: number;
  feesPaid: number;
  fundingPaid: number;
  slippagePaid: number;
  liquidationAdjustment: number;
  netPnL: number;
  roiPct: number;
  exitReason: ExitReason;
}

export interface EquityPoint {
  timestamp: number;
  equity: number;
  cashBalance: number;
  unrealizedPnL: number;
  openPositionCount: number;
}

export interface BacktestMetrics {
  initialCapital: number;
  finalEquity: number;
  netPnL: number;
  roiPct: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  breakEvenTrades: number;
  winRatePct: number;
  expectancyUsdt: number;
  maxDrawdownUsdt: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  sortinoRatio: number;
  totalFeesPaid: number;
  totalFundingPaid: number;
  totalSlippagePaid: number;
  dataQuality: ReturnType<PointInTimeFeed['checkQuality']>;
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
}

export interface StrategySignal {
  action: 'OPEN_LONG' | 'OPEN_SHORT' | 'CLOSE' | 'HOLD';
  symbol: string;
  stopPrice: number;
  tpPrice?: number;
  sizeUsdt?: number;
  leverage?: number;
}

export type StrategyFn = (
  feed: PointInTimeFeed,
  currentBar: PITCandle,
  openPositions: BacktestPosition[]
) => StrategySignal | null;

export class PerpBacktestEngine {
  private config: Required<BacktestConfig>;
  private cashBalance: number;
  private openPositions: BacktestPosition[] = [];
  private closedTrades: BacktestTrade[] = [];
  private equityCurve: EquityPoint[] = [];
  private tradeCounter = 0;
  private processedFundingSettlements = new Set<string>();
  private lastFundingCheckTime: number | null = null;
  private totalFeesPaid = 0;
  private totalFundingPaid = 0;
  private totalSlippagePaid = 0;
  private dataQuality: ReturnType<PointInTimeFeed['checkQuality']> | null = null;
  private roiEngine: MinimalRoiEngine | null = null;
  private trailingEngine: DynamicTrailingStopEngine | null = null;

  constructor(config: BacktestConfig = { initialCapital: 1000 }) {
    this.config = {
      initialCapital: config.initialCapital,
      takerFeeRate: config.takerFeeRate ?? 0.00055,
      makerFeeRate: config.makerFeeRate ?? 0.0002,
      slippageBps: config.slippageBps ?? 5,
      maintenanceMarginRate: config.maintenanceMarginRate ?? 0.005,
      fundingIntervalHours: config.fundingIntervalHours ?? 8,
      defaultFundingRate: config.defaultFundingRate ?? 0.0001,
      maxLeverage: config.maxLeverage ?? 5,
      enableMinimalRoi: config.enableMinimalRoi ?? false,
      minimalRoiTable: config.minimalRoiTable ?? [],
      enableTrailingStop: config.enableTrailingStop ?? false,
      trailingStopConfig: config.trailingStopConfig ?? {},
    };
    this.cashBalance = this.config.initialCapital;
    if (config.enableMinimalRoi) {
      this.roiEngine = new MinimalRoiEngine(config.minimalRoiTable);
    }
    if (config.enableTrailingStop) {
      this.trailingEngine = new DynamicTrailingStopEngine(config.trailingStopConfig);
    }
  }

  /**
   * Calculates liquidation price for isolated perpetual position.
   */
  public calculateLiquidationPrice(
    side: 'LONG' | 'SHORT',
    entryPrice: number,
    leverage: number,
    mmr: number
  ): number {
    if (side === 'LONG') {
      return entryPrice * (1 - 1 / leverage + mmr);
    } else {
      return entryPrice * (1 + 1 / leverage - mmr);
    }
  }

  /**
   * Runs backtest over historical candles using the provided strategy callback.
   */
  public run(
    candles: PITCandle[],
    fundingRates: PITFundingRate[] = [],
    strategy: StrategyFn
  ): BacktestMetrics {
    const feed = new PointInTimeFeed(candles, fundingRates);
    const sortedCandles = feed.asOf(Number.MAX_SAFE_INTEGER);

    // Initialize state
    this.cashBalance = this.config.initialCapital;
    this.openPositions = [];
    this.closedTrades = [];
    this.equityCurve = [];
    this.tradeCounter = 0;
    this.processedFundingSettlements = new Set();
    this.lastFundingCheckTime = null;
    this.totalFeesPaid = 0;
    this.totalFundingPaid = 0;
    this.totalSlippagePaid = 0;
    this.dataQuality = sortedCandles.length > 0
      ? feed.checkQuality(sortedCandles[sortedCandles.length - 1].closedAt)
      : feed.checkQuality(0);

    if (sortedCandles.length === 0) return this.generateMetrics();

    for (const bar of sortedCandles) {
      // 1. Process Funding Settlement if applicable
      this.processFunding(bar.closedAt, feed);

      // 2. Check Exits on Active Positions against the Current Bar (Stop, TP, Liquidation)
      this.processPositionExits(bar);

      // 3. Query Strategy for Decisions
      const strategyFeed = feed.pointInTimeView(bar.closedAt);
      const signal = strategy(strategyFeed, bar, [...this.openPositions]);

      // 4. Execute Strategy Signal if triggered
      if (signal) {
        this.processSignal(signal, bar);
      }

      // 5. Record Equity Snapshot
      this.recordEquitySnapshot(bar.closedAt, bar.close);
    }

    return this.generateMetrics();
  }

  private processFunding(currentTimestamp: number, feed: PointInTimeFeed): void {
    const previousTimestamp = this.lastFundingCheckTime;
    this.lastFundingCheckTime = currentTimestamp;
    if (previousTimestamp === null) return;

    const intervals = new Set([...feed.fundingIntervals(this.config.fundingIntervalHours), this.config.fundingIntervalHours]);
    for (const intervalHours of intervals) {
      const intervalMs = intervalHours * 60 * 60 * 1000;
      let settlement = Math.floor(previousTimestamp / intervalMs) * intervalMs + intervalMs;
      while (settlement <= currentTimestamp) {
        const settlementKey = `${intervalHours}:${settlement}`;
        if (PointInTimeFeed.isFundingSettlementWindow(settlement, intervalHours)
          && !this.processedFundingSettlements.has(settlementKey)) {
          const rateRecord = feed.getFundingRateAt(settlement);
          // A historical interval change replaces the prior clock; it does not add a second funding stream.
          if ((rateRecord?.intervalHours ?? this.config.fundingIntervalHours) !== intervalHours) {
            settlement += intervalMs;
            continue;
          }
          this.processedFundingSettlements.add(settlementKey);
          const fundingRate = rateRecord
            ? rateRecord.rate
            : this.config.defaultFundingRate;
          for (const pos of this.openPositions) {
            const positionNotional = pos.qty * pos.entryPrice;
            const fundingPayment = pos.side === 'LONG'
              ? positionNotional * fundingRate
              : -positionNotional * fundingRate;
            pos.accumulatedFunding += fundingPayment;
            this.cashBalance -= fundingPayment;
            this.totalFundingPaid += fundingPayment;
          }
        }
        settlement += intervalMs;
      }
    }
  }

  private processPositionExits(bar: PITCandle): void {
    const remaining: BacktestPosition[] = [];

    for (const pos of this.openPositions) {
      let exitReason: ExitReason | null = null;
      let exitPrice = 0;

      // OHLC bars do not reveal intrabar ordering. Protective exits take precedence over close-based ROI.
      if (pos.side === 'LONG') {
          // Liquidation check
          if (bar.low <= pos.liquidationPrice) {
            exitReason = 'LIQUIDATION';
            exitPrice = pos.liquidationPrice;
          }
          // Stop Loss / Trailing Stop check
          else if (bar.low <= pos.stopPrice) {
            exitReason = pos.trailingState?.isActivated ? 'TRAILING_STOP' : 'STOP_LOSS';
            // Gap-down execution slippage
            const slippageFactor = 1 - (this.config.slippageBps / 10_000);
            exitPrice = Math.min(pos.stopPrice, bar.open) * slippageFactor;
          }
          // Take Profit check
          else if (pos.tpPrice && bar.high >= pos.tpPrice) {
            exitReason = 'TAKE_PROFIT';
            exitPrice = pos.tpPrice;
          }
      } else {
          // Short position
          // Liquidation check
          if (bar.high >= pos.liquidationPrice) {
            exitReason = 'LIQUIDATION';
            exitPrice = pos.liquidationPrice;
          }
          // Stop Loss / Trailing Stop check
          else if (bar.high >= pos.stopPrice) {
            exitReason = pos.trailingState?.isActivated ? 'TRAILING_STOP' : 'STOP_LOSS';
            // Gap-up execution slippage
            const slippageFactor = 1 + (this.config.slippageBps / 10_000);
            exitPrice = Math.max(pos.stopPrice, bar.open) * slippageFactor;
          }
          // Take Profit check
          else if (pos.tpPrice && bar.low <= pos.tpPrice) {
            exitReason = 'TAKE_PROFIT';
            exitPrice = pos.tpPrice;
          }
      }

      if (!exitReason && this.roiEngine) {
        const durationMin = Math.max(0, (bar.closedAt - pos.entryTime) / 60_000);
        const grossPnL = pos.side === 'LONG'
          ? (bar.close - pos.entryPrice) * pos.qty
          : (pos.entryPrice - bar.close) * pos.qty;
        if (this.roiEngine.shouldTakeProfit(durationMin, (grossPnL / pos.initialMargin) * 100)) {
          exitReason = 'MINIMAL_ROI';
          exitPrice = bar.close;
        }
      }

      if (exitReason) {
        this.closePosition(pos, exitPrice, bar.closedAt, exitReason);
      } else {
        // Dynamic Trailing Stop update for surviving positions
        if (this.trailingEngine && pos.trailingState) {
          this.trailingEngine.updateStop(pos.trailingState, bar.close);
          pos.stopPrice = pos.trailingState.currentStopPrice;
        }
        remaining.push(pos);
      }
    }

    this.openPositions = remaining;
  }

  private processSignal(signal: StrategySignal, bar: PITCandle): void {
    if (signal.action === 'CLOSE') {
      const remaining: BacktestPosition[] = [];
      for (const pos of this.openPositions) {
        if (pos.symbol === signal.symbol) {
          this.closePosition(pos, bar.close, bar.closedAt, 'SIGNAL_CLOSE');
        } else {
          remaining.push(pos);
        }
      }
      this.openPositions = remaining;
      return;
    }

    if (signal.action === 'OPEN_LONG' || signal.action === 'OPEN_SHORT') {
      // Enforce stop loss requirement (core Mpu Gandring invariant)
      if (typeof signal.stopPrice !== 'number' || signal.stopPrice <= 0) {
        return; // Fail closed: order rejected if no valid stop loss
      }

      const side: 'LONG' | 'SHORT' = signal.action === 'OPEN_LONG' ? 'LONG' : 'SHORT';
      const leverage = Math.min(signal.leverage ?? this.config.maxLeverage, this.config.maxLeverage);
      const requestedMargin = Math.max(0, signal.sizeUsdt ?? 200);
      const feeRate = leverage * this.config.takerFeeRate;
      const allocatedMargin = Math.min(requestedMargin, this.cashBalance / (1 + feeRate));

      if (allocatedMargin < 10) return; // Below minimum trade size

      // Account for entry slippage (taker)
      const slippageOffset = bar.close * (this.config.slippageBps / 10_000);
      const entryPrice = side === 'LONG' ? bar.close + slippageOffset : bar.close - slippageOffset;
      const notional = allocatedMargin * leverage;
      const qty = notional / entryPrice;

      // Deduct taker fee
      const fee = notional * this.config.takerFeeRate;
      const entrySlippagePaid = notional * (this.config.slippageBps / 10_000);
      this.cashBalance -= (allocatedMargin + fee);
      this.totalFeesPaid += fee;
      this.totalSlippagePaid += entrySlippagePaid;

      const liqPrice = this.calculateLiquidationPrice(
        side,
        entryPrice,
        leverage,
        this.config.maintenanceMarginRate
      );

      let trailingState: TrailingPositionState | undefined;
      if (this.trailingEngine) {
        trailingState = this.trailingEngine.initializePosition(side, entryPrice, signal.stopPrice);
      }

      this.tradeCounter++;
      const pos: BacktestPosition = {
        id: `bt-pos-${this.tradeCounter}`,
        symbol: signal.symbol,
        side,
        entryPrice,
        qty,
        leverage,
        initialMargin: allocatedMargin,
        stopPrice: signal.stopPrice,
        tpPrice: signal.tpPrice,
        entryTime: bar.closedAt,
        liquidationPrice: liqPrice,
        accumulatedFunding: 0,
        entrySlippagePaid,
        trailingState,
      };

      this.openPositions.push(pos);
    }
  }

  private closePosition(
    pos: BacktestPosition,
    exitPrice: number,
    exitTime: number,
    reason: ExitReason
  ): void {
    const notional = pos.qty * exitPrice;
    const entryNotional = pos.qty * pos.entryPrice;

    // Gross PnL
    const grossPnL = pos.side === 'LONG'
      ? (exitPrice - pos.entryPrice) * pos.qty
      : (pos.entryPrice - exitPrice) * pos.qty;

    // Taker fee on exit
    const exitFee = notional * this.config.takerFeeRate;
    const entryFee = entryNotional * this.config.takerFeeRate;
    const feesPaid = entryFee + (reason === 'LIQUIDATION' ? 0 : exitFee);

    // Slippage impact estimate
    const exitSlippagePaid = notional * (this.config.slippageBps / 10_000);
    const slippagePaid = pos.entrySlippagePaid + exitSlippagePaid;
    let liquidationAdjustment = 0;

    // For liquidation, maximum loss is initial margin
    if (reason === 'LIQUIDATION') {
      // The unrecovered residual margin reconciles mark-to-liquidation gross PnL with the isolated-margin loss.
      liquidationAdjustment = -pos.initialMargin - grossPnL;
      // Initial margin and entry costs have already left cash; liquidation returns no margin.
    } else {
      // Entry fee and funding were already debited from cash. Only return margin plus gross PnL less exit fee.
      this.cashBalance += Math.max(0, pos.initialMargin + grossPnL - exitFee);
    }
    const netPnL = grossPnL - feesPaid - pos.accumulatedFunding + liquidationAdjustment;
    if (reason !== 'LIQUIDATION') this.totalFeesPaid += exitFee;
    this.totalSlippagePaid += exitSlippagePaid;

    const trade: BacktestTrade = {
      id: pos.id,
      symbol: pos.symbol,
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice,
      qty: pos.qty,
      leverage: pos.leverage,
      initialMargin: pos.initialMargin,
      entryTime: pos.entryTime,
      exitTime,
      durationMs: exitTime - pos.entryTime,
      grossPnL,
      feesPaid,
      fundingPaid: pos.accumulatedFunding,
      slippagePaid,
      liquidationAdjustment,
      netPnL,
      roiPct: (netPnL / pos.initialMargin) * 100,
      exitReason: reason,
    };

    this.closedTrades.push(trade);
  }

  private recordEquitySnapshot(timestamp: number, currentPrice: number): void {
    let unrealizedPnL = 0;
    for (const pos of this.openPositions) {
      const pnl = pos.side === 'LONG'
        ? (currentPrice - pos.entryPrice) * pos.qty
        : (pos.entryPrice - currentPrice) * pos.qty;
      unrealizedPnL += pnl;
    }

    const marginInUse = this.openPositions.reduce((acc, p) => acc + p.initialMargin, 0);
    const totalEquity = this.cashBalance + marginInUse + unrealizedPnL;

    this.equityCurve.push({
      timestamp,
      equity: Math.max(0, totalEquity),
      cashBalance: this.cashBalance,
      unrealizedPnL,
      openPositionCount: this.openPositions.length,
    });
  }

  private generateMetrics(): BacktestMetrics {
    const finalEquity = this.equityCurve.length > 0
      ? this.equityCurve[this.equityCurve.length - 1].equity
      : this.cashBalance;

    const netPnL = finalEquity - this.config.initialCapital;
    const roiPct = (netPnL / this.config.initialCapital) * 100;

    let grossProfit = 0;
    let grossLoss = 0;
    let winningTrades = 0;
    let losingTrades = 0;
    let breakEvenTrades = 0;
    let totalFeesPaid = this.totalFeesPaid;
    let totalFundingPaid = this.totalFundingPaid;
    let totalSlippagePaid = this.totalSlippagePaid;

    for (const t of this.closedTrades) {
      if (t.netPnL > 0) {
        grossProfit += t.netPnL;
        winningTrades++;
      } else if (t.netPnL < 0) {
        grossLoss += Math.abs(t.netPnL);
        losingTrades++;
      } else {
        breakEvenTrades++;
      }
    }

    const totalTrades = this.closedTrades.length;
    const winRatePct = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;
    const profitFactor = grossLoss > 0
      ? grossProfit / grossLoss
      : grossProfit > 0 ? 999 : 0;
    const expectancyUsdt = totalTrades > 0 ? netPnL / totalTrades : 0;

    // Calculate Max Drawdown
    let peak = this.config.initialCapital;
    let maxDrawdownUsdt = 0;
    let maxDrawdownPct = 0;

    for (const pt of this.equityCurve) {
      if (pt.equity > peak) {
        peak = pt.equity;
      }
      const ddUsdt = peak - pt.equity;
      const ddPct = peak > 0 ? (ddUsdt / peak) * 100 : 0;
      if (ddUsdt > maxDrawdownUsdt) maxDrawdownUsdt = ddUsdt;
      if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
    }

    // Calculate Sharpe & Sortino (Periodic returns)
    let sharpeRatio = 0;
    let sortinoRatio = 0;

    if (this.equityCurve.length > 1) {
      const returns: number[] = [];
      const downsideReturns: number[] = [];
      for (let i = 1; i < this.equityCurve.length; i++) {
        const prev = this.equityCurve[i - 1].equity;
        const curr = this.equityCurve[i].equity;
        const r = prev > 0 ? (curr - prev) / prev : 0;
        returns.push(r);
        if (r < 0) downsideReturns.push(r);
      }

      if (returns.length > 0) {
        const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((a, b) => a + Math.pow(b - meanReturn, 2), 0) / returns.length;
        const stdDev = Math.sqrt(variance);

        // Annualized scaling assuming 1h bars (~8760 periods/year)
        const annualizationFactor = Math.sqrt(8760);
        if (stdDev > 0) {
          sharpeRatio = (meanReturn / stdDev) * annualizationFactor;
        }

        const downsideVariance = downsideReturns.length > 0
          ? downsideReturns.reduce((a, b) => a + Math.pow(b, 2), 0) / returns.length
          : 0;
        const downsideStdDev = Math.sqrt(downsideVariance);
        if (downsideStdDev > 0) {
          sortinoRatio = (meanReturn / downsideStdDev) * annualizationFactor;
        }
      }
    }

    return {
      initialCapital: this.config.initialCapital,
      finalEquity,
      netPnL,
      roiPct,
      grossProfit,
      grossLoss,
      profitFactor: Number(profitFactor.toFixed(2)),
      totalTrades,
      winningTrades,
      losingTrades,
      breakEvenTrades,
      winRatePct: Number(winRatePct.toFixed(2)),
      expectancyUsdt: Number(expectancyUsdt.toFixed(2)),
      maxDrawdownUsdt: Number(maxDrawdownUsdt.toFixed(2)),
      maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
      sharpeRatio: Number(sharpeRatio.toFixed(2)),
      sortinoRatio: Number(sortinoRatio.toFixed(2)),
      totalFeesPaid: Number(totalFeesPaid.toFixed(8)),
      totalFundingPaid: Number(totalFundingPaid.toFixed(8)),
      totalSlippagePaid: Number(totalSlippagePaid.toFixed(8)),
      dataQuality: this.dataQuality ?? {
        status: 'EMPTY', lastClosedBarTime: null, gapCount: 0, stalenessMs: 0, totalBars: 0, invalidRecordCount: 0,
      },
      trades: this.closedTrades,
      equityCurve: this.equityCurve,
    };
  }
}
