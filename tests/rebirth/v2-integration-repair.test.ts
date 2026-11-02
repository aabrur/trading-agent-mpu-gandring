import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import { RoleRunner } from '../../server/v2/agents/runner.js';
import { CycleRunner } from '../../server/v2/decision/cycle.js';
import { AccountRegistry } from '../../server/v2/accounts/registry.js';
import { ExecutionAuthorityService } from '../../server/v2/accounts/authority.js';
import { RuntimeStore } from '../../server/v2/store/database.js';
import {
  ExecutionGateway,
  type GatewayVenueTransport,
  type TradeIntent
} from '../../server/v2/execution/gateway.js';
import { createVenueAdapter } from '../../server/v2/execution/adapters/aster.js';
import { createTransportFromAdapter } from '../../server/v2/execution/adapters/factory.js';
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
        // Windows WAL handles can lag behind test teardown.
      }
    }
  }
});

function makeFreshMarket(price = '68500'): MarketFrame {
  return {
    evidenceId: 'ev-int-mkt',
    revision: 1,
    symbol: 'BTCUSDT',
    venue: 'aster',
    category: 'linear',
    asOf: Date.now(),
    last: verifiedEvidence({ value: price, source: 'aster.tickers.BTCUSDT', unit: 'USDT' }),
    bid: verifiedEvidence({ value: price, source: 'aster.tickers.BTCUSDT', unit: 'USDT' }),
    ask: verifiedEvidence({ value: price, source: 'aster.tickers.BTCUSDT', unit: 'USDT' }),
    closed: { '1m': [], '5m': [], '15m': [], '1h': [], '4h': [], '1d': [] },
    current: {},
    tradesEvidenceId: null,
    bookEvidenceId: null,
    funding: unavailableEvidence('aster.tickers.BTCUSDT', 'n/a'),
    openInterest: unavailableEvidence('aster.tickers.BTCUSDT', 'n/a')
  };
}

describe('Approved order consistency', () => {
  it('gives Risk and Lead the same Owner candidate including side', async () => {
    const seen: Array<{ role: string; user: string }> = [];
    const runner = new RoleRunner({
      providerCaller: async (req) => {
        seen.push({ role: req.role, user: req.user });
        if (req.role === 'risk') {
          return JSON.stringify({
            stance: 'LONG',
            decision: 'APPROVE',
            claimRefs: ['ev-1'],
            contraryRefs: [],
            reasoning: 'Candidate matches Owner caps.',
            confidence: { value: 0.8, scale: 'probability_0_1' }
          });
        }
        if (req.role === 'execution') {
          return JSON.stringify({
            stance: 'LONG',
            claimRefs: ['ev-1'],
            contraryRefs: [],
            reasoning: 'Resting limit is the candidate.',
            confidence: { value: 0.7, scale: 'probability_0_1' },
            proposedStop: '67000',
            proposedTp: '72000',
            proposedOrderType: 'LIMIT_GTC',
            proposedLimitPrice: '68400'
          });
        }
        if (req.role === 'lead') {
          return JSON.stringify({
            stance: 'LONG',
            claimRefs: ['ev-1'],
            contraryRefs: [],
            reasoning: 'Lead keeps the working ticket.',
            confidence: { value: 0.4, scale: 'probability_0_1' },
            proposedStop: '67000',
            proposedTp: '72000',
            proposedOrderType: 'LIMIT_GTC',
            proposedLimitPrice: '68400'
          });
        }
        return JSON.stringify({
          stance: 'LONG',
          claimRefs: ['ev-1'],
          contraryRefs: [],
          reasoning: `${req.role} observe`,
          confidence: { value: 0.7, scale: 'probability_0_1' },
          proposedStop: '67000'
        });
      },
      resolveAssignment: () => ({ provider: 'openai', model: 'gpt-5', apiKey: 'sk-test' })
    });

    const out = await new CycleRunner({ roleRunner: runner }).run({
      cycleId: 'cycle-candidate-consistency',
      reason: 'owner',
      accountRef: 'paper:default',
      symbol: 'BTCUSDT',
      evidenceId: 'ev-1',
      configVersion: 1,
      policy: {
        minEntryConfidencePct: 60,
        requireTwoOfThreeAnalysts: false,
        maxLeverage: 5,
        defaultStopPct: 20,
        takeProfitPct: 40,
        availableCapitalUsdt: 800,
        allocationPerOrderUsdt: 266.66,
        maxPositions: 3,
        orderSizePct: null,
        dailyLossLimitPct: 10
      },
      marketSummary: { last: '68500' }
    });

    expect(out.verdict?.action).toBe('OPEN_LONG');
    expect(out.verdict?.thesis?.orderType).toBe('LIMIT_GTC');
    expect(out.verdict?.thesis?.limitPrice).toBe('68400');
    expect(out.verdict?.thesis?.stop).toBe('67000');
    expect(out.verdict?.thesis?.tp).toBe('72000');

    const riskPrompt = seen.find((s) => s.role === 'risk')?.user ?? '';
    const leadPrompt = seen.find((s) => s.role === 'lead')?.user ?? '';
    for (const prompt of [riskPrompt, leadPrompt]) {
      expect(prompt).toContain('"side": "LONG"');
      expect(prompt).toContain('LIMIT_GTC');
      expect(prompt).toContain('68400');
      expect(prompt).toContain('67000');
      expect(prompt).toContain('72000');
      expect(prompt).toContain('"maxLeverage": 5');
      expect(prompt).toContain('266.66');
    }
  });
});

describe('Reconciliation P0', () => {
  it('promotes ACCEPTED to FILLED without a second submit and places the resting stop', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mpu-recon-'));
    tempDirs.push(dir);
    const store = await RuntimeStore.open(path.join(dir, 'runtime.sqlite'));
    openStores.push(store);
    const authority = new ExecutionAuthorityService(store, 'holder-main');
    const registry = await AccountRegistry.open(store, authority);
    const account = await registry.register({
      venue: 'bybit',
      network: 'testnet',
      mode: 'TESTNET',
      nativeIdentity: 'uid-recon-1',
      subaccountRef: null
    });
    const lease = await authority.claim(account.accountRef, 'holder-main');

    let submits = 0;
    let lookups = 0;
    let orderState: 'ACCEPTED' | 'FILLED' = 'ACCEPTED';
    let posQty = '0';
    const stops: string[] = [];

    const transport: GatewayVenueTransport = {
      balance: async () => ({
        balanceUsdt: '1000',
        availableUsdt: '1000',
        realizedDailyPnlUsdt: '0'
      }),
      positions: async () =>
        posQty === '0'
          ? []
          : [
              {
                positionKey: 'BTCUSDT:ONE_WAY',
                symbol: 'BTCUSDT',
                side: 'LONG',
                qty: posQty,
                entryPrice: '68400'
              }
            ],
      submitOrder: async (order) => {
        submits += 1;
        return {
          clientOrderId: order.clientOrderId,
          venueOrderId: 'ord-resting-1',
          state: 'ACCEPTED',
          filledQty: null
        };
      },
      lookupOrder: async (_symbol, clientOrderId) => {
        lookups += 1;
        return {
          clientOrderId,
          venueOrderId: 'ord-resting-1',
          state: orderState,
          filledQty: orderState === 'FILLED' ? '0.02' : null
        };
      },
      cancelEntryOrder: async (_symbol, clientOrderId) => ({
        clientOrderId,
        venueOrderId: 'ord-resting-1',
        state: 'CANCELLED',
        filledQty: '0'
      }),
      readProtection: async () => ({
        state: 'MISSING',
        coveredQty: '0',
        stopPrice: null,
        reduceOnly: true
      }),
      placeProtection: async (pos, stopPrice) => {
        stops.push(stopPrice);
        return {
          state: 'VERIFIED',
          coveredQty: pos.qty,
          stopPrice,
          reduceOnly: true
        };
      },
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
        minEntryConfidencePct: 60
      }),
      readFreshMarket: () => makeFreshMarket('68500')
    });

    const intent: TradeIntent = {
      intentId: 'intent-limit-1',
      accountRef: account.accountRef,
      configVersion: 1,
      authorityEpoch: lease.writerEpoch,
      action: 'OPEN',
      symbol: 'BTCUSDT',
      side: 'LONG',
      quantity: '0.02',
      entry: '68400',
      stop: '67000',
      tp: '72000',
      leverage: 5,
      thesisId: 'thesis-limit-1',
      orderType: 'LIMIT_GTC',
      limitPrice: '68400'
    };

    const accepted = await gateway.submit(intent);
    expect(accepted.orderState).toBe('ACCEPTED');
    expect(accepted.filledQty).toBeNull();
    expect(submits).toBe(1);

    orderState = 'FILLED';
    posQty = '0.02';
    const recon = await gateway.reconcile(account.accountRef);
    expect(submits).toBe(1);
    expect(lookups).toBeGreaterThan(0);
    expect(recon.pending.some((p) => p.orderState === 'ACCEPTED')).toBe(false);
    expect(recon.protection['BTCUSDT:ONE_WAY']).toBe('VERIFIED');
    expect(stops).toEqual(['67000']);

    const second = await gateway.reconcile(account.accountRef);
    expect(submits).toBe(1);
    expect(second.protection['BTCUSDT:ONE_WAY']).toBe('VERIFIED');
  });
});

describe('Aster LIMIT_GTC through ExecutionGateway', () => {
  it('quantizes the limit, returns ACCEPTED, then FILLED on lookup without resubmitting', async () => {
    const ownerKey = generatePrivateKey();
    const owner = privateKeyToAccount(ownerKey);
    const agentKey = generatePrivateKey();
    const agent = privateKeyToAccount(agentKey);

    let submitted = 0;
    let orderStatus = 'NEW';
    let executedQty = '0';
    const posted: Array<{ type: string | null; price: string | null; tif: string | null }> = [];

    const jsonResponse = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
      });

    const adapter = createVenueAdapter({
      network: 'testnet',
      credentialRef: 'cred://aster/agent',
      readSecret: async () => ({
        key: owner.address,
        secret: agentKey,
        verifiedAgentAddress: agent.address
      }),
      fetchImpl: (async (input, init) => {
        const url = new URL(String(input));
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.pathname === '/fapi/v3/exchangeInfo') {
          return jsonResponse({
            symbols: [
              {
                symbol: 'BTCUSDT',
                contractType: 'PERPETUAL',
                contractSize: 1,
                quoteAsset: 'USDT',
                filters: [
                  { filterType: 'PRICE_FILTER', tickSize: '0.1' },
                  { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '50' },
                  { filterType: 'MIN_NOTIONAL', notional: '5' }
                ]
              }
            ]
          });
        }
        if (url.pathname === '/fapi/v3/ticker/price') {
          return jsonResponse({ symbol: 'BTCUSDT', price: '68500.0', time: Date.now() });
        }
        if (url.pathname === '/fapi/v3/account') {
          return jsonResponse({ totalMarginBalance: '1000', availableBalance: '900', canTrade: true, canWithdraw: true });
        }
        if (url.pathname === '/fapi/v3/leverage') {
          return jsonResponse({ leverage: 5, symbol: 'BTCUSDT' });
        }
        if (url.pathname === '/fapi/v3/order' && method === 'POST') {
          posted.push({
            type: url.searchParams.get('type'),
            price: url.searchParams.get('price'),
            tif: url.searchParams.get('timeInForce')
          });
          if (url.searchParams.get('type') === 'LIMIT') submitted += 1;
          return jsonResponse({
            orderId: 9001,
            clientOrderId: url.searchParams.get('newClientOrderId'),
            status: 'NEW'
          });
        }
        if (url.pathname === '/fapi/v3/order' && method === 'GET') {
          return jsonResponse({
            orderId: 9001,
            clientOrderId: url.searchParams.get('origClientOrderId'),
            status: orderStatus,
            executedQty,
            avgPrice: executedQty === '0' ? '0' : '68450.1'
          });
        }
        if (url.pathname === '/fapi/v3/positionRisk') {
          return jsonResponse(
            executedQty === '0'
              ? []
              : [
                  {
                    symbol: 'BTCUSDT',
                    positionSide: 'BOTH',
                    positionAmt: executedQty,
                    entryPrice: '68450.1',
                    leverage: '5',
                    unRealizedProfit: null
                  }
                ]
          );
        }
        if (url.pathname === '/fapi/v3/openOrders') {
          return jsonResponse([]);
        }
        return jsonResponse({});
      }) as typeof fetch
    });

    const dir = mkdtempSync(path.join(os.tmpdir(), 'mpu-aster-gw-'));
    tempDirs.push(dir);
    const store = await RuntimeStore.open(path.join(dir, 'runtime.sqlite'));
    openStores.push(store);
    const authority = new ExecutionAuthorityService(store, 'holder-main');
    const registry = await AccountRegistry.open(store, authority);
    const account = await registry.register({
      venue: 'aster',
      network: 'testnet',
      mode: 'TESTNET',
      nativeIdentity: owner.address,
      subaccountRef: null
    });
    const lease = await authority.claim(account.accountRef, 'holder-main');

    const gateway = new ExecutionGateway({
      store,
      authority,
      getTransport: () => createTransportFromAdapter(adapter),
      getAccountPolicy: () => ({
        activeConfigVersion: 1,
        safetyNetUsdt: '200',
        maxPositions: 2,
        dailyLossCapUsdt: '50',
        minEntryConfidencePct: 60
      }),
      readFreshMarket: () => makeFreshMarket('68500')
    });

    const receipt = await gateway.submit({
      intentId: 'intent-aster-gtc',
      accountRef: account.accountRef,
      configVersion: 1,
      authorityEpoch: lease.writerEpoch,
      action: 'OPEN',
      symbol: 'BTCUSDT',
      side: 'LONG',
      quantity: '0.0259',
      entry: '68450.19',
      stop: '67000',
      tp: '72000',
      leverage: 5,
      thesisId: 'thesis-aster-gtc',
      orderType: 'LIMIT_GTC',
      limitPrice: '68450.19'
    });

    expect(receipt.orderState).toBe('ACCEPTED');
    expect(receipt.filledQty).toBeNull();
    expect(submitted).toBe(1);
    expect(posted.some((p) => p.type === 'LIMIT' && p.price === '68450.1' && p.tif === 'GTC')).toBe(true);

    orderStatus = 'FILLED';
    executedQty = '0.025';
    const recon = await gateway.reconcile(account.accountRef);
    expect(submitted).toBe(1);
    expect(recon.pending.some((p) => p.clientOrderId === receipt.clientOrderId && p.orderState === 'ACCEPTED')).toBe(
      false
    );
  });
});
