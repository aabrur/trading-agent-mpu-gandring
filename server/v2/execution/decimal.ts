import { DecimalStringSchema, type DecimalString } from '../contracts.js';

interface ParsedDecimal {
  sign: 1n | -1n;
  digits: bigint;
  scale: number;
}

function parseDecimal(raw: DecimalString): ParsedDecimal {
  const valid = DecimalStringSchema.parse(raw);
  const negative = valid.startsWith('-');
  const unsigned = negative ? valid.slice(1) : valid;
  const dot = unsigned.indexOf('.');
  if (dot < 0) {
    const d = BigInt(unsigned);
    return { sign: d === 0n ? 1n : negative ? -1n : 1n, digits: d, scale: 0 };
  }
  const intPart = unsigned.slice(0, dot);
  const fracPart = unsigned.slice(dot + 1);
  const combined = BigInt(intPart + fracPart);
  return {
    sign: combined === 0n ? 1n : negative ? -1n : 1n,
    digits: combined,
    scale: fracPart.length
  };
}

function pow10(exp: number): bigint {
  return 10n ** BigInt(exp);
}

function formatScaled(value: bigint, scale: number, trimTrailingZeros = false): DecimalString {
  if (value === 0n) {
    if (scale === 0 || trimTrailingZeros) return '0';
    return `0.${'0'.repeat(scale)}`;
  }
  const neg = value < 0n;
  const absStr = (neg ? -value : value).toString();
  if (scale === 0) {
    return `${neg ? '-' : ''}${absStr}`;
  }
  const padded = absStr.padStart(scale + 1, '0');
  const intPart = padded.slice(0, padded.length - scale);
  let fracPart = padded.slice(padded.length - scale);
  if (trimTrailingZeros) {
    fracPart = fracPart.replace(/0+$/, '');
    if (!fracPart) return `${neg ? '-' : ''}${intPart}`;
  }
  return `${neg ? '-' : ''}${intPart}.${fracPart}`;
}

export function quantize(
  value: DecimalString,
  step: DecimalString,
  mode: 'floor' | 'ceil'
): DecimalString {
  const v = parseDecimal(value);
  const s = parseDecimal(step);
  if (s.sign < 0n || s.digits <= 0n) {
    throw new Error(`quantize step must be strictly positive, got "${step}"`);
  }

  const commonScale = Math.max(v.scale, s.scale);
  const vScaled = v.sign * v.digits * pow10(commonScale - v.scale);
  const sScaled = s.digits * pow10(commonScale - s.scale);

  let q = vScaled / sScaled;
  const r = vScaled % sScaled;
  if (mode === 'floor' && r < 0n) {
    q -= 1n;
  } else if (mode === 'ceil' && r > 0n) {
    q += 1n;
  }

  // q * s.digits is exact at s.scale decimal places!
  const resultAtStepScale = q * s.digits;
  return formatScaled(resultAtStepScale, s.scale, false);
}

export function compareDecimals(a: DecimalString, b: DecimalString): -1 | 0 | 1 {
  const pa = parseDecimal(a);
  const pb = parseDecimal(b);
  const scale = Math.max(pa.scale, pb.scale);
  const va = pa.sign * pa.digits * pow10(scale - pa.scale);
  const vb = pb.sign * pb.digits * pow10(scale - pb.scale);
  if (va === vb) return 0;
  return va < vb ? -1 : 1;
}

export function addDecimals(a: DecimalString, b: DecimalString): DecimalString {
  const pa = parseDecimal(a);
  const pb = parseDecimal(b);
  const scale = Math.max(pa.scale, pb.scale);
  const sum =
    pa.sign * pa.digits * pow10(scale - pa.scale) +
    pb.sign * pb.digits * pow10(scale - pb.scale);
  return formatScaled(sum, scale, true);
}

export function subDecimals(a: DecimalString, b: DecimalString): DecimalString {
  const pa = parseDecimal(a);
  const pb = parseDecimal(b);
  const scale = Math.max(pa.scale, pb.scale);
  const diff =
    pa.sign * pa.digits * pow10(scale - pa.scale) -
    pb.sign * pb.digits * pow10(scale - pb.scale);
  return formatScaled(diff, scale, true);
}

export function mulDecimals(a: DecimalString, b: DecimalString): DecimalString {
  const pa = parseDecimal(a);
  const pb = parseDecimal(b);
  const prod = pa.sign * pb.sign * pa.digits * pb.digits;
  return formatScaled(prod, pa.scale + pb.scale, true);
}

export function divDecimals(
  numerator: DecimalString,
  denominator: DecimalString,
  precision = 12,
  mode: 'floor' | 'ceil' = 'floor'
): DecimalString {
  const pn = parseDecimal(numerator);
  const pd = parseDecimal(denominator);
  if (pd.digits === 0n) {
    throw new Error('Division by zero in divDecimals');
  }
  const shift = precision + pd.scale - pn.scale;
  const scaledNum =
    shift >= 0
      ? pn.sign * pn.digits * pow10(shift)
      : pn.sign * pn.digits;
  const scaledDen =
    shift >= 0
      ? pd.sign * pd.digits
      : pd.sign * pd.digits * pow10(-shift);

  const positiveDen = scaledDen < 0n ? -scaledDen : scaledDen;
  const signedNum = scaledDen < 0n ? -scaledNum : scaledNum;
  let q = signedNum / positiveDen;
  const r = signedNum % positiveDen;
  if (mode === 'floor' && r < 0n) q -= 1n;
  if (mode === 'ceil' && r > 0n) q += 1n;
  return formatScaled(q, precision, true);
}

export interface InstrumentUnitDescriptor {
  baseCoin: string;
  quoteCoin: string;
  contractMultiplier: number;
}

export function assertCompatibleInstrumentUnits(
  left: InstrumentUnitDescriptor,
  right: InstrumentUnitDescriptor
): void {
  const baseL = left.baseCoin.trim().toUpperCase();
  const baseR = right.baseCoin.trim().toUpperCase();
  if (baseL !== baseR) {
    throw new Error(`Instrument base asset mismatch: "${baseL}" vs "${baseR}"`);
  }
  if (left.contractMultiplier !== right.contractMultiplier) {
    throw new Error(
      `Instrument contractMultiplier mismatch: ${left.contractMultiplier} vs ${right.contractMultiplier}`
    );
  }
}
