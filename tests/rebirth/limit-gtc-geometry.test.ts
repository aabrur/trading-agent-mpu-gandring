import { describe, expect, it } from 'vitest';
import {
  CycleRunner
} from '../../server/v2/decision/cycle.js';
import type { RoleRunner } from '../../server/v2/agents/runner.js';

describe('Task 2: SL/TP Geometry Recalculation for LIMIT_GTC', () => {
  it('recalculates stop and take profit from limitPrice when switching from MARKET to LIMIT_GTC', async () => {
    // Market last: 1.2779
    // Profile: 40% ROE stop, 60% ROE TP at 20x leverage
    // price stop = 2%, price tp = 3%
    // Market SL: 1.2779 * 1.02 = 1.3035 (SHORT)
    // Market TP: 1.2779 * 0.97 = 1.2396 (SHORT)
    // When Lead / Execution changes entry to LIMIT_GTC at 1.2900:
    // Expected SL from 1.2900: 1.2900 * 1.02 = 1.3158
    // Expected TP from 1.2900: 1.2900 * 0.97 = 1.2513

    const fakeRoleRunner: RoleRunner = {
      async run(task) {
        if (task.role === 'market') {
          return {
            taskId: task.taskId,
            cycleId: task.cycleId,
            role: 'market',
            status: 'completed',
            stance: 'SHORT',
            confidence: { value: 65, scale: 'integer_0_100' },
            reasoning: 'Market breakdown',
            proposedOrderType: 'MARKET',
            proposedLimitPrice: null,
            proposedStop: '1.7891',
            proposedTp: '0.5112',
            claims: [],
            claimRefs: []
          };
        }
        if (task.role === 'execution') {
          return {
            taskId: task.taskId,
            cycleId: task.cycleId,
            role: 'execution',
            status: 'completed',
            stance: 'SHORT',
            confidence: { value: 62, scale: 'integer_0_100' },
            reasoning: 'Propose limit retest',
            proposedOrderType: 'LIMIT_GTC',
            proposedLimitPrice: '1.2900',
            proposedStop: null,
            proposedTp: null,
            claims: [],
            claimRefs: []
          };
        }
        if (task.role === 'risk') {
          return {
            taskId: task.taskId,
            cycleId: task.cycleId,
            role: 'risk',
            status: 'completed',
            stance: 'SHORT',
            confidence: { value: 65, scale: 'integer_0_100' },
            reasoning: 'Approved limit entry',
            decision: 'APPROVE',
            claims: [],
            claimRefs: []
          };
        }
        if (task.role === 'lead') {
          return {
            taskId: task.taskId,
            cycleId: task.cycleId,
            role: 'lead',
            status: 'completed',
            stance: 'SHORT',
            confidence: { value: 65, scale: 'integer_0_100' },
            reasoning: 'Authorized limit entry',
            proposedOrderType: 'LIMIT_GTC',
            proposedLimitPrice: '1.2900',
            claims: [],
            claimRefs: []
          };
        }
        return {
          taskId: task.taskId,
          cycleId: task.cycleId,
          role: task.role,
          status: 'completed',
          stance: 'SHORT',
          confidence: { value: 60, scale: 'integer_0_100' },
          reasoning: 'Short stance',
          claims: [],
          claimRefs: []
        };
      },
      async chat() {
        return 'chat reply';
      },
      cleanupCycle() {}
    };

    const runner = new CycleRunner({ roleRunner: fakeRoleRunner });
    const res = await runner.run({
      accountRef: 'test-acc',
      symbol: 'XRPUSDT',
      evidenceId: 'ev-1',
      configVersion: 1,
      reason: 'manual',
      marketSummary: { lastPrice: '1.2779' },
      policy: {
        minEntryConfidencePct: 55,
        requireTwoOfThreeAnalysts: false,
        maxLeverage: 20,
        defaultStopPct: 40,
        takeProfitPct: 60,
        takeProfitR: 1.5,
        supportsLimitGtc: true,
        profileBaselineStopPrice: { long: '0.7667', short: '1.7891' },
        profileBaselineTpPrice: { long: '2.0446', short: '0.5112' }
      }
    });

    expect(res.status).toBe('completed');
    expect(res.verdict.action).toBe('OPEN_SHORT');
    expect(res.verdict.thesis?.orderType).toBe('LIMIT_GTC');
    expect(res.verdict.thesis?.limitPrice).toBe('1.2900');
    // Geometry must be anchored to 1.2900: SL 1.8060, TP 0.5160
    expect(Number(res.verdict.thesis?.stop)).toBeCloseTo(1.8060, 3);
    expect(Number(res.verdict.thesis?.tp)).toBeCloseTo(0.5160, 3);
  });
});
