import { randomUUID } from 'node:crypto';
import type { Certainty, Evidence, MarketCandle } from '../contracts.js';
import type { PublicTradeRecord } from './bybit.js';

export const FORMULA_VERSION = 'mpu-indicators-v1';

export interface IndicatorValue<T> {
  value: T | null;
  reason: string | null;
}

export interface BollingerReading {
  middle: number;
  upper: number;
  lower: number;
  stdDev: number;
  bandwidth: number | null;
}

export interface MacdReading {
  macd: number;
  signal: number;
  histogram: number;
}

export interface SwingPivot {
  index: number;
  startAt: number;
  kind: 'HIGH' | 'LOW';
  price: number;
  rsiAtPivot: number | null;
}

export interface StructureSummary {
  pivots: SwingPivot[];
  sequence: Array<'HH' | 'HL' | 'LH' | 'LL'>;
  bos: 'BULLISH' | 'BEARISH' | null;
  choch: 'BULLISH' | 'BEARISH' | null;
  rsiDivergence: 'BULLISH' | 'BEARISH' | null;
}

function closedOnly(bars: readonly MarketCandle[]): MarketCandle[] {
  return bars.filter((b) => b.confirmed);
}

export function computeSma(bars: readonly MarketCandle[], period = 20): IndicatorValue<number> {
  const closed = closedOnly(bars);
  if (closed.length < period) {
    return { value: null, reason: `insufficient_warmup:need_${period}_have_${closed.length}` };
  }
  const slice = closed.slice(-period);
  const sum = slice.reduce((acc, b) => acc + Number(b.close), 0);
  return { value: sum / period, reason: null };
}

export function computeEmaSeries(closes: readonly number[], period: number): number[] {
  if (closes.length < period) return [];
  const alpha = 2 / (period + 1);
  let ema = 0;
  for (let i = 0; i < period; i++) {
    ema += closes[i]!;
  }
  ema /= period;
  const out = [ema];
  for (let i = period; i < closes.length; i++) {
    ema = closes[i]! * alpha + ema * (1 - alpha);
    out.push(ema);
  }
  return out;
}

export function computeEma(bars: readonly MarketCandle[], period: number): IndicatorValue<number> {
  const closed = closedOnly(bars);
  if (closed.length < period) {
    return { value: null, reason: `insufficient_warmup:need_${period}_have_${closed.length}` };
  }
  const series = computeEmaSeries(
    closed.map((b) => Number(b.close)),
    period
  );
  return { value: series.at(-1) ?? null, reason: null };
}

export function computeWilderRsiSeries(closes: readonly number[], period = 14): Array<number | null> {
  const out: Array<number | null> = Array.from({ length: closes.length }, () => null);
  if (closes.length < period + 1) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const delta = closes[i]! - closes[i - 1]!;
    if (delta > 0) gainSum += delta;
    else lossSum += -delta;
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  const toRsi = (ag: number, al: number): number => {
    if (al === 0) return ag === 0 ? 50 : 100;
    const rs = ag / al;
    return 100 - 100 / (1 + rs);
  };

  out[period] = toRsi(avgGain, avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const delta = closes[i]! - closes[i - 1]!;
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }

  return out;
}

export function computeWilderRsi14(bars: readonly MarketCandle[]): IndicatorValue<number> {
  const closed = closedOnly(bars);
  if (closed.length < 15) {
    return { value: null, reason: `insufficient_warmup:need_15_have_${closed.length}` };
  }
  const series = computeWilderRsiSeries(
    closed.map((b) => Number(b.close)),
    14
  );
  return { value: series.at(-1) ?? null, reason: null };
}

export function computeWilderAtr14(bars: readonly MarketCandle[]): IndicatorValue<number> {
  const closed = closedOnly(bars);
  if (closed.length < 15) {
    return { value: null, reason: `insufficient_warmup:need_15_have_${closed.length}` };
  }
  const trs: number[] = [];
  for (let i = 1; i < closed.length; i++) {
    const h = Number(closed[i]!.high);
    const l = Number(closed[i]!.low);
    const prevC = Number(closed[i - 1]!.close);
    trs.push(Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC)));
  }
  let atr = 0;
  for (let i = 0; i < 14; i++) atr += trs[i]!;
  atr /= 14;
  for (let i = 14; i < trs.length; i++) {
    atr = (atr * 13 + trs[i]!) / 14;
  }
  return { value: atr, reason: null };
}

export function computeMacd12269(bars: readonly MarketCandle[]): IndicatorValue<MacdReading> {
  const closed = closedOnly(bars);
  const warmup = 26 + 9 - 1; // 34 closed bars
  if (closed.length < warmup) {
    return { value: null, reason: `insufficient_warmup:need_${warmup}_have_${closed.length}` };
  }
  const closes = closed.map((b) => Number(b.close));
  const ema12 = computeEmaSeries(closes, 12); // starts at index 11
  const ema26 = computeEmaSeries(closes, 26); // starts at index 25

  const macdLine: number[] = [];
  for (let idx = 25; idx < closes.length; idx++) {
    const fast = ema12[idx - 11]!;
    const slow = ema26[idx - 25]!;
    macdLine.push(fast - slow);
  }
  const signalSeries = computeEmaSeries(macdLine, 9);
  const macd = macdLine.at(-1)!;
  const signal = signalSeries.at(-1)!;
  return {
    value: {
      macd,
      signal,
      histogram: macd - signal
    },
    reason: null
  };
}

export function computeBollinger20(bars: readonly MarketCandle[]): IndicatorValue<BollingerReading> {
  const closed = closedOnly(bars);
  if (closed.length < 20) {
    return { value: null, reason: `insufficient_warmup:need_20_have_${closed.length}` };
  }
  const slice = closed.slice(-20).map((b) => Number(b.close));
  const mean = slice.reduce((acc, c) => acc + c, 0) / 20;
  // Architecture section 7: population standard deviation (/ 20) and 2 SD
  const variance = slice.reduce((acc, c) => acc + (c - mean) ** 2, 0) / 20;
  const stdDev = Math.sqrt(variance);
  const upper = mean + 2 * stdDev;
  const lower = mean - 2 * stdDev;
  const bandwidth = mean > 0 ? (upper - lower) / mean : null;

  return {
    value: { middle: mean, upper, lower, stdDev, bandwidth },
    reason: null
  };
}

export function computeUtcVwap(
  bars: readonly MarketCandle[],
  trades: readonly PublicTradeRecord[] = [],
  options: { completeUtcSessionTrades?: boolean; asOfMs?: number } = {}
): Evidence<number> {
  const closed = closedOnly(bars);
  const refTime = options.asOfMs ?? closed.at(-1)?.endAt ?? Date.now();
  const utcDayStart = Date.UTC(
    new Date(refTime).getUTCFullYear(),
    new Date(refTime).getUTCMonth(),
    new Date(refTime).getUTCDate(),
    0,
    0,
    0,
    0
  );

  if (options.completeUtcSessionTrades && trades.length > 0) {
    const sessionTrades = trades.filter((t) => t.sourceAt >= utcDayStart && t.sourceAt <= refTime + 60_000);
    let pv = 0;
    let vol = 0;
    for (const t of sessionTrades) {
      const p = Number(t.price);
      const sz = Number(t.size);
      if (Number.isFinite(p) && Number.isFinite(sz) && sz > 0) {
        pv += p * sz;
        vol += sz;
      }
    }
    if (vol > 0) {
      return {
        id: `ev-vwap-${randomUUID()}`,
        value: pv / vol,
        certainty: 'VERIFIED',
        availability: 'AVAILABLE',
        freshness: 'CURRENT',
        source: 'bybit.linear.publicTrade',
        sourceAt: sessionTrades.at(-1)?.sourceAt ?? refTime,
        observedAt: Date.now(),
        publishedAt: null,
        eventAt: null,
        unit: 'USDT',
        reason: null
      };
    }
  }

  const sessionBars = closed.filter((b) => b.startAt >= utcDayStart);
  let pv = 0;
  let vol = 0;
  for (const b of sessionBars) {
    const typical = (Number(b.high) + Number(b.low) + Number(b.close)) / 3;
    const v = Number(b.volume);
    if (Number.isFinite(typical) && Number.isFinite(v) && v > 0) {
      pv += typical * v;
      vol += v;
    }
  }
  if (vol <= 0) {
    return {
      id: `ev-vwap-${randomUUID()}`,
      value: null,
      certainty: null,
      availability: 'UNAVAILABLE',
      freshness: 'UNKNOWN',
      source: 'candle_hlc3_approximation',
      sourceAt: null,
      observedAt: Date.now(),
      publishedAt: null,
      eventAt: null,
      unit: 'USDT',
      reason: 'no_utc_session_volume'
    };
  }

  const certainty: Certainty = 'INFERRED';
  return {
    id: `ev-vwap-${randomUUID()}`,
    value: pv / vol,
    certainty,
    availability: 'AVAILABLE',
    freshness: 'CURRENT',
    source: 'candle_hlc3_approximation',
    sourceAt: sessionBars.at(-1)?.sourceAt ?? refTime,
    observedAt: Date.now(),
    publishedAt: null,
    eventAt: null,
    unit: 'USDT',
    reason: 'approximated_from_closed_candles_hlc3'
  };
}

export function computeConfirmedPivots(bars: readonly MarketCandle[]): SwingPivot[] {
  const closed = closedOnly(bars);
  if (closed.length < 5) return [];

  const closes = closed.map((b) => Number(b.close));
  const rsiSeries = computeWilderRsiSeries(closes, 14);
  const pivots: SwingPivot[] = [];

  // Two closed bars strictly to the left AND two closed bars strictly to the right (no future peeking).
  for (let i = 2; i <= closed.length - 3; i++) {
    const hi = Number(closed[i]!.high);
    const lo = Number(closed[i]!.low);

    const isSwingHigh =
      hi > Number(closed[i - 1]!.high) &&
      hi > Number(closed[i - 2]!.high) &&
      hi >= Number(closed[i + 1]!.high) &&
      hi >= Number(closed[i + 2]!.high) &&
      (hi > Number(closed[i + 1]!.high) || hi > Number(closed[i + 2]!.high));

    const isSwingLow =
      lo < Number(closed[i - 1]!.low) &&
      lo < Number(closed[i - 2]!.low) &&
      lo <= Number(closed[i + 1]!.low) &&
      lo <= Number(closed[i + 2]!.low) &&
      (lo < Number(closed[i + 1]!.low) || lo < Number(closed[i + 2]!.low));

    if (isSwingHigh) {
      pivots.push({
        index: i,
        startAt: closed[i]!.startAt,
        kind: 'HIGH',
        price: hi,
        rsiAtPivot: rsiSeries[i] ?? null
      });
    }
    if (isSwingLow) {
      pivots.push({
        index: i,
        startAt: closed[i]!.startAt,
        kind: 'LOW',
        price: lo,
        rsiAtPivot: rsiSeries[i] ?? null
      });
    }
  }

  return pivots;
}

export function computeStructureSummary(bars: readonly MarketCandle[]): StructureSummary {
  const closed = closedOnly(bars);
  const pivots = computeConfirmedPivots(closed);
  const sequence: Array<'HH' | 'HL' | 'LH' | 'LL'> = [];

  let prevHigh: SwingPivot | null = null;
  let prevLow: SwingPivot | null = null;
  let rsiDivergence: 'BULLISH' | 'BEARISH' | null = null;

  for (const p of pivots) {
    if (p.kind === 'HIGH') {
      if (prevHigh) {
        sequence.push(p.price > prevHigh.price ? 'HH' : 'LH');
        if (
          p.price > prevHigh.price &&
          p.rsiAtPivot !== null &&
          prevHigh.rsiAtPivot !== null &&
          p.rsiAtPivot < prevHigh.rsiAtPivot
        ) {
          rsiDivergence = 'BEARISH';
        }
      }
      prevHigh = p;
    } else {
      if (prevLow) {
        sequence.push(p.price > prevLow.price ? 'HL' : 'LL');
        if (
          p.price < prevLow.price &&
          p.rsiAtPivot !== null &&
          prevLow.rsiAtPivot !== null &&
          p.rsiAtPivot > prevLow.rsiAtPivot
        ) {
          rsiDivergence = 'BULLISH';
        }
      }
      prevLow = p;
    }
  }

  const lastClose = closed.length > 0 ? Number(closed.at(-1)!.close) : null;
  let bos: 'BULLISH' | 'BEARISH' | null = null;
  let choch: 'BULLISH' | 'BEARISH' | null = null;

  if (lastClose !== null) {
    if (prevHigh && lastClose > prevHigh.price) {
      const priorBearish = sequence.slice(-2).some((s) => s === 'LH' || s === 'LL');
      if (priorBearish) choch = 'BULLISH';
      else bos = 'BULLISH';
    } else if (prevLow && lastClose < prevLow.price) {
      const priorBullish = sequence.slice(-2).some((s) => s === 'HH' || s === 'HL');
      if (priorBullish) choch = 'BEARISH';
      else bos = 'BEARISH';
    }
  }

  return {
    pivots,
    sequence,
    bos,
    choch,
    rsiDivergence
  };
}

export function computeRelativeVolume(
  bars: readonly MarketCandle[],
  baselineWindow = 20
): IndicatorValue<number> {
  const closed = closedOnly(bars);
  if (closed.length < baselineWindow + 1) {
    return {
      value: null,
      reason: `insufficient_warmup:need_${baselineWindow + 1}_have_${closed.length}`
    };
  }
  const currentBar = closed.at(-1)!;
  // Strictly exclude the evaluated bar from the prior comparable baseline window!
  const prior = closed
    .slice(-(baselineWindow + 1), -1)
    .map((b) => Number(b.volume))
    .sort((a, b) => a - b);

  const mid = Math.floor(prior.length / 2);
  const median =
    prior.length % 2 === 1
      ? prior[mid]!
      : (prior[mid - 1]! + prior[mid]!) / 2;

  if (!(median > 0)) {
    return { value: null, reason: 'zero_prior_median_volume' };
  }
  return {
    value: Number(currentBar.volume) / median,
    reason: null
  };
}
