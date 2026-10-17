import 'dotenv/config';
import type { AgentId } from './types.js';
import { registerSecrets } from './redact.js';

export type ProviderName = 'mock' | 'xai' | 'openai' | 'anthropic' | 'gemini' | 'deepseek' | 'openrouter';
export const PROVIDERS: ProviderName[] = ['mock', 'xai', 'openai', 'anthropic', 'gemini', 'deepseek', 'openrouter'];
export const AGENT_IDS: AgentId[] = ['lead', 'market', 'research', 'strategist', 'risk', 'execution', 'reviewer'];

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
  tradingMode: 'PAPER';
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
  risk: { maxLeverage: number; defaultStopPct: number; minStopPct: number; maxLossPerTradePct: number; minOrderUsdt: number; takerFee: number };
  debate: { rounds: number; paceMs: number; fightThreshold: number; autoMinutes: number };
  bridge: { url: string; key: string; enabled: boolean };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const mode = (env.TRADING_MODE ?? 'PAPER').trim().toUpperCase();
  if (mode !== 'PAPER') {
    throw new ConfigError(`TRADING_MODE is "${mode}". This version only runs in PAPER mode. There is no live order code here. Refusing to start.`, 2);
  }
  const keys = {
    xai: env.XAI_API_KEY ?? '', openai: env.OPENAI_API_KEY ?? '', anthropic: env.ANTHROPIC_API_KEY ?? '',
    gemini: env.GEMINI_API_KEY ?? '', deepseek: env.DEEPSEEK_API_KEY ?? '', openrouter: env.OPENROUTER_API_KEY ?? ''
  };
  registerSecrets([...Object.values(keys), env.GROKBOT_WEBHOOK_KEY]);
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
    tradingMode: 'PAPER',
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
      takerFee: num(env, 'TAKER_FEE', 0.00055)
    },
    debate: {
      rounds: Math.min(4, Math.max(1, num(env, 'DEBATE_ROUNDS', 2))),
      paceMs: Math.max(0, num(env, 'DEBATE_PACE_MS', 700)),
      fightThreshold: num(env, 'FIGHT_THRESHOLD', 0.45),
      autoMinutes: Math.max(0, num(env, 'AUTO_DEBATE_MINUTES', 0))
    },
    bridge: { url, key, enabled: !!url && !!key }
  };
}
