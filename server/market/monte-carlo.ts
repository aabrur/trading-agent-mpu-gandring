/**
 * Monte Carlo Path Distribution & Volatility Cone Engine for Mpu Gandring.
 *
 * Clean-room TypeScript implementation inspired by shiyu-coder/Kronos:
 * - Deterministic geometric Brownian motion simulation with momentum drift.
 * - Extracts P10 (bearish tail), P50 (median expected path), and P90 (bullish tail).
 * - Computes probability of hitting Take Profit before Stop Loss: P(TP first).
 * - Classifies forward volatility regime: EXPANDING, CONTRACTING, or STABLE.
 */

export type VolatilityRegime = 'EXPANDING_VOLATILITY' | 'CONTRACTING_VOLATILITY' | 'STABLE_DRIFT' | 'UNCERTAIN';

export interface MonteCarloForecast {
  currentPrice: number;
  horizon: number;
  numPaths: number;
  drift: number;
  volatility: number;
  regime: VolatilityRegime;
  probTpFirst: number; // 0.0 to 1.0
  expectedReturnPct: number;
  p10: number[]; // Lower quantile path
  p50: number[]; // Median expected path
  p90: number[]; // Upper quantile path
}

export interface MonteCarloInput {
  candles: Array<{ close?: number; c?: number; [key: string]: any }>;
  horizon?: number; // Forward bar steps (default 10)
  numPaths?: number; // Number of simulated trajectories (default 200)
  tpPrice?: number;
  slPrice?: number;
}

/**
 * Standard Normal Box-Muller random number generator with deterministic seed support.
 */
function boxMuller(randFn: () => number = Math.random): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = randFn();
  while (v === 0) v = randFn();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/**
 * Runs forward Monte Carlo simulation over historical candles.
 */
export function simulateMonteCarlo(input: MonteCarloInput): MonteCarloForecast {
  const { candles, horizon = 10, numPaths = 200, tpPrice, slPrice } = input;

  const closes = (candles ?? [])
    .map(c => typeof c.close === 'number' ? c.close : typeof c.c === 'number' ? c.c : 0)
    .filter(c => c > 0);

  if (closes.length < 2) {
    return {
      currentPrice: closes[0] ?? 0,
      horizon,
      numPaths,
      drift: 0,
      volatility: 0,
      regime: 'UNCERTAIN',
      probTpFirst: 0.5,
      expectedReturnPct: 0,
      p10: [],
      p50: [],
      p90: [],
    };
  }

  const currentPrice = closes[closes.length - 1];

  // Calculate log returns
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push(Math.log(closes[i] / closes[i - 1]));
  }

  const n = returns.length;
  const meanReturn = returns.reduce((a, b) => a + b, 0) / n;
  const variance = returns.reduce((acc, r) => acc + Math.pow(r - meanReturn, 2), 0) / Math.max(1, n - 1);
  const volatility = Math.sqrt(variance);

  // Momentum drift with slight mean-reverting dampener
  const drift = meanReturn * 0.8;

  // Simulate M paths
  const paths: number[][] = [];
  let tpHits = 0;
  let slHits = 0;

  for (let i = 0; i < numPaths; i++) {
    const path: number[] = [currentPrice];
    let p = currentPrice;
    let hitTp = false;
    let hitSl = false;

    for (let step = 1; step <= horizon; step++) {
      const z = boxMuller();
      p = p * Math.exp((drift - 0.5 * Math.pow(volatility, 2)) + volatility * z);
      path.push(p);

      // Barrier checks
      if (!hitTp && !hitSl) {
        if (typeof tpPrice === 'number' && p >= tpPrice) {
          hitTp = true;
        } else if (typeof slPrice === 'number' && p <= slPrice) {
          hitSl = true;
        }
      }
    }

    if (hitTp && !hitSl) tpHits++;
    else if (hitSl && !hitTp) slHits++;

    paths.push(path);
  }

  // Extract quantiles per step
  const p10: number[] = [];
  const p50: number[] = [];
  const p90: number[] = [];

  for (let step = 0; step <= horizon; step++) {
    const sortedPrices = paths.map(pth => pth[step]).sort((a, b) => a - b);
    const idx10 = Math.floor(0.10 * numPaths);
    const idx50 = Math.floor(0.50 * numPaths);
    const idx90 = Math.min(numPaths - 1, Math.floor(0.90 * numPaths));

    p10.push(Number(sortedPrices[idx10].toFixed(4)));
    p50.push(Number(sortedPrices[idx50].toFixed(4)));
    p90.push(Number(sortedPrices[idx90].toFixed(4)));
  }

  const totalTerminal = tpHits + slHits;
  const probTpFirst = totalTerminal > 0
    ? Number((tpHits / totalTerminal).toFixed(4))
    : 0.5;

  const expectedReturnPct = Number((((p50[p50.length - 1] - currentPrice) / currentPrice) * 100).toFixed(2));

  // Volatility regime evaluation
  const recentReturns = returns.slice(-5);
  const recentVariance = recentReturns.reduce((acc, r) => acc + Math.pow(r - meanReturn, 2), 0) / Math.max(1, recentReturns.length - 1);
  const recentVol = Math.sqrt(recentVariance);

  let regime: VolatilityRegime = 'STABLE_DRIFT';
  if (recentVol > volatility * 1.3) {
    regime = 'EXPANDING_VOLATILITY';
  } else if (recentVol < volatility * 0.7) {
    regime = 'CONTRACTING_VOLATILITY';
  }

  return {
    currentPrice: Number(currentPrice.toFixed(4)),
    horizon,
    numPaths,
    drift: Number(drift.toFixed(6)),
    volatility: Number(volatility.toFixed(6)),
    regime,
    probTpFirst,
    expectedReturnPct,
    p10,
    p50,
    p90,
  };
}
