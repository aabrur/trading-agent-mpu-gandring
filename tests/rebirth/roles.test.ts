import { describe, expect, it } from 'vitest';
import { ResearchHost } from '../../server/v2/research/host.js';
import {
  GROK_ROLE_ALIASES,
  ROLE_DEFINITIONS,
  buildRoleSystemPrompt,
  resolveCanonicalRole
} from '../../server/v2/agents/roles.js';
import {
  RoleRunner,
  satisfiesLeadProbabilityThreshold
} from '../../server/v2/agents/runner.js';
import type { RoleTask } from '../../server/v2/agents/runner.js';
import type { ProviderCaller } from '../../server/v2/agents/providers.js';

describe('T07 six-role integrity, task fencing, confidence scales and non-mock unavailability', () => {
  it('exactly_six_roles', () => {
    const ids = Object.keys(ROLE_DEFINITIONS);
    expect(ids).toEqual(['lead', 'market', 'research', 'strategist', 'risk', 'execution']);
    expect(ids).toHaveLength(6);
    expect(ids).not.toContain('jev');

    expect(resolveCanonicalRole('Head of Trading')).toBe('lead');
    expect(resolveCanonicalRole('Technical Market')).toBe('market');
    expect(resolveCanonicalRole('Macro Research')).toBe('research');
    expect(resolveCanonicalRole('Trading Systems')).toBe('strategist');
    expect(resolveCanonicalRole('Head of Risk')).toBe('risk');
    expect(resolveCanonicalRole('Execution Trader')).toBe('execution');
    expect(Object.keys(GROK_ROLE_ALIASES)).toHaveLength(6);

    for (const id of ids as Array<keyof typeof ROLE_DEFINITIONS>) {
      const prompt = buildRoleSystemPrompt(id);
      expect(prompt).toContain('Trading Agent Mpu Gandring');
      expect(prompt).not.toContain('\u2014');
    }
  });

  it('all_roles_can_use_applicable_host_tools', async () => {
    const host = new ResearchHost({
      readMarketSnapshot: async (symbol) => ({
        symbol,
        venue: 'bybit',
        category: 'linear',
        last: '69000',
        observedAt: 1_760_000_000_000
      }),
      readPortfolio: async (accountRef) => ({
        accountRef,
        balance: '1000',
        positions: []
      })
    });

    const caller: ProviderCaller = async (req) => {
      if (req.turn === 0) {
        return JSON.stringify({
          toolCalls: [
            req.role === 'execution' || req.role === 'risk'
              ? { name: 'get_portfolio', args: {} }
              : { name: 'get_market_snapshot', args: { symbol: 'BTCUSDT' } }
          ]
        });
      }
      if (req.role === 'risk') {
        return JSON.stringify({
          stance: 'LONG',
          decision: 'APPROVE',
          claimRefs: ['market:BTCUSDT'],
          contraryRefs: [],
          reasoning: 'Risk parameters match active Owner cap.',
          confidence: { value: 0.72, scale: 'probability_0_1' }
        });
      }
      return JSON.stringify({
        stance: 'LONG',
        claimRefs: ['market:BTCUSDT'],
        contraryRefs: [],
        reasoning: `Grounded observation from ${req.role}`,
        confidence:
          req.role === 'lead'
            ? { value: 0.78, scale: 'probability_0_1' }
            : req.role === 'strategist'
              ? { value: 84, scale: 'score_0_100' }
              : { value: 4, scale: 'ordinal_1_5' }
      });
    };

    const runner = new RoleRunner({
      researchHost: host,
      providerCaller: caller,
      resolveAssignment: (role) => ({
        provider: 'openai',
        model: `gpt-5-${role}`,
        apiKey: 'test-key-present'
      })
    });

    const roles = ['lead', 'market', 'research', 'strategist', 'risk', 'execution'] as const;
    for (const role of roles) {
      const task: RoleTask = {
        cycleId: 'cycle-tools-1',
        role,
        phase: 'observe',
        taskAttempt: 1,
        evidenceId: 'ev-100',
        configVersion: 1,
        accountRef: 'paper:default',
        route: 'LOCAL',
        deadlineAt: Date.now() + 30_000,
        symbol: 'BTCUSDT'
      };
      const result = await runner.run(task);
      expect(result.status).toBe('completed');
      expect(result.toolTraceIds.length).toBe(1);
      expect(result.provider).toBe('openai');
      expect(result.model).toBe(`gpt-5-${role}`);
      if (result.role === 'risk') {
        expect(result.decision).toBe('APPROVE');
      }
    }
  });

  it('model_change_applies_next_task', async () => {
    let activeModel = 'grok-3';
    let activeProvider = 'xai';

    const runner = new RoleRunner({
      providerCaller: async () =>
        JSON.stringify({
          stance: 'HOLD',
          claimRefs: ['ev-1'],
          contraryRefs: [],
          reasoning: 'No confirmed break.',
          confidence: { value: 3, scale: 'ordinal_1_5' }
        }),
      resolveAssignment: () => ({
        provider: activeProvider,
        model: activeModel,
        apiKey: 'configured-key'
      })
    });

    const first = await runner.run({
      cycleId: 'cycle-model-1',
      role: 'market',
      phase: 'observe',
      taskAttempt: 1,
      evidenceId: 'ev-1',
      configVersion: 1,
      accountRef: 'paper:default',
      route: 'LOCAL',
      deadlineAt: Date.now() + 10_000
    });
    expect(first.provider).toBe('xai');
    expect(first.model).toBe('grok-3');

    activeProvider = 'anthropic';
    activeModel = 'claude-sonnet-4-5';

    const second = await runner.run({
      cycleId: 'cycle-model-2',
      role: 'market',
      phase: 'observe',
      taskAttempt: 1,
      evidenceId: 'ev-2',
      configVersion: 2,
      accountRef: 'paper:default',
      route: 'LOCAL',
      deadlineAt: Date.now() + 10_000
    });
    expect(second.provider).toBe('anthropic');
    expect(second.model).toBe('claude-sonnet-4-5');
  });

  it('cancellation_discards_late_result', async () => {
    let releaseAttempt1: (() => void) | null = null;
    const runner = new RoleRunner({
      providerCaller: async (req) => {
        if (req.taskAttempt === 1) {
          await new Promise<void>((resolve) => {
            releaseAttempt1 = resolve;
            req.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
        }
        return JSON.stringify({
          stance: req.taskAttempt === 1 ? 'LONG' : 'SHORT',
          claimRefs: [`attempt-${req.taskAttempt}`],
          contraryRefs: [],
          reasoning: `Attempt ${req.taskAttempt}`,
          confidence: { value: 0.65, scale: 'probability_0_1' }
        });
      },
      resolveAssignment: () => ({
        provider: 'openai',
        model: 'gpt-5',
        apiKey: 'key-1'
      })
    });

    const abort1 = new AbortController();
    const p1 = runner.run(
      {
        cycleId: 'cycle-cancel-1',
        role: 'lead',
        phase: 'final',
        taskAttempt: 1,
        evidenceId: 'ev-cancel',
        configVersion: 1,
        accountRef: 'paper:default',
        route: 'LOCAL',
        deadlineAt: Date.now() + 30_000
      },
      abort1.signal
    );

    const p2 = runner.run({
      cycleId: 'cycle-cancel-1',
      role: 'lead',
      phase: 'final',
      taskAttempt: 2,
      evidenceId: 'ev-cancel',
      configVersion: 1,
      accountRef: 'paper:default',
      route: 'LOCAL',
      deadlineAt: Date.now() + 30_000
    });

    abort1.abort();
    releaseAttempt1?.();

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.status).toBe('cancelled');
    expect(r1.stance).toBeNull();
    expect(r2.status).toBe('completed');
    expect(r2.stance).toBe('SHORT');
    expect(runner.getAcceptedResult('cycle-cancel-1', 'lead', 'final')?.taskAttempt).toBe(2);
  });

  it('no_key_is_unavailable_not_mock', async () => {
    let callerInvoked = false;
    const runner = new RoleRunner({
      providerCaller: async () => {
        callerInvoked = true;
        return '{}';
      },
      resolveAssignment: () => ({
        provider: 'xai',
        model: 'grok-3',
        apiKey: null
      })
    });

    const res = await runner.run({
      cycleId: 'cycle-nokey-1',
      role: 'strategist',
      phase: 'observe',
      taskAttempt: 1,
      evidenceId: 'ev-nokey',
      configVersion: 1,
      accountRef: 'paper:default',
      route: 'LOCAL',
      deadlineAt: Date.now() + 10_000
    });

    expect(callerInvoked).toBe(false);
    expect(res.status).toBe('unavailable');
    expect(res.stance).toBeNull();
    expect(res.provider).toBe('xai');
    expect(res.errorReason).toMatch(/missing|unconfigured|api key/i);
  });

  it('ordinal_confidence_is_not_probability', () => {
    const grokTmOrdinal = {
      value: 5,
      scale: 'ordinal_1_5' as const,
      source: 'grok:market',
      availability: 'AVAILABLE' as const,
      reason: null
    };
    const tsScore = {
      value: 92,
      scale: 'score_0_100' as const,
      source: 'local:strategist',
      availability: 'AVAILABLE' as const,
      reason: null
    };
    const leadProb = {
      value: 0.74,
      scale: 'probability_0_1' as const,
      source: 'local:lead',
      availability: 'AVAILABLE' as const,
      reason: null
    };

    expect(grokTmOrdinal.value).toBe(5);
    expect(grokTmOrdinal.scale).toBe('ordinal_1_5');
    expect(satisfiesLeadProbabilityThreshold('market', grokTmOrdinal, 65)).toBe(false);
    expect(satisfiesLeadProbabilityThreshold('lead', grokTmOrdinal, 65)).toBe(false);
    expect(satisfiesLeadProbabilityThreshold('strategist', tsScore, 65)).toBe(false);
    expect(satisfiesLeadProbabilityThreshold('lead', tsScore, 65)).toBe(false);
    expect(satisfiesLeadProbabilityThreshold('lead', leadProb, 70)).toBe(true);
    expect(satisfiesLeadProbabilityThreshold('lead', leadProb, 80)).toBe(false);
  });
});
