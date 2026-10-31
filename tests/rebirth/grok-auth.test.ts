import { createHmac, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  verifyCallback,
  type CallbackHeaders,
  type KeyRegistry
} from '../../server/v2/connectors/grok/auth.js';

describe('T15 Grok Callback HMAC Raw-Body Authentication Verification', () => {
  const SECRET = 'test-grok-shared-hmac-secret-32bytes!';
  const KEY_ID = 'key-grok-alpha-1';

  const defaultRegistry: KeyRegistry = {
    getKey: async (keyId: string) => {
      if (keyId === KEY_ID) {
        return {
          keyId,
          secret: SECRET,
          revoked: false,
          scopes: ['role.task.result', 'desk.state.sync']
        };
      }
      if (keyId === 'key-owner-granted') {
        return {
          keyId: 'key-owner-granted',
          secret: SECRET,
          revoked: false,
          scopes: ['role.task.result', 'owner.command']
        };
      }
      if (keyId === 'key-revoked') {
        return {
          keyId: 'key-revoked',
          secret: SECRET,
          revoked: true,
          scopes: ['role.task.result']
        };
      }
      return null;
    }
  };

  function computeHeaders(params: {
    method: string;
    path: string;
    rawBody: Buffer;
    timestamp: number;
    nonce: string;
    keyId: string;
    secret: string;
  }): CallbackHeaders {
    const bodyDigest = createHash('sha256').update(params.rawBody).digest('hex');
    const message = `${params.method}\n${params.path}\n${params.timestamp}\n${params.nonce}\n${bodyDigest}`;
    const signature = createHmac('sha256', params.secret).update(message).digest('hex');

    return {
      keyId: params.keyId,
      timestamp: params.timestamp,
      nonce: params.nonce,
      signature
    };
  }

  it('authenticates_valid_raw_body_hmac_and_returns_verified_peer_event', async () => {
    const event = {
      protocol: 'mpu.grok.v2',
      kind: 'role.task.result',
      eventId: 'evt-auth-1',
      cycleId: 'cyc-1',
      role: 'market',
      phase: 'deliberation',
      attempt: 1,
      evidence: { certainty: 'VERIFIED' },
      configVersion: 1,
      accountRef: 'bybit:mainnet:default',
      timestamp: Date.now()
    };

    const rawBody = Buffer.from(JSON.stringify(event));
    const now = Date.now();
    const headers = computeHeaders({
      method: 'POST',
      path: '/api/grok/callback',
      rawBody,
      timestamp: now,
      nonce: 'nonce-1',
      keyId: KEY_ID,
      secret: SECRET
    });

    const result = await verifyCallback({
      rawBody,
      method: 'POST',
      path: '/api/grok/callback',
      headers,
      registry: defaultRegistry
    });

    expect(result.principal.keyId).toBe(KEY_ID);
    expect(result.event.kind).toBe('role.task.result');
  });

  it('owner_command_request_missing_independent_grant_fails_authorization_even_when_hmac_valid', async () => {
    const event = {
      protocol: 'mpu.grok.v2',
      kind: 'owner.command.request',
      eventId: 'evt-cmd-unauth',
      command: 'close BTCUSDT',
      accountRef: 'bybit:mainnet:default',
      expectedActiveVersion: 1,
      timestamp: Date.now()
    };

    const rawBody = Buffer.from(JSON.stringify(event));
    const now = Date.now();
    // Key KEY_ID lacks 'owner.command' scope
    const headers = computeHeaders({
      method: 'POST',
      path: '/api/grok/callback',
      rawBody,
      timestamp: now,
      nonce: 'nonce-unauth-cmd',
      keyId: KEY_ID,
      secret: SECRET
    });

    await expect(
      verifyCallback({
        rawBody,
        method: 'POST',
        path: '/api/grok/callback',
        headers,
        registry: defaultRegistry
      })
    ).rejects.toThrow(/missing independent grant|unauthorized scope/i);
  });

  it('rejects_tampered_body_or_whitespace', async () => {
    const event = {
      protocol: 'mpu.grok.v2',
      kind: 'peer.heartbeat',
      eventId: 'evt-hb-1',
      peerId: 'peer-alpha',
      timestamp: Date.now()
    };

    const rawBody = Buffer.from(JSON.stringify(event));
    const now = Date.now();
    const headers = computeHeaders({
      method: 'POST',
      path: '/api/grok/callback',
      rawBody,
      timestamp: now,
      nonce: 'nonce-tamper-1',
      keyId: KEY_ID,
      secret: SECRET
    });

    // Tamper raw body with extra whitespace
    const tamperedBody = Buffer.from(JSON.stringify(event) + ' ');

    await expect(
      verifyCallback({
        rawBody: tamperedBody,
        method: 'POST',
        path: '/api/grok/callback',
        headers,
        registry: defaultRegistry
      })
    ).rejects.toThrow(/signature mismatch|invalid signature/i);
  });

  it('rejects_expired_timestamp_greater_than_300s', async () => {
    const rawBody = Buffer.from('{}');
    const expiredTimestamp = Date.now() - 301000;
    const headers = computeHeaders({
      method: 'POST',
      path: '/api/grok/callback',
      rawBody,
      timestamp: expiredTimestamp,
      nonce: 'nonce-expired-1',
      keyId: KEY_ID,
      secret: SECRET
    });

    await expect(
      verifyCallback({
        rawBody,
        method: 'POST',
        path: '/api/grok/callback',
        headers,
        registry: defaultRegistry
      })
    ).rejects.toThrow(/timestamp expired|clock skew/i);
  });

  it('rejects_body_overflow_greater_than_128kib', async () => {
    const overflowBody = Buffer.alloc(129 * 1024, 0);
    const headers = computeHeaders({
      method: 'POST',
      path: '/api/grok/callback',
      rawBody: overflowBody,
      timestamp: Date.now(),
      nonce: 'nonce-overflow-1',
      keyId: KEY_ID,
      secret: SECRET
    });

    await expect(
      verifyCallback({
        rawBody: overflowBody,
        method: 'POST',
        path: '/api/grok/callback',
        headers,
        registry: defaultRegistry
      })
    ).rejects.toThrow(/payload too large|overflow/i);
  });
});
