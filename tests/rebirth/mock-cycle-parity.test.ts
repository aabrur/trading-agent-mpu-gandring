import { describe, it, expect } from 'vitest';
import { generateMockAgentReply } from '../../server/v2/agents/mock.js';
import { RoleRunner } from '../../server/v2/agents/runner.js';
import { CycleRunner } from '../../server/v2/decision/cycle.js';
import { createOfficialProviderCaller } from '../../server/v2/agents/providers.js';

describe('V2 Mock Agent Deliberation and Chat Parity', () => {
  it('generates rich, natural chat replies in Indonesian and English for all roles', async () => {
    const leadReplyJson = await generateMockAgentReply({
      role: 'lead',
      user: 'apakah semua aman terkendali?'
    });
    const leadReply = JSON.parse(leadReplyJson);
    expect(leadReply.role).toBe('lead');
    expect(leadReply.reply).toContain('aman dan terkendali');
    expect(leadReply.confidence).toBeGreaterThanOrEqual(0.8);

    const riskReplyJson = await generateMockAgentReply({
      role: 'risk',
      user: 'bagaimana stop loss dan leverage kita?'
    });
    const riskReply = JSON.parse(riskReplyJson);
    expect(riskReply.role).toBe('risk');
    expect(riskReply.reply).toContain('Risk gate aktif');

    const marketReplyJson = await generateMockAgentReply({
      role: 'market',
      user: 'bagaimana kondisi tape sekarang?'
    });
    const marketReply = JSON.parse(marketReplyJson);
    expect(marketReply.role).toBe('market');
    expect(marketReply.reply).toContain('orderbook');
  });

  it('runs two-phase deliberation cycle with healthy debate, approved risk, and OPEN_LONG verdict', async () => {
    const providerCaller = createOfficialProviderCaller();
    const roleRunner = new RoleRunner({
      providerCaller,
      resolveAssignment: () => ({
        provider: 'mock',
        model: 'mock-desk-v1',
        apiKey: null
      })
    });

    const cycleRunner = new CycleRunner({ roleRunner });
    const cycleResult = await cycleRunner.run({
      cycleId: `test-cycle-mock-${Date.now()}`,
      reason: 'owner',
      accountRef: 'paper:default',
      symbol: 'BTCUSDT',
      evidenceId: 'ev-test-mock-1',
      configVersion: 1,
      policy: {
        minEntryConfidencePct: 60,
        requireTwoOfThreeAnalysts: true,
        maxLeverage: 10,
        defaultStopPct: 30,
        takeProfitPct: 47,
        takeProfitR: 1.57,
        availableCapitalUsdt: 50000,
        allocationPerOrderUsdt: 12500,
        maxPositions: 4,
        orderSizePct: null,
        safetyNet: 10000,
        sizingMode: 'AUTO_EQUAL_SLOTS_MONEY_TRADE_DIV_N',
        tradingProfile: 'balance'
      },
      marketSummary: {
        symbol: 'BTCUSDT',
        last: 75000,
        change24hPct: 2.5
      }
    });

    expect(cycleResult.status).toBe('completed');
    expect(cycleResult.verdict).toBeDefined();
    expect(cycleResult.verdict?.action).toBe('OPEN_LONG');
    expect(cycleResult.verdict?.symbol).toBe('BTCUSDT');
    expect(cycleResult.verdict?.thesis).toBeDefined();
    expect(cycleResult.verdict?.thesis?.stop).toBeTruthy();
    expect(cycleResult.verdict?.thesis?.tp).toBeTruthy();
    expect(cycleResult.verdict?.rejectionReason).toBeNull();

    // Verify all 6 agents finished with completed status and no schema failures
    const failedRoles = cycleResult.roleResults.filter((r) => r.status !== 'completed');
    expect(failedRoles).toHaveLength(0);

    // Verify risk role explicitly returned APPROVE
    const riskResult = cycleResult.roleResults.find((r) => r.role === 'risk' && r.phase === 'final');
    expect(riskResult).toBeDefined();
    expect((riskResult as any)?.decision).toBe('APPROVE');
  });

  it('triggers debate disagreement between bull market analyst and cautionary research analyst during observe phase', async () => {
    const marketObserve = JSON.parse(await generateMockAgentReply({
      role: 'market',
      phase: 'observe',
      user: JSON.stringify({ promptContext: { marketSummary: { symbol: 'BTCUSDT', last: 75000, change24hPct: 2.5 } } })
    }));

    const researchObserve = JSON.parse(await generateMockAgentReply({
      role: 'research',
      phase: 'observe',
      user: JSON.stringify({ promptContext: { marketSummary: { symbol: 'BTCUSDT', last: 75000, change24hPct: 2.5 } } })
    }));

    expect(marketObserve.stance).toBe('LONG');
    expect(researchObserve.stance).toBe('SHORT');

    // In challenge phase, research shifts to consensus
    const researchChallenge = JSON.parse(await generateMockAgentReply({
      role: 'research',
      phase: 'challenge',
      user: JSON.stringify({ promptContext: { marketSummary: { symbol: 'BTCUSDT', last: 75000, change24hPct: 2.5 } } })
    }));
    expect(researchChallenge.stance).toBe('LONG');
  });

  it('returns HOLD verdict without opening duplicate positions when symbol already has an active position', async () => {
    const providerCaller = createOfficialProviderCaller();
    const roleRunner = new RoleRunner({
      providerCaller,
      resolveAssignment: () => ({
        provider: 'mock',
        model: 'mock-desk-v1',
        apiKey: null
      })
    });

    const cycleRunner = new CycleRunner({ roleRunner });
    const cycleResult = await cycleRunner.run({
      cycleId: `test-cycle-hold-${Date.now()}`,
      reason: 'schedule',
      accountRef: 'paper:default',
      symbol: 'SOLUSDT',
      evidenceId: 'ev-test-hold-1',
      configVersion: 1,
      policy: {
        minEntryConfidencePct: 60,
        requireTwoOfThreeAnalysts: true,
        maxLeverage: 10,
        defaultStopPct: 30,
        takeProfitPct: 60,
        takeProfitR: 2.0,
        availableCapitalUsdt: 50000,
        allocationPerOrderUsdt: 12500,
        maxPositions: 4,
        orderSizePct: null,
        safetyNet: 10000,
        sizingMode: 'AUTO_EQUAL_SLOTS_MONEY_TRADE_DIV_N',
        tradingProfile: 'balance',
        hasPosition: true,
        positionSide: 'LONG'
      },
      marketSummary: {
        symbol: 'SOLUSDT',
        last: 86.5,
        change24hPct: 2.8,
        hasPosition: true,
        positionSide: 'LONG'
      }
    });

    expect(cycleResult.status).toBe('completed');
    expect(cycleResult.verdict).toBeDefined();
    expect(cycleResult.verdict?.action).toBe('HOLD');
    expect(cycleResult.verdict?.symbol).toBe('SOLUSDT');
    expect(cycleResult.verdict?.thesis).toBeNull();
  });
});
