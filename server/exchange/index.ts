import { BybitAdapter } from './bybit.js';
import { BinanceAdapter } from './binance.js';
import { OkxAdapter } from './okx.js';
import { HyperliquidAdapter } from './hyperliquid.js';
import { EXCHANGES, ExchangeError, type ExchangeAdapter, type ExchangeName, type FetchLike, type Network } from './types.js';

export * from './types.js';

export interface ExchangeCreds { key: string; secret: string; passphrase?: string }
export interface ExchangeSettings { name: ExchangeName | null; creds: Record<Network, ExchangeCreds | null> }

const PREFIX: Record<ExchangeName, string> = { bybit: 'BYBIT', binance: 'BINANCE', okx: 'OKX', hyperliquid: 'HYPERLIQUID' };

/** Env names per venue. Hyperliquid uses the main account ADDRESS (public) plus the API agent wallet key. */
export function envNames(name: ExchangeName, network: Network) {
  const p = PREFIX[name] + (network === 'testnet' ? '_TESTNET' : '');
  if (name === 'hyperliquid') return { key: `${p}_ACCOUNT_ADDRESS`, secret: `${p}_AGENT_PRIVATE_KEY` };
  return { key: `${p}_API_KEY`, secret: `${p}_API_SECRET`, ...(name === 'okx' ? { passphrase: `${p}_API_PASSPHRASE` } : {}) };
}

export function exchangeSettings(env: NodeJS.ProcessEnv): ExchangeSettings {
  const raw = (env.EXCHANGE ?? '').trim().toLowerCase();
  if (raw && raw !== 'none' && !EXCHANGES.includes(raw as ExchangeName)) throw new ExchangeError(`EXCHANGE="${raw}" is not one of none, ${EXCHANGES.join(', ')}`);
  const name = raw && raw !== 'none' ? (raw as ExchangeName) : null;
  const read = (network: Network): ExchangeCreds | null => {
    if (!name) return null;
    const n = envNames(name, network);
    const key = (env[n.key] ?? '').trim(), secret = (env[n.secret] ?? '').trim(), passphrase = n.passphrase ? (env[n.passphrase] ?? '').trim() : undefined;
    return key && secret ? { key, secret, passphrase } : null;
  };
  return { name, creds: { testnet: read('testnet'), mainnet: read('mainnet') } };
}

/** All exchange secret values, so the redactor can scrub them. Public addresses are left alone. */
export function exchangeSecrets(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  for (const name of EXCHANGES) for (const net of ['testnet', 'mainnet'] as Network[]) {
    const n = envNames(name, net);
    if (name !== 'hyperliquid') out.push(env[n.key] ?? '');
    out.push(env[n.secret] ?? '', n.passphrase ? env[n.passphrase] ?? '' : '');
  }
  return out.filter((v) => v.length >= 6);
}

export function makeAdapter(name: ExchangeName, network: Network, creds: ExchangeCreds, fetchImpl: FetchLike = fetch): ExchangeAdapter {
  switch (name) {
    case 'bybit': return new BybitAdapter(network, creds.key, creds.secret, fetchImpl);
    case 'binance': return new BinanceAdapter(network, creds.key, creds.secret, fetchImpl);
    case 'okx': return new OkxAdapter(network, creds.key, creds.secret, creds.passphrase ?? '', fetchImpl);
    case 'hyperliquid': return new HyperliquidAdapter(network, creds.key, creds.secret, fetchImpl);
  }
}
