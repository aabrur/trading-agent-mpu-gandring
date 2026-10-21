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

export const TradingSettingsSchema = TradingFields.refine(
  (v) => v.minStopPct <= v.defaultStopPct,
  { message: 'Minimum stop must not exceed maximum stop.', path: ['minStopPct'] }
);

export type TradingSettings = z.infer<typeof TradingFields>;
export type TradingPresetId = 'default' | 'balance' | 'profit' | 'high_risk';
export type TradingProfile = 'current' | TradingPresetId | 'manual';

export const TRADING_PRESET_IDS: readonly TradingPresetId[] = ['default', 'balance', 'profit', 'high_risk'] as const;
export const TRADING_PROFILES: readonly TradingProfile[] = ['current', 'default', 'balance', 'profit', 'high_risk', 'manual'] as const;
export type TradingNetwork = 'testnet' | 'mainnet';

export const DEFAULT_TRADING_SETTINGS: Readonly<TradingSettings> = Object.freeze({
  dailyLossLimitPct: 4,
  maxLossPerTradePct: 1,
  minEntryConfidencePct: 55,
  maxLeverage: 3,
  defaultStopPct: 2.5,
  minStopPct: 1.0,
  takeProfitR: 2.5,
  minOrderUsdt: 5,
  safetyNet: 50,
  maxPositions: 3
});

export const TRADING_PRESETS: Record<TradingPresetId, {
  name: string;
  description: string;
  values: Omit<TradingSettings, 'minOrderUsdt' | 'safetyNet'>;
}> = {
  default: {
    name: 'Default',
    description: 'Baseline trend positioning with structural breathing room against 15m noise wicks.',
    values: {
      dailyLossLimitPct: 4,
      maxLossPerTradePct: 1,
      minEntryConfidencePct: 55,
      maxLeverage: 3,
      defaultStopPct: 2.5,
      minStopPct: 1.0,
      takeProfitR: 2.5,
      maxPositions: 3
    }
  },
  balance: {
    name: 'Balance',
    description: 'Balanced momentum and trend-following with wider stop tolerance and 3R upside.',
    values: {
      dailyLossLimitPct: 5,
      maxLossPerTradePct: 1.5,
      minEntryConfidencePct: 60,
      maxLeverage: 5,
      defaultStopPct: 3.0,
      minStopPct: 1.2,
      takeProfitR: 3.0,
      maxPositions: 3
    }
  },
  profit: {
    name: 'Profit',
    description: 'Aggressive momentum hunting combining whale flows, news catalysts, and focused capital.',
    values: {
      dailyLossLimitPct: 8,
      maxLossPerTradePct: 2.5,
      minEntryConfidencePct: 65,
      maxLeverage: 7,
      defaultStopPct: 3.8,
      minStopPct: 1.5,
      takeProfitR: 3.5,
      maxPositions: 2
    }
  },
  high_risk: {
    name: 'High Risk High Reward',
    description: 'Maximum conviction predator mode with wide structural stops, concentrated slots, and 4.5R targets.',
    values: {
      dailyLossLimitPct: 12,
      maxLossPerTradePct: 4.0,
      minEntryConfidencePct: 70,
      maxLeverage: 10,
      defaultStopPct: 4.5,
      minStopPct: 1.8,
      takeProfitR: 4.5,
      maxPositions: 2
    }
  }
};

export function resolveTradingPreset(preset: TradingPresetId, base: TradingSettings): TradingSettings {
  const values = preset === 'default' ? { ...DEFAULT_TRADING_SETTINGS } : { ...TRADING_PRESETS[preset].values };
  return TradingSettingsSchema.parse({
    ...values,
    minOrderUsdt: base.minOrderUsdt ?? DEFAULT_TRADING_SETTINGS.minOrderUsdt,
    safetyNet: base.safetyNet ?? DEFAULT_TRADING_SETTINGS.safetyNet
  });
}

export function draftProfile(saved: TradingProfile): TradingPresetId | 'manual' {
  if (saved === 'default' || saved === 'balance' || saved === 'profit' || saved === 'high_risk' || saved === 'manual') return saved;
  return 'manual';
}

export const TRADING_ENV: Record<keyof TradingSettings, string> = {
  dailyLossLimitPct: 'DAILY_LOSS_LIMIT_PCT',
  maxLossPerTradePct: 'MAX_LOSS_PER_TRADE_PCT',
  minEntryConfidencePct: 'MIN_ENTRY_CONFIDENCE_PCT',
  maxLeverage: 'MAX_LEVERAGE',
  defaultStopPct: 'DEFAULT_STOP_PCT',
  minStopPct: 'MIN_STOP_PCT',
  takeProfitR: 'TAKE_PROFIT_R',
  minOrderUsdt: 'MIN_ORDER_USDT',
  safetyNet: 'SAFETY_NET',
  maxPositions: 'OPEN_ORDERS_N'
};

export const tradingPrefix = (network: TradingNetwork) => network.toUpperCase() + '_DESK_';

export function selectedTradingProfile(env: Record<string, string | undefined>, network: TradingNetwork): TradingProfile {
  const value = env[tradingPrefix(network) + 'PROFILE'] || 'current';
  if (!TRADING_PROFILES.includes(value as TradingProfile)) throw new Error('Invalid ' + network + ' desk profile');
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
  const overrides = manualTradingOverrides(env, network);
  const networkBase: TradingSettings = {
    ...base,
    minOrderUsdt: overrides.minOrderUsdt ?? base.minOrderUsdt ?? DEFAULT_TRADING_SETTINGS.minOrderUsdt,
    safetyNet: overrides.safetyNet ?? base.safetyNet ?? DEFAULT_TRADING_SETTINGS.safetyNet
  };
  const values = profile === 'current'
    ? { ...base }
    : profile in TRADING_PRESETS
      ? env[tradingPrefix(network) + 'SAVED_PROFILE'] === profile
        ? TradingSettingsSchema.parse(Object.fromEntries(Object.entries(TRADING_ENV).map(([key, name]) => [key, Number(env[tradingPrefix(network) + 'SAVED_' + name])])))
        : resolveTradingPreset(profile as TradingPresetId, networkBase)
      : TradingSettingsSchema.parse({ ...base, ...overrides });
  return { profile, values };
}

export function entryConfidenceReason(minimumPct: number, confidence?: number): string | null {
  if (minimumPct <= 0) return null;
  if (confidence == null || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return `Entry requires reported confidence of at least ${minimumPct}%; confidence is unavailable.`;
  return confidence < minimumPct / 100 ? `Entry confidence ${(confidence * 100).toFixed(1)}% is below the configured ${minimumPct}% minimum.` : null;
}
