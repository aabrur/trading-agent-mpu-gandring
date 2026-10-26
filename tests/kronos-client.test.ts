import { describe, expect, it, vi } from 'vitest';
import { KronosClient } from '../server/market/kronos-client.js';

describe('Non-Blocking Kronos Client with Circuit Breaker & Fail-Open Resilience', () => {
  const candles = [
    { t: 1, c: 100 },
    { t: 2, c: 102 },
    { t: 3, c: 104 },
  ];

  it('successfully processes worker response when worker is healthy', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        current_price: 104,
        horizon: 5,
        num_paths: 100,
        drift: 0.01,
        volatility: 0.02,
        regime: 'STABLE_DRIFT',
        prob_tp_first: 0.75,
        prob_sl_first: 0.15,
        prob_no_hit: 0.1,
        p10: [104, 103, 102, 101, 100, 99],
        p50: [104, 105, 106, 107, 108, 109],
        p90: [104, 107, 109, 112, 114, 116],
      }),
    });

    const client = new KronosClient({
      workerUrl: 'http://127.0.0.1:8181',
      fetchFn: mockFetch as any,
    });

    const result = await client.predict({ candles, horizon: 5, numPaths: 100 });
    expect(result.workerAvailable).toBe(true);
    expect(result.source).toBe('PYTHON_GBM_SIMULATION');
    expect(result.currentPrice).toBe(104);
    expect(result.probTpFirst).toBe(0.75);
    expect(result.probSlFirst).toBe(0.15);
    expect(result.probNoHit).toBe(0.1);
    expect(result.circuitState).toBe('CLOSED');
  });

  it('fails open to native statistical simulation without throwing when worker is unreachable', async () => {
    const mockFailingFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:8181'));

    const client = new KronosClient({
      workerUrl: 'http://127.0.0.1:8181',
      fetchFn: mockFailingFetch as any,
      maxFailures: 3,
    });

    // 1st failure: fail-open to native fallback
    const res1 = await client.predict({ candles, horizon: 5 });
    expect(res1.workerAvailable).toBe(false);
    expect(res1.source).toBe('LOCAL_GBM_SIMULATION');
    expect(res1.p50.length).toBe(6);
    expect(res1.currentPrice).toBe(104);

    // 2nd failure
    await client.predict({ candles, horizon: 5 });
    expect(client.getCircuitStatus().state).toBe('CLOSED');

    // 3rd failure: trips circuit to OPEN
    await client.predict({ candles, horizon: 5 });
    expect(client.getCircuitStatus().state).toBe('OPEN');

    // 4th call: circuit is OPEN, fails open immediately without calling fetch
    mockFailingFetch.mockClear();
    const res4 = await client.predict({ candles, horizon: 5 });
    expect(mockFailingFetch).not.toHaveBeenCalled();
    expect(res4.workerAvailable).toBe(false);
    expect(res4.circuitState).toBe('OPEN');
    expect(res4.source).toBe('LOCAL_GBM_SIMULATION');
  });

  it('recovers to HALF_OPEN after cooldown and closes upon worker recovery', async () => {
    let shouldSucceed = false;
    const dynamicFetch = vi.fn().mockImplementation(async () => {
      if (!shouldSucceed) throw new Error('Worker offline');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          current_price: 104,
          horizon: 10,
          num_paths: 200,
          drift: 0,
          volatility: 0.1,
          regime: 'STABLE_DRIFT',
          prob_tp_first: null,
          prob_sl_first: null,
          prob_no_hit: null,
          p10: Array.from({ length: 11 }, (_, index) => index === 0 ? 104 : 100 + index),
          p50: Array.from({ length: 11 }, (_, index) => 104 + index),
          p90: Array.from({ length: 11 }, (_, index) => 104 + index * 2),
        }),
      };
    });

    const client = new KronosClient({
      workerUrl: 'http://127.0.0.1:8181',
      fetchFn: dynamicFetch as any,
      maxFailures: 2,
      cooldownMs: 5_000,
    });

    const now = 1_000_000;
    // Trip circuit with 2 failures
    await client.predict({ candles }, now);
    await client.predict({ candles }, now);
    expect(client.getCircuitStatus(now).state).toBe('OPEN');

    // Before cooldown (+4s): remains OPEN
    expect(client.getCircuitStatus(now + 4_000).state).toBe('OPEN');

    // After cooldown (+6s): transitions to HALF_OPEN
    expect(client.getCircuitStatus(now + 6_000).state).toBe('HALF_OPEN');

    // Probe call succeeds
    shouldSucceed = true;
    const probeRes = await client.predict({ candles }, now + 6_000);
    expect(probeRes.workerAvailable).toBe(true);
    expect(probeRes.circuitState).toBe('CLOSED');
    expect(client.getCircuitStatus(now + 6_000).state).toBe('CLOSED');
  });

  it('sends seed and side and falls back on malformed worker output', async () => {
    const mockFetch = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      expect(request.seed).toBe(23);
      expect(request.side).toBe('SHORT');
      return { ok: true, status: 200, json: async () => ({ p10: [1], p50: [2], p90: [3] }) };
    });
    const client = new KronosClient({ fetchFn: mockFetch as unknown as typeof fetch });
    const result = await client.predict({ candles, seed: 23, side: 'SHORT', horizon: 2 });
    expect(result.workerAvailable).toBe(false);
    expect(result.source).toBe('LOCAL_GBM_SIMULATION');
    expect(result.p50).toHaveLength(3);
  });

  it('keeps the timeout active while the worker response body is being read', async () => {
    const mockFetch = vi.fn(async (_url: string, init: RequestInit) => ({
      ok: true,
      status: 200,
      json: () => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('body read aborted')));
      }),
    }));
    const client = new KronosClient({ timeoutMs: 5, fetchFn: mockFetch as unknown as typeof fetch });
    const result = await client.predict({ candles, horizon: 2, seed: 1 });

    expect(result.workerAvailable).toBe(false);
    expect(result.source).toBe('LOCAL_GBM_SIMULATION');
  });
});
