import { describe, expect, it } from 'vitest';
import { createReplacementRuntime } from '../../server/v2/runtime.js';
import { RoleRunner } from '../../server/v2/agents/runner.js';
import { CycleRunner } from '../../server/v2/decision/cycle.js';

describe('Two-Phase Cycle (Slot-Aware Efficiency) & Agent Memory Context', () => {
  it('skips watchlist discovery and emits token conservation log when all slots are occupied', async () => {
    const evaluatedSymbols: string[] = [];
    const emittedLogs: string[] = [];

    const roleRunner = new RoleRunner({
      providerCaller: async () =>
        JSON.stringify({
          stance: 'HOLD',
          decision: 'APPROVE',
          claimRefs: ['ev-test-1'],
          contraryRefs: [],
          reasoning: 'Holding active position',
          confidence: { value: 0.85, scale: 'probability_0_1' }
        }),
      resolveAssignment: () => ({
        provider: 'openai',
        model: 'gpt-4o-mini',
        apiKey: 'test-key'
      })
    });

    const cycleRunner = new CycleRunner({ roleRunner });
    const originalRun = cycleRunner.run.bind(cycleRunner);
    cycleRunner.run = async (input) => {
      evaluatedSymbols.push(input.symbol);
      return originalRun(input);
    };

    const runtime = createReplacementRuntime({
      roleRunner,
      cycleRunner
    });

    runtime.hub.subscribe((event: any) => {
      if (event.type === 'log') {
        const payload = event.payload ?? event.data;
        if (payload?.text) emittedLogs.push(payload.text);
      }
    });

    try {
      // Set N = 2 slots, with 2 active positions already open
      runtime.updateState((draft: any) => {
        draft.paper.n = 2;
        draft.watchlist = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'XRPUSDT'];
        draft.auto.symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'XRPUSDT'];
        draft.paper.positions = [
          {
            id: 'pos-btc',
            symbol: 'BTCUSDT',
            side: 'LONG',
            qty: 0.1,
            entry: 67000,
            stop: 65000,
            tp: 72000,
            margin: 100,
            leverage: 5,
            openedAt: Date.now() - 3600000,
            mark: 68000,
            unrealizedPnl: 100
          },
          {
            id: 'pos-eth',
            symbol: 'ETHUSDT',
            side: 'SHORT',
            qty: 1.5,
            entry: 2500,
            stop: 2600,
            tp: 2300,
            margin: 100,
            leverage: 5,
            openedAt: Date.now() - 1800000,
            mark: 2450,
            unrealizedPnl: 75
          }
        ];
      });

      const res = await runtime.triggerCycle(undefined, 'timer');
      expect(res.ok).toBe(true);

      // Phase 1 evaluated only the 2 open positions
      expect(evaluatedSymbols).toContain('BTCUSDT');
      expect(evaluatedSymbols).toContain('ETHUSDT');
      expect(evaluatedSymbols.length).toBe(2);

      // Candidates in watchlist (SOLUSDT, DOGEUSDT, XRPUSDT) must NEVER be called
      expect(evaluatedSymbols).not.toContain('SOLUSDT');
      expect(evaluatedSymbols).not.toContain('DOGEUSDT');
      expect(evaluatedSymbols).not.toContain('XRPUSDT');

      // The exact slot-aware efficiency log must be emitted
      const expectedLog = emittedLogs.find((msg) =>
        msg.includes('All 2 slots occupied') && msg.includes('Skipping watchlist discovery to conserve API tokens')
      );
      expect(expectedLog).toBeDefined();
    } finally {
      await runtime.stop();
    }
  });

  it('evaluates watchlist candidates sequentially when free slots are available', async () => {
    const evaluatedSymbols: string[] = [];

    const roleRunner = new RoleRunner({
      providerCaller: async () =>
        JSON.stringify({
          stance: 'HOLD',
          decision: 'APPROVE',
          claimRefs: ['ev-test-1'],
          contraryRefs: [],
          reasoning: 'Neutral scan',
          confidence: { value: 0.8, scale: 'probability_0_1' }
        }),
      resolveAssignment: () => ({
        provider: 'openai',
        model: 'gpt-4o-mini',
        apiKey: 'test-key'
      })
    });

    const cycleRunner = new CycleRunner({ roleRunner });
    const originalRun = cycleRunner.run.bind(cycleRunner);
    cycleRunner.run = async (input) => {
      evaluatedSymbols.push(input.symbol);
      return originalRun(input);
    };

    const runtime = createReplacementRuntime({
      roleRunner,
      cycleRunner
    });

    try {
      // Set N = 3 slots, with 1 active position open (2 free slots)
      runtime.updateState((draft: any) => {
        draft.paper.n = 3;
        draft.watchlist = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
        draft.auto.symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
        draft.paper.positions = [
          {
            id: 'pos-btc',
            symbol: 'BTCUSDT',
            side: 'LONG',
            qty: 0.1,
            entry: 67000,
            stop: 65000,
            tp: 72000,
            margin: 100,
            leverage: 5,
            openedAt: Date.now() - 3600000,
            mark: 68000,
            unrealizedPnl: 100
          }
        ];
      });

      const res = await runtime.triggerCycle(undefined, 'timer');
      expect(res.ok).toBe(true);

      // Phase 1 evaluated open position first
      expect(evaluatedSymbols[0]).toBe('BTCUSDT');

      // Phase 2 evaluated the watchlist candidates because freeSlots = 2
      expect(evaluatedSymbols).toContain('ETHUSDT');
      expect(evaluatedSymbols).toContain('SOLUSDT');
    } finally {
      await runtime.stop();
    }
  });

  it('injects running position metadata, cross-market breadth, and owner chat memory into prompt context', async () => {
    let capturedMarketSummary: Record<string, any> | null = null;

    const roleRunner = new RoleRunner({
      providerCaller: async () =>
        JSON.stringify({
          stance: 'HOLD',
          decision: 'APPROVE',
          claimRefs: [],
          contraryRefs: [],
          reasoning: 'Evaluated with context',
          confidence: { value: 0.8, scale: 'probability_0_1' }
        }),
      resolveAssignment: () => ({
        provider: 'openai',
        model: 'gpt-4o-mini',
        apiKey: 'test-key'
      })
    });

    const cycleRunner = new CycleRunner({ roleRunner });
    const originalRun = cycleRunner.run.bind(cycleRunner);
    cycleRunner.run = async (input) => {
      if (input.symbol === 'BTCUSDT') {
        capturedMarketSummary = input.marketSummary as Record<string, any>;
      }
      return originalRun(input);
    };

    const runtime = createReplacementRuntime({
      roleRunner,
      cycleRunner
    });

    try {
      runtime.updateState((draft: any) => {
        draft.paper.n = 3;
        draft.tickers = {
          BTCUSDT: { last: 68000, change15m: -2.1, relVol15m: 3.5, trend15m: 'DOWNTREND', change24hPct: -4.5 },
          ETHUSDT: { last: 2400, change15m: -2.8, relVol15m: 4.2, trend15m: 'DOWNTREND', change24hPct: -5.2 },
          SOLUSDT: { last: 140, change15m: -3.0, relVol15m: 5.0, trend15m: 'DOWNTREND', change24hPct: -6.0 }
        };
        draft.watchlist = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
        draft.paper.positions = [
          {
            id: 'pos-btc',
            symbol: 'BTCUSDT',
            side: 'LONG',
            qty: 0.1,
            entry: 67000,
            stop: 65000,
            tp: 72000,
            margin: 100,
            leverage: 5,
            openedAt: 1700000000000,
            mark: 68000,
            unrealizedPnl: 100
          }
        ];
        draft.roomHistory = [
          { from: 'owner', text: 'Perketat stop loss BTC sekarang', at: Date.now() - 60000, to: 'all' },
          { from: 'owner', text: 'Jangan buka posisi baru dulu kalau market dump', at: Date.now() - 30000, to: 'all' }
        ];
        draft.verdicts = [
          {
            id: 'v-prior',
            symbol: 'BTCUSDT',
            action: 'OPEN_LONG',
            reason: 'Bullish reclaim of support',
            at: 1700000000000,
            order: { entry: 67000, stop: 65000, tp: 72000, leverage: 5 }
          }
        ];
      });

      await runtime.triggerCycle(undefined, 'timer');

      expect(capturedMarketSummary).toBeDefined();
      // 1. Running position metadata
      expect(capturedMarketSummary?.evaluationMode).toBe('POSITION_MANAGEMENT');
      expect(capturedMarketSummary?.existingPosition).toBeDefined();
      expect(capturedMarketSummary?.existingPosition.entryPrice).toBe(67000);
      expect(capturedMarketSummary?.existingPosition.roePct).toBeGreaterThan(0);
      expect(capturedMarketSummary?.existingPosition.slDistancePct).toBeCloseTo(4.41, 1);
      expect(capturedMarketSummary?.existingPosition.tpDistancePct).toBeCloseTo(5.88, 1);
      expect(capturedMarketSummary?.existingPosition.priorEntryThesis?.action).toBe('OPEN_LONG');

      // 2. Cross-market breadth
      expect(capturedMarketSummary?.crossMarketBreadth).toBeDefined();
      expect(capturedMarketSummary?.crossMarketBreadth.marketCondition).toBe('BROAD_SELLOFF');
      expect(capturedMarketSummary?.crossMarketBreadth.bearishCount).toBe(3);
      expect(capturedMarketSummary?.crossMarketBreadth.avgChange15m).toBeLessThan(-2);

      // 3. Owner chat memory
      expect(capturedMarketSummary?.ownerDirectives).toBeDefined();
      expect(capturedMarketSummary?.ownerDirectives.recentMessages.length).toBe(2);
      expect(capturedMarketSummary?.ownerDirectives.recentMessages[0].text).toContain('Perketat stop loss');
      expect(capturedMarketSummary?.ownerDirectives.instruction).toContain('Owner Sovereignty');
    } finally {
      await runtime.stop();
    }
  });
});
