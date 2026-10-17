import { BybitAdapter } from './bybit.js';
import { BinanceAdapter } from './binance.js';
import { OkxAdapter } from './okx.js';
import { HyperliquidAdapter } from './hyperliquid.js';
import { AsterAdapter } from './aster.js';
import { DydxAdapter } from './dydx.js';
import { ParadexAdapter } from './paradex.js';
import { OrderlyAdapter } from './orderly.js';
import { EXCHANGES, ExchangeError, type ExchangeAdapter, type ExchangeName, type FetchLike, type Network } from './types.js';

export * from './types.js';
export * from './rules.js';

export interface ExchangeCreds { key: string; secret: string; passphrase?: string }
export interface ExchangeSettings { name: ExchangeName | null; creds: Record<Network, ExchangeCreds | null> }

const PREFIX: Record<ExchangeName, string> = { bybit: 'BYBIT', binance: 'BINANCE', okx: 'OKX', hyperliquid: 'HYPERLIQUID', aster: 'ASTER', dydx: 'DYDX', paradex: 'PARADEX', orderly: 'ORDERLY' };
/** Venues whose first field ("key") is a public address or account id, not a secret. */
export const PUBLIC_KEY_FIELD = new Set<ExchangeName>(['hyperliquid', 'aster', 'dydx', 'paradex', 'orderly']);
/** Venues whose third field ("passphrase") is public (dYdX authenticator id). */
export const PUBLIC_THIRD_FIELD = new Set<ExchangeName>(['dydx']);

/**
 * Env names per venue. DEX venues take a public address (or account id) plus a DELEGATED key:
 * Hyperliquid agent wallet, Aster Pro API agent wallet, dYdX API Trading Key + authenticator id,
 * Paradex subkey, Orderly key. Never the main wallet key.
 */
export function envNames(name: ExchangeName, network: Network): { key: string; secret: string; passphrase?: string } {
  const p = PREFIX[name] + (network === 'testnet' ? '_TESTNET' : '');
  switch (name) {
    case 'hyperliquid': return { key: `${p}_ACCOUNT_ADDRESS`, secret: `${p}_AGENT_PRIVATE_KEY` };
    case 'aster': return { key: `${p}_USER_ADDRESS`, secret: `${p}_SIGNER_PRIVATE_KEY` };
    case 'dydx': return { key: `${p}_ADDRESS`, secret: `${p}_API_PRIVATE_KEY`, passphrase: `${p}_AUTHENTICATOR_ID` };
    case 'paradex': return { key: `${p}_ACCOUNT_ADDRESS`, secret: `${p}_SUBKEY_PRIVATE_KEY` };
    case 'orderly': return { key: `${p}_ACCOUNT_ID`, secret: `${p}_KEY_SECRET` };
    case 'okx': return { key: `${p}_API_KEY`, secret: `${p}_API_SECRET`, passphrase: `${p}_API_PASSPHRASE` };
    default: return { key: `${p}_API_KEY`, secret: `${p}_API_SECRET` };
  }
}

export function exchangeSettings(env: NodeJS.ProcessEnv): ExchangeSettings {
  const raw = (env.EXCHANGE ?? '').trim().toLowerCase();
  if (raw && raw !== 'none' && !EXCHANGES.includes(raw as ExchangeName)) throw new ExchangeError(`EXCHANGE="${raw}" is not one of none, ${EXCHANGES.join(', ')}`);
  const name = raw && raw !== 'none' ? (raw as ExchangeName) : null;
  const read = (network: Network): ExchangeCreds | null => {
    if (!name) return null;
    const n = envNames(name, network);
    const key = (env[n.key] ?? '').trim(), secret = (env[n.secret] ?? '').trim(), passphrase = n.passphrase ? (env[n.passphrase] ?? '').trim() : undefined;
    return key && secret && (!n.passphrase || passphrase) ? { key, secret, passphrase } : null;
  };
  return { name, creds: { testnet: read('testnet'), mainnet: read('mainnet') } };
}

/** All exchange secret values, so the redactor can scrub them. Public addresses are left alone. */
export function exchangeSecrets(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  for (const name of EXCHANGES) for (const net of ['testnet', 'mainnet'] as Network[]) {
    const n = envNames(name, net);
    if (!PUBLIC_KEY_FIELD.has(name)) out.push(env[n.key] ?? '');
    out.push(env[n.secret] ?? '');
    if (n.passphrase && !PUBLIC_THIRD_FIELD.has(name)) out.push(env[n.passphrase] ?? '');
  }
  return out.filter((v) => v.length >= 6);
}

export function makeAdapter(name: ExchangeName, network: Network, creds: ExchangeCreds, fetchImpl: FetchLike = fetch): ExchangeAdapter {
  switch (name) {
    case 'bybit': return new BybitAdapter(network, creds.key, creds.secret, fetchImpl);
    case 'binance': return new BinanceAdapter(network, creds.key, creds.secret, fetchImpl);
    case 'okx': return new OkxAdapter(network, creds.key, creds.secret, creds.passphrase ?? '', fetchImpl);
    case 'hyperliquid': return new HyperliquidAdapter(network, creds.key, creds.secret, fetchImpl);
    case 'aster': return new AsterAdapter(network, creds.key, creds.secret, fetchImpl);
    case 'dydx': return new DydxAdapter(network, creds.key, creds.secret, creds.passphrase ?? '', fetchImpl);
    case 'paradex': return new ParadexAdapter(network, creds.key, creds.secret, fetchImpl);
    case 'orderly': return new OrderlyAdapter(network, creds.key, creds.secret, fetchImpl);
  }
}
