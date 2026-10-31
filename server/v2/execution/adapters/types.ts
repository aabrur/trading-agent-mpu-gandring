import { z } from 'zod';
import { safe } from '../../../redact.js';
import {
  DecimalStringSchema,
  EXCHANGES,
  INTENT_STATES,
  NETWORKS,
  type DecimalString,
  type Network,
  type Venue
} from '../../contracts.js';
import { compareDecimals, mulDecimals, quantize } from '../decimal.js';

export const VENUE_STATUS: Record<Venue, 'implemented' | 'experimental'> = {
  bybit: 'implemented',
  binance: 'experimental',
  okx: 'experimental',
  hyperliquid: 'experimental',
  aster: 'experimental',
  dydx: 'experimental',
  paradex: 'experimental',
  orderly: 'experimental'
};

export const VENUE_LABELS: Record<Venue, string> = {
  bybit: 'Bybit',
  binance: 'Binance',
  okx: 'OKX',
  hyperliquid: 'Hyperliquid',
  aster: 'Aster',
  dydx: 'dYdX v4',
  paradex: 'Paradex',
  orderly: 'Orderly'
};

export interface DelegatedCredentials {
  key: string;
  secret: string;
  passphrase?: string | null;
  verifiedAgentAddress?: string | null;
}

export interface AdapterOptions {
  network: Network;
  credentialRef: string;
  fetchImpl: typeof fetch;
  readSecret: (ref: string) => Promise<DelegatedCredentials>;
}

export class AdapterCapabilityError extends Error {
  constructor(message: string) {
    super(safe(message));
    this.name = 'AdapterCapabilityError';
  }
}

export class VenueTransportError extends Error {
  constructor(
    message: string,
    public readonly code?: string | number,
    public readonly retryable = false
  ) {
    super(safe(message));
    this.name = 'VenueTransportError';
  }
}

export const PermissionEvidenceSchema = z.object({
  ok: z.boolean(),
  canTrade: z.boolean(),
  canWithdraw: z.boolean().nullable(),
  verified: z.boolean(),
  delegatedOnly: z.boolean(),
  detail: z.string(),
  observedAt: z.number().int().nonnegative()
});
export type PermissionEvidence = z.infer<typeof PermissionEvidenceSchema>;

export const NativeAccountIdentitySchema = z.object({
  venue: z.enum(EXCHANGES),
  network: z.enum(NETWORKS),
  publicAccountId: z.string().min(1),
  subaccountRef: z.string().nullable(),
  positionMode: z.enum(['ONE_WAY', 'HEDGE']),
  observedAt: z.number().int().nonnegative()
});
export type NativeAccountIdentity = z.infer<typeof NativeAccountIdentitySchema>;

export const NativeBalanceSchema = z.object({
  settlementCurrency: z.string().min(1),
  equity: DecimalStringSchema.nullable(),
  available: DecimalStringSchema.nullable(),
  realizedDailyPnl: DecimalStringSchema.nullable().default(null),
  observedAt: z.number().int().nonnegative(),
  availability: z.enum(['AVAILABLE', 'STALE', 'UNAVAILABLE'])
});
export type NativeBalance = z.infer<typeof NativeBalanceSchema>;

export const NativeRulesSchema = z.object({
  symbol: z.string().min(1),
  nativeSymbol: z.string().min(1),
  tickSize: DecimalStringSchema,
  qtyStep: DecimalStringSchema,
  minQty: DecimalStringSchema,
  maxQty: DecimalStringSchema.nullable(),
  minNotional: DecimalStringSchema.nullable(),
  contractMultiplier: DecimalStringSchema,
  settlementCurrency: z.string().min(1),
  positionModeCapability: z.enum(['ONE_WAY', 'HEDGE', 'BOTH']),
  exchangeStops: z.boolean(),
  restingLimitGtcEntry: z.boolean()
});
export type NativeRules = z.infer<typeof NativeRulesSchema>;

export const VenueQuoteSchema = z.object({
  symbol: z.string().min(1),
  last: DecimalStringSchema,
  bid: DecimalStringSchema.nullable(),
  ask: DecimalStringSchema.nullable(),
  sourceAt: z.number().int().nullable(),
  observedAt: z.number().int().nonnegative(),
  ageMs: z.number().int().nonnegative().nullable()
});
export type VenueQuote = z.infer<typeof VenueQuoteSchema>;

export const NativeOrderSchema = z.object({
  clientOrderId: z.string().min(1),
  symbol: z.string().min(1),
  side: z.enum(['LONG', 'SHORT']),
  positionMode: z.enum(['ONE_WAY', 'HEDGE']).default('ONE_WAY'),
  hedgeLeg: z.enum(['LONG', 'SHORT']).nullable().default(null),
  orderType: z.enum(['MARKET', 'LIMIT_GTC']),
  quantity: DecimalStringSchema,
  limitPrice: DecimalStringSchema.nullable().default(null),
  leverage: z.number().int().positive(),
  expireAt: z.number().int().positive().nullable().default(null)
});
export type NativeOrder = z.infer<typeof NativeOrderSchema>;

export const NativeOrderReceiptSchema = z.object({
  clientOrderId: z.string().min(1),
  venueOrderId: z.string().nullable(),
  symbol: z.string().min(1),
  state: z.enum(INTENT_STATES),
  filledQty: DecimalStringSchema.nullable(),
  avgFillPrice: DecimalStringSchema.nullable(),
  observedAt: z.number().int().nonnegative(),
  reason: z.string().nullable()
});
export type NativeOrderReceipt = z.infer<typeof NativeOrderReceiptSchema>;

export const NativePositionSchema = z.object({
  positionKey: z.string().min(1),
  nativePositionId: z.string().nullable(),
  symbol: z.string().min(1),
  nativeSymbol: z.string().min(1),
  positionMode: z.enum(['ONE_WAY', 'HEDGE']),
  hedgeLeg: z.enum(['LONG', 'SHORT']).nullable(),
  side: z.enum(['LONG', 'SHORT']),
  qty: DecimalStringSchema,
  entryPrice: DecimalStringSchema,
  leverage: z.number().positive().nullable(),
  unrealizedPnl: DecimalStringSchema.nullable(),
  observedAt: z.number().int().nonnegative()
});
export type NativePosition = z.infer<typeof NativePositionSchema>;

export const NativeProtectionSchema = z.object({
  stopPrice: DecimalStringSchema,
  tpPrice: DecimalStringSchema.nullable().default(null),
  triggerBy: z.enum(['MARK_PRICE', 'LAST_PRICE', 'INDEX_PRICE']).default('MARK_PRICE'),
  clientOrderId: z.string().min(1)
});
export type NativeProtection = z.infer<typeof NativeProtectionSchema>;

export const ProtectionEvidenceSchema = z.object({
  symbol: z.string().min(1),
  positionKey: z.string().min(1),
  side: z.enum(['LONG', 'SHORT']),
  requiredQty: DecimalStringSchema,
  coveredQty: DecimalStringSchema,
  stopPrice: DecimalStringSchema.nullable(),
  tpPrice: DecimalStringSchema.nullable(),
  reduceOnlyOrPositionBound: z.boolean(),
  state: z.enum(['VERIFIED', 'UNVERIFIED', 'MISSING']),
  observedAt: z.number().int().nonnegative(),
  reason: z.string().nullable()
});
export type ProtectionEvidence = z.infer<typeof ProtectionEvidenceSchema>;

export const FinancialRecordSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['fill', 'fee', 'funding']),
  symbol: z.string().nullable(),
  side: z.enum(['LONG', 'SHORT']).nullable(),
  qty: DecimalStringSchema.nullable(),
  price: DecimalStringSchema.nullable(),
  feeAmount: DecimalStringSchema.nullable(),
  feeCurrency: z.string().nullable(),
  realizedPnl: DecimalStringSchema.nullable(),
  fundingAmount: DecimalStringSchema.nullable(),
  currency: z.string().nullable(),
  occurredAt: z.number().int().nonnegative()
});
export type NativeFinancialRecord = z.infer<typeof FinancialRecordSchema>;

export const FinancialPageSchema = z.object({
  records: z.array(FinancialRecordSchema),
  nextCursor: z.string().nullable(),
  complete: z.boolean(),
  supported: z.array(z.enum(['fills', 'fees', 'funding']))
});
export type FinancialPage = z.infer<typeof FinancialPageSchema>;

export interface VenueAdapter {
  readonly venue: Venue;
  readonly network: Network;
  readonly status: 'implemented' | 'experimental';
  readonly capabilities: {
    exchangeStops: boolean;
    restingLimitGtcEntry: boolean;
    hedgeMode: boolean;
    financialHistory: readonly ('fills' | 'fees' | 'funding')[];
  };
  permissions(): Promise<PermissionEvidence>;
  accountIdentity(): Promise<NativeAccountIdentity>;
  balance(): Promise<NativeBalance>;
  instruments(symbol: string): Promise<NativeRules>;
  quote(symbol: string): Promise<VenueQuote>;
  positions(): Promise<NativePosition[]>;
  submit(intent: NativeOrder): Promise<NativeOrderReceipt>;
  lookupOrder(symbol: string, clientOrderId: string): Promise<NativeOrderReceipt>;
  cancelEntry(symbol: string, clientOrderId: string): Promise<NativeOrderReceipt>;
  protection(position: NativePosition): Promise<ProtectionEvidence>;
  protect(position: NativePosition, protection: NativeProtection): Promise<ProtectionEvidence>;
  close(position: NativePosition, clientOrderId: string): Promise<NativeOrderReceipt>;
  financialHistory(cursor: string | null): Promise<FinancialPage>;
}

const SEED_WORDS_RE = /^([a-z]{3,12}\s+){11,23}[a-z]{3,12}$/i;

export function scrubAdapterError(
  message: string,
  secrets: ReadonlyArray<string | null | undefined> = []
): string {
  let out = message;
  for (const s of secrets) {
    if (typeof s === 'string' && s.trim().length >= 6) {
      out = out.split(s).join('[REDACTED]');
      out = out.split(s.trim()).join('[REDACTED]');
    }
  }
  return safe(out);
}

export function parseOptionalDecimal(value: unknown): DecimalString | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const parsed = DecimalStringSchema.safeParse(text);
  return parsed.success ? parsed.data : null;
}

export function parsePositiveDecimalOrNull(value: unknown): DecimalString | null {
  const dec = parseOptionalDecimal(value);
  if (!dec) return null;
  return compareDecimals(dec, '0') > 0 ? dec : null;
}

export function looksLikeMnemonicSeed(value: string): boolean {
  return SEED_WORDS_RE.test(value.trim());
}

export function validateDelegatedCredentialInput(input: {
  venue: Venue;
  key: string;
  secret: string;
  passphrase?: string | null;
}): void {
  if (!input.key.trim() || !input.secret.trim()) {
    throw new AdapterCapabilityError(`Missing delegated credentials for ${input.venue}`);
  }
  if (looksLikeMnemonicSeed(input.key) || looksLikeMnemonicSeed(input.secret)) {
    throw new AdapterCapabilityError('Refused seed phrase: only delegated trade-only keys are accepted');
  }
  if (input.passphrase && looksLikeMnemonicSeed(input.passphrase)) {
    throw new AdapterCapabilityError('Refused seed phrase in credential passphrase');
  }
}

export function assertLivePermissionEvidence(evidence: PermissionEvidence): void {
  if (!evidence.verified) {
    throw new AdapterCapabilityError(`LIVE refused: key permissions are not verified (${evidence.detail})`);
  }
  if (!evidence.canTrade) {
    throw new AdapterCapabilityError(`LIVE refused: key cannot trade (${evidence.detail})`);
  }
  if (evidence.canWithdraw !== false) {
    throw new AdapterCapabilityError('LIVE refused: key has withdraw permission or unknown withdraw capability');
  }
  if (!evidence.delegatedOnly) {
    throw new AdapterCapabilityError('LIVE refused: credential is not a delegated trade-only key');
  }
}

export function prepareNativeOrderQuantities(
  order: NativeOrder,
  rules: NativeRules,
  referencePrice: DecimalString
): { quantity: DecimalString; limitPrice: DecimalString | null } {
  const checked = NativeOrderSchema.parse(order);

  if (!rules.exchangeStops) {
    throw new AdapterCapabilityError(`Venue ${rules.nativeSymbol} does not support exchange-side stops`);
  }

  if (checked.orderType === 'LIMIT_GTC' && !rules.restingLimitGtcEntry) {
    throw new AdapterCapabilityError(`LIMIT_GTC is not supported or verified for ${rules.nativeSymbol}`);
  }

  if (checked.positionMode === 'HEDGE') {
    if (rules.positionModeCapability === 'ONE_WAY') {
      throw new AdapterCapabilityError(`Hedge mode is not supported on ${rules.nativeSymbol}`);
    }
    if (checked.hedgeLeg !== checked.side) {
      throw new AdapterCapabilityError(
        `Wrong hedge leg ${checked.hedgeLeg ?? 'null'} for ${checked.side} entry order`
      );
    }
  } else if (checked.hedgeLeg !== null) {
    throw new AdapterCapabilityError('ONE_WAY order must not specify a hedgeLeg');
  }

  const flooredQty = quantize(checked.quantity, rules.qtyStep, 'floor');
  if (compareDecimals(flooredQty, rules.minQty) < 0) {
    throw new AdapterCapabilityError(
      `Quantized quantity ${flooredQty} is below venue minQty ${rules.minQty}`
    );
  }
  if (rules.maxQty !== null && compareDecimals(flooredQty, rules.maxQty) > 0) {
    throw new AdapterCapabilityError(
      `Quantized quantity ${flooredQty} exceeds venue maxQty ${rules.maxQty}`
    );
  }

  let limitPrice: DecimalString | null = null;
  if (checked.orderType === 'LIMIT_GTC') {
    if (!checked.limitPrice) {
      throw new AdapterCapabilityError('LIMIT_GTC order requires an explicit limitPrice');
    }
    // LONG rounds down (floor) to avoid crossing higher; SHORT rounds up (ceil) to avoid selling lower.
    limitPrice = quantize(
      checked.limitPrice,
      rules.tickSize,
      checked.side === 'LONG' ? 'floor' : 'ceil'
    );
  }

  const effectivePrice = limitPrice ?? referencePrice;
  const effectiveExposure = mulDecimals(
    mulDecimals(flooredQty, rules.contractMultiplier),
    effectivePrice
  );
  if (rules.minNotional !== null && compareDecimals(effectiveExposure, rules.minNotional) < 0) {
    throw new AdapterCapabilityError(
      `Order notional ${effectiveExposure} is below venue minNotional ${rules.minNotional}`
    );
  }

  return { quantity: flooredQty, limitPrice };
}

export function evaluateProtectionCoverage(input: {
  symbol: string;
  positionKey: string;
  side: 'LONG' | 'SHORT';
  requiredQty: DecimalString;
  coveredQty: DecimalString | null;
  stopPrice: DecimalString | null;
  tpPrice: DecimalString | null;
  reduceOnlyOrPositionBound: boolean;
  observedAt: number;
  netPositionBound?: boolean;
}): ProtectionEvidence {
  if (!input.stopPrice || compareDecimals(input.stopPrice, '0') <= 0) {
    return {
      symbol: input.symbol,
      positionKey: input.positionKey,
      side: input.side,
      requiredQty: input.requiredQty,
      coveredQty: '0',
      stopPrice: null,
      tpPrice: input.tpPrice,
      reduceOnlyOrPositionBound: input.reduceOnlyOrPositionBound,
      state: 'MISSING',
      observedAt: input.observedAt,
      reason: 'No active stop trigger price resting on venue'
    };
  }

  if (!input.reduceOnlyOrPositionBound) {
    return {
      symbol: input.symbol,
      positionKey: input.positionKey,
      side: input.side,
      requiredQty: input.requiredQty,
      coveredQty: input.coveredQty ?? '0',
      stopPrice: input.stopPrice,
      tpPrice: input.tpPrice,
      reduceOnlyOrPositionBound: false,
      state: 'UNVERIFIED',
      observedAt: input.observedAt,
      reason: 'Stop order is neither reduce-only nor position-bound'
    };
  }

  const effectiveCovered = input.netPositionBound ? input.requiredQty : input.coveredQty;
  if (!effectiveCovered || compareDecimals(effectiveCovered, '0') <= 0) {
    return {
      symbol: input.symbol,
      positionKey: input.positionKey,
      side: input.side,
      requiredQty: input.requiredQty,
      coveredQty: '0',
      stopPrice: input.stopPrice,
      tpPrice: input.tpPrice,
      reduceOnlyOrPositionBound: true,
      state: 'MISSING',
      observedAt: input.observedAt,
      reason: 'Stop trigger covers zero quantity'
    };
  }

  if (compareDecimals(effectiveCovered, input.requiredQty) < 0) {
    return {
      symbol: input.symbol,
      positionKey: input.positionKey,
      side: input.side,
      requiredQty: input.requiredQty,
      coveredQty: effectiveCovered,
      stopPrice: input.stopPrice,
      tpPrice: input.tpPrice,
      reduceOnlyOrPositionBound: true,
      state: 'MISSING',
      observedAt: input.observedAt,
      reason: `Stop coverage ${effectiveCovered} is less than native exposure ${input.requiredQty}`
    };
  }

  return {
    symbol: input.symbol,
    positionKey: input.positionKey,
    side: input.side,
    requiredQty: input.requiredQty,
    coveredQty: effectiveCovered,
    stopPrice: input.stopPrice,
    tpPrice: input.tpPrice,
    reduceOnlyOrPositionBound: true,
    state: 'VERIFIED',
    observedAt: input.observedAt,
    reason: null
  };
}

export async function fetchVenueJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit = {},
  timeoutMs = 10_000
): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: ctrl.signal });
    const raw = await res.text();
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = { raw: raw.slice(0, 240) };
    }
    if (!res.ok) {
      const detail =
        parsed && typeof parsed === 'object'
          ? String(
              (parsed as Record<string, unknown>).msg ??
                (parsed as Record<string, unknown>).retMsg ??
                (parsed as Record<string, unknown>).message ??
                (parsed as Record<string, unknown>).raw ??
                ''
            ).slice(0, 160)
          : '';
      throw new VenueTransportError(`HTTP ${res.status}: ${detail}`, res.status);
    }
    return parsed;
  } catch (err) {
    if (ctrl.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      throw new VenueTransportError('Venue request timed out', 'TIMEOUT', true);
    }
    if (err instanceof VenueTransportError) throw err;
    throw new VenueTransportError(err instanceof Error ? err.message : 'Venue request failed');
  } finally {
    clearTimeout(timer);
  }
}
