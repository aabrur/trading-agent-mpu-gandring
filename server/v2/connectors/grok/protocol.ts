import { z } from 'zod';
import { ROLE_IDS, TRADING_MODES, type RoleId, type TradingMode } from '../../contracts.js';

export const RoleTaskResultEventSchema = z.object({
  protocol: z.literal('mpu.grok.v2'),
  kind: z.literal('role.task.result'),
  eventId: z.string().min(1),
  cycleId: z.string().min(1),
  role: z.enum(ROLE_IDS),
  phase: z.string().min(1),
  attempt: z.number().int().positive(),
  evidence: z.record(z.string(), z.unknown()),
  configVersion: z.number().int().nonnegative(),
  accountRef: z.string().min(1),
  timestamp: z.number().int().positive()
});

export const OwnerCommandRequestEventSchema = z.object({
  protocol: z.literal('mpu.grok.v2'),
  kind: z.literal('owner.command.request'),
  eventId: z.string().min(1),
  command: z.string().min(1),
  grantId: z.string().optional(),
  accountRef: z.string().min(1),
  expectedActiveVersion: z.number().int().nonnegative(),
  timestamp: z.number().int().positive()
});

export const DeskStateSyncEventSchema = z.object({
  protocol: z.literal('mpu.grok.v2'),
  kind: z.literal('desk.state.sync'),
  eventId: z.string().min(1),
  mode: z.enum(TRADING_MODES),
  killed: z.boolean(),
  timestamp: z.number().int().positive()
});

export const PeerHeartbeatEventSchema = z.object({
  protocol: z.literal('mpu.grok.v2'),
  kind: z.literal('peer.heartbeat'),
  eventId: z.string().min(1),
  peerId: z.string().min(1),
  timestamp: z.number().int().positive()
});

export const BridgeEventSchema = z.discriminatedUnion('kind', [
  RoleTaskResultEventSchema,
  OwnerCommandRequestEventSchema,
  DeskStateSyncEventSchema,
  PeerHeartbeatEventSchema
]);

export type BridgeEvent = z.infer<typeof BridgeEventSchema>;
export type RoleTaskResultEvent = z.infer<typeof RoleTaskResultEventSchema>;
export type OwnerCommandRequestEvent = z.infer<typeof OwnerCommandRequestEventSchema>;
export type DeskStateSyncEvent = z.infer<typeof DeskStateSyncEventSchema>;
export type PeerHeartbeatEvent = z.infer<typeof PeerHeartbeatEventSchema>;

export function parseBridgeEvent(value: unknown): BridgeEvent {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid bridge event: must be an object.');
  }

  const record = value as Record<string, unknown>;
  if (record.protocol === 'mpu.grok.v1') {
    throw new Error('Unsupported protocol version: mpu.grok.v1 is deprecated; v2 required.');
  }
  if (record.protocol !== 'mpu.grok.v2') {
    throw new Error(`Unsupported protocol version: expected mpu.grok.v2, received ${String(record.protocol)}`);
  }

  // Validate evidence rules for role task results
  if (record.kind === 'role.task.result' && typeof record.evidence === 'object' && record.evidence !== null) {
    const evidence = record.evidence as Record<string, unknown>;
    if (evidence.certainty === 'PENDING') {
      throw new Error('PENDING cannot become evidence certainty in completed role task result.');
    }
    if ('canonicalPriceOverride' in evidence || 'externalVenue' in evidence) {
      throw new Error('Remote external-venue price cannot enter canonical market data.');
    }
  }

  return BridgeEventSchema.parse(value);
}
