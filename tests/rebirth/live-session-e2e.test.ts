import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { AccountRegistry } from '../../server/v2/accounts/registry.js';
import { ExecutionAuthorityService } from '../../server/v2/accounts/authority.js';
import { RoleRunner } from '../../server/v2/agents/runner.js';
import { createReplacementApp } from '../../server/v2/app.js';
import { ChatService } from '../../server/v2/api/chat.js';
import {
  ROLE_IDS,
  availableFinancialField,
  unavailableFinancialField,
  type OfficeCommand,
  type OfficeReply,
  type OfficeState
} from '../../server/v2/contracts.js';
import { createVenueAdapter } from '../../server/v2/execution/adapters/bybit.js';
import { createTransportFromAdapter } from '../../server/v2/execution/adapters/factory.js';
import { assertLivePermissionEvidence } from '../../server/v2/execution/adapters/types.js';
import { ExecutionGateway } from '../../server/v2/execution/gateway.js';
import { BybitMarketHub, type BybitWsLike } from '../../server/v2/market/bybit.js';
import { attachOfficeWebSocket } from '../../server/v2/office.js';
import { createReplacementRuntime, validateStartupEnvironment } from '../../server/v2/runtime.js';
import { SecretStore } from '../../server/v2/settings/secrets.js';
import { SettingsService } from '../../server/v2/settings/service.js';
import { RuntimeStore } from '../../server/v2/store/database.js';

const LIVE_KEY = 'bybitMainnetKey00001';
const LIVE_SECRET = 'bybitMainnetSecret99999999999999';

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

class MockBybitWs implements BybitWsLike {
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  on(event: 'open' | 'message' | 'close' | 'error', listener: (...args: unknown[]) => void): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
  }
  send(_payload: string): void {}
  close(): void {}
  emit(event: string, ...args: unknown[]): void {
    for (const fn of this.listeners.get(event) ?? []) fn(...args);
  }
}

function makeFreshKlines(basePrice: number, count = 40, intervalMs = 900_000): string[][] {
  const now = Date.now();
  const rows: string[][] = [];
  // Bybit REST returns newest-first
  for (let i = 0; i < count; i += 1) {
    const start = now - (i + 1) * intervalMs;
    const close = basePrice - i * 12;
    const open = close - 8;
    const high = Math.max(open, close) + 15;
    const low = Math.min(open, close) - 12;
    rows.push([
      String(start),
      open.toFixed(1),
      high.toFixed(1),
      low.toFixed(1),
      close.toFixed(1),
      '42.5',
      String(Math.round(close * 42.5))
    ]);
  }
  return rows;
}

describe('LIVE session E2E lifecycle, safety gates, and 6-agent live Q&A', () => {
  const dbFiles: string[] = [];

  afterEach(() => {
    while (dbFiles.length > 0) {
      const f = dbFiles.pop()!;
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          rmSync(`${f}${suffix}`, { force: true, maxRetries: 5, retryDelay: 50 });
        } catch {}
      }
    }
  });

  it('refuses LIVE startup without credentials and blocks mock inference in LIVE RoleRunner', async () => {
    expect(() =>
      validateStartupEnvironment({
        TRADING_MODE: 'LIVE',
        EXCHANGE: 'bybit',
        BYBIT_API_KEY: '',
        BYBIT_API_SECRET: ''
      })
    ).toThrow(/keys are missing/i);

    const withdrawAdapter = createVenueAdapter({
      network: 'mainnet',
      credentialRef: 'bybit:mainnet',
      readSecret: async () => ({ key: LIVE_KEY, secret: LIVE_SECRET }),
      fetchImpl: (async (input) => {
        const url = new URL(String(input));
        if (url.pathname === '/v5/market/time') {
          return jsonRes({ retCode: 0, time: Date.now() });
        }
        return jsonRes({
          retCode: 0,
          retMsg: 'OK',
          result: { userID: '777', readOnly: 0, permissions: { ContractTrade: ['Order'], Wallet: ['Withdraw'] } }
        });
      }) as typeof fetch
    });
    const badPerms = await withdrawAdapter.permissions();
    expect(() => assertLivePermissionEvidence(badPerms)).toThrow(/withdraw/i);

    const liveRunner = new RoleRunner({
      isLiveMode: () => true,
      providerCaller: async () => '{"reply":"should not run"}',
      resolveAssignment: () => ({
        provider: 'mock',
        model: 'mock-desk-v1',
        apiKey: null
      })
    });

    await expect(
      liveRunner.chat({
        role: 'lead',
        prompt: 'halo',
        configVersion: 1,
        cycleId: 'live-chat-mock-block'
      })
    ).rejects.toThrow(/forbidden in LIVE mode/i);
  });

  it('runs a full LIVE session over HTTP + WS with synced balance, 6-agent Q&A, advisory boundary, sovereign SL/TP open, and clean close', async () => {
    const dbFile = path.join(os.tmpdir(), `test-live-e2e-${Date.now()}-${randomUUID()}.sqlite`);
    dbFiles.push(dbFile);

    const store = await RuntimeStore.open(dbFile);
    const secrets = new SecretStore({ allowWrite: false });
    const envOverrides: NodeJS.ProcessEnv = {
      TRADING_MODE: 'LIVE',
      EXCHANGE: 'bybit',
      OPENROUTER_API_KEY: 'sk-openrouter-live-test-only',
      DEFAULT_PROVIDER: 'openrouter',
      DEFAULT_MODEL: 'openai/gpt-4o-mini',
      SAFETY_NET: '250',
      MAINNET_DESK_SAFETY_NET: '250',
      OPEN_ORDERS_N: '2',
      MAINNET_DESK_OPEN_ORDERS_N: '2',
      MAX_LEVERAGE: '5',
      MAINNET_DESK_MAX_LEVERAGE: '5'
    };
    const settings = await SettingsService.initialize(store, secrets);
    const applied = await settings.apply(
      {
        mode: 'LIVE',
        venue: { exchange: 'bybit', network: 'mainnet' },
        paper: { balance: 1250, safetyNet: 250, n: 2 },
        trading: {
          maxLeverage: 5,
          defaultStopPct: 20,
          takeProfitPct: 60,
          takeProfitR: 3,
          minStopPct: 0.2,
          minOrderUsdt: 5,
          minEntryConfidencePct: 60,
          dailyLossLimitPct: 10,
          maxPositions: 2,
          safetyNet: 250,
          orderSizePct: null
        }
      },
      settings.current().activeVersion
    );
    expect(applied.applyStatus).toBe('applied');

    const authority = new ExecutionAuthorityService(store);
    const accounts = await AccountRegistry.open(store, authority);
    const accountCtx = await accounts.register({
      venue: 'bybit',
      network: 'mainnet',
      mode: 'LIVE',
      nativeIdentity: 'bybit-live-uid-888',
      subaccountRef: null
    });
    const accountRef = accountCtx.accountRef;
    await authority.claim(accountRef);

    // Stateful mock Bybit mainnet venue
    let openPosition: {
      symbol: string;
      side: 'Buy' | 'Sell';
      size: string;
      avgPrice: string;
      leverage: string;
      stopLoss: string;
      takeProfit: string;
    } | null = null;
    const orders = new Map<
      string,
      { orderId: string; orderLinkId: string; symbol: string; status: string; qty: string; avgPrice: string }
    >();
    const createCalls: Array<Record<string, unknown>> = [];
    const tradingStopCalls: Array<Record<string, unknown>> = [];

    const bybitFetch = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const now = Date.now();
      if (url.pathname === '/v5/market/time') {
        return jsonRes({ retCode: 0, time: now, result: { timeSecond: String(Math.floor(now / 1000)), timeNano: `${now}000000` } });
      }
      if (url.pathname === '/v5/user/query-api') {
        return jsonRes({
          retCode: 0,
          retMsg: 'OK',
          result: {
            userID: '888123',
            readOnly: 0,
            permissions: { ContractTrade: ['Order', 'Position'], Wallet: [] },
            ips: ['127.0.0.1']
          }
        });
      }
      if (url.pathname === '/v5/account/wallet-balance') {
        return jsonRes({
          retCode: 0,
          retMsg: 'OK',
          result: {
            list: [{ totalEquity: '1250.00', totalAvailableBalance: '1250.00', totalInitialMargin: '0' }]
          }
        });
      }
      if (url.pathname === '/v5/market/instruments-info') {
        return jsonRes({
          retCode: 0,
          retMsg: 'OK',
          result: {
            list: [
              {
                symbol: 'BTCUSDT',
                baseCoin: 'BTC',
                quoteCoin: 'USDT',
                settleCoin: 'USDT',
                priceFilter: { tickSize: '0.1' },
                lotSizeFilter: { minOrderQty: '0.001', maxOrderQty: '100', maxMktOrderQty: '100', qtyStep: '0.001', minNotionalValue: '5' }
              }
            ],
            nextPageCursor: ''
          }
        });
      }
      if (url.pathname === '/v5/market/tickers') {
        return jsonRes({
          retCode: 0,
          retMsg: 'OK',
          time: now,
          result: {
            list: [
              {
                symbol: 'BTCUSDT',
                lastPrice: '70000.0',
                bid1Price: '69999.5',
                ask1Price: '70000.5',
                fundingRate: '0.0001',
                openInterest: '50000',
                price24hPcnt: '0.025'
              }
            ]
          }
        });
      }
      if (url.pathname === '/v5/market/kline') {
        const tfInterval = url.searchParams.get('interval') ?? '15';
        const msMap: Record<string, number> = { '1': 60_000, '5': 300_000, '15': 900_000, '60': 3_600_000, '240': 14_400_000, D: 86_400_000 };
        return jsonRes({
          retCode: 0,
          retMsg: 'OK',
          time: now,
          result: { list: makeFreshKlines(70_000, 40, msMap[tfInterval] ?? 900_000) }
        });
      }
      if (url.pathname === '/v5/position/set-leverage') {
        return jsonRes({ retCode: 0, retMsg: 'OK', result: {} });
      }
      if (url.pathname === '/v5/order/create') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        createCalls.push(body);
        const cid = String(body.orderLinkId);
        const qty = String(body.qty);
        const oid = `bybit-live-${createCalls.length}`;
        if (body.reduceOnly === true) {
          openPosition = null;
        } else {
          openPosition = {
            symbol: String(body.symbol),
            side: body.side === 'Sell' ? 'Sell' : 'Buy',
            size: qty,
            avgPrice: '70000.0',
            leverage: '5',
            stopLoss: '',
            takeProfit: ''
          };
        }
        orders.set(cid, {
          orderId: oid,
          orderLinkId: cid,
          symbol: String(body.symbol),
          status: 'Filled',
          qty,
          avgPrice: '70000.0'
        });
        return jsonRes({ retCode: 0, retMsg: 'OK', result: { orderId: oid, orderLinkId: cid } });
      }
      if (url.pathname === '/v5/order/realtime') {
        const orderFilter = url.searchParams.get('orderFilter');
        if (orderFilter === 'StopOrder') {
          return jsonRes({ retCode: 0, retMsg: 'OK', result: { list: [] } });
        }
        const cid = url.searchParams.get('orderLinkId');
        if (cid && orders.has(cid)) {
          const o = orders.get(cid)!;
          return jsonRes({
            retCode: 0,
            retMsg: 'OK',
            result: {
              list: [
                {
                  orderId: o.orderId,
                  orderLinkId: o.orderLinkId,
                  symbol: o.symbol,
                  orderStatus: o.status,
                  cumExecQty: o.qty,
                  avgPrice: o.avgPrice
                }
              ]
            }
          });
        }
        return jsonRes({ retCode: 0, retMsg: 'OK', result: { list: [] } });
      }
      if (url.pathname === '/v5/position/list') {
        return jsonRes({
          retCode: 0,
          retMsg: 'OK',
          result: {
            list: openPosition
              ? [
                  {
                    symbol: openPosition.symbol,
                    side: openPosition.side,
                    positionIdx: 0,
                    size: openPosition.size,
                    avgPrice: openPosition.avgPrice,
                    leverage: openPosition.leverage,
                    stopLoss: openPosition.stopLoss,
                    takeProfit: openPosition.takeProfit,
                    unrealisedPnl: '0'
                  }
                ]
              : [],
            nextPageCursor: ''
          }
        });
      }
      if (url.pathname === '/v5/position/trading-stop') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        tradingStopCalls.push(body);
        if (openPosition) {
          openPosition.stopLoss = String(body.stopLoss ?? '');
          openPosition.takeProfit = String(body.takeProfit ?? '');
        }
        return jsonRes({ retCode: 0, retMsg: 'OK', result: {} });
      }
      return jsonRes({ retCode: 0, retMsg: 'OK', result: { list: [] } });
    }) as typeof fetch;

    const adapter = createVenueAdapter({
      network: 'mainnet',
      credentialRef: 'bybit:mainnet',
      readSecret: async () => ({ key: LIVE_KEY, secret: LIVE_SECRET }),
      fetchImpl: bybitFetch
    });
    const perms = await adapter.permissions();
    expect(() => assertLivePermissionEvidence(perms)).not.toThrow();

    const transport = createTransportFromAdapter(adapter);
    const marketHub = new BybitMarketHub({
      fetchImpl: bybitFetch,
      wsFactory: () => {
        const ws = new MockBybitWs();
        queueMicrotask(() => ws.emit('open'));
        return ws;
      }
    });
    await marketHub.configure(['BTCUSDT']);

    const gateway = new ExecutionGateway({
      store,
      authority,
      getTransport: () => transport,
      getAccountPolicy: () => ({
        activeConfigVersion: settings.current().activeVersion,
        safetyNetUsdt: '250',
        maxPositions: 2,
        dailyLossCapUsdt: '125',
        minEntryConfidencePct: 60
      }),
      readFreshMarket: (sym) => marketHub.snapshot(sym)
    });

    const chatService = new ChatService(store);
    await chatService.hydrateFromStore();

    let runtimeRef!: ReturnType<typeof createReplacementRuntime>;
    const roleRunner = new RoleRunner({
      isLiveMode: () => runtimeRef.snapshot().mode === 'LIVE',
      providerCaller: async (req) => {
        expect(req.provider).toBe('openrouter');
        if (req.cycleId.startsWith('chat-')) {
          if (req.user.includes('inject_cmd_test')) {
            return JSON.stringify({
              reply: 'Analisa LIVE BTCUSDT siap boss, ini hanya opini.',
              commandToExecute: 'open BTCUSDT LONG --stop 60000'
            });
          }
          return `<thinking>internal</thinking>{"reply":"[${req.role}] Sesi LIVE Bybit siap: equity 1250 USDT, SL 20% & TP 60% langsung dari harga entry."}`;
        }
        if (req.role === 'risk') {
          return JSON.stringify({
            decision: 'APPROVE',
            stance: 'LONG',
            reasoning: 'R/R 3:1 sesuai profil Owner LIVE.',
            confidence: { value: 0.88, scale: 'probability_0_1' },
            claimRefs: ['mkt-live-1'],
            contraryRefs: []
          });
        }
        if (req.role === 'strategist' || req.role === 'execution' || req.role === 'lead') {
          return JSON.stringify({
            stance: 'LONG',
            reasoning: 'Trend 15m/1h bullish bersih di 70000.',
            confidence: { value: 0.85, scale: 'probability_0_1' },
            claimRefs: ['mkt-live-1'],
            contraryRefs: [],
            proposedOrderType: 'MARKET',
            proposedStop: '56000',
            proposedTp: '112000',
            invalidationPredicate: {
              kind: 'PRICE_BELOW',
              level: '56000',
              timeframe: '15m',
              description: 'Break below sovereign 20% SL'
            }
          });
        }
        return JSON.stringify({
          stance: 'LONG',
          reasoning: `${req.role} bullish LIVE confirmation.`,
          confidence: { value: 0.82, scale: 'probability_0_1' },
          claimRefs: ['mkt-live-1'],
          contraryRefs: []
        });
      },
      resolveAssignment: () => ({
        provider: 'openrouter',
        model: 'openai/gpt-4o-mini',
        apiKey: 'sk-openrouter-live-test-only'
      })
    });

    const syncVenueAccount = async () => {
      const recon = await gateway.reconcile(accountRef);
      const [bal, posList] = await Promise.all([adapter.balance(), adapter.positions()]);
      const eq = Number(bal.equity ?? 0);
      const av = Number(bal.available ?? eq);
      runtimeRef.updateState((d) => {
        d.financial.balance = availableFinancialField(eq);
        d.financial.equity = availableFinancialField(eq);
        d.financial.availableBalance = availableFinancialField(av);
        d.paper.balance = eq;
        d.paper.equity = eq;
        d.paper.moneyTrade = Math.max(0, eq - d.paper.safetyNet);
        d.paper.perOrder = Math.floor((d.paper.moneyTrade / d.paper.n) * 100) / 100;
        d.venueAccount = {
          equity: eq,
          available: av,
          unrealized: 0,
          at: Date.now(),
          status: 'confirmed',
          positions: posList.map((p) => ({ symbol: p.symbol, side: p.side, qty: Number(p.qty) }))
        };
        d.paper.positions = posList.map((p, idx) => ({
          id: `pos-${p.symbol}-${idx}`,
          symbol: p.symbol,
          side: p.side,
          qty: Number(p.qty),
          entry: Number(p.entryPrice),
          stop: Number(recon.verifiedStops[p.positionKey] ?? 0),
          tp: recon.verifiedTps?.[p.positionKey] ? Number(recon.verifiedTps[p.positionKey]) : null,
          mark: Number(p.entryPrice),
          unrealizedPnl: 0,
          leverage: p.leverage ?? 5,
          margin: (Number(p.qty) * Number(p.entryPrice)) / (p.leverage ?? 5),
          openedAt: p.observedAt,
          protectionStatus: recon.protection[p.positionKey] === 'VERIFIED' ? 'confirmed' : 'missing',
          entryStatus: 'confirmed'
        }));
      });
    };

    const dispatcher = async (input: OfficeCommand, _state: OfficeState): Promise<OfficeReply> => {
      const auth = await authority.claim(accountRef);
      if (input.kind === 'open') {
        const p = (input.payload ?? {}) as Record<string, unknown>;
        const r = await gateway.submit({
          intentId: `live-open-${Date.now()}`,
          accountRef,
          configVersion: settings.current().activeVersion,
          authorityEpoch: auth.writerEpoch,
          action: 'OPEN',
          symbol: String(p.symbol),
          side: (p.side as 'LONG' | 'SHORT') ?? 'LONG',
          quantity: String(p.qty),
          entry: p.entry != null ? String(p.entry) : null,
          stop: p.stop != null ? String(p.stop) : null,
          tp: p.tp != null ? String(p.tp) : null,
          leverage: Number(p.leverage ?? 5),
          thesisId: p.thesis ? `thesis-${Date.now()}` : null,
          thesis: (p.thesis ?? null) as any,
          orderType: (p.orderType as 'MARKET' | 'LIMIT_GTC') ?? 'MARKET',
          limitPrice: p.limitPrice != null ? String(p.limitPrice) : null
        });
        return { ok: r.orderState !== 'REJECTED', code: r.orderState, message: r.reason ?? `Order ${r.orderState}`, data: r as any };
      }
      if (input.kind === 'close') {
        const targetPos = (await adapter.positions())[0];
        if (!targetPos) return { ok: false, code: 'INVALID_INPUT', message: 'No open position' };
        const r = await gateway.close({
          intentId: `live-close-${Date.now()}`,
          accountRef,
          configVersion: settings.current().activeVersion,
          authorityEpoch: auth.writerEpoch,
          symbol: targetPos.symbol,
          side: targetPos.side,
          quantity: targetPos.qty,
          ownerAuthorized: true
        });
        await syncVenueAccount();
        return { ok: r.orderState === 'FILLED', code: 'OK', message: `Closed ${targetPos.symbol}`, data: r as any };
      }
      if (input.kind === 'protect') {
        const p = (input.payload ?? {}) as Record<string, unknown>;
        const res = await gateway.protectPosition({
          accountRef,
          symbol: String(p.symbol),
          stopPrice: String(p.stop),
          tpPrice: p.tp ? String(p.tp) : null
        });
        await syncVenueAccount();
        return { ok: res.ok, code: res.code, message: res.message };
      }
      return { ok: false, code: 'SERVICE_UNAVAILABLE', message: 'unsupported' };
    };

    runtimeRef = createReplacementRuntime({
      initialMode: 'LIVE',
      initialAppMode: 'local',
      env: envOverrides,
      settings,
      secrets,
      chatService,
      marketHub,
      roleRunner,
      executionGateway: gateway,
      venueAdapter: adapter,
      getVenueAdapter: () => adapter,
      activeAccountRef: () => accountRef,
      syncVenueAccount,
      dispatcher,
      initialFinancial: {
        balance: availableFinancialField(1250),
        equity: availableFinancialField(1250),
        availableBalance: availableFinancialField(1250),
        realizedPnl: unavailableFinancialField(),
        unrealizedPnl: availableFinancialField(0)
      }
    });
    await syncVenueAccount();

    const app = createReplacementApp(runtimeRef, {
      chatService,
      setupDeps: { settings, secrets, accounts }
    });
    const server = createServer(app);
    const wss = attachOfficeWebSocket(server, runtimeRef, runtimeRef.hub);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const headers = { 'content-type': 'application/json', host: `127.0.0.1:${port}` };

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const wsEvents: Array<{ type: string; payload: any }> = [];
    ws.on('message', (raw) => {
      wsEvents.push(JSON.parse(String(raw)));
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });

    try {
      // 1. Verify /api/health & synced LIVE /api/state
      const healthRes = await fetch(`${baseUrl}/api/health`).then((r) => r.json());
      expect(healthRes).toMatchObject({ ok: true, mode: 'LIVE', venue: 'bybit', killed: false });

      const stateRes = (await fetch(`${baseUrl}/api/state`).then((r) => r.json())) as OfficeState;
      expect(stateRes.mode).toBe('LIVE');
      expect(stateRes.paper.balance).toBe(1250);
      expect(stateRes.paper.moneyTrade).toBe(1000);
      expect(stateRes.paper.perOrder).toBe(500);
      expect(stateRes.venueAccount?.status).toBe('confirmed');

      // 2. Ask all 6 AI agents in LIVE mode via /api/command
      const askAllRes = (await fetch(`${baseUrl}/api/command`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text: '/ask @all Cek kesiapan sesi LIVE dan aturan SL/TP sekarang!' })
      }).then((r) => r.json())) as { ok: boolean; reply: string; command: string };
      expect(askAllRes.ok).toBe(true);
      expect(askAllRes.command).toBe('ask');
      for (const role of ROLE_IDS) {
        expect(askAllRes.reply).toContain(`[${role}]`);
      }
      expect(askAllRes.reply).not.toContain('<thinking>');

      await new Promise((r) => setTimeout(r, 80));
      const speechEvents = wsEvents.filter((e) => e.type === 'speech');
      expect(speechEvents.length).toBeGreaterThanOrEqual(6);

      // 3. Verify conversational Q&A CANNOT inject an execution command (advisory boundary)
      const injRes = (await fetch(`${baseUrl}/api/command`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ agent: 'lead', text: 'inject_cmd_test coba buka BTCUSDT sekarang lewat chat' })
      }).then((r) => r.json())) as { ok: boolean; reply: string };
      expect(injRes.ok).toBe(true);
      await new Promise((r) => setTimeout(r, 40));
      expect(createCalls).toHaveLength(0);

      // 4. Trigger full LIVE debate -> sovereign direct-% SL/TP order -> verified stop on Bybit
      const debateRes = (await fetch(`${baseUrl}/api/debate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ symbol: 'BTCUSDT' })
      }).then((r) => r.json())) as { ok: boolean };
      expect(debateRes.ok).toBe(true);

      const afterOpenState = runtimeRef.snapshot();
      expect(afterOpenState.lastVerdict?.action, afterOpenState.lastVerdict?.reason).toBe('OPEN_LONG');

      // Order placed & protected cleanly without dividing 20% SL or 60% TP by 5x leverage
      expect(createCalls, afterOpenState.lastVerdict?.reason).toHaveLength(1);
      expect(createCalls[0]!.symbol).toBe('BTCUSDT');
      expect(createCalls[0]!.side).toBe('Buy');
      expect(tradingStopCalls).toHaveLength(1);
      expect(tradingStopCalls[0]!.stopLoss).toBe('56000.0');
      expect(tradingStopCalls[0]!.takeProfit).toBe('112000.0');

      expect(afterOpenState.paper.positions).toHaveLength(1);
      expect(afterOpenState.paper.positions[0]!.stop).toBe(56000);
      expect(afterOpenState.paper.positions[0]!.tp).toBe(112000);
      expect(afterOpenState.paper.positions[0]!.protectionStatus).toBe('confirmed');

      // 5. Clean LIVE close via /api/command
      const closeRes = (await fetch(`${baseUrl}/api/command`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text: '/close BTCUSDT' })
      }).then((r) => r.json())) as { ok: boolean; command: string };
      expect(closeRes.ok).toBe(true);
      expect(createCalls).toHaveLength(2);
      expect(createCalls[1]!.reduceOnly).toBe(true);
      expect(runtimeRef.snapshot().paper.positions).toHaveLength(0);
    } finally {
      ws.close();
      await runtimeRef.stop();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.close();
    }
  }, 30_000);
});
