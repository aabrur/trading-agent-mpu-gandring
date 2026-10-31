import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeStore } from '../../server/v2/store/database.js';
import { AccountRegistry } from '../../server/v2/accounts/registry.js';
import { ExecutionAuthorityService } from '../../server/v2/accounts/authority.js';
import {
  ExecutionGateway,
  type GatewayVenueTransport,
  type TradeIntent
} from '../../server/v2/execution/gateway.js';
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

async function createTestStore() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mpu-gw-test-'));
  tempDirs.push(dir);
  const dbPath = path.join(dir, 'runtime.sqlite');
  const store = await RuntimeStore.open(dbPath);
  openStores.push(store);
  const authority = new ExecutionAuthorityService(store, 'holder-main');
  const registry = await AccountRegistry.open(store, authority);
  const account = await registry.register({
    venue: 'bybit',
    network: 'testnet',
    mode: 'TESTNET',
    nativeIdentity: 'uid-bybit-100',
    subaccountRef: null
  });
  const lease = await authority.claim(account.accountRef, 'holder-main');
  return { dir, dbPath, store, accountRef: account.accountRef, authority, epoch: lease.writerEpoch };
}

function makeFreshMarket(price = '68500'): MarketFrame {
  return {
    evidenceId: 'ev-gw-mkt',
    revision: 1,
    symbol: 'BTCUSDT',
    venue: 'bybit',
    category: 'linear',
    asOf: Date.now(),
    last: verifiedEvidence({ value: price, source: 'bybit.tickers.BTCUSDT', unit: 'USDT' }),
    bid: verifiedEvidence({ value: price, source: 'bybit.tickers.BTCUSDT', unit: 'USDT' }),
    ask: verifiedEvidence({ value: price, source: 'bybit.tickers.BTCUSDT', unit: 'USDT' }),
    closed: { '1m': [], '5m': [], '15m': [], '1h': [], '4h': [], '1d': [] },
    current: {},
    tradesEvidenceId: null,
    bookEvidenceId: null,
    funding: unavailableEvidence('bybit.tickers.BTCUSDT', 'n/a'),
    openInterest: unavailableEvidence('bybit.tickers.BTCUSDT', 'n/a')
  };
}

describe('T09 single execution gateway, journal-before-send, timeout UNKNOWN, Owner close and zero transaction-over-IO', () => {
  it('submits at most once per intent, returns UNKNOWN with null filledQty on timeout, never holds SQL tx over IO, and keeps callback writes at 0', async () => {
    const { store, accountRef, authority, epoch } = await createTestStore();

    let nativeSubmissionsForSameIntent = 0;
    let activeSqlTxCount = 0;
    let sqlTxHeldDuringNetwork = false;

    const origTransaction = store.transaction.bind(store);
    store.transaction = async <T>(fn: Parameters<typeof origTransaction>[0]): Promise<T> => {
      activeSqlTxCount += 1;
      try {
        return await origTransaction(fn);
      } finally {
        activeSqlTxCount -= 1;
      }
    };

    const transport: GatewayVenueTransport = {
      balance: async () => {
        if (activeSqlTxCount > 0) sqlTxHeldDuringNetwork = true;
        return { balanceUsdt: '1000', availableUsdt: '1000', realizedDailyPnlUsdt: '0' };
      },
      positions: async () => {
        if (activeSqlTxCount > 0) sqlTxHeldDuringNetwork = true;
        return [];
      },
      submitOrder: async (order) => {
        if (activeSqlTxCount > 0) sqlTxHeldDuringNetwork = true;
        nativeSubmissionsForSameIntent += 1;
        return {
          clientOrderId: order.clientOrderId,
          venueOrderId: 'ord-1',
          state: 'FILLED',
          filledQty: order.quantity
        };
      },
      lookupOrder: async (_symbol, clientOrderId) => ({
        clientOrderId,
        venueOrderId: 'ord-1',
        state: 'FILLED',
        filledQty: '0.01'
      }),
      cancelEntryOrder: async (_symbol, clientOrderId) => ({
        clientOrderId,
        venueOrderId: 'ord-1',
        state: 'CANCELLED',
        filledQty: '0'
      }),
      readProtection: async (pos) => ({
        state: 'VERIFIED',
        coveredQty: pos.qty,
        stopPrice: '67000',
        reduceOnly: true
      }),
      placeProtection: async (pos, stopPrice) => ({
        state: 'VERIFIED',
        coveredQty: pos.qty,
        stopPrice,
        reduceOnly: true
      }),
      closePosition: async (pos, clientOrderId) => ({
        clientOrderId,
        venueOrderId: 'close-1',
        state: 'FILLED',
        filledQty: pos.qty
      })
    };

    const gateway = new ExecutionGateway({
      store,
      authority,
      getTransport: () => transport,
      getAccountPolicy: () => ({
        activeConfigVersion: 1,
        safetyNetUsdt: '200',
        maxPositions: 2,
        dailyLossCapUsdt: '50',
        minEntryConfidencePct: 75
      }),
      readFreshMarket: () => makeFreshMarket('68500')
    });

    const intent: TradeIntent = {
      intentId: 'intent-dedupe-1',
      accountRef,
      configVersion: 1,
      authorityEpoch: epoch,
      action: 'OPEN',
      symbol: 'BTCUSDT',
      side: 'LONG',
      quantity: '0.01',
      entry: null,
      stop: '67000',
      tp: '71000',
      leverage: 5,
      thesisId: 'thesis-1'
    };

    const r1 = await gateway.submit(intent);
    const r2 = await gateway.submit(intent);
    expect(r1.orderState).toBe('FILLED');
    expect(r2.clientOrderId).toBe(r1.clientOrderId);
    expect(nativeSubmissionsForSameIntent).toBe(1);
    expect(sqlTxHeldDuringNetwork).toBe(false);

    // Timeout case -> UNKNOWN with filledQty null
    const timeoutTransport: GatewayVenueTransport = {
      ...transport,
      submitOrder: async () => {
        throw new Error('Exchange HTTP request timed out');
      }
    };
    const timeoutGateway = new ExecutionGateway({
      store,
      authority,
      getTransport: () => timeoutTransport,
      getAccountPolicy: () => ({
        activeConfigVersion: 1,
        safetyNetUsdt: '200',
        maxPositions: 4,
        dailyLossCapUsdt: '50',
        minEntryConfidencePct: 75
      }),
      readFreshMarket: () => makeFreshMarket('68500')
    });

    const timeoutReceipt = await timeoutGateway.submit({
      ...intent,
      intentId: 'intent-timeout-1',
      symbol: 'ETHUSDT',
      stop: '2400'
    });
    expect(timeoutReceipt.orderState).toBe('UNKNOWN');
    expect(timeoutReceipt.filledQty).toBeNull();

    // Direct Owner close is never blocked by entry confidence, full slots or daily loss cap.
    let closeSubmitted = false;
    const closeTransport: GatewayVenueTransport = {
      ...transport,
      balance: async () => ({
        balanceUsdt: '940',
        availableUsdt: '150',
        realizedDailyPnlUsdt: '-60'
      }),
      positions: async () => [
        {
          positionKey: 'BTCUSDT:ONE_WAY',
          symbol: 'BTCUSDT',
          side: 'LONG',
          qty: '0.01',
          entryPrice: '68500'
        }
      ],
      closePosition: async (pos, clientOrderId) => {
        closeSubmitted = true;
        return {
          clientOrderId,
          venueOrderId: 'close-owner-1',
          state: 'FILLED',
          filledQty: pos.qty
        };
      }
    };

    const closeGateway = new ExecutionGateway({
      store,
      authority,
      getTransport: () => closeTransport,
      getAccountPolicy: () => ({
        activeConfigVersion: 1,
        safetyNetUsdt: '200',
        maxPositions: 1,
        dailyLossCapUsdt: '50',
        minEntryConfidencePct: 95,
        currentLeadProbability: 0.1
      }),
      readFreshMarket: () => makeFreshMarket('68200')
    });

    const closeReceipt = await closeGateway.close({
      intentId: 'intent-owner-close-1',
      accountRef,
      configVersion: 1,
      authorityEpoch: epoch,
      symbol: 'BTCUSDT',
      side: 'LONG',
      quantity: '0.01',
      ownerAuthorized: true
    });
    const ownerCloseBlockedByEntryConfidence = closeReceipt.orderState !== 'FILLED' || !closeSubmitted;
    expect(ownerCloseBlockedByEntryConfidence).toBe(false);

    // Remote callback trade.status projection performs zero native order writes.
    let callbackTradeStatusNativeWrites = 0;
    const spyTransport: GatewayVenueTransport = {
      ...transport,
      submitOrder: async (o) => {
        callbackTradeStatusNativeWrites += 1;
        return transport.submitOrder(o);
      },
      cancelEntryOrder: async (s, c) => {
        callbackTradeStatusNativeWrites += 1;
        return transport.cancelEntryOrder(s, c);
      },
      closePosition: async (p, c) => {
        callbackTradeStatusNativeWrites += 1;
        return transport.closePosition(p, c);
      }
    };
    const callbackGateway = new ExecutionGateway({
      store,
      authority,
      getTransport: () => spyTransport,
      getAccountPolicy: () => ({
        activeConfigVersion: 1,
        safetyNetUsdt: '200',
        maxPositions: 2,
        dailyLossCapUsdt: '50',
        minEntryConfidencePct: 70
      }),
      readFreshMarket: () => makeFreshMarket('68500')
    });
    await callbackGateway.recordExternalStatusObservation({
      accountRef,
      source: 'grok.callback.trade.status',
      payload: { symbol: 'BTCUSDT', reportedState: 'FILLED' }
    });
    expect(callbackTradeStatusNativeWrites).toBe(0);
  });

  it('aborts before submit on journal disk error, blocks OPEN on daily-loss latch, and recovers after restart via lookupOrder without resending', async () => {
    const { dbPath, store, accountRef, authority, epoch } = await createTestStore();

    let diskFailedSubmits = 0;

    const baseTransport: GatewayVenueTransport = {
      balance: async () => ({ balanceUsdt: '1000', availableUsdt: '1000', realizedDailyPnlUsdt: '0' }),
      positions: async () => [],
      submitOrder: async (o) => {
        diskFailedSubmits += 1;
        return { clientOrderId: o.clientOrderId, venueOrderId: 'ord-x', state: 'ACCEPTED', filledQty: '0' };
      },
      lookupOrder: async (_sym, clientOrderId) => ({
        clientOrderId,
        venueOrderId: 'ord-recovered',
        state: 'FILLED',
        filledQty: '0.02'
      }),
      cancelEntryOrder: async (_sym, c) => ({ clientOrderId: c, venueOrderId: 'ord-x', state: 'CANCELLED', filledQty: '0' }),
      readProtection: async (pos) => ({ state: 'VERIFIED', coveredQty: pos.qty, stopPrice: '66000', reduceOnly: true }),
      placeProtection: async (pos, stop) => ({ state: 'VERIFIED', coveredQty: pos.qty, stopPrice: stop, reduceOnly: true }),
      closePosition: async (pos, c) => ({ clientOrderId: c, venueOrderId: 'cl', state: 'FILLED', filledQty: pos.qty })
    };

    store.simulateWriteFailure('SQLITE_FULL: database or disk is full');
    const diskFailGw = new ExecutionGateway({
      store,
      authority,
      getTransport: () => baseTransport,
      getAccountPolicy: () => ({
        activeConfigVersion: 1,
        safetyNetUsdt: '200',
        maxPositions: 2,
        dailyLossCapUsdt: '50',
        minEntryConfidencePct: 60
      }),
      readFreshMarket: () => makeFreshMarket('68500')
    });

    const diskErrReceipt = await diskFailGw.submit({
      intentId: 'intent-disk-full',
      accountRef,
      configVersion: 1,
      authorityEpoch: epoch,
      action: 'OPEN',
      symbol: 'BTCUSDT',
      side: 'LONG',
      quantity: '0.02',
      entry: null,
      stop: '66000',
      tp: null,
      leverage: 5,
      thesisId: 'th-disk'
    });
    expect(diskErrReceipt.orderState).toBe('REJECTED');
    expect(diskFailedSubmits).toBe(0);

    // Halt latch engages in memory immediately even when store persistence fails!
    const degradedHalt = await diskFailGw.halt({
      requestId: 'halt-disk-full',
      accountRef,
      source: 'local.owner',
      policy: 'HALT_ONLY'
    });
    expect(degradedHalt.halted).toBe(true);
    expect(degradedHalt.persisted).toBe(false);
    store.simulateWriteFailure(null);

    // Daily loss cap hit blocks new OPEN on healthy store.
    const dailyCapTransport: GatewayVenueTransport = {
      ...baseTransport,
      balance: async () => ({ balanceUsdt: '1000', availableUsdt: '1000', realizedDailyPnlUsdt: '-75' })
    };
    const dailyCapGw = new ExecutionGateway({
      store,
      authority,
      getTransport: () => dailyCapTransport,
      getAccountPolicy: () => ({
        activeConfigVersion: 1,
        safetyNetUsdt: '200',
        maxPositions: 2,
        dailyLossCapUsdt: '50',
        minEntryConfidencePct: 60
      }),
      readFreshMarket: () => makeFreshMarket('68500')
    });
    const dailyRejected = await dailyCapGw.submit({
      intentId: 'intent-daily-cap',
      accountRef,
      configVersion: 1,
      authorityEpoch: epoch,
      action: 'OPEN',
      symbol: 'BTCUSDT',
      side: 'LONG',
      quantity: '0.02',
      entry: null,
      stop: '66000',
      tp: null,
      leverage: 5,
      thesisId: 'th-cap'
    });
    expect(dailyRejected.orderState).toBe('REJECTED');
    expect(dailyRejected.reason).toMatch(/daily loss/i);

    // Simulate crash/restart after venue accepted order while local intent stayed UNKNOWN.
    const nowIso = new Date().toISOString();
    await store.execute(
      `INSERT INTO execution_intents (
        account_ref, intent_id, client_order_id, cycle_id, symbol, side, intent_kind,
        order_state, protection_state, venue_order_id, payload_json, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, 'BTCUSDT', 'LONG', 'OPEN', 'UNKNOWN', 'PENDING', NULL, ?, ?, ?)`,
      [
        accountRef,
        'intent-crash-after-accept',
        'cid-crash-after-accept',
        JSON.stringify({ stop: '66000', quantity: '0.02' }),
        nowIso,
        nowIso
      ]
    );

    const restartedStore = await RuntimeStore.open(dbPath);
    openStores.push(restartedStore);
    const restartedAuth = new ExecutionAuthorityService(restartedStore, 'holder-main');
    let submitsDuringRecovery = 0;

    const restartedGw = new ExecutionGateway({
      store: restartedStore,
      authority: restartedAuth,
      getTransport: () => ({
        ...baseTransport,
        positions: async () => [
          {
            positionKey: 'BTCUSDT:ONE_WAY',
            symbol: 'BTCUSDT',
            side: 'LONG',
            qty: '0.02',
            entryPrice: '68400'
          }
        ],
        submitOrder: async () => {
          submitsDuringRecovery += 1;
          throw new Error('submitOrder disabled during recovery');
        }
      }),
      getAccountPolicy: () => ({
        activeConfigVersion: 1,
        safetyNetUsdt: '200',
        maxPositions: 2,
        dailyLossCapUsdt: '50',
        minEntryConfidencePct: 60
      }),
      readFreshMarket: () => makeFreshMarket('68400')
    });

    const recon = await restartedGw.reconcile(accountRef);
    expect(submitsDuringRecovery).toBe(0);
    expect(recon.protection['BTCUSDT:ONE_WAY']).toBe('VERIFIED');
  });
});
