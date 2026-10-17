import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { exchangeSettings, ADAPTER_STATUS, type ExchangeName } from '../exchange/index.js';

// LIVE is locked until three things happened, in order, through the CLI:
//   1. a testnet round trip passed (place, reconcile, close, cancel)
//   2. the mainnet key was checked on the exchange and has NO withdraw permission
//   3. a human typed the confirmation phrase
// Each step is a signed record in .mpu-gandring/live-state.json. The signature uses a random
// install key that only this machine has, and LIVE_CONFIRMED in .env is a signature over all
// three records plus a fingerprint of the current mainnet key. Editing .env or the state file
// by hand, or swapping in a different key, breaks the chain and the server refuses LIVE.
// This guards against accidents and copy-pasted configs. It is not DRM against the machine's owner.

export const CONFIRM_PHRASE = 'I UNDERSTAND LIVE TRADING CAN LOSE MONEY';

export interface TestnetRecord { exchange: ExchangeName; passedAt: number; symbol: string; clientId: string; steps: string[]; sig: string }
export interface PermissionRecord { exchange: ExchangeName; keyFp: string; checkedAt: number; canWithdraw: false; detail: string; sig: string }
export interface ConfirmRecord { exchange: ExchangeName; keyFp: string; at: number; sig: string }
export interface LiveState { version: 1; testnet?: TestnetRecord; permission?: PermissionRecord; confirmation?: ConfirmRecord }

export const stateDir = (env: NodeJS.ProcessEnv = process.env) => path.resolve(env.MG_STATE_DIR || '.mpu-gandring');
const statePath = (dir: string) => path.join(dir, 'live-state.json');
const keyPath = (dir: string) => path.join(dir, 'install.key');

export function installKey(dir: string, create = false): Buffer | null {
  const p = keyPath(dir);
  if (existsSync(p)) return Buffer.from(readFileSync(p, 'utf8').trim(), 'hex');
  if (!create) return null;
  mkdirSync(dir, { recursive: true });
  const k = randomBytes(32);
  writeFileSync(p, k.toString('hex') + '\n', { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch { /* windows */ }
  return k;
}

const canon = (o: Record<string, unknown>) => JSON.stringify(Object.keys(o).filter((k) => k !== 'sig').sort().map((k) => [k, o[k]]));
export function sign(key: Buffer, o: Record<string, unknown>) { return createHmac('sha256', key).update(canon(o)).digest('hex'); }
function sigOk(key: Buffer, o: { sig?: string } & Record<string, unknown>) {
  if (!o?.sig || !/^[0-9a-f]{64}$/.test(o.sig)) return false;
  return timingSafeEqual(Buffer.from(o.sig, 'hex'), Buffer.from(sign(key, o), 'hex'));
}

/** Short one-way fingerprint of a key pair. Never the key itself. */
export function keyFingerprint(exchange: string, key: string, secret: string) {
  return createHash('sha256').update(`${exchange}|${key}|${secret}`).digest('hex').slice(0, 16);
}

export function readState(dir: string): LiveState {
  try { const s = JSON.parse(readFileSync(statePath(dir), 'utf8')); return s?.version === 1 ? s : { version: 1 }; }
  catch { return { version: 1 }; }
}
export function writeState(dir: string, s: LiveState) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(statePath(dir), JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
}

export function recordTestnet(dir: string, r: Omit<TestnetRecord, 'sig'>) {
  const key = installKey(dir, true)!;
  const s = readState(dir);
  s.testnet = { ...r, sig: sign(key, r) };
  // a new testnet pass invalidates any older confirmation
  delete s.confirmation;
  writeState(dir, s);
  return s.testnet;
}
export function recordPermission(dir: string, r: Omit<PermissionRecord, 'sig'>) {
  if (r.canWithdraw !== false) throw new Error('refusing to record a key that can withdraw');
  const key = installKey(dir, true)!;
  const s = readState(dir);
  s.permission = { ...r, sig: sign(key, r) };
  delete s.confirmation;
  writeState(dir, s);
  return s.permission;
}
/** Writes the confirmation and returns the LIVE_CONFIRMED value for .env. Only the CLI calls this. */
export function recordConfirmation(dir: string, exchange: ExchangeName, keyFp: string, typedPhrase: string): string {
  if (typedPhrase.trim() !== CONFIRM_PHRASE) throw new Error('confirmation phrase does not match');
  const key = installKey(dir, false);
  if (!key) throw new Error('no install key, run the testnet step first');
  const s = readState(dir);
  const r = { exchange, keyFp, at: Date.now() };
  s.confirmation = { ...r, sig: sign(key, r) };
  writeState(dir, s);
  return liveToken(key, s)!;
}

function liveToken(key: Buffer, s: LiveState) {
  if (!s.testnet || !s.permission || !s.confirmation) return null;
  return createHmac('sha256', key).update(['live', s.confirmation.exchange, s.confirmation.keyFp, s.testnet.sig, s.permission.sig, s.confirmation.sig].join('|')).digest('hex');
}

export interface UnlockCheck { ok: boolean; reasons: string[]; exchange: ExchangeName | null; keyFp: string | null }

/** Everything the server checks before it will start with TRADING_MODE=LIVE. Synchronous, no network. */
export function checkLiveUnlock(env: NodeJS.ProcessEnv, dir = stateDir(env)): UnlockCheck {
  const reasons: string[] = [];
  let ex: ReturnType<typeof exchangeSettings>;
  try { ex = exchangeSettings(env); } catch (e) { return { ok: false, reasons: [(e as Error).message], exchange: null, keyFp: null }; }
  if (!ex.name) reasons.push('EXCHANGE is not set');
  const creds = ex.creds.mainnet;
  if (ex.name && !creds) reasons.push(`mainnet ${ex.name} credentials are missing in .env`);
  const keyFp = ex.name && creds ? keyFingerprint(ex.name, creds.key, creds.secret) : null;
  const key = installKey(dir, false);
  const s = readState(dir);
  if (!key) reasons.push('no install key in the state folder, run `npm run setup -- testnet` first');
  if (key) {
    if (!s.testnet) reasons.push('no passed testnet round trip on record (`npm run setup -- testnet`)');
    else if (!sigOk(key, s.testnet as any)) reasons.push('testnet record signature is invalid (edited by hand?)');
    else if (s.testnet.exchange !== ex.name) reasons.push(`testnet pass was on ${s.testnet.exchange}, not ${ex.name}`);
    if (!s.permission) reasons.push('no withdraw permission check on record (`npm run setup -- check-key`)');
    else if (!sigOk(key, s.permission as any)) reasons.push('permission record signature is invalid (edited by hand?)');
    else if (s.permission.canWithdraw !== false) reasons.push('the key on record can withdraw');
    else if (s.permission.keyFp !== keyFp) reasons.push('the mainnet key in .env is not the key that was checked');
    if (!s.confirmation) reasons.push('no typed confirmation on record (`npm run setup -- unlock-live`)');
    else if (!sigOk(key, s.confirmation as any)) reasons.push('confirmation record signature is invalid (edited by hand?)');
    else if (s.confirmation.keyFp !== keyFp || s.confirmation.exchange !== ex.name) reasons.push('confirmation was for a different key or exchange');
    const token = liveToken(key, s);
    const given = (env.LIVE_CONFIRMED ?? '').trim();
    if (!given) reasons.push('LIVE_CONFIRMED is missing (only `npm run setup -- unlock-live` writes it)');
    else if (!token || given.length !== token.length || !timingSafeEqual(Buffer.from(given), Buffer.from(token))) reasons.push('LIVE_CONFIRMED does not match the signed state (hand edited or stale)');
  }
  if (ex.name && ADAPTER_STATUS[ex.name] === 'experimental' && (env.ALLOW_EXPERIMENTAL_LIVE ?? '').trim() !== 'yes') {
    reasons.push(`the ${ex.name} adapter is experimental; it needs ALLOW_EXPERIMENTAL_LIVE=yes on top of every other check`);
  }
  return { ok: reasons.length === 0, reasons, exchange: ex.name, keyFp };
}
