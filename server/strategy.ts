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
  roc5?: number;
  momentumConflict?: boolean;
  invalidation: number | null;
  reason: string;
  barTime: number | null;
}

export function closedOnly(candles: Candle[], now = Date.now(), barMs = 15 * 60_000): Candle[] {
  return candles.filter((c) => c.t + barMs <= now);
}

export function strategyVote(candles: Candle[], observed: { roc5?: number | null; orderflow?: { cvdDelta: number; buySellRatio: number | null } | null } = {}): RuleVote {
  const closes = candles.map((c) => c.c);
  const blank: RuleVote = { side: 'ABSTAIN', close: closes.at(-1) ?? 0, ema9: NaN, ema21: NaN, ema50: NaN, change5Pct: 0, invalidation: null, reason: '', barTime: candles.at(-1)?.t ?? null };
  if (closes.length < 55) return { ...blank, reason: `Only ${closes.length} closed bars. Need at least 55. Abstaining.` };
  const e9 = ema(closes, 9).at(-1)!, e21 = ema(closes, 21).at(-1)!, e50 = ema(closes, 50).at(-1)!;
  const close = closes.at(-1)!;
  const c5 = closes.at(-5)!;
  const change5Pct = ((close - c5) / c5) * 100;
  const roc5 = Number.isFinite(observed.roc5) ? observed.roc5! : (close - closes.at(-6)!) / closes.at(-6)!;
  const base = { ...blank, close, ema9: e9, ema21: e21, ema50: e50, change5Pct, roc5, momentumConflict: false };
  const candidate = close > e9 && close > e21 && close > e50 ? 'LONG'
    : close < e9 && close < e21 && close < e50 ? 'SHORT'
      : change5Pct > 0.3 && close > e9 ? 'LONG'
        : change5Pct < -0.3 && close < e9 ? 'SHORT' : null;
  if (candidate) {
    const sign = candidate === 'LONG' ? 1 : -1;
    const flow = observed.orderflow;
    const opposing = [
      ...(sign * change5Pct < 0 ? ['five-bar price change'] : []),
      ...(sign * roc5 < 0 ? ['ROC5'] : []),
      ...(flow && Number.isFinite(flow.cvdDelta) && sign * flow.cvdDelta < 0 ? ['observed CVD'] : []),
      ...(flow && flow.buySellRatio !== null && Number.isFinite(flow.buySellRatio) && sign * (flow.buySellRatio - 1) < 0 ? ['observed taker-flow ratio'] : []),
    ];
    if (opposing.length) return { ...base, momentumConflict: true, reason: `${candidate} price structure conflicts with ${opposing.join(', ')}. Abstaining.` };
    return { ...base, side: candidate, invalidation: e9, reason: `${candidate} price structure with no opposing observed short-term momentum.` };
  }
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
    return trs.reduce((a, b) => a + b, 0) / trs.length;
  }
  let a = trs.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < trs.length; i++) {
    a = (a * (period - 1) + trs[i]) / period;
  }
  return a;
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
    return { sessionVwap, poc: p, vah: p, val: p };
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
    sessionVwap,
    poc,
    vah,
    val
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
    recentSwingHigh: high,
    recentSwingLow: low,
    distToLiquiditySweepPct: Math.round(distPct * 100) / 100
  };
}

export function calculateVolatility(candles: Candle[]): { atr14: number; atrPct: number; realizedVol24h: number | null; realizedVol24hBasis: string; bollingerBandWidthPct: number } {
  const close = candles.at(-1)?.c ?? 0;
  const a14 = atr(candles, 14);
  const atrPct = close > 0 ? Math.round((a14 / close) * 10000) / 100 : 0;

  let rv: number | null = null;
  const day = candles.slice(-97);
  if (day.length === 97 && day.every((c, i) => c.c > 0 && (!i || c.t - day[i - 1].t === 15 * 60_000))) {
    const returns: number[] = [];
    for (let i = 1; i < day.length; i++) {
      returns.push(Math.log(day[i].c / day[i - 1].c));
    }
    rv = Math.round(Math.sqrt(returns.reduce((sum, value) => sum + value * value, 0)) * 10000) / 100;
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
    realizedVol24hBasis: 'Root sum squared log returns over exactly 96 closed 15m intervals, percent, not annualized',
    bollingerBandWidthPct: bbWidth
  };
}

export function determineTrendRegime(closes: number[]): { ema9: number; ema21: number; ema50: number; ema200: number | null; regime: 'STRONG_UPTREND' | 'STRONG_DOWNTREND' | 'RANGING_CHOP' | 'SQUEEZE_BREAKOUT' } {
  const close = closes.at(-1) ?? 0;
  const e9 = ema(closes, 9).at(-1) || close;
  const e21 = ema(closes, 21).at(-1) || close;
  const e50 = ema(closes, 50).at(-1) || close;
  const e200 = ema(closes, 200).at(-1);

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
    ema9: e9,
    ema21: e21,
    ema50: e50,
    ema200: e200 ?? null,
    regime
  };
}

export function buildTechnicalSummary(candlesMap: { '5m'?: Candle[]; '15m'?: Candle[]; '1h'?: Candle[]; '4h'?: Candle[] }): TechnicalSummary {
  const base15m = candlesMap['15m'] ?? [];
  const base5m = candlesMap['5m'] ?? [];
  const base1h = candlesMap['1h'] ?? [];
  const base4h = candlesMap['4h'] ?? [];
  const trend = (bars: Candle[]) => bars.length >= 50 ? determineTrendRegime(bars.map((c) => c.c)) : null;

  return {
    derivation: { volumeProfile: 'Candle-weighted estimate, not exchange volume-at-price', swingLevels: 'Observed candle extrema; distance is a proxy, not measured liquidation liquidity', momentum: 'RSI on the stated closed-candle timeframe' },
    mtfTrend: {
      '5m': trend(base5m),
      '15m': trend(base15m),
      '1h': trend(base1h),
      '4h': trend(base4h)
    },
    volatility: base15m.length >= 20 ? calculateVolatility(base15m) : null,
    momentum: {
      rsi14_15m: base15m.length > 14 ? rsi(base15m.map((c) => c.c), 14) : null,
      rsi14_1h: base1h.length > 14 ? rsi(base1h.map((c) => c.c), 14) : null,
      rsi14_4h: base4h.length > 14 ? rsi(base4h.map((c) => c.c), 14) : null
    },
    volumeProfile: base15m.length ? calculateVolumeProfile(base15m) : null,
    swingLevels: base15m.length ? calculateSwingLevels(base15m) : null
  };
}
