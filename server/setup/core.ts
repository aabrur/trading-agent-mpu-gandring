// Setup logic shared by the CLI wizard (npm run setup) and the office Setup wizard (/api/setup/*), so they cannot drift.
// Keys only ever go into the local .env (chmod 600). Nothing here returns or logs a secret value.
import { readEnv, setEnv } from '../../cli/envfile.js';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { EXCHANGES, makeAdapter, envNames, PUBLIC_KEY_FIELD, PUBLIC_THIRD_FIELD, VENUE_LABEL, type ExchangeName, type Network } from '../exchange/index.js';
import { localKeyCheck, looksLikeSeed, checkKeyStep } from '../live/steps.js';
import { checkTradingMode, networkFor, verifyKey, type TradingMode } from '../live/guard.js';
import { safe } from '../redact.js';
import { envFields, LIVE_CONFIRM_PHRASE, MODES } from './guide.js';

export interface KeyInput { key?: string; secret?: string; third?: string }
export interface SetupResult { ok: boolean; detail: string; saved?: string[]; warning?: string }

/** Names that only a main wallet key or a seed would use. Never accepted, never written. */
export const FORBIDDEN_ENV = /(^|_)(MAIN_PRIVATE_KEY|MAIN_WALLET_KEY|SEED|SEED_PHRASE|MNEMONIC)$|^HYPERLIQUID(_TESTNET)?_PRIVATE_KEY$/;
const HEX64 = /^(0x)?[0-9a-fA-F]{64}$/;

export const isVenue = (v: unknown): v is ExchangeName => typeof v === 'string' && (EXCHANGES as readonly string[]).includes(v);
export const isNetwork = (v: unknown): v is Network => v === 'testnet' || v === 'mainnet';

/** Local checks before anything is sent anywhere: fields present, no seed phrase, no private key in a public field, no main wallet key. */
export function checkKeyInput(venue: ExchangeName, net: Network, k: KeyInput): string | null {
  const key = (k.key ?? '').trim(), secret = (k.secret ?? '').trim(), third = (k.third ?? '').trim();
  const n = envNames(venue, net);
  if (!key || !secret || (n.passphrase && !third)) return `fill ${envFields(venue, net).map((f) => f.name).join(', ')}`;
  if ([key, secret, third].some(looksLikeSeed)) return 'This looks like a seed phrase. Never enter a seed phrase anywhere. Use a delegated trading key (API key, agent wallet, subkey).';
  if (PUBLIC_KEY_FIELD.has(venue) && venue !== 'orderly' && HEX64.test(key)) return `${n.key} must be your public address, not a private key.`;
  if (n.passphrase && PUBLIC_THIRD_FIELD.has(venue) && !/^\d+$/.test(third)) return `${n.passphrase} must be a number.`;
  return localKeyCheck(venue, key, secret, third || undefined);
}

/**
 * Check the key on the venue with the same guard the server uses at every start (verifyKey).
 * definitive=true means the venue answered and the key is refused (can withdraw, cannot trade, not a delegated key...).
 */
export async function verifyVenueKey(venue: ExchangeName, net: Network, k: KeyInput, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; detail: string; definitive: boolean }> {
  try {
    const a = makeAdapter(venue, net, { key: k.key!.trim(), secret: k.secret!.trim(), passphrase: k.third?.trim() || undefined }, fetchImpl);
    const v = await verifyKey(a);
    return { ok: v.ok, detail: safe(v.detail), definitive: !v.ok && v.perm !== null };
  } catch (e) { return { ok: false, detail: safe((e as Error).message), definitive: false }; }
}

/** Validate, verify on the venue, then write EXCHANGE and the key fields to .env. A refused key is never written. */
export async function saveVenueKeys(envFile: string, venue: ExchangeName, net: Network, k: KeyInput, o: { fetchImpl?: typeof fetch; verify?: boolean } = {}): Promise<SetupResult> {
  if (!isVenue(venue) || !isNetwork(net)) return { ok: false, detail: 'unknown venue or network' };
  const bad = checkKeyInput(venue, net, k);
  if (bad) return { ok: false, detail: `REFUSED: ${bad}` };
  let warning: string | undefined;
  if (o.verify !== false) {
    const v = await verifyVenueKey(venue, net, k, o.fetchImpl);
    if (!v.ok && v.definitive) return { ok: false, detail: `REFUSED by the ${VENUE_LABEL[venue]} ${net} check: ${v.detail}. Nothing was saved.` };
    if (!v.ok) warning = `saved, but not verified yet (${v.detail}). TESTNET/LIVE will check again and refuse if it can withdraw.`;
  }
  const n = envNames(venue, net);
  const up: Record<string, string> = { EXCHANGE: venue, [n.key]: k.key!.trim(), [n.secret]: k.secret!.trim() };
  if (n.passphrase) up[n.passphrase] = k.third!.trim();
  if (venue === 'aster' && k.secret && /^0x[0-9a-fA-F]{64}$/.test(k.secret.trim())) {
    try {
      const signerAddr = privateKeyToAccount(k.secret.trim() as Hex).address;
      const pinKey = net === 'testnet' ? 'ASTER_TESTNET_AGENT_WITHDRAW_OFF_VERIFIED' : 'ASTER_AGENT_WITHDRAW_OFF_VERIFIED';
      up[pinKey] = signerAddr;
    } catch { /* ignore if invalid private key */ }
  }
  setEnv(envFile, up);
  return { ok: true, detail: `${VENUE_LABEL[venue]} ${net} key saved to ${envFile} (chmod 600)${warning ? '' : ', checked: can trade, cannot withdraw'}.`, saved: Object.keys(up), warning };
}

export function setVenue(envFile: string, venue: string): SetupResult {
  if (venue !== 'none' && !isVenue(venue)) return { ok: false, detail: `unknown venue ${venue}` };
  setEnv(envFile, { EXCHANGE: venue });
  return { ok: true, detail: `EXCHANGE=${venue}`, saved: ['EXCHANGE'] };
}

/** PAPER always; TESTNET/LIVE only after the same checks as a server start; LIVE also needs the typed confirmation. */
export async function checkMode(env: NodeJS.ProcessEnv, mode: string, o: { confirm?: string; fetchImpl?: typeof fetch } = {}): Promise<SetupResult> {
  const m = String(mode).toUpperCase() as TradingMode;
  if (!(MODES as readonly string[]).includes(m)) return { ok: false, detail: 'mode must be PAPER, TESTNET or LIVE' };
  if (m === 'PAPER') return { ok: true, detail: 'PAPER' };
  if (m === 'LIVE' && (o.confirm ?? '').trim() !== LIVE_CONFIRM_PHRASE) return { ok: false, detail: `LIVE needs the explicit confirmation: type "${LIVE_CONFIRM_PHRASE}"` };
  const pre = checkTradingMode(env, m);
  if (!pre.ok) return { ok: false, detail: `${m} refused: ${pre.reasons.join('; ')}` };
  const k = await checkKeyStep(env, networkFor(m)!, o.fetchImpl ? { factory: (n, net, c) => makeAdapter(n, net, c, o.fetchImpl) } : {}).catch((e) => ({ ok: false, detail: safe((e as Error).message) }));
  if (!k.ok) return { ok: false, detail: `${m} refused: ${k.detail}` };
  return { ok: true, detail: `${m} ready: ${k.detail}` };
}

export async function setTradingMode(envFile: string, mode: string, o: { confirm?: string; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): Promise<SetupResult> {
  const env = o.env ?? setupEnv(envFile);
  const r = await checkMode(env, mode, o);
  if (!r.ok) return r;
  setEnv(envFile, { TRADING_MODE: String(mode).toUpperCase() });
  return { ...r, saved: ['TRADING_MODE'], detail: `${r.detail}. Saved TRADING_MODE=${String(mode).toUpperCase()}. Restart the office to apply.` };
}

/** process.env (platform secrets, e.g. Grok Bot secret cards) plus the .env file; non-empty file values win. */
export function setupEnv(envFile: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const file = Object.fromEntries(Object.entries(readEnv(envFile)).filter(([, v]) => v !== ''));
  return { ...base, ...file };
}

const short = (v: string) => (v.length > 14 ? `${v.slice(0, 6)}...${v.slice(-4)}` : v);
/** What is configured, with every secret reduced to "set" / "empty". Public addresses are shortened. */
export function maskedStatus(env: NodeJS.ProcessEnv) {
  const ex = (env.EXCHANGE || 'none').trim().toLowerCase();
  const venues = isVenue(ex) ? (['testnet', 'mainnet'] as Network[]).map((net) => ({ network: net, fields: envFields(ex, net).map((f) => ({ name: f.name, set: !!(env[f.name] ?? '').trim(), shown: !f.secret && env[f.name] ? short(String(env[f.name])) : null })) })) : [];
  const forbidden = Object.keys(env).filter((k) => FORBIDDEN_ENV.test(k) && (env[k] ?? '').trim());
  return { tradingMode: (env.TRADING_MODE || 'PAPER').toUpperCase(), appMode: env.APP_MODE || 'local', exchange: ex, venues, forbidden };
}

/** How to open a URL in the default browser on this OS (the CLI wizard runs it; tests check the mapping). */
export function openUrlCommand(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (!/^https?:\/\//.test(url)) throw new Error('only http(s) URLs');
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['cmd', ['/c', 'start', '', url]];
  return ['xdg-open', [url]];
}
