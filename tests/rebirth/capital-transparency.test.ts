import { describe, expect, it } from 'vitest';
import { buildLiveDeskChatContext } from '../../server/v2/api/chat.js';
import { createInitialOfficeState } from '../../server/v2/office.js';

describe('Task 7: Capital Transparency and Account Capital Metric Standardization', () => {
  it('buildLiveDeskChatContext exposes standardized accountCapital metrics', () => {
    const state = createInitialOfficeState();
    state.paper.equity = 12.17;
    state.paper.balance = 12.17;
    state.paper.safetyNet = 0.00;
    state.paper.moneyTrade = 12.17;
    state.paper.usedMargin = 4.05;
    state.paper.n = 3;
    state.paper.perOrder = 4.05;
    state.paper.positions = [
      {
        symbol: 'ETHUSDT',
        side: 'SHORT',
        qty: 0.034,
        entry: 2363,
        mark: 2360,
        unrealizedPnl: 0.10,
        stop: 2391.5,
        tp: 2352
      }
    ];

    const ctx = buildLiveDeskChatContext(state);

    expect(ctx.accountCapital).toBeDefined();
    expect(ctx.accountCapital?.totalEquity).toBe(12.17);
    expect(ctx.accountCapital?.safetyNet).toBe(0.00);
    expect(ctx.accountCapital?.moneyTradeBudget).toBe(12.17);
    expect(ctx.accountCapital?.usedMargin).toBe(4.05);
    expect(ctx.accountCapital?.freeAllocatableMargin).toBe(8.12);
    expect(ctx.accountCapital?.perOrderAllocation).toBe(4.05);
    expect(ctx.accountCapital?.maxSlotsN).toBe(3);
    expect(ctx.accountCapital?.freeSlots).toBe(2);
  });
});
