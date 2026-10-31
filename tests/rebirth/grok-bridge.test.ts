import { describe, expect, it } from 'vitest';
import {
  GrokBridge,
  type GrokBridgeOptions,
  type BridgeReceipt
} from '../../server/v2/connectors/grok/bridge.js';
import type { BridgeEvent } from '../../server/v2/connectors/grok/protocol.js';

describe('T16 Grok Bridge Durable Asynchronous Delivery Verification', () => {
  it('webhook_200_without_callback_stays_pending: webhook HTTP 200 alone leaves event in pending state', async () => {
    let webhookCalled = false;
    const bridge = new GrokBridge({
      webhookUrl: 'https://grok.example.invalid/webhook',
      webhookPoster: async (_url, _body) => {
        webhookCalled = true;
        // Mock successful outbound HTTP 200 acknowledgement
        return { ok: true, status: 200 };
      }
    });

    const event: BridgeEvent = {
      protocol: 'mpu.grok.v2',
      kind: 'role.task.result',
      eventId: 'evt-webhook-ack-1',
      cycleId: 'cyc-1',
      role: 'lead',
      phase: 'synthesis',
      attempt: 1,
      evidence: { certainty: 'VERIFIED' },
      configVersion: 1,
      accountRef: 'bybit:mainnet:default',
      timestamp: Date.now()
    };

    const receipt = await bridge.enqueue(event);
    expect(webhookCalled).toBe(true);
    expect(receipt.eventId).toBe('evt-webhook-ack-1');
    // Crucial: HTTP 200 alone must be ACCEPTED_BY_WEBHOOK or REMOTE_PENDING, not REMOTE_COMPLETED
    expect(receipt.status).toBe('ACCEPTED_BY_WEBHOOK');

    const status = bridge.status();
    expect(status.lastAcceptedAt).toBeDefined();
    expect(status.observedHealth).toBe('OUTBOUND_ONLY');
  });

  it('duplicate_event_gets_original_receipt: duplicate submission returns original cached receipt', async () => {
    let callCount = 0;
    const bridge = new GrokBridge({
      webhookUrl: 'https://grok.example.invalid/webhook',
      webhookPoster: async () => {
        callCount += 1;
        return { ok: true, status: 200 };
      }
    });

    const event: BridgeEvent = {
      protocol: 'mpu.grok.v2',
      kind: 'peer.heartbeat',
      eventId: 'evt-dup-1',
      peerId: 'peer-alpha',
      timestamp: Date.now()
    };

    const receipt1 = await bridge.enqueue(event);
    const receipt2 = await bridge.enqueue(event);

    expect(receipt1.eventId).toBe('evt-dup-1');
    expect(receipt2.eventId).toBe('evt-dup-1');
    // Webhook should only be dispatched once for the same eventId
    expect(callCount).toBe(1);
  });

  it('native_order_writes_equals_zero_for_all_bridge_ingest_paths: bridge never writes native orders', async () => {
    let nativeOrderSubmitted = false;
    const fakeGateway = {
      submit: async () => {
        nativeOrderSubmitted = true;
        return {} as any;
      }
    };

    const bridge = new GrokBridge({
      gateway: fakeGateway as any
    });

    // Ingest a remote role completion
    await bridge.ingest({
      principal: { peerId: 'peer-1', keyId: 'key-1', scopes: ['role.task.result'] },
      bodyDigest: 'digest-1',
      event: {
        protocol: 'mpu.grok.v2',
        kind: 'role.task.result',
        eventId: 'evt-ingest-1',
        cycleId: 'cyc-1',
        role: 'risk',
        phase: 'evaluation',
        attempt: 1,
        evidence: { certainty: 'VERIFIED', action: 'APPROVE' },
        configVersion: 1,
        accountRef: 'bybit:mainnet:default',
        timestamp: Date.now()
      }
    });

    // Ingest must NEVER trigger direct native orders
    expect(nativeOrderSubmitted).toBe(false);
  });
});
