import { afterEach, describe, expect, it, vi } from 'vitest';
import { DecisionsRequestSchema, DecisionsResponseSchema, JEV_ENDPOINT, JEV_MODEL } from '../server/decision/schemas.js';
import { JevService, loadJevSettings, resolveJevKey, sanitizeJevState, submitDecisions } from '../server/decision/jev.js';

const questions = {
  regime: {
    type: 'choice' as const,
    instructions: 'Classify the market regime from the supplied indicators only.',
    criteria: {
      TREND_UP: 'Price making higher highs with trend support',
      TREND_DOWN: 'Price making lower lows with trend pressure',
      RANGING: 'Oscillating without a clear break',
      BREAKOUT: 'Leaving a well-defined range',
      VOLATILE: 'Unusually wide range relative to recent history',
      UNCERTAIN: 'Not enough clean evidence'
    }
  }
};

const okBody = {
  model: 'typesafe/jev-1.14-20261001',
  answers: {
    regime: { type: 'choice', choice: 'RANGING', probabilities: { RANGING: 0.7, UNCERTAIN: 0.3 }, confidence: 0.55 }
  },
  usage: { input_tokens: 400, output_tokens: 20, cost: 0.00002 },
  id: 'gen-dec-test',
  provider: 'TypeSafe'
};

describe('Jev request and response schemas', () => {
  it('accepts a typed Decisions API request', () => {
    const parsed = DecisionsRequestSchema.safeParse({ model: JEV_MODEL, state: { rsi: 51 }, questions });
    expect(parsed.success).toBe(true);
  });
  it('accepts a typed Decisions API response', () => {
    expect(DecisionsResponseSchema.safeParse(okBody).success).toBe(true);
  });
  it('rejects a chat-completions shaped payload', () => {
    expect(DecisionsResponseSchema.safeParse({ choices: [{ message: { content: '{}' } }] }).success).toBe(false);
  });
});

describe('Jev BYOK and disabled behavior', () => {
  it('reuses OPENROUTER_API_KEY when no dedicated Jev key is set', () => {
    expect(resolveJevKey({ OPENROUTER_API_KEY: 'or-shared' }).source).toBe('openrouter');
    expect(resolveJevKey({ OPENROUTER_API_KEY: 'or-shared', JEV_OPENROUTER_API_KEY: 'or-jev' }).source).toBe('jev');
    expect(resolveJevKey({}).source).toBe('none');
  });
  it('stays disabled by default and does not invent a live connection', () => {
    const s = loadJevSettings({ TRADING_MODE: 'PAPER' }, 'PAPER');
    expect(s.enabled).toBe(false);
    expect(s.effectiveMode).toBe('off');
    expect(s.health).toBe('DISABLED');
    expect(s.model).toBe(JEV_MODEL);
    expect(s.provider).toBe('openrouter');
  });
  it('does not auto-promote ASSIST onto LIVE', () => {
    const s = loadJevSettings({ JEV_ENABLED: 'true', JEV_MODE: 'assist', OPENROUTER_API_KEY: 'k' }, 'LIVE');
    expect(s.mode).toBe('assist');
    expect(s.effectiveMode).toBe('shadow');
    expect(loadJevSettings({ JEV_ENABLED: 'true', JEV_MODE: 'assist', JEV_ALLOW_LIVE: 'yes', OPENROUTER_API_KEY: 'k' }, 'LIVE').effectiveMode).toBe('assist');
  });
  it('strips credential-shaped fields from state', () => {
    const cleaned = sanitizeJevState({ rsi: 40, OPENROUTER_API_KEY: 'sk-or-v1-secretvalue', nested: { apiKey: 'abc' } }) as Record<string, unknown>;
    expect(JSON.stringify(cleaned)).not.toContain('sk-or-v1-secretvalue');
    expect(cleaned.rsi).toBe(40);
  });
});

describe('Jev HTTP adapter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('posts the Decisions API shape to OpenRouter and does not use chat completions', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(JEV_ENDPOINT);
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe(JEV_MODEL);
      expect(body.questions.regime.type).toBe('choice');
      expect(body).not.toHaveProperty('messages');
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe('Bearer or-key');
      return new Response(JSON.stringify(okBody), { status: 200 });
    });
    const settings = loadJevSettings({ JEV_ENABLED: 'true', OPENROUTER_API_KEY: 'or-key' }, 'PAPER');
    const result = await submitDecisions({ settings, key: 'or-key', state: { rsi: 51 }, questions, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.ok).toBe(true);
    expect(result.response?.answers.regime).toMatchObject({ type: 'choice', choice: 'RANGING' });
    expect(result.response?.usage?.cost).toBe(0.00002);
  });

  it('maps auth, rate-limit, timeout, malformed, missing-key and disabled states', async () => {
    const settings = loadJevSettings({ JEV_ENABLED: 'true', OPENROUTER_API_KEY: 'k' }, 'PAPER');
    const http = async (status: number, body = '{}') => submitDecisions({
      settings, key: 'k', state: {}, questions, fetchImpl: (async () => new Response(body, { status })) as unknown as typeof fetch
    });
    expect((await http(401)).health).toBe('AUTH_ERROR');
    expect((await http(429)).health).toBe('RATE_LIMITED');
    expect((await http(200, '{"nope":true}')).health).toBe('PROVIDER_ERROR');
    expect((await submitDecisions({ settings: loadJevSettings({}, 'PAPER'), key: '', state: {}, questions })).health).toBe('DISABLED');
    expect((await submitDecisions({ settings, key: '', state: {}, questions })).health).toBe('MISSING_KEY');

    const aborting = async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    };
    expect((await submitDecisions({ settings, key: 'k', state: {}, questions, fetchImpl: aborting as unknown as typeof fetch })).health).toBe('TIMEOUT');
  });

  it('does not send a network request when Jev is disabled', async () => {
    const fetchImpl = vi.fn();
    const svc = new JevService({ JEV_ENABLED: 'false', OPENROUTER_API_KEY: 'or-secret-value-xyz' }, 'PAPER', fetchImpl as unknown as typeof fetch);
    const result = await svc.evaluate({ rsi: 1 }, questions);
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    const json = JSON.stringify(svc.status());
    expect(json).not.toContain('or-secret-value-xyz');
  });

  it('prefers the dedicated Jev OpenRouter key over the shared key', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer dedicated-jev-key');
      return new Response(JSON.stringify(okBody), { status: 200 });
    });
    const svc = new JevService({ JEV_ENABLED: 'true', OPENROUTER_API_KEY: 'shared-or-key', JEV_OPENROUTER_API_KEY: 'dedicated-jev-key' }, 'PAPER', fetchImpl as unknown as typeof fetch);
    const result = await svc.testConnection();
    expect(result.ok).toBe(true);
    expect(JSON.stringify(svc.status())).not.toContain('dedicated-jev-key');
    expect(JSON.stringify(svc.status())).not.toContain('shared-or-key');
  });
});
