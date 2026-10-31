import { z } from 'zod';
import { DecimalStringSchema, type MarketFrame } from '../contracts.js';
import { compareDecimals } from '../execution/decimal.js';
import type { ThesisInvalidationPredicate } from '../agents/runner.js';

export interface TradeThesis {
  id: string;
  cycleId: string;
  accountRef: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  evidenceId: string;
  configVersion: number;
  claims: string[];
  invalidation: ThesisInvalidationPredicate[];
  stop: string;
  tp: string | null;
  orderType: 'MARKET' | 'LIMIT_GTC';
}

export interface StructuralBreakFact {
  timeframe: string;
  direction: 'BULLISH' | 'BEARISH';
  ref: string;
}

export interface EntryValidation {
  status: 'valid' | 'invalidated' | 'unavailable';
  reason: string | null;
  evidenceRefs: string[];
}

// Strict schema forbids legacy bypass flags such as aiApproved.
const RevalidateInputGuardSchema = z
  .object({
    thesis: z.object({
      id: z.string().min(1),
      cycleId: z.string().min(1),
      accountRef: z.string().min(1),
      symbol: z.string().min(1),
      side: z.enum(['LONG', 'SHORT']),
      evidenceId: z.string().min(1),
      configVersion: z.number().int().positive(),
      claims: z.array(z.string()),
      invalidation: z.array(
        z.object({
          kind: z.enum(['PRICE_BELOW', 'PRICE_ABOVE', 'STRUCTURE_BREAK']),
          level: z.string().optional(),
          timeframe: z.string().optional(),
          description: z.string().min(1)
        })
      ),
      stop: DecimalStringSchema,
      tp: DecimalStringSchema.nullable(),
      orderType: z.enum(['MARKET', 'LIMIT_GTC'])
    }),
    activeConfigVersion: z.number().int().positive(),
    freshMarket: z.custom<MarketFrame>((val) => Boolean(val && typeof val === 'object' && 'evidenceId' in val)),
    structuralBreaks: z.array(
      z.object({
        timeframe: z.string().min(1),
        direction: z.enum(['BULLISH', 'BEARISH']),
        ref: z.string().min(1)
      })
    ),
    optionalResearchStatus: z.enum(['ok', 'unavailable', 'unconfigured']).optional(),
    jevStatus: z.enum(['completed', 'disabled', 'unavailable']).optional()
  })
  .strict();

export type RevalidateEntryInput = z.infer<typeof RevalidateInputGuardSchema>;

export function revalidateEntry(input: RevalidateEntryInput): EntryValidation {
  const checked = RevalidateInputGuardSchema.parse(input);
  const { thesis, activeConfigVersion, freshMarket, structuralBreaks } = checked;

  const baseRefs = [thesis.evidenceId, freshMarket.evidenceId];

  if (thesis.configVersion !== activeConfigVersion) {
    return {
      status: 'invalidated',
      reason: `Thesis configVersion ${thesis.configVersion} superseded by active version ${activeConfigVersion}`,
      evidenceRefs: baseRefs
    };
  }

  if (freshMarket.symbol !== thesis.symbol) {
    return {
      status: 'unavailable',
      reason: `Market frame symbol ${freshMarket.symbol} does not match thesis symbol ${thesis.symbol}`,
      evidenceRefs: baseRefs
    };
  }

  if (freshMarket.last.availability !== 'AVAILABLE' || freshMarket.last.value === null) {
    return {
      status: 'unavailable',
      reason: freshMarket.last.reason ?? 'Canonical Bybit linear last price is unavailable',
      evidenceRefs: baseRefs
    };
  }

  const lastPrice = freshMarket.last.value;

  // Stop level breach immediately invalidates the entry thesis before sending an order.
  if (thesis.side === 'LONG' && compareDecimals(lastPrice, thesis.stop) <= 0) {
    return {
      status: 'invalidated',
      reason: `Fresh price ${lastPrice} already reached or breached LONG stop ${thesis.stop}`,
      evidenceRefs: baseRefs
    };
  }
  if (thesis.side === 'SHORT' && compareDecimals(lastPrice, thesis.stop) >= 0) {
    return {
      status: 'invalidated',
      reason: `Fresh price ${lastPrice} already reached or breached SHORT stop ${thesis.stop}`,
      evidenceRefs: baseRefs
    };
  }

  if (thesis.invalidation.length === 0) {
    return {
      status: 'unavailable',
      reason: 'Thesis has no evaluable invalidation predicate',
      evidenceRefs: baseRefs
    };
  }

  for (const pred of thesis.invalidation) {
    if (pred.kind === 'PRICE_BELOW') {
      if (!pred.level || !DecimalStringSchema.safeParse(pred.level).success) {
        return {
          status: 'unavailable',
          reason: `Invalidation predicate missing valid price level: ${pred.description}`,
          evidenceRefs: baseRefs
        };
      }
      if (compareDecimals(lastPrice, pred.level) <= 0) {
        return {
          status: 'invalidated',
          reason: `PRICE_BELOW invalidation hit (${lastPrice} <= ${pred.level}): ${pred.description}`,
          evidenceRefs: baseRefs
        };
      }
    } else if (pred.kind === 'PRICE_ABOVE') {
      if (!pred.level || !DecimalStringSchema.safeParse(pred.level).success) {
        return {
          status: 'unavailable',
          reason: `Invalidation predicate missing valid price level: ${pred.description}`,
          evidenceRefs: baseRefs
        };
      }
      if (compareDecimals(lastPrice, pred.level) >= 0) {
        return {
          status: 'invalidated',
          reason: `PRICE_ABOVE invalidation hit (${lastPrice} >= ${pred.level}): ${pred.description}`,
          evidenceRefs: baseRefs
        };
      }
    } else if (pred.kind === 'STRUCTURE_BREAK') {
      const opposingDir = thesis.side === 'LONG' ? 'BEARISH' : 'BULLISH';
      const matchingBreak = structuralBreaks.find(
        (b) =>
          b.direction === opposingDir &&
          (!pred.timeframe || b.timeframe === pred.timeframe)
      );
      if (matchingBreak) {
        return {
          status: 'invalidated',
          reason: `Opposing ${matchingBreak.direction} structure break on ${matchingBreak.timeframe}: ${pred.description}`,
          evidenceRefs: [...baseRefs, matchingBreak.ref]
        };
      }
    }
  }

  // Missing optional research or Jev outage does not reject an intact canonical thesis.
  return {
    status: 'valid',
    reason: null,
    evidenceRefs: baseRefs
  };
}
