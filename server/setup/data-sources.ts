import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { setEnv } from '../../cli/envfile.js';
import { registerSecrets } from '../redact.js';
import { resetWhaleCache } from '../market/whale.js';

const secret = z.string().max(400).refine(value => !value || /^\S+$/.test(value));
export const DataSourcesBody = z.object({ cryptoPanicKey: secret.optional(), whaleAlertKey: secret.optional() }).strict();
export function dataSourcesStatus(env: NodeJS.ProcessEnv) {
  return { newsProvider: env.NEWS_PROVIDER || 'sample', publicNewsFallback: 'Bybit announcements in LIVE/TESTNET',
    cryptoPanicKeySet: !!env.CRYPTOPANIC_API_KEY?.trim(), whaleAlertKeySet: !!env.WHALE_ALERT_API_KEY?.trim() };
}
export function saveDataSources(file: string, cfg: AppConfig, input: unknown) {
  const values = DataSourcesBody.parse(input);
  const updates: Record<string, string> = {};
  if (values.cryptoPanicKey) { updates.CRYPTOPANIC_API_KEY = values.cryptoPanicKey; updates.NEWS_PROVIDER = 'cryptopanic'; }
  if (values.whaleAlertKey) updates.WHALE_ALERT_API_KEY = values.whaleAlertKey;
  registerSecrets([values.cryptoPanicKey, values.whaleAlertKey]);
  if (Object.keys(updates).length) {
    setEnv(file, updates);
    Object.assign(process.env, updates);
    if (values.cryptoPanicKey) { cfg.news.provider = 'cryptopanic'; cfg.news.key = values.cryptoPanicKey; }
    if (values.whaleAlertKey) resetWhaleCache();
  }
  return { ok: true, detail: 'Data source settings saved. Empty fields keep existing keys. Feed availability is verified when the next collection runs.' };
}
