import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../server/config.js';
import { Desk } from '../server/desk.js';
import { makeCaller } from '../server/providers/index.js';
import { boundedPreState, interpretAnswers, jevMayEnrichAgents, preAnalysisQuestions } from '../server/decision/evaluation.js';

const okBody = {
  model: 'typesafe/jev-1.14-test',
  answers: {
    market_regime: { type: 'choice', choice: 'RANGING', probabilities: { RANGING: 0.8, UNCERTAIN: 0.2 }, confidence: 0.4 },
    news_relevant: { type: 'noul', noul: 0.2 },
    news_needs_research: { type: 'noul', noul: 0.1 },
    news_false_critical: { type: 'noul', noul: 0.7 },
    whale_significant: { type: 'noul', noul: 0.05 },
    material_conflict: { type: 'noul', noul: 0.1 }
  },
  usage: { input_tokens: 120, cost: 0.00001 }
};

describe('Jev intelligence bounds', () => {
  it('keeps pre-analysis state small and does not invent whale facts', () => {
    const state = boundedPreState({
      symbol: 'ETHUSDT',
      rsi: 51,
      news: [{ title: 'ETH upgrade rumor', evidenceStatus: 'REPORTED', freshness: 'fresh', category: 'upgrade' }],
      whale: [{ classification: 'unknown', usdValueOrNull: null, confirmationStatus: 'unverified', attributionConfidence: 'unknown' }]
    });
    expect(state.whale[0].usdValueOrNull).toBeNull();
    expect(state.whale[0]).not.toHaveProperty('owner');
    expect(JSON.stringify(preAnalysisQuestions())).toContain('Do not invent');
  });

  it('reads typed answers without treating confidence as a trade probability', () => {
    const interp = interpretAnswers(okBody as never);
    expect(interp.marketRegime).toBe('RANGING');
    expect(interp.newsFalseCritical).toBe(0.7);
    expect(interp.confidence).toBe(0.4);
  });

  it('enriches agent context only in assist mode', () => {
    expect(jevMayEnrichAgents('shadow')).toBe(false);
    expect(jevMayEnrichAgents('off')).toBe(false);
    expect(jevMayEnrichAgents('assist')).toBe(true);
  });
});

describe('Jev shadow debate', () => {
  it('records Jev output without changing the baseline verdict or opening extra orders', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(okBody), { status: 200 }));
    const baseEnv = { TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEBATE_PACE_MS: '0' };
    const off = loadConfig(baseEnv);
    const deskOff = new Desk(off, makeCaller(off), { reportsDir: null, jevEnv: baseEnv });
    const baseline = await deskOff.runDebate('ETHUSDT');

    const env = { ...baseEnv, JEV_ENABLED: 'true', JEV_MODE: 'shadow', OPENROUTER_API_KEY: 'or-shadow-test-key' };
    const c = loadConfig(env);
    const desk = new Desk(c, makeCaller(c), { reportsDir: null, jevFetch: fetchImpl as unknown as typeof fetch, jevEnv: env });
    const v = await desk.runDebate('ETHUSDT');
    expect(v.action).toBe(baseline.action);
    expect(v.riskDecision).toBe(baseline.riskDecision);
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(0);
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(call[1]?.body));
    expect(body.questions.market_regime.type).toBe('choice');
    expect(JSON.stringify(body)).not.toContain('or-shadow-test-key');
    expect(desk.jevLast).toBeTruthy();
    expect(desk.snapshot().jev.mode).toBe('shadow');
    expect(desk.snapshot().jev.affectedContext).toBe(false);
  });

  it('does not call Jev when disabled and leaves debate behavior intact', async () => {
    const fetchImpl = vi.fn();
    const env = { TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEBATE_PACE_MS: '0' };
    const c = loadConfig(env);
    const desk = new Desk(c, makeCaller(c), { reportsDir: null, jevFetch: fetchImpl as unknown as typeof fetch, jevEnv: env });
    const v = await desk.runDebate('ETHUSDT');
    expect(['OPEN_LONG', 'OPEN_SHORT', 'CLOSE', 'HOLD']).toContain(v.action);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(desk.snapshot().jev.health).toBe('DISABLED');
  });
});
