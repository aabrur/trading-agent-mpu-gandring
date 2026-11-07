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

  it('unifies clean market summary without redundant fields and injects long-term lessons into agent context', async () => {
    let capturedMarketSummary: Record<string, any> | null = null;

    const roleRunner = new RoleRunner({
      providerCaller: async () =>
        JSON.stringify({
          stance: 'HOLD',
          decision: 'APPROVE',
          claimRefs: [],
          contraryRefs: [],
          reasoning: 'Clean context verification',
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
        draft.tickers = { BTCUSDT: { last: 65000 } };
        draft.watchlist = ['BTCUSDT'];
        draft.lessons = [
          {
            id: 'l-btc-1',
            role: 'execution',
            kind: 'pending_order_cancelled',
            symbol: 'BTCUSDT',
            happened: 'Resting limit order cancelled due to trend breakdown',
            rootCause: 'Market structural shift',
            lesson: 'Cancel resting orders when momentum reverses',
            firstAt: Date.now() - 100000,
            lastAt: Date.now() - 100000,
            count: 1,
            source: 'runtime',
            status: 'confirmed'
          },
          {
            id: 'l-eth-1',
            role: 'risk',
            kind: 'stop_loss_hit',
            symbol: 'ETHUSDT',
            happened: 'ETH stopped out',
            rootCause: 'Slippage',
            lesson: 'Widen stop on high volatility',
            firstAt: Date.now() - 50000,
            lastAt: Date.now() - 50000,
            count: 1,
            source: 'runtime',
            status: 'confirmed'
          }
        ];
      });

      await runtime.triggerCycle('BTCUSDT', 'owner');

      expect(capturedMarketSummary).toBeDefined();

      // Verify removal of redundant duplicate fields
      expect(capturedMarketSummary?.intelligenceFeeds).toBeUndefined();
      expect(capturedMarketSummary?.recentOwnerDiscussion).toBeUndefined();
      expect(capturedMarketSummary?.jevReview).toBeUndefined();
      expect(capturedMarketSummary?.deskSlots).toBeUndefined();

      // Single source of truth for research and capital
      expect(capturedMarketSummary?.optionalResearch).toBeDefined();
      expect(capturedMarketSummary?.optionalResearch.news).toBeDefined();
      expect(capturedMarketSummary?.optionalResearch.whale).toBeDefined();
      expect(capturedMarketSummary?.optionalResearch.catalyst).toBeDefined();

      expect(capturedMarketSummary?.accountCapital).toBeDefined();
      expect(capturedMarketSummary?.accountCapital.maxSlotsN).toBe(3);
      expect(capturedMarketSummary?.accountCapital.freeSlots).toBe(3);

      // Verify memory injection of recentLessons
      expect(capturedMarketSummary?.recentLessons).toBeDefined();
      expect(Array.isArray(capturedMarketSummary?.recentLessons)).toBe(true);
      expect(capturedMarketSummary?.recentLessons.length).toBe(1);
      expect(capturedMarketSummary?.recentLessons[0].symbol).toBe('BTCUSDT');
      expect(capturedMarketSummary?.recentLessons[0].kind).toBe('pending_order_cancelled');
    } finally {
      await runtime.stop();
    }
  });

  it('evaluates resting limit orders under PENDING_ORDER_MANAGEMENT mode and cancels them upon CLOSE verdict with auto-recorded lesson', async () => {
    let capturedMarketSummary: Record<string, any> | null = null;

    const roleRunner = new RoleRunner({
      providerCaller: async () =>
        JSON.stringify({
          stance: 'CLOSE',
          decision: 'APPROVE',
          claimRefs: [],
          contraryRefs: [],
          reasoning: 'Market structure reversed, cancel resting entry order',
          confidence: { value: 0.9, scale: 'probability_0_1' }
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
        draft.tickers = { BTCUSDT: { last: 66000 } };
        draft.venueAccount = {
          equity: 1000,
          available: 1000,
          unrealized: 0,
          at: Date.now(),
          status: 'confirmed',
          positions: [],
          pendingSymbols: ['BTCUSDT'],
          pendingOrders: [
            {
              intentId: 'intent-limit-1',
              clientOrderId: 'cl-ord-btc-1',
              symbol: 'BTCUSDT',
              side: 'LONG',
              orderState: 'ACCEPTED',
              filledQty: null
            }
          ]
        };
        draft.verdicts = [
          {
            id: 'v-pending-btc',
            symbol: 'BTCUSDT',
            action: 'OPEN_LONG',
            operationalStatus: 'PENDING',
            reason: 'Support retest limit buy',
            at: Date.now() - 10000,
            order: {
              positionId: 'cl-ord-btc-1',
              entry: 64500,
              stop: 63000,
              tp: 68000,
              leverage: 5
            }
          }
        ];
      });

      const res = await runtime.triggerCycle('BTCUSDT', 'schedule');
      expect(res.ok).toBe(true);

      // Verify PENDING_ORDER_MANAGEMENT mode
      expect(capturedMarketSummary?.evaluationMode).toBe('PENDING_ORDER_MANAGEMENT');
      expect(capturedMarketSummary?.pendingOrder).toBeDefined();
      expect(capturedMarketSummary?.pendingOrder.clientOrderId).toBe('cl-ord-btc-1');
      expect(capturedMarketSummary?.pendingOrder.limitPrice).toBe(64500);
      expect(capturedMarketSummary?.pendingOrder.instruction).toContain('PENDING_ORDER_MANAGEMENT');

      // Verify that CLOSE verdict cancelled the resting order and recorded an organic lesson
      const snap = runtime.snapshot();
      expect(snap.venueAccount?.pendingOrders?.find((p) => p.symbol === 'BTCUSDT')).toBeUndefined();
      expect(snap.venueAccount?.pendingSymbols).not.toContain('BTCUSDT');

      const cancelledLesson = snap.lessons?.find((l) => l.kind === 'pending_order_cancelled' && l.symbol === 'BTCUSDT');
      expect(cancelledLesson).toBeDefined();
      expect(cancelledLesson?.lesson).toContain('Cancelled resting order');
    } finally {
      await runtime.stop();
    }
  });

  it('triggers two-phase cycle when owner issues run cycle command', async () => {
    let runCalled = false;
    const cycleRunner = new CycleRunner({
      roleRunner: new RoleRunner({
        providerCaller: async () => JSON.stringify({ stance: 'HOLD', confidence: { value: 0.8, scale: 'probability_0_1' } }),
        resolveAssignment: () => ({ provider: 'mock', model: 'mock' })
      })
    });
    const origRun = cycleRunner.run.bind(cycleRunner);
    cycleRunner.run = async (input) => {
      runCalled = true;
      return origRun(input);
    };

    const runtime = createReplacementRuntime({
      roleRunner: new RoleRunner({
        providerCaller: async () => JSON.stringify({ stance: 'HOLD', confidence: { value: 0.8, scale: 'probability_0_1' } }),
        resolveAssignment: () => ({ provider: 'mock', model: 'mock' })
      }),
      cycleRunner
    });

    try {
      const res = await runtime.handleCommand({ text: 'run cycle' });
      expect(res.ok).toBe(true);
      expect(res.reply).toContain('two-phase deliberation cycle');

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(runCalled).toBe(true);
    } finally {
      await runtime.stop();
    }
  });

  it('blocks deliberation via early Slot Gate when all slots are full for non-owner reason', async () => {
    let runCalled = false;

    const roleRunner = new RoleRunner({
      providerCaller: async () => JSON.stringify({ stance: 'HOLD' }),
      resolveAssignment: () => ({ provider: 'mock', model: 'mock' })
    });

    const cycleRunner = new CycleRunner({ roleRunner });
    cycleRunner.run = async () => {
      runCalled = true;
      return { status: 'completed', roleResults: [] } as any;
    };

    const runtime = createReplacementRuntime({
      roleRunner,
      cycleRunner
    });

    try {
      runtime.updateState((draft: any) => {
        draft.paper.n = 1;
        draft.paper.positions = [
          {
            id: 'pos-1',
            symbol: 'BTCUSDT',
            side: 'LONG',
            qty: 1,
            entry: 65000,
            stop: 64000,
            tp: 67000,
            margin: 100,
            leverage: 5,
            openedAt: Date.now(),
            mark: 65000,
            unrealizedPnl: 0
          }
        ];
      });

      // Try triggering cycle for a new candidate SOLUSDT via schedule (non-owner)
      const res = await runtime.triggerCycle('SOLUSDT', 'schedule');
      expect(res.ok).toBe(false);
      expect(res.message).toContain('All 1 position slots occupied. Deliberation skipped by Slot Gate.');
      // cycleRunner.run must never be called
      expect(runCalled).toBe(false);
    } finally {
      await runtime.stop();
    }
  });

  it('pre-screens and prioritizes candidates by quantitative opportunity ranking in Phase 2', async () => {
    const evaluatedSymbols: string[] = [];
    const emittedLogs: string[] = [];

    const roleRunner = new RoleRunner({
      providerCaller: async () =>
        JSON.stringify({
          stance: 'HOLD',
          decision: 'APPROVE',
          claimRefs: ['ev-test-1'],
          contraryRefs: [],
          reasoning: 'Evaluated candidate',
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

    const mockMarketHub = {
      snapshot: (sym: string) => {
        if (sym === 'ZECUSDT') {
          return {
            symbol: 'ZECUSDT',
            venue: 'bybit',
            category: 'linear',
            asOf: Date.now(),
            last: { value: '1290.0', availability: 'AVAILABLE' },
            closed: {
              '15m': Array.from({ length: 25 }, (_, i) => ({
                startAt: Date.now() - (25 - i) * 900000,
                open: 1200 + i,
                high: 1210 + i,
                low: 1195 + i,
                close: 1205 + i,
                volume: i === 24 ? 10000 : 1000,
                confirmed: true
              }))
            },
            price24hPcnt: '0.08'
          };
        }
        return {
          symbol: sym,
          venue: 'bybit',
          category: 'linear',
          asOf: Date.now(),
          last: { value: '100.0', availability: 'AVAILABLE' },
          closed: {
            '15m': Array.from({ length: 25 }, (_, i) => ({
              startAt: Date.now() - (25 - i) * 900000,
              open: 100,
              high: 101,
              low: 99,
              close: 100,
              volume: 100,
              confirmed: true
            }))
          },
          price24hPcnt: '0.001'
        };
      },
      stop: async () => {}
    } as any;

    const runtime = createReplacementRuntime({
      roleRunner,
      cycleRunner,
      marketHub: mockMarketHub
    });

    runtime.hub.subscribe((event: any) => {
      if (event.type === 'log') {
        const payload = event.payload ?? event.data;
        if (payload?.text) emittedLogs.push(payload.text);
      }
    });

    try {
      runtime.updateState((draft: any) => {
        draft.paper.n = 2;
        draft.watchlist = ['ETHUSDT', 'SOLUSDT', 'ZECUSDT'];
        draft.auto.symbols = ['ETHUSDT', 'SOLUSDT', 'ZECUSDT'];
        draft.paper.positions = [];
      });

      const res = await runtime.triggerCycle(undefined, 'schedule');
      expect(res.ok).toBe(true);

      // ZECUSDT must be evaluated FIRST because its opportunity score is highest!
      expect(evaluatedSymbols[0]).toBe('ZECUSDT');

      // Check that WATCHLIST SCREEN log was emitted
      const screenLog = emittedLogs.find((l) => l.includes('[WATCHLIST SCREEN]'));
      expect(screenLog).toBeDefined();
      expect(screenLog).toContain('ZECUSDT');
    } finally {
      await runtime.stop();
    }
  });
});
