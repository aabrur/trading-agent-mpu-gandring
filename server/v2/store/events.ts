import { createHash } from 'node:crypto';
import { sanitizeDiagnostic } from '../../session-log.js';
import { DomainEventSchema, type DomainEvent } from '../contracts.js';

function sortCanonical(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sortCanonical(item));
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b))) {
    if (record[key] !== undefined) {
      sorted[key] = sortCanonical(record[key]);
    }
  }
  return sorted;
}

export interface PreparedEventRecord {
  eventId: string;
  scope: string;
  kind: string;
  createdAt: string;
  correlationId: string | null;
  causationId: string | null;
  schemaVersion: number;
  payloadJson: string;
  payloadDigest: string;
}

export function prepareDomainEvent(rawEvent: DomainEvent): PreparedEventRecord {
  const parsed = DomainEventSchema.parse(rawEvent);
  const redactedPayload = sanitizeDiagnostic(parsed.payload);
  const canonicalPayload = sortCanonical(redactedPayload);
  const payloadJson = JSON.stringify(canonicalPayload);
  const identityJson = JSON.stringify({
    scope: parsed.scope,
    kind: parsed.kind,
    schemaVersion: parsed.schemaVersion,
    correlationId: parsed.correlationId,
    causationId: parsed.causationId,
    payload: canonicalPayload
  });
  const payloadDigest = createHash('sha256').update(identityJson).digest('hex');

  return {
    eventId: parsed.eventId,
    scope: parsed.scope,
    kind: parsed.kind,
    createdAt: parsed.createdAt,
    correlationId: parsed.correlationId,
    causationId: parsed.causationId,
    schemaVersion: parsed.schemaVersion,
    payloadJson,
    payloadDigest
  };
}
