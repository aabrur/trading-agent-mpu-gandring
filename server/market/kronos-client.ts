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

import { simulateMonteCarlo, type MonteCarloForecast, type MonteCarloInput } from './monte-carlo.js';

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
  source: 'KRONOS_PYTHON_WORKER' | 'NATIVE_STATISTICAL_FALLBACK';
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
    const start = Date.now();
    const { state } = this.getCircuitStatus(now);

    // If circuit is OPEN, fail-open immediately to native statistical fallback without network delay
    if (state === 'OPEN') {
      const fallback = simulateMonteCarlo(input);
      return {
        ...fallback,
        workerAvailable: false,
        source: 'NATIVE_STATISTICAL_FALLBACK',
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
          tp_price: input.tpPrice,
          sl_price: input.slPrice,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        throw new Error(`Worker returned HTTP ${res.status}`);
      }

      const data = await res.json() as any;
      if (!Array.isArray(data.p50) || data.p50.length === 0) {
        throw new Error('Malformed prediction payload from worker');
      }

      // Success: reset failures and close circuit
      this.circuitState = 'CLOSED';
      this.failureCount = 0;

      return {
        currentPrice: data.current_price ?? (data.p50[0] || 0),
        horizon: data.horizon ?? input.horizon ?? 10,
        numPaths: data.num_paths ?? input.numPaths ?? 200,
        drift: data.drift ?? 0,
        volatility: data.volatility ?? 0,
        regime: data.regime ?? 'STABLE_DRIFT',
        probTpFirst: data.prob_tp_first ?? 0.5,
        expectedReturnPct: Number((((data.p50[data.p50.length - 1] - data.p50[0]) / (data.p50[0] || 1)) * 100).toFixed(2)),
        p10: data.p10,
        p50: data.p50,
        p90: data.p90,
        workerAvailable: true,
        source: 'KRONOS_PYTHON_WORKER',
        latencyMs: Date.now() - start,
        circuitState: 'CLOSED',
      };
    } catch (err: any) {
      clearTimeout(timeoutId);

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
        source: 'NATIVE_STATISTICAL_FALLBACK',
        latencyMs: Date.now() - start,
        circuitState: this.circuitState,
      };
    }
  }
}
