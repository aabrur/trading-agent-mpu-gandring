import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';

describe('Isolated Python Kronos Worker (workers/kronos/worker.py)', () => {
  const workerScript = path.resolve(__dirname, '..', 'workers', 'kronos', 'worker.py');

  it('worker script exists at workers/kronos/worker.py', () => {
    expect(existsSync(workerScript)).toBe(true);
  });

  it('runs python worker self-test successfully', () => {
    const out = execFileSync('python', [workerScript, '--test'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(out).toContain('PASS: local GBM worker self-test passed.');
  });

  it('accepts stdio JSON input and returns structured prediction payload', () => {
    const inputPayload = JSON.stringify({
      candles: [
        { t: 1, c: 100 },
        { t: 2, c: 102 },
        { t: 3, c: 101 },
        { t: 4, c: 103 },
        { t: 5, c: 105 },
      ],
      horizon: 5,
      num_paths: 100,
      seed: 41,
      side: 'SHORT',
      tp_price: 98,
      sl_price: 110,
    });

    const out = execFileSync('python', [workerScript], {
      input: inputPayload,
      encoding: 'utf8',
      timeout: 10_000,
    });

    const parsed = JSON.parse(out);
    const repeated = execFileSync('python', [workerScript], {
      input: inputPayload,
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(JSON.parse(repeated)).toEqual(parsed);
    expect(parsed).toHaveProperty('current_price', 105);
    expect(parsed).toHaveProperty('p10');
    expect(parsed).toHaveProperty('p50');
    expect(parsed).toHaveProperty('p90');
    expect(parsed.p10.length).toBe(6);
    expect(parsed.p50.length).toBe(6);
    expect(parsed.p90.length).toBe(6);
    expect(parsed.p10[5]).toBeLessThanOrEqual(parsed.p50[5]);
    expect(parsed.p50[5]).toBeLessThanOrEqual(parsed.p90[5]);
    expect(parsed.prob_tp_first).toBeGreaterThanOrEqual(0);
    expect(parsed.prob_tp_first).toBeLessThanOrEqual(1);
    expect(parsed.prob_tp_first + parsed.prob_sl_first + parsed.prob_no_hit).toBeCloseTo(1, 3);
  });
});
