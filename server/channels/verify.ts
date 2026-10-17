// Webhook signature checks for inbound chat commands. Every check is constant-time and fails closed.
import { createHmac, createPublicKey, timingSafeEqual, verify as edVerify } from 'node:crypto';

const MAX_SKEW_S = 300;
const eqHex = (a: string, b: string) => { const x = Buffer.from(a, 'utf8'); const y = Buffer.from(b, 'utf8'); return x.length === y.length && timingSafeEqual(x, y); };
const fresh = (ts: string, nowS: number) => /^\d{1,12}$/.test(ts) && Math.abs(nowS - Number(ts)) <= MAX_SKEW_S;

/** Slack: X-Slack-Signature = v0=hex(HMAC-SHA256(signing secret, "v0:" + timestamp + ":" + raw body)), timestamp within 5 minutes. */
export function verifySlack(secret: string, raw: Buffer | string, ts: string | undefined, sig: string | undefined, nowS = Math.floor(Date.now() / 1000)): boolean {
  if (!secret || !ts || !sig || !fresh(ts, nowS)) return false;
  const mac = 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:`).update(raw).digest('hex');
  return eqHex(mac, sig);
}

/** WhatsApp Cloud API (Meta webhooks): X-Hub-Signature-256 = sha256=hex(HMAC-SHA256(app secret, raw body)). */
export function verifyMeta(appSecret: string, raw: Buffer | string, sig: string | undefined): boolean {
  if (!appSecret || !sig) return false;
  return eqHex('sha256=' + createHmac('sha256', appSecret).update(raw).digest('hex'), sig);
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
/** Discord interactions: Ed25519 signature (X-Signature-Ed25519) over timestamp + raw body, with the app's public key. */
export function verifyDiscord(publicKeyHex: string, raw: Buffer | string, ts: string | undefined, sigHex: string | undefined, nowS = Math.floor(Date.now() / 1000)): boolean {
  try {
    if (!/^[0-9a-f]{64}$/i.test(publicKeyHex) || !ts || !sigHex || !/^[0-9a-f]{128}$/i.test(sigHex) || !fresh(ts, nowS)) return false;
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]), format: 'der', type: 'spki' });
    return edVerify(null, Buffer.concat([Buffer.from(ts, 'utf8'), Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8')]), key, Buffer.from(sigHex, 'hex'));
  } catch { return false; }
}

/** Constant-time compare for shared tokens (WhatsApp hub.verify_token). */
export function sameToken(a: string, b: string | undefined): boolean { return !!a && typeof b === 'string' && eqHex(a, b); }
