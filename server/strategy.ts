import type { Candle, TechnicalSummary } from './types.js';

// Default Strategist rule, from skills/strategy-rule. Closed bars only.
export function ema(closes: number[], n: number): number[] {
  if (closes.length < n) return [];
  const k = 2 / (n + 1);
  const out: number[] = new Array(closes.length).fill(NaN);
  let e = closes.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = e;
  for (let i = n; i < closes.length; i++) { e = closes[i] * k + e * (1 - k); out[i] = e; }
  return out;
}

export interface RuleVote {
  side: 'LONG' | 'SHORT' | 'ABSTAIN';
  close: number;
  ema9: number; ema21: number; ema50: number;
  change5Pct: number;
  invalidation: number | null;
  reason: string;
  barTime: number | null;
}

export function closedOnly(candles: Candle[], now = Date.now(), barMs = 15 * 60_000): Candle[] {
  return candles.filter((c) => c.t + barMs <= now);
}

export function strategyVote(candles: Candle[]): RuleVote {
  const closes = candles.map((c) => c.c);
  const blank: RuleVote = { side: 'ABSTAIN', close: closes.at(-1) ?? 0, ema9: NaN, ema21: NaN, ema50: NaN, change5Pct: 0, invalidation: null, reason: '', barTime: candles.at(-1)?.t ?? null };
  if (closes.length < 55) return { ...blank, reason: `Only ${closes.length} closed bars. Need at least 55. Abstaining.` };
  const e9 = ema(closes, 9).at(-1)!, e21 = ema(closes, 21).at(-1)!, e50 = ema(closes, 50).at(-1)!;
  const close = closes.at(-1)!;
  const c5 = closes.at(-5)!;
  const change5Pct = ((close - c5) / c5) * 100;
  const base = { ...blank, close, ema9: e9, ema21: e21, ema50: e50, change5Pct };
  if (close > e9 && close > e21 && close > e50) return { ...base, side: 'LONG', invalidation: e9, reason: 'Close is above EMA9, EMA21 and EMA50.' };
  if (close < e9 && close < e21 && close < e50) return { ...base, side: 'SHORT', invalidation: e9, reason: 'Close is below EMA9, EMA21 and EMA50.' };
  if (change5Pct > 0.3 && close > e9) return { ...base, side: 'LONG', invalidation: e9, reason: `Five-bar change ${change5Pct.toFixed(2)}% with close above EMA9.` };
  if (change5Pct < -0.3 && close < e9) return { ...base, side: 'SHORT', invalidation: e9, reason: `Five-bar change ${change5Pct.toFixed(2)}% with close below EMA9.` };
  return { ...base, reason: 'Trend and momentum gates both undecided.' };
}

export function rsi(closes: number[], period = 14): number {
  if (closes.length <= period) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - (100 / (1 + rs))) * 10) / 10;
}

export function volumeDelta(candles: Candle[], period = 20): { volRatio: number; takerBuyPressure: number } {
  if (candles.length < 5) return { volRatio: 1, takerBuyPressure: 0.5 };
  const slice = candles.slice(-period);
  const avgVol = slice.reduce((acc, c) => acc + c.v, 0) / slice.length;
  const lastVol = candles.at(-1)?.v ?? avgVol;
  const volRatio = avgVol > 0 ? Math.round((lastVol / avgVol) * 100) / 100 : 1;
  const recent5 = candles.slice(-5);
  let buyVol = 0, totalVol = 0;
  for (const c of recent5) {
    totalVol += c.v;
    if (c.c >= c.o) buyVol += c.v;
  }
  const takerBuyPressure = totalVol > 0 ? Math.round((buyVol / totalVol) * 100) / 100 : 0.5;
  return { volRatio, takerBuyPressure };
}

export function atr(candles: Candle[], period = 14): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevC = candles[i - 1].c;
    const tr = Math.max(c.h - c.l, Math.abs(c.h - prevC), Math.abs(c.l - prevC));
    trs.push(tr);
  }
  if (trs.length < period) {
    return Math.round((trs.reduce((a, b) => a + b, 0) / trs.length) * 100) / 100;
  }
  let a = trs.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < trs.length; i++) {
    a = (a * (period - 1) + trs[i]) / period;
  }
  return Math.round(a * 100) / 100;
}

export function calculateVolumeProfile(candles: Candle[], binsCount = 50): { sessionVwap: number; poc: number; vah: number; val: number } {
  if (!candles.length) return { sessionVwap: 0, poc: 0, vah: 0, val: 0 };
  let sumTypVol = 0, totalVol = 0;
  let minP = Infinity, maxP = -Infinity;
  for (const c of candles) {
    const typ = (c.h + c.l + c.c) / 3;
    sumTypVol += typ * c.v;
    totalVol += c.v;
    if (c.l < minP) minP = c.l;
    if (c.h > maxP) maxP = c.h;
  }
  const sessionVwap = totalVol > 0 ? sumTypVol / totalVol : candles.at(-1)?.c ?? 0;
  if (minP >= maxP || totalVol === 0) {
    const p = candles.at(-1)?.c ?? 0;
    return { sessionVwap: Math.round(sessionVwap * 100) / 100, poc: p, vah: p, val: p };
  }
  const step = (maxP - minP) / binsCount;
  const bins = new Float64Array(binsCount);
  for (const c of candles) {
    const binIdx = Math.min(binsCount - 1, Math.max(0, Math.floor(((c.h + c.l + c.c) / 3 - minP) / step)));
    bins[binIdx] += c.v;
  }
  let maxBinIdx = 0;
  for (let i = 1; i < binsCount; i++) {
    if (bins[i] > bins[maxBinIdx]) maxBinIdx = i;
  }
  const poc = minP + (maxBinIdx + 0.5) * step;

  // Value Area (70% of total volume around POC)
  const targetVol = totalVol * 0.70;
  let cumVol = bins[maxBinIdx];
  let lowerIdx = maxBinIdx, upperIdx = maxBinIdx;
  while (cumVol < targetVol && (lowerIdx > 0 || upperIdx < binsCount - 1)) {
    const nextLower = lowerIdx > 0 ? bins[lowerIdx - 1] : -1;
    const nextUpper = upperIdx < binsCount - 1 ? bins[upperIdx + 1] : -1;
    if (nextUpper >= nextLower && upperIdx < binsCount - 1) {
      upperIdx++;
      cumVol += bins[upperIdx];
    } else if (lowerIdx > 0) {
      lowerIdx--;
      cumVol += bins[lowerIdx];
    } else {
      break;
    }
  }
  const val = minP + lowerIdx * step;
  const vah = minP + (upperIdx + 1) * step;
  return {
    sessionVwap: Math.round(sessionVwap * 100) / 100,
    poc: Math.round(poc * 100) / 100,
    vah: Math.round(vah * 100) / 100,
    val: Math.round(val * 100) / 100
  };
}

export function calculateSwingLevels(candles: Candle[], lookback = 20): { recentSwingHigh: number; recentSwingLow: number; distToLiquiditySweepPct: number } {
  if (!candles.length) return { recentSwingHigh: 0, recentSwingLow: 0, distToLiquiditySweepPct: 0 };
  const slice = candles.slice(-lookback);
  let high = -Infinity, low = Infinity;
  for (const c of slice) {
    if (c.h > high) high = c.h;
    if (c.l < low) low = c.l;
  }
  const close = candles.at(-1)?.c ?? 0;
  const distHigh = Math.abs(high - close);
  const distLow = Math.abs(close - low);
  const dist = Math.min(distHigh, distLow);
  const distPct = close > 0 ? (dist / close) * 100 : 0;
  return {
    recentSwingHigh: Math.round(high * 100) / 100,
    recentSwingLow: Math.round(low * 100) / 100,
    distToLiquiditySweepPct: Math.round(distPct * 100) / 100
  };
}

export function calculateVolatility(candles: Candle[]): { atr14: number; atrPct: number; realizedVol24h: number; bollingerBandWidthPct: number } {
  const close = candles.at(-1)?.c ?? 0;
  const a14 = atr(candles, 14);
  const atrPct = close > 0 ? Math.round((a14 / close) * 10000) / 100 : 0;

  let rv = 0;
  if (candles.length >= 20) {
    const returns: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      if (candles[i - 1].c > 0 && candles[i].c > 0) {
        returns.push(Math.log(candles[i].c / candles[i - 1].c));
      }
    }
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
    rv = Math.round(Math.sqrt(variance * 365.25 * 96) * 10000) / 100;
  }

  let bbWidth = 0;
  if (candles.length >= 20) {
    const last20 = candles.slice(-20).map((c) => c.c);
    const sma = last20.reduce((a, b) => a + b, 0) / 20;
    const variance = last20.reduce((s, x) => s + (x - sma) ** 2, 0) / 20;
    const sd = Math.sqrt(variance);
    bbWidth = sma > 0 ? Math.round(((4 * sd) / sma) * 10000) / 100 : 0;
  }

  return {
    atr14: a14,
    atrPct,
    realizedVol24h: rv,
    bollingerBandWidthPct: bbWidth
  };
}

export function determineTrendRegime(closes: number[]): { ema9: number; ema21: number; ema50: number; ema200: number; regime: 'STRONG_UPTREND' | 'STRONG_DOWNTREND' | 'RANGING_CHOP' | 'SQUEEZE_BREAKOUT' } {
  const close = closes.at(-1) ?? 0;
  const e9 = ema(closes, 9).at(-1) || close;
  const e21 = ema(closes, 21).at(-1) || close;
  const e50 = ema(closes, 50).at(-1) || close;
  const e200 = ema(closes, 200).at(-1) || close;

  let regime: 'STRONG_UPTREND' | 'STRONG_DOWNTREND' | 'RANGING_CHOP' | 'SQUEEZE_BREAKOUT' = 'RANGING_CHOP';
  if (close > e9 && e9 > e21 && e21 > e50) {
    regime = 'STRONG_UPTREND';
  } else if (close < e9 && e9 < e21 && e21 < e50) {
    regime = 'STRONG_DOWNTREND';
  } else {
    const change5 = closes.length >= 5 ? Math.abs((close - closes[closes.length - 5]) / closes[closes.length - 5]) * 100 : 0;
    if (change5 > 1.2 && (close > e9 || close < e9)) {
      regime = 'SQUEEZE_BREAKOUT';
    } else {
      regime = 'RANGING_CHOP';
    }
  }

  return {
    ema9: Math.round(e9 * 100) / 100,
    ema21: Math.round(e21 * 100) / 100,
    ema50: Math.round(e50 * 100) / 100,
    ema200: Math.round(e200 * 100) / 100,
    regime
  };
}

export function buildTechnicalSummary(candlesMap: { '5m'?: Candle[]; '15m'?: Candle[]; '1h'?: Candle[]; '4h'?: Candle[] }): TechnicalSummary {
  const base15m = candlesMap['15m'] ?? [];
  const base5m = candlesMap['5m'] ?? base15m;
  const base1h = candlesMap['1h'] ?? base15m;
  const base4h = candlesMap['4h'] ?? base15m;

  return {
    mtfTrend: {
      '5m': determineTrendRegime(base5m.map((c) => c.c)),
      '15m': determineTrendRegime(base15m.map((c) => c.c)),
      '1h': determineTrendRegime(base1h.map((c) => c.c)),
      '4h': determineTrendRegime(base4h.map((c) => c.c))
    },
    volatility: calculateVolatility(base15m),
    momentum: {
      rsi14_15m: rsi(base15m.map((c) => c.c), 14),
      rsi14_1h: rsi(base1h.map((c) => c.c), 14),
      rsi14_4h: rsi(base4h.map((c) => c.c), 14)
    },
    volumeProfile: calculateVolumeProfile(base15m),
    swingLevels: calculateSwingLevels(base15m)
  };
}
