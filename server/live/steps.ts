import { exchangeSettings, makeAdapter, type ExchangeAdapter, type ExchangeName, type Network, type ExchangeCreds } from '../exchange/index.js';
import { HyperliquidAdapter } from '../exchange/hyperliquid.js';
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
