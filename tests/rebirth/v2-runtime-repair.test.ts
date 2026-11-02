import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createReplacementRuntime } from '../../server/v2/runtime.js';
import { createReplacementApp } from '../../server/v2/app.js';
import { RuntimeStore } from '../../server/v2/store/database.js';
import { AccountRegistry } from '../../server/v2/accounts/registry.js';
import { ExecutionAuthorityService } from '../../server/v2/accounts/authority.js';
import {
  ExecutionGateway,
  convertDailyLossPctToUsdt,
  resolveOwnerPerOrderUsdt,
  type GatewayVenueTransport
} from '../../server/v2/execution/gateway.js';
import { unavailableEvidence, verifiedEvidence, type MarketFrame } from '../../server/v2/contracts.js';
import { RoleRunner } from '../../server/v2/agents/runner.js';
import { CycleRunner } from '../../server/v2/decision/cycle.js';
import { JevClient } from '../../server/v2/agents/jev.js';
import { buildLiveDeskChatContext } from '../../server/v2/api/chat.js';
import { unkill, notifyOfficeRelease } from '../../cli/unkill.js';
import { activityEntries, activityForView } from '../../web/src/activityLog.js';
import { createInitialOfficeState } from '../../server/v2/office.js';
import { writeKill, DEFAULT_KILL_FILE } from '../../server/killswitch.js';

const tempDirs: string[] = [];
const openStores: RuntimeStore[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
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
        // Windows WAL handle delay
      }
    }
  }
});

function makeMarket(price = '68500'): MarketFrame {
  return {
    evidenceId: 'ev-repair',
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

describe('Repair A: kill switch command/endpoint mismatch and persisted halt', () => {
  it('POST /api/ops/kill with {on:false} releases instead of re-engaging kill', async () => {
    const runtime = createReplacementRuntime();
    const app = createReplacementApp(runtime);
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    const killRes = await fetch(`${base}/api/ops/kill`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ on: true })
    });
    const killBody = (await killRes.json()) as { killed: boolean };
    expect(killBody.killed).toBe(true);
    expect(runtime.snapshot().killed).toBe(true);

    const releaseRes = await fetch(`${base}/api/ops/kill`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ on: false })
    });
    const releaseBody = (await releaseRes.json()) as { ok: boolean; killed: boolean };
    expect(releaseBody.ok).toBe(true);
    expect(releaseBody.killed).toBe(false);
    expect(runtime.snapshot().killed).toBe(false);
    expect(runtime.snapshot().auto.on).toBe(false);
  });

  it('CLI unkill notifies /api/unkill and refuses success when the latch stays on', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mpu-unkill-'));
    tempDirs.push(dir);
    const killFile = path.join(dir, 'kill-switch.json');
    writeKill(killFile, { at: Date.now(), reason: 'test halt', source: 'cli' });

    const fileResult = unkill(['--yes'], killFile);
    expect(fileResult.ok).toBe(true);
    expect(existsSync(killFile)).toBe(false);

    const notified = await notifyOfficeRelease({
      fetchImpl: async () =>
        new Response(JSON.stringify({ ok: true, killed: true, message: 'still latched' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    });
    expect(notified.ok).toBe(false);
    expect(notified.killed).toBe(true);
  });

  it('restored persisted halt rejects entries after a new gateway boots, and verified release allows them', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mpu-halt-'));
    tempDirs.push(dir);
    const store = await RuntimeStore.open(path.join(dir, 'runtime.sqlite'));
    openStores.push(store);
    const authority = new ExecutionAuthorityService(store, 'holder-main');
    const registry = await AccountRegistry.open(store, authority);
    const account = await registry.register({
      venue: 'bybit',
      network: 'testnet',
      mode: 'TESTNET',
      nativeIdentity: 'uid-halt-1',
      subaccountRef: null
    });
    const lease = await authority.claim(account.accountRef, 'holder-main');
    await authority.setHalt(account.accountRef, true, 'local_owner', 'test halt');

    let submits = 0;
    const transport: GatewayVenueTransport = {
      balance: async () => ({ balanceUsdt: '1000', availableUsdt: '1000', realizedDailyPnlUsdt: '0' }),
      positions: async () => [],
      submitOrder: async (o) => {
        submits += 1;
        return { clientOrderId: o.clientOrderId, venueOrderId: 'ord-1', state: 'FILLED', filledQty: o.quantity };
      },
      lookupOrder: async (_s, c) => ({ clientOrderId: c, venueOrderId: 'ord-1', state: 'FILLED', filledQty: '0.01' }),
      cancelEntryOrder: async (_s, c) => ({ clientOrderId: c, venueOrderId: 'ord-1', state: 'CANCELLED', filledQty: '0' }),
      readProtection: async (pos) => ({ state: 'VERIFIED', coveredQty: pos.qty, stopPrice: '67000', reduceOnly: true }),
      placeProtection: async (pos, stop) => ({ state: 'VERIFIED', coveredQty: pos.qty, stopPrice: stop, reduceOnly: true }),
      closePosition: async (pos, c) => ({ clientOrderId: c, venueOrderId: 'cl-1', state: 'FILLED', filledQty: pos.qty })
    };

    const policy = {
      activeConfigVersion: 1,
      safetyNetUsdt: '200',
      maxPositions: 2,
      dailyLossCapUsdt: '100',
      minEntryConfidencePct: 60
    };

    const restarted = new ExecutionGateway({
      store,
      authority,
      getTransport: () => transport,
      getAccountPolicy: () => policy,
      readFreshMarket: () => makeMarket()
    });
    restarted.restorePersistedHalt(account.accountRef);

    const blocked = await restarted.submit({
      intentId: 'intent-after-restart',
      accountRef: account.accountRef,
      configVersion: 1,
      authorityEpoch: lease.writerEpoch,
      action: 'OPEN',
      symbol: 'BTCUSDT',
      side: 'LONG',
      quantity: '0.01',
      entry: null,
      stop: '67000',
      tp: null,
      leverage: 5,
      thesisId: 'th-1'
    });
    expect(blocked.orderState).toBe('REJECTED');
    expect(submits).toBe(0);
    expect((await authority.current(account.accountRef))?.haltLatched).toBe(true);

    const released = await authority.setHalt(account.accountRef, false, 'local_owner', 'Owner released kill switch');
    expect(released.haltLatched).toBe(false);
    restarted.clearInMemoryHalt(account.accountRef);

    const afterRelease = await restarted.submit({
      intentId: 'intent-after-release',
      accountRef: account.accountRef,
      configVersion: 1,
      authorityEpoch: lease.writerEpoch,
      action: 'OPEN',
      symbol: 'BTCUSDT',
      side: 'LONG',
      quantity: '0.01',
      entry: null,
      stop: '67000',
      tp: null,
      leverage: 5,
      thesisId: 'th-2'
    });
    expect(afterRelease.orderState).toBe('FILLED');
    expect(submits).toBe(1);
  });
});

describe('Repair B: live chat context', () => {
  it('injects a bounded desk snapshot without secrets', () => {
    const state = createInitialOfficeState();
    state.trading = {
      profile: 'BALANCED',
      values: {
        dailyLossLimitPct: 10,
        maxLossPerTradePct: 50,
        minEntryConfidencePct: 60,
        maxLeverage: 5,
        orderSizePct: 25,
        defaultStopPct: 20,
        minStopPct: 5,
        takeProfitPct: 40,
        takeProfitR: 2,
        maxOrderUsdt: 0,
        minOrderUsdt: 5,
        safetyNet: 200,
        maxPositions: 3
      }
    } as typeof state.trading;
    state.paper.positions = [
      {
        id: 'pos-1',
        symbol: 'BTCUSDT',
        side: 'LONG',
        qty: 0.01,
        entry: 68000,
        stop: 67000,
        tp: 70000,
        margin: 136,
        leverage: 5,
        openedAt: Date.now(),
        mark: 68500,
        unrealizedPnl: 5,
        protectionStatus: 'confirmed',
        entryStatus: 'confirmed'
      }
    ];
    state.tickers.BTCUSDT = { symbol: 'BTCUSDT', last: 68500, change24hPct: 1.2, source: 'bybit', example: false, at: Date.now() };
    state.agents.lead.model = 'gpt-5';
    const snapshot = buildLiveDeskChatContext(state, {
      capturedAt: '2026-11-02T12:00:00.000Z',
      secrets: { OPENROUTER_API_KEY: 'sk-secret-should-never-leak', BYBIT_API_SECRET: 'exchange-secret' }
    });
    const encoded = JSON.stringify(snapshot);
    expect(encoded).not.toContain('sk-secret');
    expect(encoded).not.toContain('exchange-secret');
    expect(snapshot.tradingProfile).toBe('BALANCED');
    expect(snapshot.positions.length).toBe(1);
    expect(snapshot.watchlistPrices.length).toBeGreaterThan(0);
    expect(snapshot.freshness.positions).toMatch(/live|cached|stale|unavailable/);
  });
});

describe('Repair C: debate contract', () => {
  it('does not apply a second-stage Lead confidence veto after Risk APPROVE', async () => {
    const seen: Array<{ role: string; user: string }> = [];
    const runner = new RoleRunner({
      providerCaller: async (req) => {
        seen.push({ role: req.role, user: req.user });
        if (req.role === 'risk') {
          expect(req.user).toContain('maxLeverage');
          expect(req.user).toContain('LIMIT_GTC');
          return JSON.stringify({
            stance: 'LONG',
            decision: 'APPROVE',
            claimRefs: ['ev-1'],
            contraryRefs: [],
            reasoning: 'Owner caps respected including candidate limit order.',
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
            reasoning: 'Lead agrees with Risk.',
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
      cycleId: 'cycle-no-second-gate',
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
        maxPositions: 3
      },
      marketSummary: {
        last: '68500',
        optionalResearch: {
          news: { status: 'unavailable', reason: 'not fetched this cycle' },
          whale: { status: 'unavailable', reason: 'not fetched this cycle' },
          catalyst: { status: 'unavailable', reason: 'not fetched this cycle' }
        }
      }
    });
    expect(out.verdict?.action).toBe('OPEN_LONG');
    expect(out.verdict?.rejectionReason).toBeNull();
    expect(out.verdict?.thesis?.orderType).toBe('LIMIT_GTC');
    expect(out.verdict?.thesis?.limitPrice).toBe('68400');
    const riskPrompt = seen.find((s) => s.role === 'risk')?.user ?? '';
    expect(riskPrompt).toContain('68400');
  });
});

describe('Repair G: arithmetic', () => {
  it('converts daily-loss percent against the equity basis and does not fall back to 50 USDT', () => {
    expect(convertDailyLossPctToUsdt(1000, 10)).toBe('100.00');
    expect(resolveOwnerPerOrderUsdt({ perOrder: 266.66, moneyTrade: 800, n: 3 })).toBe(266.66);
    expect(resolveOwnerPerOrderUsdt({ perOrder: 0, moneyTrade: 800, n: 3 })).toBe(266.66);
    expect(resolveOwnerPerOrderUsdt({ perOrder: 0, moneyTrade: 0, n: 3 })).toBe(0);
  });
});

describe('Repair E: activity identity', () => {
  it('deduplicates the same event id across logs and room history while keeping speech', () => {
    const id = 'evt-1';
    const at = Date.now();
    const entries = activityEntries({
      logs: [
        { id, at, kind: 'execution', text: 'Submitted LIMIT_GTC BTCUSDT', source: 'backend' },
        { id, at, kind: 'execution', text: 'Submitted LIMIT_GTC BTCUSDT', source: 'backend' },
        { id: 'speech-1', at: at + 1, kind: 'speech', agent: 'lead', text: 'I like the long.', source: 'debate' }
      ],
      roomHistory: [{ id: 'speech-1', at: at + 1, from: 'lead', to: 'owner', text: 'I like the long.' }],
      chats: { lead: [], market: [], research: [], strategist: [], risk: [], execution: [] },
      paper: { closed: [] }
    } as Parameters<typeof activityEntries>[0]);
    const execution = entries.filter((e) => e.kind === 'execution');
    expect(execution).toHaveLength(1);
    expect(activityForView(entries, 'log').some((e) => e.kind === 'execution')).toBe(true);
    expect(activityForView(entries, 'history').some((e) => e.kind === 'speech')).toBe(true);
  });
});

describe('Repair F: Jev telemetry', () => {
  it('separates config health from remote-call health and records timeout vs heuristic', async () => {
    const client = new JevClient({
      enabled: true,
      apiKey: 'or-test-key',
      timeoutMs: 20,
      fetchImpl: async (_url, init) => {
        const err = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
        if (init?.signal?.aborted) throw err;
        await new Promise<void>((_, reject) => {
          const timer = setTimeout(() => reject(err), 5);
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(err);
          });
        });
        return new Response('{}', { status: 200 });
      }
    });
    const review = await client.review({
      cycleId: 'c1',
      symbol: 'BTCUSDT',
      evidenceId: 'ev-1',
      state: { observations: [] }
    });
    expect(review.status).toBe('unavailable');
    const tel = client.telemetry();
    expect(tel.configHealth).toBe('configured');
    expect(tel.remoteHealth).toMatch(/timeout|error/);
    expect(tel.requests).toBe(1);
    expect(tel.timeouts + tel.errors).toBeGreaterThan(0);
    expect(tel.lastSource).toBe('heuristic');
  });
});

void DEFAULT_KILL_FILE;
