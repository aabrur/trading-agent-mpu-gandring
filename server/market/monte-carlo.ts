/**
 * Local geometric Brownian motion path simulation. This is not pretrained Kronos inference.
 */

export type VolatilityRegime = 'EXPANDING_VOLATILITY' | 'CONTRACTING_VOLATILITY' | 'STABLE_DRIFT' | 'UNCERTAIN';

export interface MonteCarloForecast {
  currentPrice: number | null;
  horizon: number;
  numPaths: number;
  drift: number | null;
  volatility: number | null;
  regime: VolatilityRegime;
  probTpFirst: number | null;
  probSlFirst: number | null;
  probNoHit: number | null;
  expectedReturnPct: number | null;
  /** Pointwise simulated quantiles, not calibrated confidence intervals. */
  p10: number[];
  p50: number[];
  p90: number[];
}

export interface MonteCarloInput {
  candles: Array<{ close?: number; c?: number; [key: string]: unknown }>;
  horizon?: number;
  numPaths?: number;
  seed?: number;
  side?: 'LONG' | 'SHORT';
  tpPrice?: number;
  slPrice?: number;
}

const MAX_HORIZON = 500;
const MAX_PATHS = 5000;

export function validateForecastOptions(horizon: number, numPaths: number, seed?: number): void {
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > MAX_HORIZON) {
    throw new RangeError(`horizon must be an integer from 1 to ${MAX_HORIZON}`);
  }
  if (!Number.isInteger(numPaths) || numPaths < 1 || numPaths > MAX_PATHS) {
    throw new RangeError(`numPaths must be an integer from 1 to ${MAX_PATHS}`);
  }
  if (seed !== undefined && (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff)) {
    throw new RangeError('seed must be an integer from 0 to 4294967295');
  }
}

function createRandom(seed?: number): () => number {
  if (seed === undefined) return Math.random;
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function boxMuller(randFn: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = randFn();
  while (v === 0) v = randFn();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function simulateMonteCarlo(input: MonteCarloInput): MonteCarloForecast {
  const horizon = input.horizon ?? 10;
  const numPaths = input.numPaths ?? 200;
  validateForecastOptions(horizon, numPaths, input.seed);
  const side = input.side ?? 'LONG';
  if (side !== 'LONG' && side !== 'SHORT') throw new RangeError('side must be LONG or SHORT');

  const closes = (input.candles ?? [])
    .map(c => typeof c.close === 'number' ? c.close : c.c)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
  const currentPrice = closes.length > 0 ? closes[closes.length - 1] : null;
  const insufficient = (current: number | null): MonteCarloForecast => ({
    currentPrice: current,
    horizon,
    numPaths,
    drift: null,
    volatility: null,
    regime: 'UNCERTAIN',
    probTpFirst: null,
    probSlFirst: null,
    probNoHit: null,
    expectedReturnPct: null,
    p10: [],
    p50: [],
    p90: [],
  });
  if (closes.length < 2 || currentPrice === null) return insufficient(currentPrice);

  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) returns.push(Math.log(closes[i] / closes[i - 1]));
  if (returns.some(value => !Number.isFinite(value))) return insufficient(currentPrice);

  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((acc, value) => acc + (value - meanReturn) ** 2, 0) / Math.max(1, returns.length - 1);
  const volatility = Math.sqrt(variance);
  const drift = meanReturn * 0.8;
  const rand = createRandom(input.seed);
  const paths: number[][] = [];
  let tpHits = 0;
  let slHits = 0;
  let noHits = 0;
  const hasBarriers = Number.isFinite(input.tpPrice) && (input.tpPrice as number) > 0
    && Number.isFinite(input.slPrice) && (input.slPrice as number) > 0;
  if (hasBarriers && (side === 'LONG' ? input.tpPrice! <= input.slPrice! : input.tpPrice! >= input.slPrice!)) {
    throw new RangeError(`tpPrice and slPrice are not ordered for a ${side} position`);
  }

  for (let i = 0; i < numPaths; i++) {
    const path = [currentPrice];
    let price = currentPrice;
    let firstHit: 'TP' | 'SL' | null = null;
    for (let step = 1; step <= horizon; step++) {
      price *= Math.exp(drift - 0.5 * volatility ** 2 + volatility * boxMuller(rand));
      if (!Number.isFinite(price) || price <= 0) return insufficient(currentPrice);
      path.push(price);
      if (firstHit === null && hasBarriers) {
        const tpHit = side === 'LONG' ? price >= input.tpPrice! : price <= input.tpPrice!;
        const slHit = side === 'LONG' ? price <= input.slPrice! : price >= input.slPrice!;
        if (tpHit) firstHit = 'TP';
        else if (slHit) firstHit = 'SL';
      }
    }
    if (firstHit === 'TP') tpHits++;
    else if (firstHit === 'SL') slHits++;
    else noHits++;
    paths.push(path);
  }

  const quantile = (values: number[], p: number): number => values.sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(p * values.length))];
  const p10: number[] = [];
  const p50: number[] = [];
  const p90: number[] = [];
  for (let step = 0; step <= horizon; step++) {
    const prices = paths.map(path => path[step]);
    p10.push(quantile(prices, 0.1));
    p50.push(quantile(prices, 0.5));
    p90.push(quantile(prices, 0.9));
  }

  const recentReturns = returns.slice(-5);
  const recentVariance = recentReturns.reduce((acc, value) => acc + (value - meanReturn) ** 2, 0) / Math.max(1, recentReturns.length - 1);
  const recentVolatility = Math.sqrt(recentVariance);
  const regime: VolatilityRegime = recentVolatility > volatility * 1.3
    ? 'EXPANDING_VOLATILITY'
    : recentVolatility < volatility * 0.7 ? 'CONTRACTING_VOLATILITY' : 'STABLE_DRIFT';
  const expectedReturnPct = ((p50[p50.length - 1] - currentPrice) / currentPrice) * 100;
  if (!Number.isFinite(expectedReturnPct)) return insufficient(currentPrice);
  return {
    currentPrice,
    horizon,
    numPaths,
    drift: Number(drift.toFixed(6)),
    volatility: Number(volatility.toFixed(6)),
    regime,
    probTpFirst: hasBarriers ? Number((tpHits / numPaths).toFixed(4)) : null,
    probSlFirst: hasBarriers ? Number((slHits / numPaths).toFixed(4)) : null,
    probNoHit: hasBarriers ? Number((noHits / numPaths).toFixed(4)) : null,
    expectedReturnPct,
    p10,
    p50,
    p90,
  };
}
