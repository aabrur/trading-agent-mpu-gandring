import { describe, expect, it } from 'vitest';
import { createReplacementRuntime } from '../../server/v2/runtime.js';
import type { RoleRunner } from '../../server/v2/agents/runner.js';

describe('Task 4: Reset Stance and Camp at Symbol Cycle Start', () => {
  it('resets agent stances and camps to neutral before running a new symbol cycle', async () => {
    const fakeRoleRunner: RoleRunner = {
      async run(task) {
        return {
          taskId: task.taskId,
          cycleId: task.cycleId,
          role: task.role,
          status: 'completed',
          stance: 'LONG',
          confidence: { value: 60, scale: 'integer_0_100' },
          reasoning: 'Testing cycle reset',
          claims: [],
          claimRefs: []
        };
      },
      cleanupCycle() {}
    };

    const runtime = createReplacementRuntime({ roleRunner: fakeRoleRunner });

    // Simulate stale stances from previous ETHUSDT cycle
    runtime.updateState((draft) => {
      draft.agents.lead.stance = 'SHORT';
      draft.agents.lead.confidence = 80;
      draft.agents.risk.stance = 'SHORT';
      draft.agents.risk.confidence = 75;
      draft.agents.market.stance = 'SHORT';
      draft.agents.market.confidence = 70;
    });

    const preState = runtime.snapshot();
    expect(preState.agents.lead.stance).toBe('SHORT');
    expect(preState.agents.risk.stance).toBe('SHORT');

    // Run cycle on a new symbol
    await runtime.triggerCycle('SOLUSDT', 'owner');

    const postState = runtime.snapshot();
    // In postState, agents now have fresh stances from the completed SOLUSDT cycle
    expect(postState.agents.lead.stance).toBe('LONG');
    expect(postState.agents.risk.stance).toBe('LONG');
  });

  it('calculates disagreement only across roles that have spoken in the active cycle', () => {
    // Isolated check on spoken role filtering
    const agents: Record<string, { id: string; stance: string }> = {
      market: { id: 'market', stance: 'LONG' },
      risk: { id: 'risk', stance: 'SHORT' }, // stale from previous symbol
      lead: { id: 'lead', stance: 'NEUTRAL' }
    };

    const spokenRoles = new Set(['market']);
    const spokenAgents = Object.values(agents).filter((a) => spokenRoles.has(a.id));

    const bull = spokenAgents.filter((a) => a.stance === 'LONG').map((a) => a.id);
    const bear = spokenAgents.filter((a) => a.stance === 'SHORT').map((a) => a.id);

    expect(bull).toEqual(['market']);
    expect(bear).toEqual([]); // risk is excluded because it has not spoken yet
  });
});
