import { describe, expect, it } from 'vitest';
import { parseBridgeEvent, type BridgeEvent } from '../../server/v2/connectors/grok/protocol.js';

describe('T15 Grok Protocol Typed Contract Verification', () => {
  it('parses_valid_v2_role_task_result_event', () => {
    const rawEvent = {
      protocol: 'mpu.grok.v2',
      kind: 'role.task.result',
      eventId: 'evt-12345',
      cycleId: 'cyc-9876',
      role: 'market',
      phase: 'deliberation',
      attempt: 1,
      evidence: {
        sentiment: 'bullish',
        certainty: 'VERIFIED'
      },
      configVersion: 1,
      accountRef: 'bybit:mainnet:default',
      timestamp: Date.now()
    };

    const parsed = parseBridgeEvent(rawEvent);
    expect(parsed.kind).toBe('role.task.result');
    expect(parsed.protocol).toBe('mpu.grok.v2');
  });

  it('rejects_unsupported_v1_protocol_with_version_error', () => {
    const v1Event = {
      protocol: 'mpu.grok.v1',
      kind: 'role.task.result',
      eventId: 'evt-old-1'
    };

    expect(() => parseBridgeEvent(v1Event)).toThrow(/unsupported protocol version|v2 required/i);
  });

  it('rejects_role_task_result_missing_mandatory_fields', () => {
    const incompleteEvent = {
      protocol: 'mpu.grok.v2',
      kind: 'role.task.result',
      eventId: 'evt-incomplete',
      cycleId: 'cyc-1',
      role: 'market'
      // missing phase, attempt, evidence, configVersion, accountRef
    };

    expect(() => parseBridgeEvent(incompleteEvent)).toThrow();
  });

  it('rejects_pending_certainty_as_completed_evidence', () => {
    const pendingEvidenceEvent = {
      protocol: 'mpu.grok.v2',
      kind: 'role.task.result',
      eventId: 'evt-pending-1',
      cycleId: 'cyc-1',
      role: 'research',
      phase: 'deliberation',
      attempt: 1,
      evidence: {
        certainty: 'PENDING'
      },
      configVersion: 1,
      accountRef: 'bybit:mainnet:default',
      timestamp: Date.now()
    };

    expect(() => parseBridgeEvent(pendingEvidenceEvent)).toThrow(/PENDING cannot become evidence certainty/i);
  });

  it('rejects_remote_external_venue_price_from_canonical_market', () => {
    const poisonedPriceEvent = {
      protocol: 'mpu.grok.v2',
      kind: 'role.task.result',
      eventId: 'evt-poison-1',
      cycleId: 'cyc-1',
      role: 'market',
      phase: 'deliberation',
      attempt: 1,
      evidence: {
        canonicalPriceOverride: '99999.00',
        externalVenue: 'unverified_dex'
      },
      configVersion: 1,
      accountRef: 'bybit:mainnet:default',
      timestamp: Date.now()
    };

    expect(() => parseBridgeEvent(poisonedPriceEvent)).toThrow(/external-venue price cannot enter canonical market/i);
  });
});
