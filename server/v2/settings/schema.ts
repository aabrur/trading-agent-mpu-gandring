import { z } from 'zod';
import {
  APP_MODES,
  EXCHANGES,
  NETWORKS,
  ROLE_IDS,
  TRADING_MODES
} from '../contracts.js';

export const LIVE_CONFIRM_PHRASE = 'I understand LIVE trades real money';

export const API_PROVIDERS = [
  'xai',
  'openai',
  'anthropic',
  'gemini',
  'deepseek',
  'openrouter',
  'groq',
  'mistral',
  'together',
  'fireworks'
] as const;
export type ApiProviderId = (typeof API_PROVIDERS)[number];

export const MODEL_PROVIDERS = ['unconfigured', 'local', ...API_PROVIDERS] as const;
export type ModelProviderId = (typeof MODEL_PROVIDERS)[number];

export const REASONING_LEVELS = ['none', 'low', 'medium', 'high', 'xhigh'] as const;
export type ReasoningEffort = (typeof REASONING_LEVELS)[number];

export const TradingFields = z
  .object({
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
  })
  .strict();

export const TradingSettingsSchema = TradingFields;
export type TradingSettings = z.infer<typeof TradingFields>;

export const TRADING_PRESET_IDS = ['default', 'balance', 'profit', 'aggressive'] as const;
export type TradingPresetId = (typeof TRADING_PRESET_IDS)[number];

export const TRADING_PROFILES = ['current', ...TRADING_PRESET_IDS, 'manual'] as const;
export type TradingProfile = (typeof TRADING_PROFILES)[number];

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
  safetyNet: 200,
  maxPositions: 3
});

export const TRADING_PRESETS: Record<
  TradingPresetId,
  {
    name: string;
    description: string;
    values: Omit<TradingSettings, 'minOrderUsdt' | 'maxOrderUsdt' | 'safetyNet' | 'orderSizePct'>;
  }
> = {
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

export function resolveTradingPresetValues(
  preset: TradingPresetId,
  savedBase: TradingSettings
): TradingSettings {
  const presetValues = TRADING_PRESETS[preset].values;
  return TradingSettingsSchema.parse({
    ...presetValues,
    maxOrderUsdt: savedBase.maxOrderUsdt ?? 0,
    minOrderUsdt: savedBase.minOrderUsdt ?? DEFAULT_TRADING_SETTINGS.minOrderUsdt,
    safetyNet: savedBase.safetyNet ?? DEFAULT_TRADING_SETTINGS.safetyNet,
    ...(savedBase.orderSizePct !== undefined ? { orderSizePct: savedBase.orderSizePct } : {})
  });
}

export const PreferencesBody = z
  .object({
    appMode: z.enum(['local', 'grokbot']),
    balance: z.number().finite().nonnegative(),
    safetyNet: z.number().finite().nonnegative(),
    n: z.number().int().min(1).max(4),
    dailyLoss: z.number().finite().min(0.1).max(100),
    auto: z.boolean(),
    debateInterval: z.number().int().min(1).max(1440),
    reportInterval: z.number().int().min(1).max(1440),
    maxHoldHours: z.number().int().min(0).max(720).optional().default(0)
  })
  .strict()
  .refine((v) => v.safetyNet <= v.balance, {
    message: 'Safety net must not exceed paper balance.'
  });

export const RoleAgentConfigSchema = z
  .object({
    provider: z.enum(MODEL_PROVIDERS),
    model: z.string().min(1),
    reasoning: z.enum(REASONING_LEVELS).optional(),
    route: z.enum(['LOCAL', 'GROK', 'MIRROR_READ_ONLY']).default('LOCAL')
  })
  .strict();

export const PaperSettingsSchema = z
  .object({
    balance: z.number().finite().nonnegative(),
    safetyNet: z.number().finite().nonnegative(),
    n: z.number().int().min(1).max(4)
  })
  .strict();

export const AutoSettingsSchema = z
  .object({
    on: z.boolean(),
    intervalMin: z.number().int().min(1).max(1440),
    reportIntervalMin: z.number().int().min(1).max(1440),
    maxHoldHours: z.number().int().min(0).max(720),
    symbols: z.array(z.string().min(2).max(30)).min(1).max(100),
    connectedConsensus: z.boolean().default(false)
  })
  .strict();

export const JevSettingsSchema = z
  .object({
    enabled: z.boolean(),
    provider: z.string().min(1).default('openrouter'),
    model: z.string().min(1).default('openai/gpt-5-mini'),
    mode: z.enum(['off', 'advisory', 'strict']).default('off'),
    allowLive: z.boolean().default(false)
  })
  .strict();

export const DataSourcesSettingsSchema = z
  .object({
    newsProvider: z.enum(['none', 'cryptopanic']).default('none'),
    whaleAlertEnabled: z.boolean().default(false),
    cmcEnabled: z.boolean().default(false),
    coinglassEnabled: z.boolean().default(false),
    arkhamEnabled: z.boolean().default(false),
    fredEnabled: z.boolean().default(false)
  })
  .strict();

export const PreferencesSettingsSchema = z
  .object({
    theme: z.enum(['day', 'night']).default('day'),
    language: z.enum(['en', 'id']).default('en'),
    currency: z.enum(['USD', 'IDR']).default('USD'),
    tradingviewWidget: z.boolean().default(false),
    tradingviewWebhook: z.boolean().default(false),
    tradingviewPrefix: z.string().min(1).max(30).default('BYBIT:'),
    debateMode: z.enum(['normal', 'fast']).default('normal'),
    fightThreshold: z.number().finite().min(0.05).max(1).default(0.35)
  })
  .strict();

export const ChannelsSettingsSchema = z
  .object({
    commandsEnabled: z.boolean().default(false),
    supervisorIntervalMin: z.number().int().min(1).max(1440).default(10),
    telegramEnabled: z.boolean().default(false),
    discordEnabled: z.boolean().default(false),
    slackEnabled: z.boolean().default(false),
    whatsappEnabled: z.boolean().default(false),
    ownerAllowlist: z.array(z.string().min(1).max(120)).default([])
  })
  .strict();

export const VenueSelectionSchema = z
  .object({
    exchange: z.enum(EXCHANGES).nullable(),
    network: z.enum(NETWORKS).nullable(),
    allowExperimentalLive: z.boolean().default(false),
    asterEntryOrderType: z.enum(['MARKET', 'LIMIT_GTC']).default('MARKET')
  })
  .strict();

export const OwnerSettingsSchema = z
  .object({
    mode: z.enum(TRADING_MODES),
    appMode: z.enum(APP_MODES),
    tradingProfile: z.enum(TRADING_PROFILES),
    trading: TradingSettingsSchema,
    networkProfiles: z
      .object({
        testnet: TradingSettingsSchema.optional(),
        mainnet: TradingSettingsSchema.optional()
      })
      .strict()
      .default({}),
    paper: PaperSettingsSchema,
    venue: VenueSelectionSchema,
    watchlist: z.array(z.string().min(2).max(30)).min(1).max(100),
    auto: AutoSettingsSchema,
    agents: z
      .object({
        lead: RoleAgentConfigSchema,
        market: RoleAgentConfigSchema,
        research: RoleAgentConfigSchema,
        strategist: RoleAgentConfigSchema,
        risk: RoleAgentConfigSchema,
        execution: RoleAgentConfigSchema
      })
      .strict(),
    jev: JevSettingsSchema,
    dataSources: DataSourcesSettingsSchema,
    preferences: PreferencesSettingsSchema,
    channels: ChannelsSettingsSchema
  })
  .strict();

export type OwnerSettings = z.infer<typeof OwnerSettingsSchema>;

export const OwnerSettingsPatchSchema = z
  .object({
    mode: z.enum(TRADING_MODES).optional(),
    appMode: z.enum(APP_MODES).optional(),
    tradingProfile: z.enum(TRADING_PROFILES).optional(),
    trading: TradingFields.partial().optional(),
    networkProfiles: z
      .object({
        testnet: TradingFields.partial().optional(),
        mainnet: TradingFields.partial().optional()
      })
      .strict()
      .optional(),
    paper: PaperSettingsSchema.partial().optional(),
    venue: VenueSelectionSchema.partial().optional(),
    watchlist: z.array(z.string().min(2).max(30)).min(1).max(100).optional(),
    auto: AutoSettingsSchema.partial().optional(),
    agents: z
      .record(z.enum(ROLE_IDS), RoleAgentConfigSchema.partial())
      .optional(),
    jev: JevSettingsSchema.partial().optional(),
    dataSources: DataSourcesSettingsSchema.partial().optional(),
    preferences: PreferencesSettingsSchema.partial().optional(),
    channels: ChannelsSettingsSchema.partial().optional()
  })
  .strict();

export type OwnerSettingsPatch = z.infer<typeof OwnerSettingsPatchSchema>;
