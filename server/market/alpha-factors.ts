/**
 * Alpha158 Formulaic Factor Library for Mpu Gandring.
 *
 * Clean-room TypeScript implementation inspired by quantitative factor formulas
 * from Microsoft Qlib (Alpha158/Alpha360 specification):
 * - K-Line structural ratios (KMID, KLOW, KHIGH, KSFT).
 * - Momentum & Rate of Change (ROC5, ROC10, ROC20, MA_RATIO).
 * - Volatility & Dispersion (STD5, STD20, ATR, Bollinger Bandwidth).
 * - Volume Price Interaction (VMA_RATIO, VWAP_RATIO, RSV).
 * - Multi-Factor Composite Score normalized to [-1.0, +1.0].
 */

export interface UnifiedBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Alpha158Factors {
  timestamp: number;
  // K-line Structural
  kmid: number;
  klow: number;
  khigh: number;
  ksft: number;
  hlRatio: number;
  // Momentum
  roc5: number;
  roc10: number;
  roc20: number;
  ma5Ratio: number;
  ma10Ratio: number;
  ma20Ratio: number;
  // Volatility
  std5: number;
  std20: number;
  atr14: number;
  atrRatio: number;
  bbBandwidth20: number;
  // Volume
  vma5Ratio: number;
  vma20Ratio: number;
  vwap20Ratio: number;
  rsv14: number;
  // Composite
  compositeScore: number; // -1.0 (strongly bearish) to +1.0 (strongly bullish)
  regime: 'TRENDING_BULL' | 'TRENDING_BEAR' | 'EXPANDING_VOLATILITY' | 'COMPRESSED_VOLATILITY' | 'NEUTRAL';
}

function normalizeBars(candles: any[]): UnifiedBar[] {
  if (!Array.isArray(candles)) return [];
  const bars: UnifiedBar[] = [];

  for (const c of candles) {
    if (typeof c === 'object' && c !== null) {
      const timestamp = typeof c.timestamp === 'number' ? c.timestamp : typeof c.t === 'number' ? c.t : 0;
      const open = typeof c.open === 'number' ? c.open : typeof c.o === 'number' ? c.o : 0;
      const high = typeof c.high === 'number' ? c.high : typeof c.h === 'number' ? c.h : 0;
      const low = typeof c.low === 'number' ? c.low : typeof c.l === 'number' ? c.l : 0;
      const close = typeof c.close === 'number' ? c.close : typeof c.c === 'number' ? c.c : 0;
      const volume = typeof c.volume === 'number' ? c.volume : typeof c.v === 'number' ? c.v : 0;

      if (open > 0 && high > 0 && low > 0 && close > 0) {
        bars.push({ timestamp, open, high, low, close, volume });
      }
    }
  }

  bars.sort((a, b) => a.timestamp - b.timestamp);
  return bars;
}

function sma(values: number[], period: number): number {
  if (values.length < period || period <= 0) return values.at(-1) ?? 0;
  const slice = values.slice(-period);
  return slice.reduce((acc, v) => acc + v, 0) / period;
}

function std(values: number[], period: number): number {
  if (values.length < period || period <= 1) return 0;
  const slice = values.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / (period - 1);
  return Math.sqrt(variance);
}

function calcAtr(bars: UnifiedBar[], period: number = 14): number {
  if (bars.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1];
    const curr = bars[i];
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close)
    );
    trs.push(tr);
  }
  return sma(trs, Math.min(period, trs.length));
}

/**
 * Calculates Alpha158 key quantitative factor metrics on the given candle array.
 */
export function calculateAlphaFactors(candles: any[]): Alpha158Factors | null {
  const bars = normalizeBars(candles);
  if (bars.length < 5) return null;

  const latest = bars[bars.length - 1];
  const closes = bars.map(b => b.close);
  const volumes = bars.map(b => b.volume);
  const len = bars.length;

  // 1. K-line Structural
  const open = latest.open;
  const kmid = (latest.close - open) / open;
  const klow = (Math.min(open, latest.close) - latest.low) / open;
  const khigh = (latest.high - Math.max(open, latest.close)) / open;
  const ksft = (2 * latest.close - latest.high - latest.low) / open;
  const hlRatio = (latest.high - latest.low) / open;

  // 2. Momentum
  const roc5 = len > 5 ? (latest.close - bars[len - 6].close) / bars[len - 6].close : 0;
  const roc10 = len > 10 ? (latest.close - bars[len - 11].close) / bars[len - 11].close : roc5;
  const roc20 = len > 20 ? (latest.close - bars[len - 21].close) / bars[len - 21].close : roc10;

  const ma5 = sma(closes, 5);
  const ma10 = sma(closes, 10);
  const ma20 = sma(closes, 20);

  const ma5Ratio = ma5 > 0 ? (latest.close / ma5) - 1 : 0;
  const ma10Ratio = ma10 > 0 ? (latest.close / ma10) - 1 : 0;
  const ma20Ratio = ma20 > 0 ? (latest.close / ma20) - 1 : 0;

  // 3. Volatility
  const returns: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    returns.push((bars[i].close - bars[i - 1].close) / bars[i - 1].close);
  }
  const std5 = std(returns, 5);
  const std20 = std(returns, Math.min(20, returns.length));
  const atr14 = calcAtr(bars, 14);
  const atrRatio = latest.close > 0 ? atr14 / latest.close : 0;

  const bollingerStd = std(closes, 20);
  const bbBandwidth20 = ma20 > 0 ? (4 * bollingerStd) / ma20 : 0;

  // 4. Volume
  const vma5 = sma(volumes, 5);
  const vma20 = sma(volumes, 20);
  const vma5Ratio = vma5 > 0 ? (latest.volume / vma5) - 1 : 0;
  const vma20Ratio = vma20 > 0 ? (latest.volume / vma20) - 1 : 0;

  // Approximate VWAP over last 20 bars
  const slice20 = bars.slice(-20);
  const totalVolume20 = slice20.reduce((acc, b) => acc + b.volume, 0);
  const totalPV20 = slice20.reduce((acc, b) => acc + (b.close * b.volume), 0);
  const vwap20 = totalVolume20 > 0 ? totalPV20 / totalVolume20 : ma20;
  const vwap20Ratio = vwap20 > 0 ? (latest.close / vwap20) - 1 : 0;

  // RSV 14
  const slice14 = bars.slice(-14);
  const minLow14 = Math.min(...slice14.map(b => b.low));
  const maxHigh14 = Math.max(...slice14.map(b => b.high));
  const rsv14 = (maxHigh14 - minLow14) > 0
    ? (latest.close - minLow14) / (maxHigh14 - minLow14)
    : 0.5;

  // 5. Composite Score & Regime
  // Combine momentum (ROC, MA ratios) with volume backing and stochastic positioning
  const momentumComponent = (roc5 * 2 + roc10 + ma5Ratio * 3 + ma20Ratio * 2);
  const volumeWeight = vma5Ratio > 0 ? 1.2 : 0.8;
  const rsvComponent = (rsv14 - 0.5) * 2; // maps [0, 1] to [-1, +1]

  const rawScore = (momentumComponent * 10 * volumeWeight) + (rsvComponent * 0.4);
  // Squeeze to [-1.0, +1.0] using tanh-like approximation
  const compositeScore = Math.max(-1.0, Math.min(1.0, Math.tanh(rawScore)));

  let regime: Alpha158Factors['regime'] = 'NEUTRAL';
  if (compositeScore >= 0.35 && ma5 > ma20) {
    regime = 'TRENDING_BULL';
  } else if (compositeScore <= -0.35 && ma5 < ma20) {
    regime = 'TRENDING_BEAR';
  } else if (atrRatio > 0.03 || bbBandwidth20 > 0.08) {
    regime = 'EXPANDING_VOLATILITY';
  } else if (atrRatio < 0.01 && bbBandwidth20 < 0.03) {
    regime = 'COMPRESSED_VOLATILITY';
  }

  return {
    timestamp: latest.timestamp,
    kmid: Number(kmid.toFixed(4)),
    klow: Number(klow.toFixed(4)),
    khigh: Number(khigh.toFixed(4)),
    ksft: Number(ksft.toFixed(4)),
    hlRatio: Number(hlRatio.toFixed(4)),
    roc5: Number(roc5.toFixed(4)),
    roc10: Number(roc10.toFixed(4)),
    roc20: Number(roc20.toFixed(4)),
    ma5Ratio: Number(ma5Ratio.toFixed(4)),
    ma10Ratio: Number(ma10Ratio.toFixed(4)),
    ma20Ratio: Number(ma20Ratio.toFixed(4)),
    std5: Number(std5.toFixed(4)),
    std20: Number(std20.toFixed(4)),
    atr14: Number(atr14.toFixed(2)),
    atrRatio: Number(atrRatio.toFixed(4)),
    bbBandwidth20: Number(bbBandwidth20.toFixed(4)),
    vma5Ratio: Number(vma5Ratio.toFixed(4)),
    vma20Ratio: Number(vma20Ratio.toFixed(4)),
    vwap20Ratio: Number(vwap20Ratio.toFixed(4)),
    rsv14: Number(rsv14.toFixed(4)),
    compositeScore: Number(compositeScore.toFixed(3)),
    regime,
  };
}
