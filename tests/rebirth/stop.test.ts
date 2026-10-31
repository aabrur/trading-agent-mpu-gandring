import { describe, expect, it } from 'vitest';
import {
  executeAcceptedStopSemantics,
  executeLocalKillSemantics,
  type StopSemanticsContext
} from '../../server/v2/connectors/grok/commands.js';

describe('T17 Accepted D09 STOP Semantics and Local Kill Distinction Verification', () => {
  it('local_kill_cancels_and_flattens_while_grok_stop_retains_protected_positions', async () => {
    let strategyCloseCalled = false;
    let entryCancelled = false;
    let flattenedPositions = false;

    const context: StopSemanticsContext = {
      openPositionsCount: 2,
      restingStopsCount: 2,
      cancelEntries: async () => {
        entryCancelled = true;
      },
      flattenPositions: async () => {
        flattenedPositions = true;
      },
      invokeStrategyClose: async () => {
        strategyCloseCalled = true;
      }
    };

    // 1. Remote Grok STOP execution: HALT_ONLY
    const grokStopResult = await executeAcceptedStopSemantics(context);
    expect(grokStopResult.haltLatched).toBe(true);
    expect(grokStopResult.autoTrading).toBe('OFF');
    expect(grokStopResult.action).toBe('HALT_ONLY');
    expect(entryCancelled).toBe(true);
    // Crucial: Grok STOP retains open positions and resting SL/TP, never calls strategy close or flattens
    expect(flattenedPositions).toBe(false);
    expect(strategyCloseCalled).toBe(false);
    expect(grokStopResult.retainedProtectedPositions).toBe(2);

    // Reset spies
    entryCancelled = false;
    flattenedPositions = false;
    strategyCloseCalled = false;

    // 2. Local Kill execution: HALT_AND_FLATTEN
    const localKillResult = await executeLocalKillSemantics(context);
    expect(localKillResult.haltLatched).toBe(true);
    expect(localKillResult.action).toBe('HALT_AND_FLATTEN');
    expect(entryCancelled).toBe(true);
    // Local kill immediately flattens open positions
    expect(flattenedPositions).toBe(true);
  });
});
