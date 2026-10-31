import type { DecimalString, VenueId } from '../contracts.js';

export interface BybitLinearInstrument {
  symbol: string;
  baseCoin: string;
  quoteCoin: string;
  settleCoin: string;
  tickSize: DecimalString;
  qtyStep: DecimalString;
  minOrderQty: DecimalString;
  maxOrderQty: DecimalString;
  minNotionalValue?: DecimalString;
  contractMultiplier: number;
  volumeUnit: string;
}

export interface ParsedReferenceAsset {
  canonicalBase: string;
  quote: string;
  referenceMultiplier: number;
}

export function parseReferenceSymbol(symbol: string): ParsedReferenceAsset | null {
  const clean = symbol.trim().toUpperCase();
  const quoteMatch = clean.match(/^([A-Z0-9]+?)(USDT|USDC|USD)$/);
  if (!quoteMatch) return null;
  const rawBase = quoteMatch[1]!;
  const quote = quoteMatch[2]!;

  if (rawBase.startsWith('1000') && rawBase.length > 4) {
    return {
      canonicalBase: rawBase.slice(4),
      quote,
      referenceMultiplier: 1000
    };
  }
  if (rawBase.endsWith('1000') && rawBase.length > 4) {
    return {
      canonicalBase: rawBase.slice(0, -4),
      quote,
      referenceMultiplier: 1000
    };
  }
  return {
    canonicalBase: rawBase,
    quote,
    referenceMultiplier: 1
  };
}

export function normalizeBybitInstrument(raw: {
  symbol: string;
  baseCoin: string;
  quoteCoin: string;
  settleCoin: string;
  priceFilter?: { tickSize?: string };
  lotSizeFilter?: { qtyStep?: string; minOrderQty?: string; maxOrderQty?: string; minNotionalValue?: string };
}): BybitLinearInstrument {
  const parsed = parseReferenceSymbol(raw.symbol);
  return {
    symbol: raw.symbol,
    baseCoin: raw.baseCoin,
    quoteCoin: raw.quoteCoin,
    settleCoin: raw.settleCoin,
    tickSize: raw.priceFilter?.tickSize ?? '0.01',
    qtyStep: raw.lotSizeFilter?.qtyStep ?? '0.001',
    minOrderQty: raw.lotSizeFilter?.minOrderQty ?? '0.001',
    maxOrderQty: raw.lotSizeFilter?.maxOrderQty ?? '1000000',
    ...(raw.lotSizeFilter?.minNotionalValue ? { minNotionalValue: raw.lotSizeFilter.minNotionalValue } : {}),
    contractMultiplier: parsed?.referenceMultiplier ?? 1,
    volumeUnit: raw.baseCoin
  };
}

export interface NativeInstrumentCandidate {
  nativeSymbol: string;
  baseCoin: string;
  quoteCoin: string;
  settleCoin: string;
  contractMultiplier: number;
  referenceMultiplier?: number;
}

export type InstrumentMappingResult =
  | {
      ok: true;
      referenceSymbol: string;
      venue: VenueId;
      nativeSymbol: string;
      canonicalBase: string;
      quoteCoin: string;
      settleCoin: string;
      referenceMultiplier: number;
      nativeMultiplier: number;
      qtyScaleFactor: number;
    }
  | {
      ok: false;
      referenceSymbol: string;
      venue: VenueId;
      reason: string;
    };

export function mapReferenceToNativeInstrument(
  referenceSymbol: string,
  venue: VenueId,
  native: NativeInstrumentCandidate | null | undefined
): InstrumentMappingResult {
  const parsedRef = parseReferenceSymbol(referenceSymbol);
  if (!parsedRef) {
    return {
      ok: false,
      referenceSymbol,
      venue,
      reason: `Unparseable reference symbol "${referenceSymbol}"`
    };
  }
  if (!native) {
    return {
      ok: false,
      referenceSymbol,
      venue,
      reason: `No native instrument metadata registered on ${venue} for "${referenceSymbol}"`
    };
  }

  const normalizedNativeBase = native.baseCoin
    .trim()
    .toUpperCase()
    .replace(/^1000/, '')
    .replace(/1000$/, '')
    .replace(/^K(?=[A-Z]{3,})/, '');

  if (normalizedNativeBase !== parsedRef.canonicalBase) {
    return {
      ok: false,
      referenceSymbol,
      venue,
      reason: `Base asset mismatch: reference=${parsedRef.canonicalBase}, native=${native.baseCoin}`
    };
  }

  if (!(native.contractMultiplier > 0) || !Number.isFinite(native.contractMultiplier)) {
    return {
      ok: false,
      referenceSymbol,
      venue,
      reason: `Invalid native contractMultiplier=${native.contractMultiplier}`
    };
  }

  if (
    native.referenceMultiplier !== undefined &&
    native.referenceMultiplier !== parsedRef.referenceMultiplier
  ) {
    return {
      ok: false,
      referenceSymbol,
      venue,
      reason: `Reference multiplier mismatch: expected ${parsedRef.referenceMultiplier}, got ${native.referenceMultiplier}`
    };
  }

  return {
    ok: true,
    referenceSymbol,
    venue,
    nativeSymbol: native.nativeSymbol,
    canonicalBase: parsedRef.canonicalBase,
    quoteCoin: native.quoteCoin,
    settleCoin: native.settleCoin,
    referenceMultiplier: parsedRef.referenceMultiplier,
    nativeMultiplier: native.contractMultiplier,
    qtyScaleFactor: parsedRef.referenceMultiplier / native.contractMultiplier
  };
}
