import { z } from 'zod';
import { readEnv, setEnv } from '../../cli/envfile.js';
import { loadConfig } from '../config.js';
import { DEFAULT_TRADING_SETTINGS, TRADING_ENV, TRADING_PRESETS, TradingSettingsSchema, manualTradingOverrides, resolveTradingPreset, resolveTradingSettings, tradingPrefix, tradingSettingsFromConfig } from '../trading-settings.js';

export const TradingProfileBody = z.discriminatedUnion('profile', [
  z.object({ network: z.enum(['testnet', 'mainnet']), profile: z.literal('default'), values: TradingSettingsSchema.optional() }).strict(),
  z.object({ network: z.enum(['testnet', 'mainnet']), profile: z.literal('balance'), values: TradingSettingsSchema.optional() }).strict(),
  z.object({ network: z.enum(['testnet', 'mainnet']), profile: z.literal('profit'), values: TradingSettingsSchema.optional() }).strict(),
  z.object({ network: z.enum(['testnet', 'mainnet']), profile: z.literal('high_risk'), values: TradingSettingsSchema.optional() }).strict(),
  z.object({ network: z.enum(['testnet', 'mainnet']), profile: z.literal('manual'), values: TradingSettingsSchema }).strict()
]);
export function tradingSetupInfo(env: NodeJS.ProcessEnv) {
  const base = tradingSettingsFromConfig(loadConfig({ ...env, TRADING_MODE: 'PAPER' }));
  return { defaults: DEFAULT_TRADING_SETTINGS, presets: TRADING_PRESETS, networks: Object.fromEntries((['testnet', 'mainnet'] as const).map((network) => [network, { ...resolveTradingSettings(env, base, network), manual: { ...base, ...manualTradingOverrides(env, network) } }])) };
}
export function saveTradingProfile(file: string, input: unknown) {
  const data = TradingProfileBody.parse(input), prefix = tradingPrefix(data.network);
  const updates: Record<string, string> = { [prefix + 'PROFILE']: data.profile };
  if (data.profile === 'manual') for (const [key, value] of Object.entries(data.values)) updates[prefix + TRADING_ENV[key as keyof typeof TRADING_ENV]] = String(value);
  const fileEnv = readEnv(file);
  const cleanEnv: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(cleanEnv)) {
    if (k.startsWith('TESTNET_DESK_') || k.startsWith('MAINNET_DESK_')) delete cleanEnv[k];
  }
  const env = { ...cleanEnv, ...fileEnv, [prefix + 'PROFILE']: data.profile };
  const base = tradingSettingsFromConfig(loadConfig({ ...env, TRADING_MODE: 'PAPER' }));
  // Freeze the reviewed values separately so later preset edits cannot rewrite owner intent.
  const values = data.profile === 'manual' ? data.values : data.values ?? resolveTradingPreset(data.profile, { ...base, ...manualTradingOverrides(env, data.network) });
  if (data.profile !== 'manual') {
    updates[prefix + 'SAVED_PROFILE'] = data.profile;
    for (const [key, value] of Object.entries(values)) updates[prefix + 'SAVED_' + TRADING_ENV[key as keyof typeof TRADING_ENV]] = String(value);
  }
  setEnv(file, updates);
  return { ...data, values };
}
