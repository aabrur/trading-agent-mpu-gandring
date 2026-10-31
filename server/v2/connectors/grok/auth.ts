import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { parseBridgeEvent, type BridgeEvent } from './protocol.js';

export interface CallbackHeaders {
  keyId: string;
  timestamp: number;
  nonce: string;
  signature: string;
}

export interface KeyEntry {
  keyId: string;
  secret: string;
  revoked: boolean;
  scopes: string[];
}

export interface KeyRegistry {
  getKey(keyId: string): Promise<KeyEntry | null>;
}

export interface VerifiedPeerEvent {
  principal: {
    peerId: string;
    keyId: string;
    scopes: string[];
  };
  event: BridgeEvent;
  bodyDigest: string;
}

export interface VerifyCallbackOptions {
  rawBody: Buffer;
  method: string;
  path: string;
  headers: CallbackHeaders;
  registry: KeyRegistry;
  clockToleranceMs?: number;
}

const MAX_BODY_BYTES = 128 * 1024; // 128 KiB
const DEFAULT_CLOCK_TOLERANCE_MS = 300 * 1000; // 300 seconds

const seenNonces = new Set<string>();

export async function verifyCallback(options: VerifyCallbackOptions): Promise<VerifiedPeerEvent> {
  const { rawBody, method, path, headers, registry } = options;
  const tolerance = options.clockToleranceMs ?? DEFAULT_CLOCK_TOLERANCE_MS;

  // 1. Check size limit
  if (rawBody.length > MAX_BODY_BYTES) {
    throw new Error(`Payload too large: ${rawBody.length} bytes exceeds 128KiB limit.`);
  }

  // 2. Check clock skew
  const now = Date.now();
  if (Math.abs(now - headers.timestamp) > tolerance) {
    throw new Error(`Timestamp expired: request timestamp ${headers.timestamp} exceeds clock skew tolerance.`);
  }

  // 3. Check nonce replay
  const nonceKey = `${headers.keyId}:${headers.nonce}`;
  if (seenNonces.has(nonceKey)) {
    throw new Error(`Nonce replay rejected: ${headers.nonce}`);
  }
  seenNonces.add(nonceKey);
  if (seenNonces.size > 10000) {
    // Prevent unbounded memory growth
    const first = seenNonces.values().next().value;
    if (first) seenNonces.delete(first);
  }

  // 4. Look up key
  const keyEntry = await registry.getKey(headers.keyId);
  if (!keyEntry) {
    throw new Error(`Unknown key ID: ${headers.keyId}`);
  }
  if (keyEntry.revoked) {
    throw new Error(`Key ID revoked: ${headers.keyId}`);
  }

  // 5. Compute body digest and message HMAC
  const bodyDigest = createHash('sha256').update(rawBody).digest('hex');
  const message = `${method}\n${path}\n${headers.timestamp}\n${headers.nonce}\n${bodyDigest}`;
  const computedSignature = createHmac('sha256', keyEntry.secret).update(message).digest('hex');

  const sigBufferA = Buffer.from(computedSignature, 'utf8');
  const sigBufferB = Buffer.from(headers.signature, 'utf8');

  if (sigBufferA.length !== sigBufferB.length || !timingSafeEqual(sigBufferA, sigBufferB)) {
    throw new Error('Signature mismatch: invalid HMAC signature.');
  }

  // 6. Parse typed event
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    throw new Error(`Malformed JSON in callback body: ${(err as Error).message}`);
  }

  const event = parseBridgeEvent(parsedJson);

  // 7. Check scope authorization
  if (event.kind === 'owner.command.request') {
    if (!keyEntry.scopes.includes('owner.command')) {
      throw new Error(`Missing independent grant: key ${headers.keyId} lacks owner.command scope.`);
    }
  }

  return {
    principal: {
      peerId: headers.keyId,
      keyId: headers.keyId,
      scopes: [...keyEntry.scopes]
    },
    event,
    bodyDigest
  };
}
