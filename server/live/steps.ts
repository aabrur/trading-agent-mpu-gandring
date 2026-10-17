import { exchangeSettings, makeAdapter, type ExchangeAdapter, type ExchangeName, type Network, type ExchangeCreds } from '../exchange/index.js';
import { HyperliquidAdapter } from '../exchange/hyperliquid.js';
import { testnetRoundTrip } from './testnet.js';
import { keyFingerprint, readState, recordConfirmation, recordPermission, recordTestnet, checkLiveUnlock, CONFIRM_PHRASE } from './state.js';
import { safe } from '../redact.js';

export type AdapterFactory = (name: ExchangeName, network: Network, creds: ExchangeCreds) => ExchangeAdapter;
const defaultFactory: AdapterFactory = (n, net, c) => makeAdapter(n, net, c);

/** Step 1: real testnet round trip. Writes a signed record only when every leg passed. */
export async function testnetStep(env: NodeJS.ProcessEnv, dir: string, opts: { symbol?: string; factory?: AdapterFactory; reconcileDelayMs?: number } = {}) {
  const ex = exchangeSettings(env);
  if (!ex.name) throw new Error('set EXCHANGE first (npm run setup)');
  if (!ex.creds.testnet) throw new Error(`testnet keys for ${ex.name} are missing in .env`);
  const adapter = (opts.factory ?? defaultFactory)(ex.name, 'testnet', ex.creds.testnet);
  const rt = await testnetRoundTrip(adapter, opts.symbol ?? 'BTCUSDT', { reconcileDelayMs: opts.reconcileDelayMs });
  const steps = rt.steps.map((s) => safe(s));
  if (rt.ok) recordTestnet(dir, { exchange: ex.name, passedAt: Date.now(), symbol: rt.symbol, clientId: rt.clientId, steps });
  return { ok: rt.ok, exchange: ex.name, steps };
}

/** Step 2: ask the exchange what the MAINNET key may do. Refuses (and records nothing) if it can withdraw. */
export async function checkKeyStep(env: NodeJS.ProcessEnv, dir: string, opts: { factory?: AdapterFactory } = {}) {
  const ex = exchangeSettings(env);
  if (!ex.name) throw new Error('set EXCHANGE first (npm run setup)');
  const creds = ex.creds.mainnet;
  if (!creds) throw new Error(`mainnet keys for ${ex.name} are missing in .env`);
  const adapter = (opts.factory ?? defaultFactory)(ex.name, 'mainnet', creds);
  let perm;
  try { perm = await adapter.permissions(); } catch (e) { return { ok: false, exchange: ex.name, detail: `could not read key permissions: ${safe((e as Error).message)}` }; }
  const detail = safe(perm.detail);
  if (!perm.verified) return { ok: false, exchange: ex.name, detail: `could not verify permissions: ${detail}` };
  if (perm.canWithdraw !== false || !perm.ok) return { ok: false, exchange: ex.name, detail: `REFUSED: ${detail}. Make a new key with trading only, no withdrawals.` };
  if (!perm.canTrade) return { ok: false, exchange: ex.name, detail: `key cannot trade: ${detail}` };
  recordPermission(dir, { exchange: ex.name, keyFp: keyFingerprint(ex.name, creds.key, creds.secret), checkedAt: Date.now(), canWithdraw: false, detail });
  return { ok: true, exchange: ex.name, detail };
}

/** Step 3: typed phrase. Re-checks the key live, then returns the env changes for LIVE. */
export async function unlockStep(env: NodeJS.ProcessEnv, dir: string, typedPhrase: string, opts: { factory?: AdapterFactory } = {}) {
  const ex = exchangeSettings(env);
  if (!ex.name || !ex.creds.mainnet) throw new Error('EXCHANGE and mainnet keys are required');
  const s = readState(dir);
  const pre = checkLiveUnlock({ ...env, LIVE_CONFIRMED: 'x' }, dir).reasons.filter((r) => !/confirmation|LIVE_CONFIRMED/.test(r));
  if (!s.testnet || !s.permission || pre.length) throw new Error(`not ready:\n  - ${pre.join('\n  - ') || 'missing testnet or permission record'}`);
  const again = await checkKeyStep(env, dir, opts);
  if (!again.ok) throw new Error(again.detail);
  if (typedPhrase.trim() !== CONFIRM_PHRASE) throw new Error('confirmation phrase does not match, LIVE stays locked');
  const keyFp = keyFingerprint(ex.name, ex.creds.mainnet.key, ex.creds.mainnet.secret);
  const token = recordConfirmation(dir, ex.name, keyFp, typedPhrase);
  const after = checkLiveUnlock({ ...env, TRADING_MODE: 'LIVE', LIVE_CONFIRMED: token }, dir);
  return { env: { TRADING_MODE: 'LIVE', LIVE_CONFIRMED: token }, warnings: after.reasons };
}

/** Quick local check used by the wizard: is this Hyperliquid key the main wallet? */
export function hyperliquidMainKeyCheck(address: string, agentKey: string): string | null {
  try {
    const a = new HyperliquidAdapter('mainnet', address, agentKey);
    return a.agentAddress.toLowerCase() === address.toLowerCase() ? 'This private key belongs to the main wallet. Use an API agent wallet key instead (Hyperliquid app, More, API).' : null;
  } catch (e) { return (e as Error).message; }
}
