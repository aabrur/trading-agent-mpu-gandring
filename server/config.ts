import 'dotenv/config';
import type { AgentId } from './types.js';
import { registerSecrets } from './redact.js';
import { exchangeSettings, exchangeSecrets, ADAPTER_STATUS, type ExchangeName } from './exchange/index.js';
import { checkTradingMode, type TradingMode } from './live/guard.js';

export type ProviderName = 'mock' | 'xai' | 'openai' | 'anthropic' | 'gemini' | 'deepseek' | 'openrouter';
export const PROVIDERS: ProviderName[] = ['mock', 'xai', 'openai', 'anthropic', 'gemini', 'deepseek', 'openrouter'];
export const AGENT_IDS: AgentId[] = ['lead', 'market', 'research', 'strategist', 'risk', 'execution'];

export class ConfigError extends Error {
  constructor(message: string, public exitCode = 2) { super(message); }
}

const num = (env: NodeJS.ProcessEnv, key: string, def: number) => {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new ConfigError(`${key} must be a number`);
  return n;
};

export interface AppConfig {
  tradingMode: TradingMode;
  appMode: 'local' | 'grokbot';
  host: string;
  live: { exchange: ExchangeName; network: 'testnet' | 'mainnet'; experimental: boolean } | null;
  auto: { on: boolean; intervalMin: number; symbols: string[]; maxHoldHours: number };
  reports: { intervalMin: number; telegram: { token: string; chatId: string; enabled: boolean } };
  /** proaktif-agent (scan before each cycle) and self-improving (reflect after) */
  learning: { on: boolean; scan: boolean; reflectEveryCycles: number; promoteAfter: number; lossWarnPct: number; staleFeedMin: number; path: string | null };
  exchange: { name: ExchangeName | null; hasTestnetKeys: boolean; hasMainnetKeys: boolean };
  agentEvents: { secret: string; enabled: boolean };
  tradingview: { widget: boolean; passphrase: string; webhookEnabled: boolean; prefix: string };
  news: { provider: 'sample' | 'cryptopanic'; key: string; baseUrl: string };
  port: number;
  keys: Record<Exclude<ProviderName, 'mock'>, string>;
  baseUrls: Record<'xai' | 'openai' | 'deepseek' | 'openrouter', string>;
  defaultModels: Record<ProviderName, string>;
  defaultProvider: ProviderName;
  agents: Record<AgentId, { provider: ProviderName; model: string; fellBackToMock: boolean }>;
  marketSource: 'bybit' | 'binance' | 'hyperliquid' | 'sample';
  watchlist: string[];
  tickerRefreshSeconds: number;
  paper: { balance: number; safetyNet: number; n: number };
  risk: { maxLeverage: number; defaultStopPct: number; minStopPct: number; maxLossPerTradePct: number; minOrderUsdt: number; takerFee: number; takeProfitR: number; dailyLossLimitPct: number };
  debate: { rounds: number; paceMs: number; fightThreshold: number };
  bridge: { url: string; key: string; enabled: boolean };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const mode = (env.TRADING_MODE ?? 'PAPER').trim().toUpperCase();
  if (mode !== 'PAPER' && mode !== 'TESTNET' && mode !== 'LIVE') {
    throw new ConfigError(`TRADING_MODE is "${mode}". Use PAPER (default), TESTNET or LIVE. Refusing to start.`, 2);
  }
  let live: AppConfig['live'] = null;
  if (mode !== 'PAPER') {
    const check = checkTradingMode(env, mode as TradingMode);
    if (!check.ok) {
      throw new ConfigError(`TRADING_MODE=${mode} cannot start, refusing. Fix this or go back to PAPER (npm run setup):\n  - ${check.reasons.join('\n  - ')}`, 2);
    }
    live = { exchange: check.exchange!, network: mode === 'LIVE' ? 'mainnet' : 'testnet', experimental: ADAPTER_STATUS[check.exchange!] === 'experimental' };
  }
  let ex: ReturnType<typeof exchangeSettings>;
  try { ex = exchangeSettings(env); } catch (e) { throw new ConfigError((e as Error).message); }
  const appMode = (env.APP_MODE || 'local').trim().toLowerCase();
  if (appMode !== 'local' && appMode !== 'grokbot') throw new ConfigError('APP_MODE must be local or grokbot');
  const agentEventSecret = (env.AGENT_EVENT_SECRET ?? '').trim();
  if (agentEventSecret && agentEventSecret.length < 24) throw new ConfigError('AGENT_EVENT_SECRET must be at least 24 characters (npm run setup can generate one)');
  const tvPass = (env.TRADINGVIEW_PASSPHRASE ?? '').trim();
  if (tvPass && tvPass.length < 12) throw new ConfigError('TRADINGVIEW_PASSPHRASE must be at least 12 characters');
  const newsProvider = (env.NEWS_PROVIDER || 'sample').trim().toLowerCase();
  if (newsProvider !== 'sample' && newsProvider !== 'cryptopanic') throw new ConfigError('NEWS_PROVIDER must be sample or cryptopanic');
  const keys = {
    xai: env.XAI_API_KEY ?? '', openai: env.OPENAI_API_KEY ?? '', anthropic: env.ANTHROPIC_API_KEY ?? '',
    gemini: env.GEMINI_API_KEY ?? '', deepseek: env.DEEPSEEK_API_KEY ?? '', openrouter: env.OPENROUTER_API_KEY ?? ''
  };
  registerSecrets([...Object.values(keys), env.GROKBOT_WEBHOOK_KEY, env.AGENT_EVENT_SECRET, env.TRADINGVIEW_PASSPHRASE, env.CRYPTOPANIC_API_KEY, env.TELEGRAM_BOT_TOKEN, ...exchangeSecrets(env)]);
  const defaultModels: Record<ProviderName, string> = {
    mock: 'mock-desk-v1',
    xai: env.XAI_MODEL || 'grok-3-mini',
    openai: env.OPENAI_MODEL || 'gpt-4o-mini',
    anthropic: env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest',
    gemini: env.GEMINI_MODEL || 'gemini-2.0-flash',
    deepseek: env.DEEPSEEK_MODEL || 'deepseek-chat',
    openrouter: env.OPENROUTER_MODEL || 'openrouter/auto'
  };
  const asProvider = (v: string | undefined, key: string): ProviderName | undefined => {
    if (!v) return undefined;
    const p = v.trim().toLowerCase() as ProviderName;
    if (!PROVIDERS.includes(p)) throw new ConfigError(`${key}="${v}" is not a known provider (${PROVIDERS.join(', ')})`);
    return p;
  };
  const defaultProvider = asProvider(env.DEFAULT_PROVIDER, 'DEFAULT_PROVIDER') ?? 'mock';
  const agents = {} as AppConfig['agents'];
  for (const id of AGENT_IDS) {
    const k = id.toUpperCase();
    let provider = asProvider(env[`AGENT_${k}_PROVIDER`], `AGENT_${k}_PROVIDER`) ?? defaultProvider;
    let fellBackToMock = false;
    if (provider !== 'mock' && !keys[provider]) { provider = 'mock'; fellBackToMock = true; }
    const model = provider === 'mock' ? defaultModels.mock : env[`AGENT_${k}_MODEL`] || defaultModels[provider];
    agents[id] = { provider, model, fellBackToMock };
  }
  const n = num(env, 'OPEN_ORDERS_N', 4);
  if (![1, 2, 3, 4].includes(n)) throw new ConfigError('OPEN_ORDERS_N must be 1, 2, 3 or 4');
  const balance = num(env, 'PAPER_BALANCE', 1000);
  const safetyNet = num(env, 'SAFETY_NET', 200);
  if (balance < 0 || safetyNet < 0) throw new ConfigError('PAPER_BALANCE and SAFETY_NET must be zero or more');
  const src = (env.MARKET_SOURCE || 'bybit').toLowerCase();
  if (!['bybit', 'binance', 'hyperliquid', 'sample'].includes(src)) throw new ConfigError('MARKET_SOURCE must be bybit, binance, hyperliquid or sample');
  const url = (env.GROKBOT_WEBHOOK_URL ?? '').trim();
  const key = (env.GROKBOT_WEBHOOK_KEY ?? '').trim();
  return {
    tradingMode: mode as AppConfig['tradingMode'],
    appMode: appMode as AppConfig['appMode'],
    // LIVE always binds to this computer only. TESTNET defaults to it too.
    host: mode === 'LIVE' ? '127.0.0.1' : (env.HOST || (mode === 'TESTNET' ? '127.0.0.1' : '0.0.0.0')).trim(),
    live,
    exchange: { name: ex.name, hasTestnetKeys: !!ex.creds.testnet, hasMainnetKeys: !!ex.creds.mainnet },
    agentEvents: { secret: agentEventSecret, enabled: appMode === 'grokbot' && !!agentEventSecret },
    tradingview: { widget: /^(1|on|yes|true)$/i.test(env.TRADINGVIEW_WIDGET ?? ''), passphrase: tvPass, webhookEnabled: !!tvPass, prefix: (env.TRADINGVIEW_EXCHANGE_PREFIX || 'BYBIT').trim().toUpperCase() },
    news: { provider: newsProvider as AppConfig['news']['provider'], key: (env.CRYPTOPANIC_API_KEY ?? '').trim(), baseUrl: (env.CRYPTOPANIC_BASE_URL || 'https://cryptopanic.com/api/developer/v2/posts/').trim() },
    port: num(env, 'PORT', 8787),
    keys,
    baseUrls: {
      xai: env.XAI_BASE_URL || 'https://api.x.ai/v1',
      openai: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      deepseek: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
      openrouter: env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'
    },
    defaultModels,
    defaultProvider,
    agents,
    marketSource: src as AppConfig['marketSource'],
    watchlist: (env.WATCHLIST || 'BTCUSDT,ETHUSDT,SOLUSDT').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
    tickerRefreshSeconds: Math.max(5, num(env, 'TICKER_REFRESH_SECONDS', 20)),
    paper: { balance, safetyNet, n },
    risk: {
      maxLeverage: Math.max(1, num(env, 'MAX_LEVERAGE', 3)),
      defaultStopPct: num(env, 'DEFAULT_STOP_PCT', 1.5),
      minStopPct: num(env, 'MIN_STOP_PCT', 0.3),
      maxLossPerTradePct: num(env, 'MAX_LOSS_PER_TRADE_PCT', 1),
      minOrderUsdt: num(env, 'MIN_ORDER_USDT', 5),
      takerFee: num(env, 'TAKER_FEE', 0.00055),
      takeProfitR: Math.max(0, num(env, 'TAKE_PROFIT_R', 2)),
      // cannot be switched off: clamped to 0.5..20 percent
      dailyLossLimitPct: Math.min(20, Math.max(0.5, num(env, 'DAILY_LOSS_LIMIT_PCT', 3)))
    },
    debate: {
      rounds: Math.min(4, Math.max(1, num(env, 'DEBATE_ROUNDS', 2))),
      paceMs: Math.max(0, num(env, 'DEBATE_PACE_MS', 700)),
      fightThreshold: num(env, 'FIGHT_THRESHOLD', 0.45)
    },
    auto: {
      on: !/^(0|off|no|false)$/i.test((env.AUTO_TRADING ?? 'off').trim()),
      intervalMin: Math.max(0.1, num(env, 'DEBATE_INTERVAL_MIN', 15)),
      symbols: (env.AUTO_SYMBOLS || env.WATCHLIST || 'BTCUSDT,ETHUSDT,SOLUSDT').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
      maxHoldHours: Math.max(0, num(env, 'MAX_HOLD_HOURS', 0))
    },
    learning: {
      on: !/^(0|off|no|false)$/i.test((env.LEARNING ?? 'on').trim()),
      scan: !/^(0|off|no|false)$/i.test((env.PROACTIVE_SCAN ?? 'on').trim()),
      reflectEveryCycles: Math.max(1, Math.round(num(env, 'REFLECT_EVERY_CYCLES', 1))),
      promoteAfter: Math.min(10, Math.max(2, Math.round(num(env, 'PROMOTE_AFTER', 3)))),
      lossWarnPct: Math.min(95, Math.max(50, num(env, 'LOSS_WARN_PCT', 70))),
      staleFeedMin: Math.max(1, num(env, 'STALE_FEED_MIN', 10)),
      path: /^(off|none)$/i.test((env.LEARNINGS_PATH ?? '').trim()) ? null : (env.LEARNINGS_PATH || 'data/learnings.json').trim()
    },
    reports: {
      intervalMin: Math.max(1, num(env, 'REPORT_INTERVAL_MIN', 60)),
      telegram: { token: (env.TELEGRAM_BOT_TOKEN ?? '').trim(), chatId: (env.TELEGRAM_CHAT_ID ?? '').trim(), enabled: !!(env.TELEGRAM_BOT_TOKEN ?? '').trim() && !!(env.TELEGRAM_CHAT_ID ?? '').trim() }
    },
    bridge: { url, key, enabled: !!url && !!key }
  };
}
