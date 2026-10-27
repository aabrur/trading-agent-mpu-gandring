/**
 * Harmonic Fibonacci PRZ Geometry Engine for Mpu Gandring.
 *
 * Clean-room TypeScript implementation inspired by harmonic geometric pattern recognition:
 * - Identifies 5-point XABCD structures from market swing points.
 * - Matches Fibonacci geometric ratios: Gartley, Bat, Butterfly, Crab.
 * - Computes Potential Reversal Zone (PRZ) with invalidation stop and target levels.
 */

import { structuralPrice } from '../money.js';
import { findSwingPoints, type SMCSwingPoint } from './smc.js';

export type HarmonicPatternName = 'GARTLEY' | 'BAT' | 'BUTTERFLY' | 'CRAB';
export type HarmonicOrientation = 'BULLISH' | 'BEARISH';

export interface HarmonicPattern {
  name: HarmonicPatternName;
  orientation: HarmonicOrientation;
  points: {
    X: SMCSwingPoint;
    A: SMCSwingPoint;
    B: SMCSwingPoint;
    C: SMCSwingPoint;
    D: SMCSwingPoint;
  };
  ratios: {
    ab_xa: number;
    bc_ab: number;
    cd_bc: number;
    xd_xa: number;
  };
  prz: {
    entryMin: number;
    entryMax: number;
    stopLoss: number;
    target1: number;
    target2: number;
  };
  qualityScore: number; // 0 to 100 based on Fibonacci proximity
}

function within(val: number, target: number, tol: number = 0.08): boolean {
  return Math.abs(val - target) <= tol;
}

function withinRange(val: number, min: number, max: number, tol: number = 0.08): boolean {
  return val >= (min - tol) && val <= (max + tol);
}

/**
 * Scans swing points for valid XABCD harmonic patterns.
 */
export function detectHarmonicPatterns(candles: any[]): HarmonicPattern[] {
  // Extract clean swing points
  let bars: any[] = [];
  if (Array.isArray(candles)) {
    bars = candles.map((c, i) => ({
      index: i,
      timestamp: typeof c.timestamp === 'number' ? c.timestamp : typeof c.t === 'number' ? c.t : 0,
      open: typeof c.open === 'number' ? c.open : typeof c.o === 'number' ? c.o : 0,
      high: typeof c.high === 'number' ? c.high : typeof c.h === 'number' ? c.h : 0,
      low: typeof c.low === 'number' ? c.low : typeof c.l === 'number' ? c.l : 0,
      close: typeof c.close === 'number' ? c.close : typeof c.c === 'number' ? c.c : 0,
      volume: typeof c.volume === 'number' ? c.volume : typeof c.v === 'number' ? c.v : 0,
    })).filter(b => b.open > 0 && b.high > 0 && b.low > 0 && b.close > 0);
  }

  if (bars.length < 15) return [];

  const swings = findSwingPoints(bars, 2);
  if (swings.length < 5) return [];

  const patterns: HarmonicPattern[] = [];

  // Iterate over consecutive 5-swing windows
  for (let i = 0; i <= swings.length - 5; i++) {
    const X = swings[i];
    const A = swings[i + 1];
    const B = swings[i + 2];
    const C = swings[i + 3];
    const D = swings[i + 4];

    // Must alternate High-Low-High-Low-High or Low-High-Low-High-Low
    const isBullishStructure = X.type === 'LOW' && A.type === 'HIGH' && B.type === 'LOW' && C.type === 'HIGH' && D.type === 'LOW';
    const isBearishStructure = X.type === 'HIGH' && A.type === 'LOW' && B.type === 'HIGH' && C.type === 'LOW' && D.type === 'HIGH';

    if (!isBullishStructure && !isBearishStructure) continue;

    const orientation: HarmonicOrientation = isBullishStructure ? 'BULLISH' : 'BEARISH';

    const XA = Math.abs(A.price - X.price);
    const AB = Math.abs(B.price - A.price);
    const BC = Math.abs(C.price - B.price);
    const CD = Math.abs(D.price - C.price);
    const AD = Math.abs(D.price - A.price);

    if (XA === 0 || AB === 0 || BC === 0) continue;

    const ab_xa = AB / XA;
    const bc_ab = BC / AB;
    const cd_bc = CD / BC;
    const xd_xa = AD / XA; // D completion retracement/extension of XA leg

    let matchedName: HarmonicPatternName | null = null;
    let expectedAbXa = 0;
    let expectedXdXa = 0;

    // 1. Gartley: B retracement ~0.618 XA, D retracement ~0.786 XA
    if (within(ab_xa, 0.618, 0.08) && within(xd_xa, 0.786, 0.08) && withinRange(bc_ab, 0.382, 0.886, 0.1)) {
      matchedName = 'GARTLEY';
      expectedAbXa = 0.618;
      expectedXdXa = 0.786;
    }
    // 2. Bat: B retracement 0.382-0.500 XA, D retracement ~0.886 XA
    else if (withinRange(ab_xa, 0.382, 0.500, 0.08) && within(xd_xa, 0.886, 0.08) && withinRange(bc_ab, 0.382, 0.886, 0.1)) {
      matchedName = 'BAT';
      expectedAbXa = 0.500;
      expectedXdXa = 0.886;
    }
    // 3. Butterfly: B retracement ~0.786 XA, D extension ~1.272-1.618 XA
    else if (within(ab_xa, 0.786, 0.08) && withinRange(xd_xa, 1.272, 1.618, 0.12)) {
      matchedName = 'BUTTERFLY';
      expectedAbXa = 0.786;
      expectedXdXa = 1.272;
    }
    // 4. Crab: B retracement 0.382-0.618 XA, D extension ~1.618 XA
    else if (withinRange(ab_xa, 0.382, 0.618, 0.08) && within(xd_xa, 1.618, 0.15)) {
      matchedName = 'CRAB';
      expectedAbXa = 0.618;
      expectedXdXa = 1.618;
    }

    if (matchedName) {
      // Calculate Potential Reversal Zone (PRZ)
      const dPrice = D.price;
      const przOffset = dPrice * 0.005;
      const entryMin = Math.min(dPrice - przOffset, dPrice + przOffset);
      const entryMax = Math.max(dPrice - przOffset, dPrice + przOffset);

      // Stop Loss placed beyond X or D with invalidation margin
      let stopLoss = 0;
      let target1 = 0;
      let target2 = 0;

      if (orientation === 'BULLISH') {
        stopLoss = Math.min(X.price, D.price) * 0.985;
        target1 = dPrice + (CD * 0.382);
        target2 = dPrice + (CD * 0.618);
      } else {
        stopLoss = Math.max(X.price, D.price) * 1.015;
        target1 = dPrice - (CD * 0.382);
        target2 = dPrice - (CD * 0.618);
      }

      // Proximity score (100 = perfect Fibonacci match)
      const errorAb = Math.abs(ab_xa - expectedAbXa);
      const errorXd = Math.abs(xd_xa - expectedXdXa);
      const qualityScore = Math.max(0, Math.min(100, Math.round((1 - (errorAb + errorXd)) * 100)));

      patterns.push({
        name: matchedName,
        orientation,
        points: { X, A, B, C, D },
        ratios: {
          ab_xa: Number(ab_xa.toFixed(3)),
          bc_ab: Number(bc_ab.toFixed(3)),
          cd_bc: Number(cd_bc.toFixed(3)),
          xd_xa: Number(xd_xa.toFixed(3)),
        },
        prz: {
          entryMin: structuralPrice(entryMin),
          entryMax: structuralPrice(entryMax),
          stopLoss: structuralPrice(stopLoss),
          target1: structuralPrice(target1),
          target2: structuralPrice(target2),
        },
        qualityScore,
      });
    }
  }

  return patterns;
}
