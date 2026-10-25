import { z } from 'zod';

export const TradingFields = z.object({
  dailyLossLimitPct: z.number().finite().min(0.5).max(25),
  maxLossPerTradePct: z.number().finite().positive().max(100),
  minEntryConfidencePct: z.number().finite().min(0).max(100),
  maxLeverage: z.number().int().min(1).max(100),
  orderSizePct: z.number().finite().min(1.5).max(100).optional(),
  defaultStopPct: z.number().finite().positive().lt(100),
  minStopPct: z.number().finite().nonnegative().lt(100),
  takeProfitPct: z.number().finite().positive().optional(),
  takeProfitR: z.number().finite().nonnegative(),
  maxOrderUsdt: z.number().finite().nonnegative().default(0),
  minOrderUsdt: z.number().finite().nonnegative(),
  safetyNet: z.number().finite().nonnegative(),
  maxPositions: z.number().int().min(1).max(4)
}).strict();

// Legacy sizing fields remain readable in saved profiles; execution uses margin SL/TP.
export const TradingSettingsSchema = TradingFields;

export type TradingSettings = z.infer<typeof TradingFields>;
export type TradingPresetId = 'default' | 'balance' | 'profit' | 'aggressive';
export type TradingProfile = 'current' | TradingPresetId | 'manual';

export const TRADING_PRESET_IDS: readonly TradingPresetId[] = ['default', 'balance', 'profit', 'aggressive'] as const;
export const TRADING_PROFILES: readonly TradingProfile[] = ['current', 'default', 'balance', 'profit', 'aggressive', 'manual'] as const;
export type TradingNetwork = 'testnet' | 'mainnet';

export const DEFAULT_TRADING_SETTINGS: Readonly<TradingSettings> = Object.freeze({
  dailyLossLimitPct: 10,
  maxLossPerTradePct: 20,
  minEntryConfidencePct: 60,
  maxLeverage: 5,
  defaultStopPct: 20,
  minStopPct: 0,
  takeProfitPct: 60,
  takeProfitR: 3.0,
  minOrderUsdt: 0,
  maxOrderUsdt: 0,
  safetyNet: 8,
  maxPositions: 3
});

export const TRADING_PRESETS: Record<TradingPresetId, {
  name: string;
  description: string;
  values: Omit<TradingSettings, 'minOrderUsdt' | 'maxOrderUsdt' | 'safetyNet' | 'orderSizePct'>;
}> = {
  default: {
    name: 'Default',
    description: 'Baseline auto-trading mode with TP 60% and SL 20%.',
    values: {
      dailyLossLimitPct: 10,
      maxLossPerTradePct: 20,
      minEntryConfidencePct: 60,
      maxLeverage: 5,
      defaultStopPct: 20,
      minStopPct: 0,
      takeProfitPct: 60,
      takeProfitR: 3.0,
      maxPositions: 3
    }
  },
  balance: {
    name: 'Balance',
    description: 'Balanced auto-trading mode with TP 60% and SL 30%.',
    values: {
      dailyLossLimitPct: 15,
      maxLossPerTradePct: 30,
      minEntryConfidencePct: 60,
      maxLeverage: 10,
      defaultStopPct: 30,
      minStopPct: 0,
      takeProfitPct: 60,
      takeProfitR: 2.0,
      maxPositions: 3
    }
  },
  profit: {
    name: 'Profit',
    description: 'Profit momentum mode with TP 70% and SL 40% of margin.',
    values: {
      dailyLossLimitPct: 20,
      maxLossPerTradePct: 40,
      minEntryConfidencePct: 60,
      maxLeverage: 15,
      defaultStopPct: 40,
      minStopPct: 0,
      takeProfitPct: 70,
      takeProfitR: 1.75,
      maxPositions: 2
    }
  },
  aggressive: {
    name: 'Aggressive',
    description: 'High risk high reward mode with TP 80% and SL 50%.',
    values: {
      dailyLossLimitPct: 25,
      maxLossPerTradePct: 50,
      minEntryConfidencePct: 60,
      maxLeverage: 20,
      defaultStopPct: 50,
      minStopPct: 0,
      takeProfitPct: 80,
      takeProfitR: 1.6,
      maxPositions: 2
    }
  }
};

export function resolveTradingPreset(preset: TradingPresetId, base: TradingSettings): TradingSettings {
  const values = preset === 'default' ? { ...DEFAULT_TRADING_SETTINGS } : { ...TRADING_PRESETS[preset].values };
  return TradingSettingsSchema.parse({
    ...values,
    maxOrderUsdt: base.maxOrderUsdt ?? 0,
    minOrderUsdt: base.minOrderUsdt ?? DEFAULT_TRADING_SETTINGS.minOrderUsdt,
    safetyNet: base.safetyNet ?? DEFAULT_TRADING_SETTINGS.safetyNet,
    ...(base.orderSizePct != null ? { orderSizePct: base.orderSizePct } : {})
  });
}

export function draftProfile(saved: TradingProfile): TradingPresetId | 'manual' {
  if (saved === 'default' || saved === 'balance' || saved === 'profit' || saved === 'aggressive' || saved === 'manual') return saved;
  return 'manual';
}

export const TRADING_ENV: Record<keyof TradingSettings, string> = {
  dailyLossLimitPct: 'DAILY_LOSS_LIMIT_PCT',
  maxLossPerTradePct: 'MAX_LOSS_PER_TRADE_PCT',
  minEntryConfidencePct: 'MIN_ENTRY_CONFIDENCE_PCT',
  maxLeverage: 'MAX_LEVERAGE',
  orderSizePct: 'ORDER_SIZE_PCT',
  defaultStopPct: 'DEFAULT_STOP_PCT',
  minStopPct: 'MIN_STOP_PCT',
  takeProfitPct: 'TAKE_PROFIT_PCT',
  takeProfitR: 'TAKE_PROFIT_R',
  minOrderUsdt: 'MIN_ORDER_USDT',
  maxOrderUsdt: 'MAX_ORDER_USDT',
  safetyNet: 'SAFETY_NET',
  maxPositions: 'OPEN_ORDERS_N'
};

export const tradingPrefix = (network: TradingNetwork) => network.toUpperCase() + '_DESK_';

export function selectedTradingProfile(env: Record<string, string | undefined>, network: TradingNetwork): TradingProfile {
  const saved = env[tradingPrefix(network) + 'PROFILE'] || 'current';
  const value = saved === 'high_risk' ? 'aggressive' : saved;
  if (!TRADING_PROFILES.includes(value as TradingProfile)) throw new Error('Invalid ' + network + ' desk profile');
  return value as TradingProfile;
}

export function manualTradingOverrides(env: Record<string, string | undefined>, network: TradingNetwork): Partial<TradingSettings> {
  const values: Record<string, number | undefined> = {};
  for (const [key, name] of Object.entries(TRADING_ENV)) {
    const raw = env[tradingPrefix(network) + name];
    if (key === 'orderSizePct' && raw === '') values[key] = undefined;
    if (raw != null && raw !== '') values[key] = Number(raw);
  }
  return TradingFields.omit({maxOrderUsdt: true}).partial().extend({maxOrderUsdt: z.number().finite().nonnegative().optional()}).parse(values);
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
    maxOrderUsdt: overrides.maxOrderUsdt ?? base.maxOrderUsdt ?? 0,
    minOrderUsdt: overrides.minOrderUsdt ?? base.minOrderUsdt ?? DEFAULT_TRADING_SETTINGS.minOrderUsdt,
    safetyNet: overrides.safetyNet ?? base.safetyNet ?? DEFAULT_TRADING_SETTINGS.safetyNet,
    orderSizePct: Object.hasOwn(overrides, 'orderSizePct') ? overrides.orderSizePct : base.orderSizePct
  };
  const values = profile === 'current'
    ? { ...base, minOrderUsdt: networkBase.minOrderUsdt, maxOrderUsdt: networkBase.maxOrderUsdt }
    : profile in TRADING_PRESETS
      ? (env[tradingPrefix(network) + 'SAVED_PROFILE'] === profile || profile === 'aggressive' && env[tradingPrefix(network) + 'SAVED_PROFILE'] === 'high_risk')
        ? TradingSettingsSchema.parse(Object.fromEntries(Object.entries(TRADING_ENV).filter(([, name]) => env[tradingPrefix(network) + 'SAVED_' + name] != null && env[tradingPrefix(network) + 'SAVED_' + name] !== '').map(([key, name]) => [key, Number(env[tradingPrefix(network) + 'SAVED_' + name])])))
        : resolveTradingPreset(profile as TradingPresetId, networkBase)
      : TradingSettingsSchema.parse({ ...base, ...overrides });
  return { profile, values };
}

export function entryConfidenceReason(minimumPct: number, confidence?: number): string | null {
  if (minimumPct <= 0) return null;
  if (confidence == null || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return `Entry requires reported confidence of at least ${minimumPct}%; confidence is unavailable.`;
  return confidence < minimumPct / 100 ? `Entry confidence ${(confidence * 100).toFixed(1)}% is below the configured ${minimumPct}% minimum.` : null;
}
