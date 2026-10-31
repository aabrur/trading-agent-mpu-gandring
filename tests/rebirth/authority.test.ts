import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeStore } from '../../server/v2/store/database.js';
import { AccountRegistry } from '../../server/v2/accounts/registry.js';
import { ExecutionAuthorityService } from '../../server/v2/accounts/authority.js';
import { ExecutionGateway, type GatewayVenueTransport } from '../../server/v2/execution/gateway.js';
import { unavailableEvidence, verifiedEvidence, type MarketFrame } from '../../server/v2/contracts.js';

const tempDirs: string[] = [];
const openStores: RuntimeStore[] = [];

afterEach(async () => {
  while (openStores.length > 0) {
    const s = openStores.pop();
    if (s) await s.close();
  }
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        // Ignore transient Windows WAL handle release delay in temp cleanup.
      }
    }
  }
});

function makeMarket(): MarketFrame {
  return {
    evidenceId: 'ev-auth',
    revision: 1,
    symbol: 'BTCUSDT',
    venue: 'bybit',
    category: 'linear',
    asOf: Date.now(),
    last: verifiedEvidence({ value: '68500', source: 'bybit', unit: 'USDT' }),
    bid: verifiedEvidence({ value: '68500', source: 'bybit', unit: 'USDT' }),
    ask: verifiedEvidence({ value: '68500', source: 'bybit', unit: 'USDT' }),
    closed: { '1m': [], '5m': [], '15m': [], '1h': [], '4h': [], '1d': [] },
    current: {},
    tradesEvidenceId: null,
    bookEvidenceId: null,
    funding: unavailableEvidence('bybit', 'n/a'),
    openInterest: unavailableEvidence('bybit', 'n/a')
  };
}

describe('T09 writer_epoch fencing, concurrent slot occupancy, halt race and external credential conflict honesty', () => {
  it('fences stale writer_epoch across dual-store writers, enforces unique slot occupancy under concurrency, aborts entry racing halt, and flags external credential conflict', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mpu-auth-test-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');

    const storeA = await RuntimeStore.open(dbPath);
    const storeB = await RuntimeStore.open(dbPath);
    openStores.push(storeA, storeB);

    const authA = new ExecutionAuthorityService(storeA, 'writer-A');
    const authB = new ExecutionAuthorityService(storeB, 'writer-B');

    const registry = await AccountRegistry.open(storeA, authA);
    const account = await registry.register({
      venue: 'bybit',
      network: 'testnet',
      mode: 'TESTNET',
      nativeIdentity: 'uid-shared-77',
      subaccountRef: null
    });

    const leaseA = await authA.claim(account.accountRef, 'writer-A');
    expect(leaseA.writerEpoch).toBe(1);

    // Writer B claims authority -> bumps writer_epoch to 2!
    const leaseB = await authB.claim(account.accountRef, 'writer-B');
    expect(leaseB.writerEpoch).toBe(2);

    let submitCount = 0;
    const livePositions: Array<{
      positionKey: string;
      symbol: string;
      side: 'LONG' | 'SHORT';
      qty: string;
      entryPrice: string;
      externalOrigin?: boolean;
    }> = [];

    const transport: GatewayVenueTransport = {
      balance: async () => ({ balanceUsdt: '1000', availableUsdt: '1000', realizedDailyPnlUsdt: '0' }),
      positions: async () => [...livePositions],
      submitOrder: async (o) => {
        submitCount += 1;
        livePositions.push({
          positionKey: `${o.symbol}:ONE_WAY`,
          symbol: o.symbol,
          side: o.side,
          qty: o.quantity,
          entryPrice: '68500'
        });
        return {
          clientOrderId: o.clientOrderId,
          venueOrderId: `ord-${submitCount}`,
          state: 'FILLED',
          filledQty: o.quantity
        };
      },
      lookupOrder: async (_s, c) => ({ clientOrderId: c, venueOrderId: 'ord-1', state: 'FILLED', filledQty: '0.01' }),
      cancelEntryOrder: async (_s, c) => ({ clientOrderId: c, venueOrderId: 'ord-1', state: 'CANCELLED', filledQty: '0' }),
      readProtection: async (pos) => ({ state: 'VERIFIED', coveredQty: pos.qty, stopPrice: '67000', reduceOnly: true }),
      placeProtection: async (pos, stop) => ({ state: 'VERIFIED', coveredQty: pos.qty, stopPrice: stop, reduceOnly: true }),
      closePosition: async (pos, c) => ({ clientOrderId: c, venueOrderId: 'cl-1', state: 'FILLED', filledQty: pos.qty })
    };

    const gwA = new ExecutionGateway({
      store: storeA,
      authority: authA,
      getTransport: () => transport,
      getAccountPolicy: () => ({
        activeConfigVersion: 1,
        safetyNetUsdt: '200',
        maxPositions: 1,
        dailyLossCapUsdt: '50',
        minEntryConfidencePct: 60
      }),
      readFreshMarket: () => makeMarket()
    });

    const staleAttempt = await gwA.submit({
      intentId: 'intent-stale-epoch',
      accountRef: account.accountRef,
      configVersion: 1,
      authorityEpoch: leaseA.writerEpoch, // epoch 1, stale!
      action: 'OPEN',
      symbol: 'BTCUSDT',
      side: 'LONG',
      quantity: '0.01',
      entry: null,
      stop: '67000',
      tp: null,
      leverage: 5,
      thesisId: 'th-stale'
    });
    expect(staleAttempt.orderState).toBe('REJECTED');
    expect(submitCount).toBe(0);

    // Concurrent entries on writer B with maxPositions = 1 -> only 1 succeeds, second rejected under lock!
    const gwB = new ExecutionGateway({
      store: storeB,
      authority: authB,
      getTransport: () => transport,
      getAccountPolicy: () => ({
        activeConfigVersion: 1,
        safetyNetUsdt: '200',
        maxPositions: 1,
        dailyLossCapUsdt: '50',
        minEntryConfidencePct: 60
      }),
      readFreshMarket: () => makeMarket()
    });

    const [c1, c2] = await Promise.all([
      gwB.submit({
        intentId: 'intent-concurrent-1',
        accountRef: account.accountRef,
        configVersion: 1,
        authorityEpoch: leaseB.writerEpoch,
        action: 'OPEN',
        symbol: 'BTCUSDT',
        side: 'LONG',
        quantity: '0.01',
        entry: null,
        stop: '67000',
        tp: null,
        leverage: 5,
        thesisId: 'th-c1'
      }),
      gwB.submit({
        intentId: 'intent-concurrent-2',
        accountRef: account.accountRef,
        configVersion: 1,
        authorityEpoch: leaseB.writerEpoch,
        action: 'OPEN',
        symbol: 'ETHUSDT',
        side: 'LONG',
        quantity: '0.1',
        entry: null,
        stop: '2400',
        tp: null,
        leverage: 5,
        thesisId: 'th-c2'
      })
    ]);

    const filledCount = [c1, c2].filter((r) => r.orderState === 'FILLED').length;
    const rejectedCount = [c1, c2].filter((r) => r.orderState === 'REJECTED').length;
    expect(filledCount).toBe(1);
    expect(rejectedCount).toBe(1);
    expect(submitCount).toBe(1);

    // External credential conflict: non-participating external bot opens SOLUSDT on the same exchange account!
    livePositions.push({
      positionKey: 'SOLUSDT:ONE_WAY',
      symbol: 'SOLUSDT',
      side: 'SHORT',
      qty: '5',
      entryPrice: '180',
      externalOrigin: true
    });

    const recon = await gwB.reconcile(account.accountRef);
    expect(recon.externalCredentialConflict).toBe(true);
    expect(recon.unknowns.some((u) => u.includes('SOLUSDT'))).toBe(true);

    // Halt racing an entry aborts the entry before submit!
    const haltPromise = gwB.halt({
      requestId: 'halt-race-1',
      accountRef: account.accountRef,
      source: 'local.owner',
      policy: 'HALT_ONLY'
    });
    const racingEntry = gwB.submit({
      intentId: 'intent-racing-halt',
      accountRef: account.accountRef,
      configVersion: 1,
      authorityEpoch: leaseB.writerEpoch,
      action: 'OPEN',
      symbol: 'XRPUSDT',
      side: 'LONG',
      quantity: '10',
      entry: null,
      stop: '0.5',
      tp: null,
      leverage: 5,
      thesisId: 'th-race'
    });
    const [haltReceipt, raceReceipt] = await Promise.all([haltPromise, racingEntry]);
    expect(haltReceipt.halted).toBe(true);
    expect(raceReceipt.orderState).toBe('REJECTED');
    expect(submitCount).toBe(1);
  });
});
