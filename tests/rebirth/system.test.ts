import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createReplacementRuntime } from '../../server/v2/runtime.js';
import { RuntimeStore } from '../../server/v2/store/database.js';
import { AccountRegistry } from '../../server/v2/accounts/registry.js';
import { ExecutionAuthorityService } from '../../server/v2/accounts/authority.js';
import { ExecutionGateway } from '../../server/v2/execution/gateway.js';
import { PaperVenue } from '../../server/v2/sandbox/paper.js';
import { ReportsService } from '../../server/v2/reports.js';

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
        rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Ignore transient Windows lock release delay in temp cleanup
      }
    }
  }
});

async function createTestStore() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mpu-sys-test-'));
  tempDirs.push(dir);
  const dbPath = path.join(dir, 'runtime.sqlite');
  const store = await RuntimeStore.open(dbPath);
  openStores.push(store);
  const authority = new ExecutionAuthorityService(store, 'sys-main');
  return { dir, store, authority };
}

describe('T18 Whole-System End-to-End Scenarios Verification', () => {
  it('system_handles_complete_bullish_cycle_and_maintains_zero_secret_exposure', async () => {
    const runtime = createReplacementRuntime();
    const state = runtime.snapshot();

    // 1. Snapshot exposes zero secrets
    const serializedState = JSON.stringify(state);
    expect(serializedState).not.toMatch(/api_key|secret|password|private_key/i);

    // 2. Paper venue handles clean end-to-end execution
    const paper = new PaperVenue({ initialBalance: '1000' });
    const orderReceipt = await paper.submit({
      clientOrderId: 'sys-ord-1',
      symbol: 'BTCUSDT',
      side: 'LONG',
      positionMode: 'ONE_WAY',
      hedgeLeg: null,
      orderType: 'MARKET',
      quantity: '0.010',
      limitPrice: null,
      leverage: 3,
      expireAt: null
    });

    expect(orderReceipt.state).toBe('FILLED');
    expect(orderReceipt.reason).toBe('SIMULATED');

    const positions = await paper.positions();
    expect(positions.length).toBe(1);

    // 3. Resting protection verified
    const prot = await paper.protect(positions[0], {
      clientOrderId: 'sys-prot-1',
      stopPrice: '62000',
      tpPrice: '72000',
      triggerBy: 'LAST_PRICE'
    });
    expect(prot.state).toBe('VERIFIED');
    expect(prot.reason).toBe('SIMULATED');

    // 4. Reports generated without secret leaks
    const reportsService = new ReportsService();
    const report = reportsService.generateReportNow(runtime);
    expect(report.id).toBeDefined();
    expect(report.text).not.toMatch(/key|secret|token/i);
  });

  it('account_switch_with_exposure_retains_draining_mode', async () => {
    const { store, authority } = await createTestStore();
    const registry = await AccountRegistry.open(store, authority);

    const acct1 = await registry.register({
      venue: 'bybit',
      network: 'mainnet',
      mode: 'PAPER',
      nativeIdentity: 'uid-alpha',
      subaccountRef: null
    });

    const acct2 = await registry.register({
      venue: 'bybit',
      network: 'mainnet',
      mode: 'PAPER',
      nativeIdentity: 'uid-beta',
      subaccountRef: null
    });

    await registry.activate(acct1.accountRef);
    await registry.attachExposure(acct1.accountRef, { positionRefs: ['pos-btc-1'] });
    await registry.activate(acct2.accountRef);

    const contexts = registry.contexts();
    const alphaContext = contexts.find((c) => c.scope.accountRef === acct1.accountRef);
    const betaContext = contexts.find((c) => c.scope.accountRef === acct2.accountRef);

    expect(alphaContext?.lifecycle).toBe('DRAINING');
    expect(betaContext?.lifecycle).toBe('ACTIVE');
  });

  it('fails_closed_when_mandatory_resting_stop_is_missing', async () => {
    const { store, authority } = await createTestStore();
    const registry = await AccountRegistry.open(store, authority);
    const acct = await registry.register({
      venue: 'bybit',
      network: 'testnet',
      mode: 'TESTNET',
      nativeIdentity: 'uid-gate-test',
      subaccountRef: null
    });
    const lease = await authority.claim(acct.accountRef, 'sys-main');

    const gateway = new ExecutionGateway({
      store,
      authority,
      getTransport: () => ({
        balance: async () => ({ balanceUsdt: '1000', availableUsdt: '1000', realizedDailyPnlUsdt: '0' }),
        positions: async () => [],
        submitOrder: async () => ({} as any),
        protection: async () => ({} as any),
        protectPosition: async () => ({} as any),
        closePosition: async () => ({} as any)
      }),
      getAccountPolicy: () => ({
        activeConfigVersion: 1,
        safetyNetUsdt: '200',
        maxPositions: 2,
        dailyLossCapUsdt: '50',
        minEntryConfidencePct: 75
      }),
      readFreshMarket: () => ({
        evidenceId: 'ev-1',
        revision: 1,
        symbol: 'BTCUSDT',
        venue: 'bybit',
        category: 'linear',
        marketPrice: '68500',
        markPrice: '68500',
        orderbook: { bids: [['68499', '1']], asks: [['68501', '1']], observedAt: Date.now() },
        freshness: 'CURRENT',
        observedAt: Date.now()
      })
    });

    // Intent without resting stop must fail closed
    const result = await gateway.submit({
      intentId: 'bad-intent-no-stop',
      accountRef: acct.accountRef,
      configVersion: 1,
      authorityEpoch: lease.writerEpoch,
      symbol: 'BTCUSDT',
      side: 'LONG',
      orderType: 'MARKET',
      quantity: '0.010',
      limitPrice: null,
      stop: null, // Missing stop!
      takeProfit: null,
      leverage: 2,
      riskAssessment: { approved: true, riskRatio: '0.02' }
    });

    expect(result.orderState).toBe('REJECTED');
    expect(result.reason).toContain('Every OPEN intent requires a stop price');
  });
});
