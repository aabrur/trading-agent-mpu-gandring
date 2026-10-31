import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  AgentId,
  Availability,
  AvailableValue,
  OfficeCommand,
  OfficeEvent,
  OfficeReply,
  OfficeState
} from '../../shared/office.js';

export type {
  AgentId,
  Availability,
  AvailableValue,
  OfficeCommand,
  OfficeEvent,
  OfficeReply,
  OfficeState
};

export const ROLE_IDS = ['lead', 'market', 'research', 'strategist', 'risk', 'execution'] as const;
export type RoleId = (typeof ROLE_IDS)[number];

export const TRADING_MODES = ['PAPER', 'TESTNET', 'LIVE'] as const;
export type TradingMode = (typeof TRADING_MODES)[number];

export const APP_MODES = ['local', 'grokbot'] as const;
export type AppMode = (typeof APP_MODES)[number];

export const EXCHANGES = ['bybit', 'binance', 'okx', 'hyperliquid', 'aster', 'dydx', 'paradex', 'orderly'] as const;
export type Venue = (typeof EXCHANGES)[number];
export type VenueId = Venue;

export const NETWORKS = ['testnet', 'mainnet'] as const;
export type Network = (typeof NETWORKS)[number];

export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type TF = (typeof TIMEFRAMES)[number];

export const DECIMAL_REGEX = /^-?\d+(?:\.\d+)?$/;
export const DecimalStringSchema = z
  .string()
  .trim()
  .regex(DECIMAL_REGEX, 'Expected finite decimal string');
export type DecimalString = z.infer<typeof DecimalStringSchema>;

export const CERTAINTY_LEVELS = ['VERIFIED', 'REPORTED', 'INFERRED'] as const;
export type Certainty = (typeof CERTAINTY_LEVELS)[number];

export const FRESHNESS_LEVELS = ['CURRENT', 'STALE', 'UNKNOWN'] as const;
export type Freshness = (typeof FRESHNESS_LEVELS)[number];

export interface Evidence<T> {
  id: string;
  value: T | null;
  certainty: Certainty | null;
  availability: Availability;
  freshness: Freshness;
  source: string;
  sourceAt: number | null;
  observedAt: number;
  publishedAt: number | null;
  eventAt: number | null;
  unit: string | null;
  reason: string | null;
}

export function unavailableFinancialField<T = number>(): AvailableValue<T> {
  return { value: null, availability: 'UNAVAILABLE' };
}

export function availableFinancialField<T>(value: T): AvailableValue<T> {
  return { value, availability: 'AVAILABLE' };
}

export function unavailableEvidence<T>(
  source: string,
  reason: string,
  observedAt = Date.now(),
  unit: string | null = null
): Evidence<T> {
  return {
    id: `ev-${randomUUID()}`,
    value: null,
    certainty: null,
    availability: 'UNAVAILABLE',
    freshness: 'UNKNOWN',
    source,
    sourceAt: null,
    observedAt,
    publishedAt: null,
    eventAt: null,
    unit,
    reason
  };
}

export function verifiedEvidence<T>(params: {
  value: T;
  source: string;
  sourceAt?: number | null;
  observedAt?: number;
  publishedAt?: number | null;
  eventAt?: number | null;
  unit?: string | null;
  certainty?: Certainty;
  freshness?: Freshness;
}): Evidence<T> {
  return {
    id: `ev-${randomUUID()}`,
    value: params.value,
    certainty: params.certainty ?? 'VERIFIED',
    availability: 'AVAILABLE',
    freshness: params.freshness ?? 'CURRENT',
    source: params.source,
    sourceAt: params.sourceAt ?? null,
    observedAt: params.observedAt ?? Date.now(),
    publishedAt: params.publishedAt ?? null,
    eventAt: params.eventAt ?? null,
    unit: params.unit ?? null,
    reason: null
  };
}

export const AccountScopeSchema = z.object({
  accountRef: z.string().min(1),
  venue: z.enum(EXCHANGES),
  network: z.enum(NETWORKS),
  mode: z.enum(TRADING_MODES),
  subaccountRef: z.string().min(1).nullable()
});
export type AccountScope = z.infer<typeof AccountScopeSchema>;

export interface MarketCandle {
  symbol: string;
  tf: TF;
  startAt: number;
  endAt: number;
  open: DecimalString;
  high: DecimalString;
  low: DecimalString;
  close: DecimalString;
  volume: DecimalString;
  volumeUnit: string;
  confirmed: boolean;
  sourceAt: number;
  observedAt: number;
}

export interface MarketFrame {
  evidenceId: string;
  revision: number;
  symbol: string;
  venue: 'bybit';
  category: 'linear';
  asOf: number;
  last: Evidence<DecimalString>;
  bid: Evidence<DecimalString>;
  ask: Evidence<DecimalString>;
  closed: Record<TF, MarketCandle[]>;
  current: Partial<Record<TF, MarketCandle>>;
  tradesEvidenceId: string | null;
  bookEvidenceId: string | null;
  funding: Evidence<DecimalString>;
  openInterest: Evidence<DecimalString>;
}

export const CONFIDENCE_SCALES = ['probability_0_1', 'ordinal_1_5', 'score_0_100'] as const;
export type ConfidenceScale = (typeof CONFIDENCE_SCALES)[number];

export interface ConfidenceReading {
  value: number | null;
  scale: ConfidenceScale | null;
  source: string;
  availability?: Availability;
  reason?: string | null;
}

export const EXIT_TRIGGERS = [
  'INVALIDATION_HIT',
  'MOMENTUM_REVERSAL',
  'SENTIMENT_REVERSAL',
  'OPPOSING_NEWS',
  'WHALE_EXIT',
  'EXCHANGE_STOP_OR_TP',
  'EARLY_TAKE_PROFIT',
  'DATA_ANOMALY_OR_CONFLICT',
  'GUARD_THREATENED'
] as const;
export type ExitTriggerCode = (typeof EXIT_TRIGGERS)[number];
export type ExitTrigger = ExitTriggerCode;

export const INTENT_STATES = [
  'CREATED',
  'JOURNALED',
  'SUBMITTING',
  'ACCEPTED',
  'UNKNOWN',
  'PARTIAL',
  'FILLED',
  'CANCELLED',
  'REJECTED'
] as const;
export type IntentState = (typeof INTENT_STATES)[number];

export const PROTECTION_STATES = [
  'NOT_APPLICABLE',
  'PENDING',
  'VERIFIED',
  'UNVERIFIED',
  'MISSING'
] as const;
export type ProtectionState = (typeof PROTECTION_STATES)[number];

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface QueryResult {
  rows: Array<Record<string, SqlValue>>;
  rowsAffected: number;
}

export const DomainEventSchema = z.object({
  eventId: z.string().min(1),
  scope: z.string().min(1),
  kind: z.string().min(1),
  createdAt: z.string().min(1),
  correlationId: z.string().min(1).nullable(),
  causationId: z.string().min(1).nullable(),
  schemaVersion: z.number().int().positive(),
  payload: z.record(z.string(), z.unknown())
});
export type DomainEvent = z.infer<typeof DomainEventSchema>;

export interface StoreTransaction {
  execute(sql: string, args?: SqlValue[]): Promise<QueryResult>;
  append(event: DomainEvent): Promise<number>;
}

export interface OfficeRuntime {
  snapshot(): OfficeState;
  dispatch(input: OfficeCommand): Promise<OfficeReply>;
  triggerCycle?(symbol?: string, reason?: string): Promise<{ ok: boolean; message: string; cycleId?: string }>;
  updateAutoSettings?(patch: Record<string, unknown>): OfficeState;
  handleCommand?(input: { text: string; agent?: string; clientRequestId?: string }): Promise<{ ok: boolean; command?: string; reply?: string; error?: string }>;
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

export function isLocalLoopbackClient(input: {
  remoteAddress?: string | null;
  hostHeader?: string | null;
  origin?: string | null;
}): { ok: boolean; reason: string } {
  if (!input.remoteAddress || !LOOPBACK_ADDRESSES.has(input.remoteAddress)) {
    return { ok: false, reason: 'only available from this computer (localhost).' };
  }
  if (!input.hostHeader || !LOOPBACK_HOST_RE.test(input.hostHeader)) {
    return { ok: false, reason: 'open the office at http://127.0.0.1 or http://localhost.' };
  }
  if (input.origin && !LOOPBACK_HOST_RE.test(input.origin.replace(/^https?:\/\//, ''))) {
    return { ok: false, reason: 'cross-origin request refused.' };
  }
  return { ok: true, reason: 'local' };
}
