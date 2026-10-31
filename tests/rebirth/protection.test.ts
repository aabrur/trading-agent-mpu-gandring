import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeStore } from '../../server/v2/store/database.js';
import { AccountRegistry } from '../../server/v2/accounts/registry.js';
import { ExecutionAuthorityService } from '../../server/v2/accounts/authority.js';
import { ensureExposureProtection } from '../../server/v2/execution/protection.js';
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

function makeMarket(price = '68500'): MarketFrame {
  return {
    evidenceId: 'ev-prot',
    revision: 1,
    symbol: 'BTCUSDT',
    venue: 'bybit',
    category: 'linear',
    asOf: Date.now(),
    last: verifiedEvidence({ value: price, source: 'bybit', unit: 'USDT' }),
    bid: verifiedEvidence({ value: price, source: 'bybit', unit: 'USDT' }),
    ask: verifiedEvidence({ value: price, source: 'bybit', unit: 'USDT' }),
    closed: { '1m': [], '5m': [], '15m': [], '1h': [], '4h': [], '1d': [] },
    current: {},
    tradesEvidenceId: null,
    bookEvidenceId: null,
    funding: unavailableEvidence('bybit', 'n/a'),
    openInterest: unavailableEvidence('bybit', 'n/a')
  };
}

describe('T09 quantity-matched stop protection, partial fill during cancel and emergency flatten on missing stop', () => {
  it('protects exact partial exposure, reconciles additional fill during cancel, and emergency-closes when stop cannot be verified', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mpu-prot-test-'));
    tempDirs.push(dir);
    const store = await RuntimeStore.open(path.join(dir, 'runtime.sqlite'));
    openStores.push(store);
    const authority = new ExecutionAuthorityService(store, 'holder-prot');
    const registry = await AccountRegistry.open(store, authority);
    const account = await registry.register({
      venue: 'aster',
      network: 'testnet',
      mode: 'TESTNET',
      nativeIdentity: '0xabc123',
      subaccountRef: null
    });
    await authority.claim(account.accountRef, 'holder-prot');

    let currentNativeExposure = '0.03';
    let confirmedStop = {
      state: 'MISSING' as 'VERIFIED' | 'MISSING' | 'UNVERIFIED',
      coveredQty: '0',
      stopPrice: '67000',
      reduceOnly: true
    };

    const partialRes = await ensureExposureProtection({
      position: {
        positionKey: 'BTCUSDT:ONE_WAY',
        symbol: 'BTCUSDT',
        side: 'LONG',
        qty: currentNativeExposure,
        entryPrice: '68500'
      },
      desiredStopPrice: '67000',
      readProtection: async () => confirmedStop,
      placeProtection: async (pos, stopPrice) => {
        confirmedStop = {
          state: 'VERIFIED',
          coveredQty: pos.qty,
          stopPrice,
          reduceOnly: true
        };
        return confirmedStop;
      },
      emergencyClose: async () => {
        throw new Error('Should not emergency-close when protection placement succeeds');
      }
    });

    expect(partialRes.protectionState).toBe('VERIFIED');
    expect(confirmedStop.coveredQty).toBe(currentNativeExposure);

    // Simulate partial fill increasing from 0.03 -> 0.05 right as remaining GTC entry is cancelled!
    currentNativeExposure = '0.05';
    const afterCancelRes = await ensureExposureProtection({
      position: {
        positionKey: 'BTCUSDT:ONE_WAY',
        symbol: 'BTCUSDT',
        side: 'LONG',
        qty: currentNativeExposure,
        entryPrice: '68490'
      },
      desiredStopPrice: '67000',
      readProtection: async () => confirmedStop, // still only covers 0.03!
      placeProtection: async (pos, stopPrice) => {
        // Replacement placed before old stop would ever leave exposure naked
        confirmedStop = {
          state: 'VERIFIED',
          coveredQty: pos.qty,
          stopPrice,
          reduceOnly: true
        };
        return confirmedStop;
      },
      emergencyClose: async () => {
        throw new Error('Should repair quantity mismatch without emergency flatten');
      }
    });
    expect(afterCancelRes.protectionState).toBe('VERIFIED');
    expect(confirmedStop.coveredQty).toBe(currentNativeExposure);

    // Stop lookup/placement outage -> triggers emergency flatten so position never rests naked!
    let emergencyClosed = false;
    const outageTransport: GatewayVenueTransport = {
      balance: async () => ({ balanceUsdt: '1000', availableUsdt: '1000', realizedDailyPnlUsdt: '0' }),
      positions: async () => [
        {
          positionKey: 'BTCUSDT:ONE_WAY',
          symbol: 'BTCUSDT',
          side: 'LONG',
          qty: '0.02',
          entryPrice: '68500'
        }
      ],
      submitOrder: async (o) => ({
        clientOrderId: o.clientOrderId,
        venueOrderId: 'ord-outage',
        state: 'FILLED',
        filledQty: o.quantity
      }),
      lookupOrder: async (_s, c) => ({ clientOrderId: c, venueOrderId: 'ord-outage', state: 'FILLED', filledQty: '0.02' }),
      cancelEntryOrder: async (_s, c) => ({ clientOrderId: c, venueOrderId: 'ord-outage', state: 'CANCELLED', filledQty: '0.02' }),
      readProtection: async () => ({ state: 'MISSING', coveredQty: '0', stopPrice: null, reduceOnly: false }),
      placeProtection: async () => ({ state: 'UNVERIFIED', coveredQty: '0', stopPrice: null, reduceOnly: false }),
      closePosition: async (pos, c) => {
        emergencyClosed = true;
        return { clientOrderId: c, venueOrderId: 'emerg-close', state: 'FILLED', filledQty: pos.qty };
      }
    };

    const gw = new ExecutionGateway({
      store,
      authority,
      getTransport: () => outageTransport,
      getAccountPolicy: () => ({
        activeConfigVersion: 1,
        safetyNetUsdt: '200',
        maxPositions: 2,
        dailyLossCapUsdt: '50',
        minEntryConfidencePct: 60
      }),
      readFreshMarket: () => makeMarket('68500')
    });

    const receipt = await gw.submit({
      intentId: 'intent-unprotected-1',
      accountRef: account.accountRef,
      configVersion: 1,
      authorityEpoch: 1,
      action: 'OPEN',
      symbol: 'BTCUSDT',
      side: 'LONG',
      quantity: '0.02',
      entry: null,
      stop: '67000',
      tp: null,
      leverage: 5,
      thesisId: 'th-prot'
    });

    expect(emergencyClosed).toBe(true);
    expect(receipt.protectionState).toBe('MISSING');
  });
});
