import type { PITCandle, PITFundingRate } from '../../research/pit.js';
import { PointInTimeFeed } from '../../research/pit.js';
import {
  PerpBacktestEngine,
  type BacktestConfig,
  type BacktestMetrics,
  type StrategyFn
} from '../../research/backtest.js';

export interface BacktestInput {
  symbol: string;
  candles: PITCandle[];
  fundingRates?: PITFundingRate[];
  config?: Partial<BacktestConfig>;
  strategy?: StrategyFn;
}

export type BacktestResult = BacktestMetrics;

/**
 * Clean-room deterministic backtest runner.
 * Never imports live gateway, wallet signers, or live exchange adapters.
 */
export async function runBacktest(input: BacktestInput): Promise<BacktestResult> {
  const engine = new PerpBacktestEngine({
    initialCapital: input.config?.initialCapital ?? 1000,
    takerFeeRate: input.config?.takerFeeRate ?? 0.00055,
    makerFeeRate: input.config?.makerFeeRate ?? 0.0002,
    slippageBps: input.config?.slippageBps ?? 5,
    maintenanceMarginRate: input.config?.maintenanceMarginRate ?? 0.005,
    fundingIntervalHours: input.config?.fundingIntervalHours ?? 8,
    defaultFundingRate: input.config?.defaultFundingRate ?? 0.0001,
    maxLeverage: input.config?.maxLeverage ?? 5,
    enableMinimalRoi: input.config?.enableMinimalRoi ?? false,
    minimalRoiTable: input.config?.minimalRoiTable ?? [],
    enableTrailingStop: input.config?.enableTrailingStop ?? false,
    trailingStopConfig: input.config?.trailingStopConfig ?? {}
  });

  const defaultStrategy: StrategyFn = () => null;
  const strategy = input.strategy ?? defaultStrategy;

  return engine.run(input.candles, input.fundingRates ?? [], strategy);
}
