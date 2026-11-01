import { describe, expect, it } from 'vitest';
import { ROLE_IDS } from '../../server/v2/contracts.js';
import { RoleRunner } from '../../server/v2/agents/runner.js';
import type { RoleId } from '../../server/v2/contracts.js';

describe('T1 model-backed operational office chat routing', () => {
  it('RoleRunner.chat executes typed provider caller without trading side effects', async () => {
    const calls: Array<{ role: RoleId; user: string; provider: string; model: string }> = [];
    const runner = new RoleRunner({
      researchHost: null as any,
      providerCaller: async (task) => {
        calls.push({ role: task.role, user: task.user, provider: task.provider, model: task.model });
        return `reply from ${task.role}`;
      },
      resolveAssignment: (role) => ({
        role,
        provider: 'mock',
        model: `mock-${role}-v1`,
        apiKey: '',
        provenOsSandbox: true
      })
    });

    const reply = await runner.chat({
      role: 'lead',
      prompt: 'status check',
      configVersion: 1,
      cycleId: 'cycle-test-1'
    });

    expect(reply).toBe('reply from lead');
    expect(calls).toHaveLength(1);
    expect(calls[0].role).toBe('lead');
    expect(calls[0].user).toBe('status check');
    expect(calls[0].model).toBe('mock-lead-v1');
    expect(runner.getAcceptedResult('cycle-test-1', 'lead', 'final')).toBeUndefined();
  });

  it('RoleRunner.chat supports all six canonical roles independently', async () => {
    const invokedRoles: RoleId[] = [];
    const runner = new RoleRunner({
      researchHost: null as any,
      providerCaller: async (task) => {
        invokedRoles.push(task.role);
        return `ack ${task.role}`;
      },
      resolveAssignment: (role) => ({
        role,
        provider: 'mock',
        model: `mock-${role}`,
        apiKey: '',
        provenOsSandbox: true
      })
    });

    for (const role of ROLE_IDS) {
      const res = await runner.chat({
        role,
        prompt: `hello ${role}`,
        configVersion: 1,
        cycleId: `cycle-${role}`
      });
      expect(res).toBe(`ack ${role}`);
    }

    expect(invokedRoles).toEqual(['lead', 'market', 'research', 'strategist', 'risk', 'execution']);
  });

  it('RoleRunner.chat propagates provider errors gracefully without crashing', async () => {
    const runner = new RoleRunner({
      researchHost: null as any,
      providerCaller: async () => {
        throw new Error('Upstream provider rate limited');
      },
      resolveAssignment: (role) => ({
        role,
        provider: 'mock',
        model: `mock-${role}`,
        apiKey: '',
        provenOsSandbox: true
      })
    });

    await expect(runner.chat({
      role: 'risk',
      prompt: 'assess portfolio risk',
      configVersion: 1,
      cycleId: 'cycle-risk-err'
    })).rejects.toThrow('Upstream provider rate limited');
  });
});
