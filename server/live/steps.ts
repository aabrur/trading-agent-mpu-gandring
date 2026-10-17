import { exchangeSettings, makeAdapter, type ExchangeAdapter, type ExchangeName, type Network, type ExchangeCreds } from '../exchange/index.js';
import { HyperliquidAdapter } from '../exchange/hyperliquid.js';
import { AsterAdapter } from '../exchange/aster.js';
import { ParadexAdapter } from '../exchange/paradex.js';
import { DydxAdapter, dydxAddressOf } from '../exchange/dydx.js';
import { parseOrderlySecret } from '../exchange/orderly.js';
import { testnetRoundTrip } from './testnet.js';
import { verifyKey } from './guard.js';
import { safe } from '../redact.js';

export type AdapterFactory = (name: ExchangeName, network: Network, creds: ExchangeCreds) => ExchangeAdapter;
const defaultFactory: AdapterFactory = (n, net, c) => makeAdapter(n, net, c);

/** Optional check (npm run doctor --roundtrip): a real testnet round trip. Not a gate for anything. */
export async function roundTripCheck(env: NodeJS.ProcessEnv, opts: { symbol?: string; factory?: AdapterFactory; reconcileDelayMs?: number } = {}) {
  const ex = exchangeSettings(env);
  if (!ex.name) throw new Error('set EXCHANGE first (npm run setup)');
  if (!ex.creds.testnet) throw new Error(`testnet keys for ${ex.name} are missing in .env`);
  const adapter = (opts.factory ?? defaultFactory)(ex.name, 'testnet', ex.creds.testnet);
  const rt = await testnetRoundTrip(adapter, opts.symbol ?? 'BTCUSDT', { reconcileDelayMs: opts.reconcileDelayMs });
  return { ok: rt.ok, exchange: ex.name, steps: rt.steps.map((s) => safe(s)) };
}

/** Automatic withdraw-permission check used by setup and by every TESTNET or LIVE start. */
export async function checkKeyStep(env: NodeJS.ProcessEnv, network: Network = 'mainnet', opts: { factory?: AdapterFactory } = {}) {
  const ex = exchangeSettings(env);
  if (!ex.name) throw new Error('set EXCHANGE first (npm run setup)');
  const creds = ex.creds[network];
  if (!creds) throw new Error(`${network} keys for ${ex.name} are missing in .env`);
  const v = await verifyKey((opts.factory ?? defaultFactory)(ex.name, network, creds));
  return { ok: v.ok, exchange: ex.name, detail: v.detail };
}

/** Quick local check used by the wizard: is this Hyperliquid key the main wallet? */
export function hyperliquidMainKeyCheck(address: string, agentKey: string): string | null {
  try {
    const a = new HyperliquidAdapter('mainnet', address, agentKey);
    return a.agentAddress.toLowerCase() === address.toLowerCase() ? 'This private key belongs to the main wallet. Use an API agent wallet key instead (Hyperliquid app, More, API).' : null;
  } catch (e) { return (e as Error).message; }
}

/** Looks like a BIP-39 seed phrase (12 to 24 words). Never accepted anywhere. */
export const looksLikeSeed = (v: string) => v.trim().split(/\s+/).length >= 12;

/**
 * Quick local checks used by the wizard and the Connect wallet flow before anything is saved.
 * Catches the main wallet key where it can be derived locally. The venue check at every start
 * (verifyKey) is still the real gate. Returns a refusal reason or null.
 */
export function localKeyCheck(name: ExchangeName, key: string, secret: string, third?: string): string | null {
  if ([key, secret, third ?? ''].some(looksLikeSeed)) return 'This looks like a seed phrase. Never enter a seed phrase. Use a delegated trading key (agent wallet, API key, subkey).';
  try {
    switch (name) {
      case 'hyperliquid': return hyperliquidMainKeyCheck(key, secret);
      case 'aster': {
        const a = new AsterAdapter('mainnet', key, secret);
        return a.signerAddress.toLowerCase() === key.toLowerCase() ? 'This private key belongs to the main wallet. Use a Pro API agent wallet key (asterdex.com, API wallet) with withdraw off.' : null;
      }
      case 'dydx': {
        new DydxAdapter('mainnet', key, secret, third ?? '');
        return dydxAddressOf(secret).address === key ? 'This private key is the owner key of the account. Use an API Trading Key (dYdX app, More, API Trading Keys).' : null;
      }
      case 'paradex': new ParadexAdapter('mainnet', key, secret); return null;
      case 'orderly': parseOrderlySecret(secret); return /^0x[0-9a-fA-F]{64}$/.test(key) ? null : 'ORDERLY account id must be the 0x account id (64 hex chars)';
      default: return null;
    }
  } catch (e) { return (e as Error).message; }
}
