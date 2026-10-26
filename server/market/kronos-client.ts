/**
 * Non-Blocking Kronos Client with Circuit Breaker & Fail-Open Resilience.
 *
 * Clean-room TypeScript client for Mpu Gandring:
 * - Connects to isolated Python Kronos worker.
 * - Non-blocking execution with strict timeout (default 800ms).
 * - Circuit breaker pattern: trips OPEN after consecutive failures to avoid event loop stalls.
 * - Fail-Open Resilience: gracefully falls back to native TypeScript Monte Carlo forecasting
 *   when worker is unavailable, ensuring trading and risk gates never halt.
 */

import { simulateMonteCarlo, validateForecastOptions, type MonteCarloForecast, type MonteCarloInput } from './monte-carlo.js';
import { randomUUID } from 'node:crypto';
import { recordDiagnostic } from '../session-log.js';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface KronosClientConfig {
  workerUrl?: string; // e.g. http://127.0.0.1:8181
  timeoutMs?: number; // e.g. 800ms
  maxFailures?: number; // Trips circuit after N failures (default 3)
  cooldownMs?: number; // Time before testing worker again (default 30_000ms)
  fetchFn?: typeof fetch;
}

export interface KronosPredictionResult extends MonteCarloForecast {
  workerAvailable: boolean;
  source: 'PYTHON_GBM_SIMULATION' | 'LOCAL_GBM_SIMULATION';
  latencyMs: number;
  circuitState: CircuitState;
}

export class KronosClient {
  private workerUrl: string;
  private timeoutMs: number;
  private maxFailures: number;
  private cooldownMs: number;
  private fetchFn: typeof fetch;

  private circuitState: CircuitState = 'CLOSED';
  private failureCount: number = 0;
  private lastFailureTime: number = 0;

  constructor(config: KronosClientConfig = {}) {
    this.workerUrl = config.workerUrl ?? (process.env.KRONOS_WORKER_URL || 'http://127.0.0.1:8181');
    this.timeoutMs = config.timeoutMs ?? 800;
    this.maxFailures = config.maxFailures ?? 3;
    this.cooldownMs = config.cooldownMs ?? 30_000;
    this.fetchFn = config.fetchFn ?? fetch;
  }

  /**
   * Evaluates circuit breaker state.
   */
  public getCircuitStatus(now: number = Date.now()): { state: CircuitState; failureCount: number } {
    if (this.circuitState === 'OPEN') {
      if (now - this.lastFailureTime >= this.cooldownMs) {
        this.circuitState = 'HALF_OPEN';
      }
    }
    return {
      state: this.circuitState,
      failureCount: this.failureCount,
    };
  }

  /**
   * Resets circuit breaker to clean CLOSED state.
   */
  public resetCircuit(): void {
    this.circuitState = 'CLOSED';
    this.failureCount = 0;
    this.lastFailureTime = 0;
  }

  /**
   * Predicts forward trajectory non-blockingly with fail-open fallback.
   */
  public async predict(input: MonteCarloInput, now: number = Date.now()): Promise<KronosPredictionResult> {
    const horizon = input.horizon ?? 10;
    const numPaths = input.numPaths ?? 200;
    validateForecastOptions(horizon, numPaths, input.seed);
    const start = Date.now();
    const requestId = `gbm-${randomUUID()}`;
    recordDiagnostic({ source: 'forecast', category: 'PREDICTION', eventName: 'forecast.requested', status: 'started', correlationId: requestId, message: 'Statistical forecast requested', details: { horizon, numPaths, side: input.side, seeded: input.seed !== undefined } });
    const { state } = this.getCircuitStatus(now);

    // If circuit is OPEN, fail-open immediately to native statistical fallback without network delay
    if (state === 'OPEN') {
      const fallback = simulateMonteCarlo(input);
      recordDiagnostic({ source: 'forecast', category: 'PREDICTION', eventName: 'forecast.fallback', status: 'circuit_open', correlationId: requestId, message: 'Local statistical fallback used', durationMs: Date.now() - start });
      return {
        ...fallback,
        workerAvailable: false,
        source: 'LOCAL_GBM_SIMULATION',
        latencyMs: Date.now() - start,
        circuitState: 'OPEN',
      };
    }

    // Attempt call to Python Kronos worker
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const endpoint = `${this.workerUrl.replace(/\/+$/, '')}/predict`;
      const res = await this.fetchFn(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          candles: input.candles,
          horizon: input.horizon ?? 10,
          num_paths: input.numPaths ?? 200,
          seed: input.seed,
          side: input.side ?? 'LONG',
          tp_price: input.tpPrice,
          sl_price: input.slPrice,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`Worker returned HTTP ${res.status}`);
      }

      const data: unknown = await res.json();
      if (!isValidWorkerPrediction(data, horizon, numPaths)) throw new Error('Malformed prediction payload from worker');
      const payload = data as WorkerPrediction;

      // Success: reset failures and close circuit
      this.circuitState = 'CLOSED';
      this.failureCount = 0;
      recordDiagnostic({ source: 'forecast', category: 'PREDICTION', eventName: 'forecast.completed', status: 'completed', correlationId: requestId, durationMs: Date.now() - start, message: 'Python statistical forecast completed', details: { model: 'GBM', horizon: payload.horizon, probTpFirst: payload.prob_tp_first, probSlFirst: payload.prob_sl_first, probNoHit: payload.prob_no_hit } });

      return {
        currentPrice: payload.current_price,
        horizon: payload.horizon,
        numPaths: payload.num_paths,
        drift: payload.drift,
        volatility: payload.volatility,
        regime: payload.regime,
        probTpFirst: payload.prob_tp_first,
        probSlFirst: payload.prob_sl_first,
        probNoHit: payload.prob_no_hit,
        expectedReturnPct: Number((((payload.p50[payload.p50.length - 1] - payload.p50[0]) / payload.p50[0]) * 100).toFixed(2)),
        p10: payload.p10,
        p50: payload.p50,
        p90: payload.p90,
        workerAvailable: true,
        source: 'PYTHON_GBM_SIMULATION',
        latencyMs: Date.now() - start,
        circuitState: 'CLOSED',
      };
    } catch (err: unknown) {
      recordDiagnostic({ source: 'forecast', category: 'PREDICTION', eventName: 'forecast.fallback', level: 'WARN', status: 'fallback', correlationId: requestId, durationMs: Date.now() - start, message: 'Forecast worker failed; local statistical fallback selected', details: { error: err } });
      // Record failure for circuit breaker
      this.failureCount++;
      this.lastFailureTime = now;
      if (this.failureCount >= this.maxFailures) {
        this.circuitState = 'OPEN';
      }

      // Fail-open resilience: fall back cleanly to native simulation
      const fallback = simulateMonteCarlo(input);
      return {
        ...fallback,
        workerAvailable: false,
        source: 'LOCAL_GBM_SIMULATION',
        latencyMs: Date.now() - start,
        circuitState: this.circuitState,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

interface WorkerPrediction {
  current_price: number;
  horizon: number;
  num_paths: number;
  drift: number;
  volatility: number;
  regime: MonteCarloForecast['regime'];
  prob_tp_first: number | null;
  prob_sl_first: number | null;
  prob_no_hit: number | null;
  p10: number[];
  p50: number[];
  p90: number[];
}

function isProbability(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1);
}

function isValidWorkerPrediction(value: unknown, horizon: number, numPaths: number): value is WorkerPrediction {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as Partial<WorkerPrediction>;
  const arrays = [result.p10, result.p50, result.p90];
  if (arrays.some(values => !Array.isArray(values) || values.length !== horizon + 1
    || values.some(price => typeof price !== 'number' || !Number.isFinite(price) || price <= 0))) return false;
  if (!Number.isFinite(result.current_price) || (result.current_price ?? 0) <= 0
    || result.horizon !== horizon || result.num_paths !== numPaths
    || !Number.isFinite(result.drift) || !Number.isFinite(result.volatility) || (result.volatility ?? -1) < 0
    || !['EXPANDING_VOLATILITY', 'CONTRACTING_VOLATILITY', 'STABLE_DRIFT', 'UNCERTAIN'].includes(String(result.regime))
    || !isProbability(result.prob_tp_first) || !isProbability(result.prob_sl_first) || !isProbability(result.prob_no_hit)) return false;
  if (result.p10?.[0] !== result.current_price || result.p50?.[0] !== result.current_price || result.p90?.[0] !== result.current_price) return false;
  for (let i = 0; i <= horizon; i++) {
    if ((result.p10?.[i] ?? Infinity) > (result.p50?.[i] ?? -Infinity)
      || (result.p50?.[i] ?? Infinity) > (result.p90?.[i] ?? -Infinity)) return false;
  }
  return true;
}
