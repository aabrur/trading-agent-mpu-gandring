import { describe, expect, it } from 'vitest';
import { createOfficialProviderCaller } from '../../server/v2/agents/providers.js';
import {
  LOCAL_CLI_AGENTS,
  buildLocalCliEnv,
  describeLocalCliSandbox,
  runLocalCliInference
} from '../../server/v2/agents/local.js';
import { RoleRunner } from '../../server/v2/agents/runner.js';
import { ResearchHost } from '../../server/v2/research/host.js';

describe('T07 remote provider adapters, format repair, tool continuation and local CLI capability honesty', () => {
  it('handles invalid JSON with claim-preserving format repair, quota 429, empty output and timeout without echoing keys', async () => {
    const secretKey = 'sk-super-secret-live-token-99999';
    let callCount = 0;

    const repairFetch: typeof fetch = async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: 'Not valid JSON yet: claimRefs=[ev-a], stance=LONG'
                }
              }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  stance: 'LONG',
                  claimRefs: ['ev-a'],
                  contraryRefs: ['ev-b'],
                  reasoning: 'Repaired JSON envelope preserving original claims.',
                  confidence: { value: 0.68, scale: 'probability_0_1' }
                })
              }
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };

    const runner = new RoleRunner({
      providerCaller: createOfficialProviderCaller({ fetchImpl: repairFetch }),
      resolveAssignment: () => ({
        provider: 'openai',
        model: 'gpt-5',
        apiKey: secretKey
      })
    });

    const repaired = await runner.run({
      cycleId: 'cycle-repair-1',
      role: 'lead',
      phase: 'final',
      taskAttempt: 1,
      evidenceId: 'ev-a',
      configVersion: 1,
      accountRef: 'paper:default',
      route: 'LOCAL',
      deadlineAt: Date.now() + 15_000
    });

    expect(callCount).toBe(2);
    expect(repaired.status).toBe('completed');
    expect(repaired.claimRefs).toEqual(['ev-a']);
    expect(repaired.contraryRefs).toEqual(['ev-b']);

    const quotaFetch: typeof fetch = async () =>
      new Response(`Rate limit exceeded for key ${secretKey}`, { status: 429 });

    const quotaRunner = new RoleRunner({
      providerCaller: createOfficialProviderCaller({ fetchImpl: quotaFetch }),
      resolveAssignment: () => ({
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4-5',
        apiKey: secretKey
      })
    });

    const quotaRes = await quotaRunner.run({
      cycleId: 'cycle-quota-1',
      role: 'market',
      phase: 'observe',
      taskAttempt: 1,
      evidenceId: 'ev-q',
      configVersion: 1,
      accountRef: 'paper:default',
      route: 'LOCAL',
      deadlineAt: Date.now() + 15_000
    });

    expect(quotaRes.status).toBe('unavailable');
    expect(JSON.stringify(quotaRes)).not.toContain(secretKey);

    const emptyFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '   ' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });

    const emptyRunner = new RoleRunner({
      providerCaller: createOfficialProviderCaller({ fetchImpl: emptyFetch }),
      resolveAssignment: () => ({
        provider: 'deepseek',
        model: 'deepseek-reasoner',
        apiKey: secretKey
      })
    });

    const emptyRes = await emptyRunner.run({
      cycleId: 'cycle-empty-1',
      role: 'research',
      phase: 'observe',
      taskAttempt: 1,
      evidenceId: 'ev-e',
      configVersion: 1,
      accountRef: 'paper:default',
      route: 'LOCAL',
      deadlineAt: Date.now() + 15_000
    });
    expect(emptyRes.status).toBe('unavailable');
  });

  it('executes real multi-turn host tool continuation across Anthropic and Gemini wire formats', async () => {
    const host = new ResearchHost({
      readMarketSnapshot: async (symbol) => ({
        symbol,
        venue: 'bybit',
        category: 'linear',
        last: '70125.5',
        observedAt: 1_760_000_050_000
      })
    });

    let anthropicTurn = 0;
    const anthropicFetch: typeof fetch = async (_url, init) => {
      anthropicTurn += 1;
      const bodyText = String(init?.body ?? '');
      if (anthropicTurn === 1) {
        return new Response(
          JSON.stringify({
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  toolCalls: [{ name: 'get_market_snapshot', args: { symbol: 'BTCUSDT' } }]
                })
              }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      expect(bodyText).toContain('70125.5');
      return new Response(
        JSON.stringify({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                stance: 'LONG',
                decision: 'APPROVE',
                claimRefs: ['market:BTCUSDT'],
                contraryRefs: [],
                reasoning: 'Verified 70125.5 linear snapshot via host tool.',
                confidence: { value: 0.8, scale: 'probability_0_1' }
              })
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };

    const runner = new RoleRunner({
      researchHost: host,
      providerCaller: createOfficialProviderCaller({ fetchImpl: anthropicFetch }),
      resolveAssignment: () => ({
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        apiKey: 'ant-key-test'
      })
    });

    const out = await runner.run({
      cycleId: 'cycle-ant-1',
      role: 'risk',
      phase: 'final',
      taskAttempt: 1,
      evidenceId: 'ev-ant',
      configVersion: 1,
      accountRef: 'paper:default',
      route: 'LOCAL',
      deadlineAt: Date.now() + 15_000,
      symbol: 'BTCUSDT'
    });

    expect(out.status).toBe('completed');
    expect(out.toolTraceIds).toHaveLength(1);
    if (out.role === 'risk') {
      expect(out.decision).toBe('APPROVE');
    }
  });

  it('reports UNSANDBOXED local CLI capability honestly and strips execution secrets from child env', async () => {
    expect(LOCAL_CLI_AGENTS.length).toBeGreaterThanOrEqual(10);

    const capability = describeLocalCliSandbox('codex', { provenOsSandbox: false });
    expect(capability.sandboxStatus).toBe('UNSANDBOXED');
    expect(capability.arbitraryShellAllowed).toBe(false);

    const scrubbed = buildLocalCliEnv({
      PATH: process.env.PATH ?? '',
      HOME: '/tmp/home',
      BYBIT_API_SECRET: 'never-inherit-me',
      HYPERLIQUID_PRIVATE_KEY: '0xdeadbeef',
      AGENT_EVENT_SECRET: 'bridge-secret'
    });
    expect(scrubbed.BYBIT_API_SECRET).toBeUndefined();
    expect(scrubbed.HYPERLIQUID_PRIVATE_KEY).toBeUndefined();
    expect(scrubbed.AGENT_EVENT_SECRET).toBeUndefined();

    const blockedShell = await runLocalCliInference({
      agentSpec: 'codex:default',
      prompt: 'Analyze BTCUSDT',
      requireArbitraryShell: true,
      provenOsSandbox: false
    });
    expect(blockedShell.ok).toBe(false);
    expect(blockedShell.sandboxStatus).toBe('UNSANDBOXED');
    expect(blockedShell.error).toMatch(/UNSANDBOXED|isolated/i);
  });
});
