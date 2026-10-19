import type { Candle } from './types.js';

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
