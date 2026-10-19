import { z } from 'zod';
import { setEnv } from '../../cli/envfile.js';
import { loadConfig } from '../config.js';
import { DEFAULT_TRADING_SETTINGS, TRADING_ENV, TradingSettingsSchema, manualTradingOverrides, resolveTradingSettings, tradingPrefix, tradingSettingsFromConfig } from '../trading-settings.js';

export const TradingProfileBody = z.discriminatedUnion('profile', [
  z.object({ network: z.enum(['testnet', 'mainnet']), profile: z.literal('default') }).strict(),
  z.object({ network: z.enum(['testnet', 'mainnet']), profile: z.literal('manual'), values: TradingSettingsSchema }).strict()
]);
export function tradingSetupInfo(env: NodeJS.ProcessEnv) {
  const base = tradingSettingsFromConfig(loadConfig({ ...env, TRADING_MODE: 'PAPER' }));
  return { defaults: DEFAULT_TRADING_SETTINGS, networks: Object.fromEntries((['testnet', 'mainnet'] as const).map((network) => [network, { ...resolveTradingSettings(env, base, network), manual: { ...base, ...manualTradingOverrides(env, network) } }])) };
}
export function saveTradingProfile(file: string, input: unknown) {
  const data = TradingProfileBody.parse(input), prefix = tradingPrefix(data.network);
  const updates: Record<string, string> = { [prefix + 'PROFILE']: data.profile };
  if (data.profile === 'manual') for (const [key, value] of Object.entries(data.values)) updates[prefix + TRADING_ENV[key as keyof typeof TRADING_ENV]] = String(value);
  setEnv(file, updates);
  return { ...data, values: data.profile === 'manual' ? data.values : { ...DEFAULT_TRADING_SETTINGS } };
}
