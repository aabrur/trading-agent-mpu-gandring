/**
 * Smart Money Concepts (SMC) Institutional Structure Engine for Mpu Gandring.
 *
 * Clean-room TypeScript implementation inspired by institutional price action methodology:
 * - Swing High & Swing Low fractal pivot identification.
 * - Break of Structure (BOS) trend continuation detection.
 * - Change of Character (ChoCH) structural trend reversal detection.
 * - Fair Value Gap (FVG) 3-bar imbalance zone calculation with mitigation tracking.
 * - Order Block (OB) institutional supply & demand zones.
 */

import { structuralPrice } from '../money.js';

export interface SMCSwingPoint {
  index: number;
  timestamp: number;
  price: number;
  type: 'HIGH' | 'LOW';
}

export interface SMCFairValueGap {
  id: string;
  type: 'BULLISH' | 'BEARISH';
  topPrice: number;
  bottomPrice: number;
  createdTime: number;
  mitigated: boolean;
  mitigatedTime?: number;
}

export interface SMCOrderBlock {
  id: string;
  type: 'BULLISH' | 'BEARISH';
  topPrice: number;
  bottomPrice: number;
  createdTime: number;
  mitigated: boolean;
  mitigatedTime?: number;
}

export type SMCStructureBreakType = 'BULLISH_BOS' | 'BEARISH_BOS' | 'BULLISH_CHOCH' | 'BEARISH_CHOCH';

export interface SMCStructureBreak {
  type: SMCStructureBreakType;
  price: number;
  timestamp: number;
  brokenLevel: number;
}

export interface SMCAnalysis {
  timestamp: number;
  marketTrend: 'BULLISH' | 'BEARISH' | 'RANGING';
  lastBreak: SMCStructureBreak | null;
  activeFVGs: SMCFairValueGap[];
  activeOrderBlocks: SMCOrderBlock[];
  recentSwingHighs: SMCSwingPoint[];
  recentSwingLows: SMCSwingPoint[];
  premiumDiscountZone: {
    rangeHigh: number;
    rangeLow: number;
    equilibrium: number;
    currentZone: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM';
  };
}

interface InternalBar {
  index: number;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function normalizeBars(candles: any[]): InternalBar[] {
  if (!Array.isArray(candles)) return [];
  const bars: InternalBar[] = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (typeof c === 'object' && c !== null) {
      const timestamp = typeof c.timestamp === 'number' ? c.timestamp : typeof c.t === 'number' ? c.t : 0;
      const open = typeof c.open === 'number' ? c.open : typeof c.o === 'number' ? c.o : 0;
      const high = typeof c.high === 'number' ? c.high : typeof c.h === 'number' ? c.h : 0;
      const low = typeof c.low === 'number' ? c.low : typeof c.l === 'number' ? c.l : 0;
      const close = typeof c.close === 'number' ? c.close : typeof c.c === 'number' ? c.c : 0;
      const volume = typeof c.volume === 'number' ? c.volume : typeof c.v === 'number' ? c.v : 0;

      if (open > 0 && high > 0 && low > 0 && close > 0) {
        bars.push({ index: i, timestamp, open, high, low, close, volume });
      }
    }
  }

  bars.sort((a, b) => a.timestamp - b.timestamp);
  for (let i = 0; i < bars.length; i++) {
    bars[i].index = i;
  }
  return bars;
}

/**
 * Finds fractal swing highs and lows with a window radius (default 2 bars left and right).
 */
export function findSwingPoints(bars: InternalBar[], window: number = 2): SMCSwingPoint[] {
  const points: SMCSwingPoint[] = [];

  for (let i = window; i < bars.length - window; i++) {
    const curr = bars[i];
    let isHigh = true;
    let isLow = true;

    for (let j = 1; j <= window; j++) {
      if (bars[i - j].high >= curr.high || bars[i + j].high > curr.high) isHigh = false;
      if (bars[i - j].low <= curr.low || bars[i + j].low < curr.low) isLow = false;
    }

    if (isHigh) {
      points.push({ index: curr.index, timestamp: curr.timestamp, price: curr.high, type: 'HIGH' });
    }
    if (isLow) {
      points.push({ index: curr.index, timestamp: curr.timestamp, price: curr.low, type: 'LOW' });
    }
  }

  return points;
}

/**
 * Detects 3-bar Fair Value Gaps (FVG) and evaluates whether they have been mitigated by later bars.
 */
export function detectFairValueGaps(bars: InternalBar[]): SMCFairValueGap[] {
  const fvgs: SMCFairValueGap[] = [];

  for (let i = 2; i < bars.length; i++) {
    const first = bars[i - 2];
    const third = bars[i];

    // Bullish FVG: Low of bar 3 is higher than High of bar 1
    if (third.low > first.high) {
      const topPrice = third.low;
      const bottomPrice = first.high;
      let mitigated = false;
      let mitigatedTime: number | undefined;

      // Check subsequent bars for mitigation
      for (let j = i + 1; j < bars.length; j++) {
        if (bars[j].low <= bottomPrice) {
          mitigated = true;
          mitigatedTime = bars[j].timestamp;
          break;
        }
      }

      fvgs.push({
        id: `fvg-bull-${first.timestamp}`,
        type: 'BULLISH',
        topPrice,
        bottomPrice,
        createdTime: bars[i - 1].timestamp,
        mitigated,
        mitigatedTime,
      });
    }

    // Bearish FVG: High of bar 3 is lower than Low of bar 1
    if (third.high < first.low) {
      const topPrice = first.low;
      const bottomPrice = third.high;
      let mitigated = false;
      let mitigatedTime: number | undefined;

      // Check subsequent bars for mitigation
      for (let j = i + 1; j < bars.length; j++) {
        if (bars[j].high >= topPrice) {
          mitigated = true;
          mitigatedTime = bars[j].timestamp;
          break;
        }
      }

      fvgs.push({
        id: `fvg-bear-${first.timestamp}`,
        type: 'BEARISH',
        topPrice,
        bottomPrice,
        createdTime: bars[i - 1].timestamp,
        mitigated,
        mitigatedTime,
      });
    }
  }

  return fvgs;
}

/**
 * Executes full Smart Money Concepts (SMC) structure analysis on candles.
 */
export function analyzeSMC(candles: any[]): SMCAnalysis | null {
  const bars = normalizeBars(candles);
  if (bars.length < 10) return null;

  const swingPoints = findSwingPoints(bars, 2);
  const fvgs = detectFairValueGaps(bars);
  const activeFVGs = fvgs.filter(f => !f.mitigated);

  const swingHighs = swingPoints.filter(p => p.type === 'HIGH');
  const swingLows = swingPoints.filter(p => p.type === 'LOW');

  let currentTrend: 'BULLISH' | 'BEARISH' | 'RANGING' = 'RANGING';
  let lastBreak: SMCStructureBreak | null = null;
  const orderBlocks: SMCOrderBlock[] = [];

  // Track structure progression across swings
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const prevHighs = swingHighs.filter(h => h.index < i - 1);
    const prevLows = swingLows.filter(l => l.index < i - 1);

    const lastHigh = prevHighs.length > 0 ? prevHighs[prevHighs.length - 1] : null;
    const lastLow = prevLows.length > 0 ? prevLows[prevLows.length - 1] : null;

    // Break above Swing High
    if (lastHigh && bar.close > lastHigh.price) {
      const isChoCH = currentTrend === 'BEARISH';
      const breakType: SMCStructureBreakType = isChoCH ? 'BULLISH_CHOCH' : 'BULLISH_BOS';

      lastBreak = {
        type: breakType,
        price: bar.close,
        timestamp: bar.timestamp,
        brokenLevel: lastHigh.price,
      };
      currentTrend = 'BULLISH';

      // Identify Bullish Order Block (last bearish candle before the up-move)
      for (let k = bar.index - 1; k >= Math.max(0, bar.index - 6); k--) {
        if (bars[k].close < bars[k].open) {
          orderBlocks.push({
            id: `ob-bull-${bars[k].timestamp}`,
            type: 'BULLISH',
            topPrice: bars[k].high,
            bottomPrice: bars[k].low,
            createdTime: bars[k].timestamp,
            mitigated: false,
          });
          break;
        }
      }
    }

    // Break below Swing Low
    if (lastLow && bar.close < lastLow.price) {
      const isChoCH = currentTrend === 'BULLISH';
      const breakType: SMCStructureBreakType = isChoCH ? 'BEARISH_CHOCH' : 'BEARISH_BOS';

      lastBreak = {
        type: breakType,
        price: bar.close,
        timestamp: bar.timestamp,
        brokenLevel: lastLow.price,
      };
      currentTrend = 'BEARISH';

      // Identify Bearish Order Block (last bullish candle before the down-move)
      for (let k = bar.index - 1; k >= Math.max(0, bar.index - 6); k--) {
        if (bars[k].close > bars[k].open) {
          orderBlocks.push({
            id: `ob-bear-${bars[k].timestamp}`,
            type: 'BEARISH',
            topPrice: bars[k].high,
            bottomPrice: bars[k].low,
            createdTime: bars[k].timestamp,
            mitigated: false,
          });
          break;
        }
      }
    }
  }

  // Evaluate Order Block mitigation by current price
  const latestPrice = bars[bars.length - 1].close;
  const activeOrderBlocks: SMCOrderBlock[] = [];

  for (const ob of orderBlocks) {
    if (ob.type === 'BULLISH' && latestPrice < ob.bottomPrice) {
      ob.mitigated = true;
    } else if (ob.type === 'BEARISH' && latestPrice > ob.topPrice) {
      ob.mitigated = true;
    }
    if (!ob.mitigated) {
      activeOrderBlocks.push(ob);
    }
  }

  // Premium / Discount calculation on recent range
  const recentSlice = bars.slice(-40);
  const rangeHigh = Math.max(...recentSlice.map(b => b.high));
  const rangeLow = Math.min(...recentSlice.map(b => b.low));
  const equilibrium = (rangeHigh + rangeLow) / 2;

  let currentZone: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM' = 'EQUILIBRIUM';
  if (latestPrice > equilibrium * 1.005) {
    currentZone = 'PREMIUM';
  } else if (latestPrice < equilibrium * 0.995) {
    currentZone = 'DISCOUNT';
  }

  return {
    timestamp: bars[bars.length - 1].timestamp,
    marketTrend: currentTrend,
    lastBreak,
    activeFVGs: activeFVGs.slice(-5), // keep 5 most recent
    activeOrderBlocks: activeOrderBlocks.slice(-5),
    recentSwingHighs: swingHighs.slice(-3),
    recentSwingLows: swingLows.slice(-3),
    premiumDiscountZone: {
      rangeHigh: structuralPrice(rangeHigh),
      rangeLow: structuralPrice(rangeLow),
      equilibrium: structuralPrice(equilibrium),
      currentZone,
    },
  };
}
