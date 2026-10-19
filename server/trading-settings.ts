import { z } from 'zod';

export const TradingFields = z.object({
  dailyLossLimitPct: z.number().finite().min(0.5).max(20),
  maxLossPerTradePct: z.number().finite().positive().max(100),
  minEntryConfidencePct: z.number().finite().min(0).max(100),
  maxLeverage: z.number().int().min(1).max(100),
  defaultStopPct: z.number().finite().positive().lt(100),
  minStopPct: z.number().finite().positive().lt(100),
  takeProfitR: z.number().finite().nonnegative(),
  minOrderUsdt: z.number().finite().positive(),
  safetyNet: z.number().finite().positive(),
  maxPositions: z.number().int().min(1).max(4)
}).strict();
export const TradingSettingsSchema = TradingFields.refine((v) => v.minStopPct <= v.defaultStopPct, { message: 'Minimum stop must not exceed maximum stop.', path: ['minStopPct'] });
export type TradingSettings = z.infer<typeof TradingFields>;
export type TradingProfile = 'current' | 'default' | 'manual';
export type TradingNetwork = 'testnet' | 'mainnet';
export const DEFAULT_TRADING_SETTINGS: Readonly<TradingSettings> = Object.freeze({ dailyLossLimitPct: 3, maxLossPerTradePct: 1, minEntryConfidencePct: 0, maxLeverage: 3, defaultStopPct: 1.5, minStopPct: 0.3, takeProfitR: 2, minOrderUsdt: 5, safetyNet: 200, maxPositions: 4 });
export const TRADING_ENV: Record<keyof TradingSettings, string> = { dailyLossLimitPct: 'DAILY_LOSS_LIMIT_PCT', maxLossPerTradePct: 'MAX_LOSS_PER_TRADE_PCT', minEntryConfidencePct: 'MIN_ENTRY_CONFIDENCE_PCT', maxLeverage: 'MAX_LEVERAGE', defaultStopPct: 'DEFAULT_STOP_PCT', minStopPct: 'MIN_STOP_PCT', takeProfitR: 'TAKE_PROFIT_R', minOrderUsdt: 'MIN_ORDER_USDT', safetyNet: 'SAFETY_NET', maxPositions: 'OPEN_ORDERS_N' };
export const tradingPrefix = (network: TradingNetwork) => network.toUpperCase() + '_DESK_';
export function selectedTradingProfile(env: Record<string, string | undefined>, network: TradingNetwork): TradingProfile {
  const value = env[tradingPrefix(network) + 'PROFILE'] || 'current';
  if (!['current', 'default', 'manual'].includes(value)) throw new Error('Invalid ' + network + ' desk profile');
  return value as TradingProfile;
}
export function manualTradingOverrides(env: Record<string, string | undefined>, network: TradingNetwork): Partial<TradingSettings> {
  const values: Record<string, number> = {};
  for (const [key, name] of Object.entries(TRADING_ENV)) {
    const raw = env[tradingPrefix(network) + name];
    if (raw != null && raw !== '') values[key] = Number(raw);
  }
  return TradingFields.partial().parse(values);
}
export function tradingSettingsFromConfig(cfg: { risk: Omit<TradingSettings, 'safetyNet' | 'maxPositions'> & { takerFee: number }; paper: { safetyNet: number; n: number } }): TradingSettings {
  const { takerFee: _fee, ...risk } = cfg.risk;
  return { ...risk, safetyNet: cfg.paper.safetyNet, maxPositions: cfg.paper.n };
}
export function resolveTradingSettings(env: Record<string, string | undefined>, base: TradingSettings, network: TradingNetwork) {
  const profile = selectedTradingProfile(env, network);
  const values = profile === 'current' ? { ...base } : profile === 'default' ? { ...DEFAULT_TRADING_SETTINGS } : TradingSettingsSchema.parse({ ...base, ...manualTradingOverrides(env, network) });
  return { profile, values };
}
export function entryConfidenceReason(minimumPct: number, confidence?: number): string | null {
  if (minimumPct <= 0) return null;
  if (confidence == null || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return `Entry requires reported confidence of at least ${minimumPct}%; confidence is unavailable.`;
  return confidence < minimumPct / 100 ? `Entry confidence ${(confidence * 100).toFixed(1)}% is below the configured ${minimumPct}% minimum.` : null;
}
