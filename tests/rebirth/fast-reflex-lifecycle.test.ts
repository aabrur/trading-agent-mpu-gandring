import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reconcileAccountState, type ReconcileVenueTransport } from '../../server/v2/execution/reconcile.js';
import { evaluateWatchlistOpportunity } from '../../server/v2/market/opportunity.js';
import { createReplacementRuntime } from '../../server/v2/runtime.js';
import { RoleRunner } from '../../server/v2/agents/runner.js';
import { CycleRunner } from '../../server/v2/decision/cycle.js';
import { AccountRegistry } from '../../server/v2/accounts/registry.js';
import { ExecutionAuthorityService } from '../../server/v2/accounts/authority.js';
import { RuntimeStore } from '../../server/v2/store/database.js';

const tempDirs: string[] = [];
const openStores: RuntimeStore[] = [];

afterEach(async () => {
  while (openStores.length > 0) {
    const store = openStores.pop();
    if (store) await store.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        // Windows file locking tolerance
      }
    }
  }
});

async function openStore() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mpu-reflex-test-'));
  tempDirs.push(dir);
  const store = await RuntimeStore.open(path.join(dir, 'runtime.sqlite'));
  openStores.push(store);
  const authority = new ExecutionAuthorityService(store, 'holder-test');
  const registry = await AccountRegistry.open(store, authority);
  const account = await registry.register({
    venue: 'bybit',
    network: 'testnet',
    mode: 'TESTNET',
    nativeIdentity: 'uid-fast-reflex',
    subaccountRef: null
  });
  return { store, accountRef: account.accountRef };
}

function mockTransport(overrides: Partial<ReconcileVenueTransport> = {}): ReconcileVenueTransport {
  const base: ReconcileVenueTransport = {
    balance: async () => ({ balanceUsdt: '1000', availableUsdt: '800', realizedDailyPnlUsdt: '0' }),
    positions: async () => [],
    lookupOrder: async (_symbol, clientOrderId) => ({
      clientOrderId,
      venueOrderId: 'v-ord-1',
      state: 'ACCEPTED',
      filledQty: '0'
    }),
    readProtection: async () => ({
      state: 'MISSING',
      coveredQty: '0',
      stopPrice: null,
      reduceOnly: true
    }),
    placeProtection: async () => ({
      state: 'VERIFIED',
      coveredQty: '1',
      stopPrice: '2325.90',
      reduceOnly: true
    }),
    closePosition: async (_pos, clientOrderId) => ({
      clientOrderId,
      venueOrderId: null,
      state: 'FILLED',
      filledQty: '1'
    })
  };
  return { ...base, ...overrides };
}

describe('Fast Reflex & End-to-End Trading Lifecycle Hardening', () => {
  describe('1. Reconciled Pending Order Pricing Visibility', () => {
    it('populates limitPrice, stopPrice, and tpPrice in reconciled pending intents', async () => {
      const { store, accountRef } = await openStore();
      const now = new Date().toISOString();

      await store.execute(
        `INSERT INTO execution_intents (
          intent_id, account_ref, client_order_id, symbol,
          side, intent_kind, order_state, protection_state, payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'intent-test-1',
          accountRef,
          'pos-eth-test',
          'ETHUSDT',
          'SHORT',
          'ENTRY_ORDER',
          'ACCEPTED',
          'VERIFIED',
          JSON.stringify({
            entry: 2242.10,
            stop: 2325.90,
            tp: 2109.34
          }),
          now,
          now
        ]
      );

      const venue = mockTransport({
        lookupOrder: async (_symbol, clientOrderId) => ({
          clientOrderId,
          venueOrderId: 'v-ord-1',
          state: 'ACCEPTED',
          filledQty: '0'
        })
      });

      const reconciled = await reconcileAccountState({
        store,
        accountRef,
        transport: venue
      });

      expect(reconciled.pending).toHaveLength(1);
      const pendingOrder = reconciled.pending[0];
      expect(pendingOrder.symbol).toBe('ETHUSDT');
      expect(pendingOrder.side).toBe('SHORT');
      expect(Number(pendingOrder.limitPrice)).toBe(2242.10);
      expect(Number(pendingOrder.stopPrice)).toBe(2325.90);
      expect(Number(pendingOrder.tpPrice)).toBe(2109.34);
    });
  });

  describe('2. 4-Stage Watchlist Funnel', () => {
    const bars15m = Array.from({ length: 30 }, (_, i) => ({
      startAt: Date.now() - (30 - i) * 900000,
      open: 100 + i,
      high: 101 + i,
      low: 99.5 + i,
      close: 100.8 + i,
      volume: 1000,
      confirmed: true
    }));

    const mockHub = {
      snapshot: (sym: string) => ({
        symbol: sym,
        venue: 'bybit',
        category: 'linear',
        asOf: Date.now(),
        last: { value: '130.0', availability: 'AVAILABLE' },
        closed: { '15m': bars15m },
        price24hPcnt: '0.05'
      })
    } as any;

    it('Stage 1: drops score to 15 when effective notional is below minimum', () => {
      // 10 USDT allocated margin * 1x leverage = 10 USDT < minNotional 20 USDT
      const evaluated = evaluateWatchlistOpportunity('TESTUSDT', mockHub, {
        allocatedMarginUsdt: 10,
        leverage: 1,
        minNotionalUsdt: 20
      });

      expect(evaluated.score).toBe(15);
      expect(evaluated.reasons.some((r) => r.startsWith('INSUFFICIENT_NOTIONAL'))).toBe(true);
      expect(evaluated.bias).toBe('NEUTRAL');
    });

    it('Stage 1: applies cooldown penalty of -20 if recently rejected', () => {
      const normal = evaluateWatchlistOpportunity('TESTUSDT', mockHub, {
        allocatedMarginUsdt: 50,
        leverage: 5,
        minNotionalUsdt: 5,
        rejectedRecently: false
      });

      const cooled = evaluateWatchlistOpportunity('TESTUSDT', mockHub, {
        allocatedMarginUsdt: 50,
        leverage: 5,
        minNotionalUsdt: 5,
        rejectedRecently: true
      });

      expect(cooled.score).toBeLessThan(normal.score);
      expect(cooled.reasons.some((r) => r.startsWith('REJECT_COOLDOWN'))).toBe(true);
    });

    it('Stage 2: neutralizes bullish bias and docks score when Systemic Risk-Off is active', () => {
      const normal = evaluateWatchlistOpportunity('BULLCOIN', mockHub, {
        systemicRiskOff: false
      });
      expect(normal.bias).toBe('BULLISH');

      const riskOff = evaluateWatchlistOpportunity('BULLCOIN', mockHub, {
        systemicRiskOff: true
      });
      expect(riskOff.bias).toBe('NEUTRAL');
      expect(riskOff.score).toBeLessThan(normal.score);
      expect(riskOff.reasons.some((r) => r.startsWith('SYSTEMIC_RISK_OFF'))).toBe(true);
    });
  });

  describe('3. Fast Reflex Loop Invariant Checks', () => {
    it('executes Breakeven Plus ratchet (+1R -> Entry + 0.15%) and enforces monotonic stops', async () => {
      const emittedLogs: string[] = [];
      const roleRunner = new RoleRunner({
        providerCaller: async () => JSON.stringify({ stance: 'HOLD' }),
        resolveAssignment: () => ({ provider: 'mock', model: 'mock' })
      });
      const cycleRunner = new CycleRunner({ roleRunner });

      const mockMarketHub = {
        snapshot: (sym: string) => {
          if (sym === 'ETHUSDT') {
            return {
              last: { value: '2300', availability: 'AVAILABLE' }, // 2300 mark vs 2200 entry = +100 profit (+1R)
              closed: { '15m': [] }
            };
          }
          return { last: { value: '100', availability: 'AVAILABLE' } };
        }
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
        // Set up an active LONG position with entry = 2200, initial stop = 2100 (risk = 100 = 1R).
        // Current mark is 2300 (+100 = +1R profit).
        runtime.updateState((draft: any) => {
          draft.paper.positions = [
            {
              id: 'pos-eth-1',
              symbol: 'ETHUSDT',
              side: 'LONG',
              qty: 0.1,
              entry: 2200,
              stop: 2100, // 100 pt risk
              tp: 2500,
              margin: 100,
              leverage: 10,
              mark: 2300,
              unrealizedPnl: 100
            }
          ];
        });

        // Trigger fast reflex loop directly
        await runtime.runFastReflex?.();

        // 1. Verify log emission
        const beLog = emittedLogs.find((l) => l.includes('[FAST REFLEX] ETHUSDT reached +1.00R. Ratcheting stop to Breakeven+ (2203.3).'));
        expect(beLog).toBeDefined();

        // 2. Verify state updated monotonically
        const updatedPos = runtime.snapshot().paper.positions.find((p) => p.symbol === 'ETHUSDT');
        expect(updatedPos).toBeDefined();
        // Breakeven Plus level for LONG: 2200 * 1.0015 = 2203.30
        expect(updatedPos?.stop).toBe(2203.3);
        expect(updatedPos?.stop).toBeGreaterThan(2200); // Guarantees positive / fee-covered stop
      } finally {
        await runtime.stop();
      }
    });

    it('auto-cancels expired pending limit order after TTL (45 minutes)', async () => {
      const emittedLogs: string[] = [];
      const roleRunner = new RoleRunner({
        providerCaller: async () => JSON.stringify({ stance: 'HOLD' }),
        resolveAssignment: () => ({ provider: 'mock', model: 'mock' })
      });
      const cycleRunner = new CycleRunner({ roleRunner });

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
        const orderCreatedAt = Date.now() - 50 * 60 * 1000; // 50 mins ago (> 45 min TTL)
        runtime.updateState((draft: any) => {
          draft.venueAccount = {
            pendingOrders: [
              {
                symbol: 'SOLUSDT',
                clientOrderId: 'pending-sol-expired',
                side: 'LONG',
                orderState: 'New',
                limitPrice: 140,
                stopPrice: 135,
                tpPrice: 155,
                createdAt: orderCreatedAt
              }
            ]
          };
          draft.verdicts = [
            {
              symbol: 'SOLUSDT',
              operationalStatus: 'PENDING',
              at: orderCreatedAt,
              order: { clientOrderId: 'pending-sol-expired', entry: 140, stop: 135, tp: 155 }
            }
          ];
        });

        await runtime.runFastReflex?.();

        const ttlLog = emittedLogs.find((l) => l.includes('[FAST REFLEX] Pending limit order for SOLUSDT expired TTL'));
        expect(ttlLog).toBeDefined();
        expect(ttlLog).toContain('Auto-cancelling');
      } finally {
        await runtime.stop();
      }
    });

    it('cancels pending limit order if runaway market price touches TP1 without fill', async () => {
      const emittedLogs: string[] = [];
      const roleRunner = new RoleRunner({
        providerCaller: async () => JSON.stringify({ stance: 'HOLD' }),
        resolveAssignment: () => ({ provider: 'mock', model: 'mock' })
      });
      const cycleRunner = new CycleRunner({ roleRunner });

      const mockMarketHub = {
        snapshot: (sym: string) => {
          if (sym === 'BTCUSDT') {
            return {
              last: { value: '72500', availability: 'AVAILABLE' } // Price runaway touched TP1 (72000)
            };
          }
          return { last: { value: '100', availability: 'AVAILABLE' } };
        }
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
          draft.venueAccount = {
            pendingOrders: [
              {
                symbol: 'BTCUSDT',
                clientOrderId: 'pending-btc-runaway',
                side: 'LONG',
                orderState: 'New',
                limitPrice: 65000,
                stopPrice: 63000,
                tpPrice: 72000,
                createdAt: Date.now() - 5 * 60 * 1000 // fresh (5m ago)
              }
            ]
          };
        });

        await runtime.runFastReflex?.();

        const runawayLog = emittedLogs.find((l) => l.includes('[FAST REFLEX] Price for BTCUSDT touched TP1 (72000) without filling pending limit. Cancelling runaway entry.'));
        expect(runawayLog).toBeDefined();
      } finally {
        await runtime.stop();
      }
    });
  });
});
