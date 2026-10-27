import { describe, expect, it, vi } from 'vitest';
import { JevService, localHeuristicEvaluation } from '../server/decision/jev.js';
import { recordFromResult, interpretAnswers } from '../server/decision/evaluation.js';
import type { Question } from '../server/decision/schemas.js';

const env = { JEV_ENABLED: 'true', JEV_MODE: 'assist', OPENROUTER_API_KEY: 'fixture-only-jev-key' };
const questions: Record<string, Question> = { market_regime: { type: 'choice', instructions: 'Classify measured regime.', criteria: { TREND_UP: 'Trend up', RANGING: 'Range' } } };
const state = { indicators: { rsi: 60, change24hPct: 3, last: 100, atr: 1, volumeRatio: 1.1 } };

describe('JEV evidence provenance', () => {
  it('keeps a heuristic response usable without claiming remote success or tokens', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 401 }));
    const service = new JevService(env, 'PAPER', fetchImpl);
    const result = await service.evaluate(state, questions);
    expect(result).toMatchObject({ ok: true, health: 'AUTH_ERROR', origin: 'heuristic', evaluatedOrigin: 'heuristic', fallback: true, error: 'Jev HTTP 401' });
    expect(result.response?.usage).toBeUndefined();
    expect(service.metrics).toMatchObject({ requests: 1, success: 0, errors: 1, fallbacks: 1, cacheHits: 0, lastInputTokens: null, lastCost: null });
    expect(service.status().health).toBe('AUTH_ERROR');
    const record = recordFromResult('pre', result, interpretAnswers(result.response));
    expect(record).toMatchObject({ origin: 'heuristic', fallback: true, inputTokens: null, cost: null });
    const cached = await service.evaluate(state, questions);
    expect(cached).toMatchObject({ origin: 'cache', evaluatedOrigin: 'heuristic', fallback: true, cached: true });
    expect(service.metrics).toMatchObject({ requests: 1, success: 0, errors: 1, fallbacks: 1, cacheHits: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('counts remote evaluation success separately from cache reuse', async () => {
    const body = { model: 'typesafe/jev-fixture', answers: { market_regime: { type: 'choice', choice: 'TREND_UP', probabilities: { TREND_UP: 0.7 }, confidence: 0.7 } }, usage: { input_tokens: 123, cost: 0.0001 } };
    const service = new JevService(env, 'PAPER', vi.fn(async () => new Response(JSON.stringify(body))));
    expect(await service.evaluate(state, questions)).toMatchObject({ ok: true, origin: 'remote', evaluatedOrigin: 'remote', fallback: false });
    expect(await service.evaluate(state, questions)).toMatchObject({ origin: 'cache', evaluatedOrigin: 'remote', fallback: false });
    expect(service.metrics).toMatchObject({ requests: 1, success: 1, errors: 0, fallbacks: 0, cacheHits: 1, lastInputTokens: 123, lastCost: 0.0001 });
  });

  it('does not invent usage for a local-only calculation', () => {
    expect(localHeuristicEvaluation(state, questions)?.usage).toBeUndefined();
  });
});
