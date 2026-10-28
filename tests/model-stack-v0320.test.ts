import { describe, expect, it } from 'vitest';
import { MODEL_CHOICES, MODEL_PRESETS, modelChoices } from '../server/setup/models.js';
import {
  supportsStrictJsonSchema,
  getGenerationParams,
  getTaskJsonSchema
} from '../server/providers/capabilities.js';
import { runAgent } from '../server/agents/run.js';
import { loadConfig } from '../server/config.js';
import { runStackBenchmark, parseArgs } from '../cli/bench-models.js';

describe('Frontier Model Stack & Capabilities (v0.0.0.3.20)', () => {
  it('includes verified October 2026 frontier models in openrouter choices', () => {
    const openrouterModels = MODEL_CHOICES.openrouter.map((m) => m.id);
    const expectedModels = [
      'anthropic/claude-opus-5.5',
      'anthropic/claude-sonnet-5.5',
      'anthropic/claude-haiku-5.5',
      'openai/gpt-6.1-sol',
      'openai/gpt-6-luna',
      'google/gemini-4-argon',
      'deepseek/deepseek-v4.1-flash',
      'deepseek/deepseek-v4.1-flash-1017',
      'z-ai/glm-5.3',
      'z-ai/glm-5.3-flash',
      'moonshotai/kimi-k3',
      'xiaomi/mimo-v2.6-flash',
      'minimax/minimax-m3.1-flash',
      'stepfun/step-5-preview'
    ];

    for (const expected of expectedModels) {
      expect(openrouterModels).toContain(expected);
    }
  });

  it('exposes well-formed performance_first and cost_optimized presets', () => {
    expect(MODEL_PRESETS.length).toBeGreaterThanOrEqual(2);

    const perf = MODEL_PRESETS.find((p) => p.id === 'performance_first');
    expect(perf).toBeDefined();
    expect(perf?.defaultProvider).toBe('openrouter');
    expect(perf?.agents.lead.model).toBe('anthropic/claude-opus-5.5');
    expect(perf?.agents.market.model).toBe('anthropic/claude-sonnet-5.5');
    expect(perf?.agents.risk.model).toBe('anthropic/claude-haiku-5.5');

    const cost = MODEL_PRESETS.find((p) => p.id === 'cost_optimized');
    expect(cost).toBeDefined();
    expect(cost?.defaultProvider).toBe('openrouter');
    expect(cost?.agents.lead.model).toBe('anthropic/claude-sonnet-5.5');
    expect(cost?.agents.market.model).toBe('deepseek/deepseek-v4.1-flash');
    expect(cost?.agents.risk.model).toBe('anthropic/claude-haiku-5.5');
  });

  it('generates strict json_schema for supporting frontier models', () => {
    expect(supportsStrictJsonSchema('openrouter', 'anthropic/claude-opus-5.5')).toBe(true);
    expect(supportsStrictJsonSchema('openrouter', 'openai/gpt-6.1-sol')).toBe(true);
    expect(supportsStrictJsonSchema('openrouter', 'google/gemini-4-argon')).toBe(true);
    expect(supportsStrictJsonSchema('openrouter', 'deepseek/deepseek-v4.1-flash')).toBe(true);
    expect(supportsStrictJsonSchema('openai', 'gpt-6.1-sol')).toBe(true);

    const params = getGenerationParams('lead', 'lead', 'openrouter', 'anthropic/claude-opus-5.5');
    expect(params.responseFormat?.type).toBe('json_schema');
    if (params.responseFormat && params.responseFormat.type === 'json_schema') {
      expect(params.responseFormat.json_schema.strict).toBe(true);
      expect(params.responseFormat.json_schema.name).toBe('mpu_lead');
      expect(params.responseFormat.json_schema.schema).toBeDefined();
    }
  });

  it('omits temperature for reasoning models and configures reasoning effort', () => {
    const claudeParams = getGenerationParams('lead', 'lead', 'openrouter', 'anthropic/claude-opus-5.5');
    expect(claudeParams.temperature).toBeUndefined();
    expect(claudeParams.reasoningEffort).toBe('high');

    const gptParams = getGenerationParams('strategist', 'lead', 'openai', 'gpt-6.1-sol');
    expect(gptParams.temperature).toBeUndefined();
    expect(gptParams.reasoningEffort).toBe('medium');

    const standardParams = getGenerationParams('market', 'opinion', 'openrouter', 'deepseek/deepseek-v4.1-flash');
    expect(standardParams.temperature).toBe(0.2);
  });

  it('produces strict OpenAI-compliant JSON schemas with root type object and complete required arrays', () => {
    const tasks = ['opinion', 'research', 'rebuttal', 'lead', 'risk', 'review', 'chat'] as const;
    for (const task of tasks) {
      const schema = getTaskJsonSchema(task) as {
        type?: string;
        properties?: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
        anyOf?: unknown[];
        oneOf?: unknown[];
      };
      expect(schema).toBeDefined();
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
      expect(schema.anyOf).toBeUndefined();
      expect(schema.oneOf).toBeUndefined();
      expect(schema.properties).toBeDefined();
      expect(schema.required).toBeDefined();

      // In strict mode, every property key must be declared in required
      const propKeys = Object.keys(schema.properties ?? {});
      for (const key of propKeys) {
        expect(schema.required).toContain(key);
      }
    }

    // Explicit check for risk schema
    const riskSchema = getTaskJsonSchema('risk') as any;
    expect(riskSchema.type).toBe('object');
    expect(riskSchema.required).toEqual(['decision', 'sizeFactor', 'leverage', 'stopPct', 'reason']);

    // Explicit check for chat schema
    const chatSchema = getTaskJsonSchema('chat') as any;
    expect(chatSchema.type).toBe('object');
    expect(chatSchema.required).toEqual(['reply', 'commandToExecute', 'askTeammates', 'askTeammate']);
  });

  it('captures failureKind on schema parse failure vs provider network error', async () => {
    const cfg = loadConfig({
      TRADING_MODE: 'PAPER',
      AGENT_LEAD_PROVIDER: 'mock',
      AGENT_LEAD_MODEL: 'mock-desk-v1'
    });

    // Case 1: Schema parse failure
    const schemaFailCaller = async () => JSON.stringify({ invalid: 'field', unexpected: 123 });
    const schemaRes = await runAgent(cfg, schemaFailCaller, 'lead', 'lead', {
      instruction: 'Test schema failure',
      data: {},
      context: {}
    });
    expect(schemaRes.fallback).toBe(true);
    expect(schemaRes.failureKind).toBe('schema');
    expect(schemaRes.lastError).toBeDefined();

    // Case 2: Timeout error
    const timeoutCaller = async () => {
      throw new Error('Connection timeout while contacting upstream API');
    };
    const timeoutRes = await runAgent(cfg, timeoutCaller, 'lead', 'lead', {
      instruction: 'Test timeout failure',
      data: {},
      context: {}
    });
    expect(timeoutRes.fallback).toBe(true);
    expect(timeoutRes.failureKind).toBe('timeout');
    expect(timeoutRes.lastError).toContain('Connection timeout');

    // Case 3: Provider upstream 500 error
    const providerFailCaller = async () => {
      throw new Error('Upstream API server returned HTTP 500 internal error');
    };
    const providerRes = await runAgent(cfg, providerFailCaller, 'lead', 'lead', {
      instruction: 'Test provider failure',
      data: {},
      context: {}
    });
    expect(providerRes.fallback).toBe(true);
    expect(providerRes.failureKind).toBe('provider');
    expect(providerRes.lastError).toContain('HTTP 500');
  });

  it('benchmarks all six agents with dry-run and calculates true directional consensus', async () => {
    // Should throw if not dry-run and no budget
    await expect(runStackBenchmark('performance', false, 0)).rejects.toThrow(
      /explicit --budget-usd > 0/
    );

    // Dry run should execute all 6 desk agents
    const metrics = await runStackBenchmark('performance', true, 0);
    expect(metrics.stack).toBe('performance');
    expect(metrics.totalCalls).toBe(6);
    expect(metrics.validJsonCount).toBe(6);
    expect(metrics.schemaCompliantCount).toBe(6);
    expect(metrics.directionalAgreementPct).toBe(100);
    expect(metrics.retriesCount).toBe(0);
    expect(metrics.budgetExceeded).toBe(false);

    // Verify consensus calculation when all agents vote SHORT
    const shortCaller = async (req: any) => {
      if (req.task === 'opinion') return JSON.stringify({ stance: 'SHORT', confidence: 0.9, argument: 'Bearish divergence.' });
      if (req.task === 'research') return JSON.stringify({ vote: 'SHORT', confidence: 0.85, argument: 'Heavy distribution.', sources: ['whales'] });
      if (req.task === 'lead') return JSON.stringify({ action: 'OPEN_SHORT', confidence: 0.9, reason: 'Trend reversal.' });
      if (req.task === 'risk_assessment') return JSON.stringify({ decision: 'APPROVE', sizeFactor: 1, leverage: 5, stopPct: 2, reason: 'Controlled risk.' });
      return JSON.stringify({ reply: 'Short bias noted.' });
    };

    const shortMetrics = await runStackBenchmark('cost', true, 0, shortCaller);
    expect(shortMetrics.directionalAgreementPct).toBe(100);
  });

  it('enforces hard budget ceiling in benchmark runner', async () => {
    // A live caller with a micro-budget of 0.000001 USD must halt before completing all tasks
    const dummyCaller = async () => JSON.stringify({ stance: 'LONG', confidence: 0.8, argument: 'Test' });
    const tightBudgetMetrics = await runStackBenchmark('cost', false, 0.000001, dummyCaller);
    expect(tightBudgetMetrics.budgetExceeded).toBe(true);
    expect(tightBudgetMetrics.totalCalls).toBe(6);
    expect(tightBudgetMetrics.validJsonCount).toBeLessThan(6);
  });

  it('parses bench CLI arguments correctly', () => {
    const args = parseArgs(['--stack', 'performance', '--budget-usd', '5', '--dry-run', '--fixtures', 'data/sample/news.json', '--json']);
    expect(args.stack).toBe('performance');
    expect(args.budgetUsd).toBe(5);
    expect(args.dryRun).toBe(true);
    expect(args.fixtures).toBe('data/sample/news.json');
    expect(args.json).toBe(true);
  });
});
