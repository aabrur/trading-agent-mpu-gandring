import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RoleRunner } from '../../server/v2/agents/runner.js';
import { AccountRegistry } from '../../server/v2/accounts/registry.js';
import { ExecutionAuthorityService } from '../../server/v2/accounts/authority.js';
import { CycleRunner } from '../../server/v2/decision/cycle.js';
import { reconcileAccountState, type ReconcileVenueTransport } from '../../server/v2/execution/reconcile.js';
import { appendKillAudit, readKill, writeKill } from '../../server/v2/kill-file.js';
import { ownerAllocationPerOrder, verifiedVenueStop } from '../../server/v2/runtime.js';
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
        // Windows can keep the sqlite handle for a moment.
      }
    }
  }
});

async function openStore() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mpu-recon-final-'));
  tempDirs.push(dir);
  const store = await RuntimeStore.open(path.join(dir, 'runtime.sqlite'));
  openStores.push(store);
  const authority = new ExecutionAuthorityService(store, 'holder-main');
  const registry = await AccountRegistry.open(store, authority);
  const account = await registry.register({
    venue: 'bybit',
    network: 'testnet',
    mode: 'TESTNET',
    nativeIdentity: 'uid-final',
    subaccountRef: null
  });
  return { store, accountRef: account.accountRef };
}

function transport(overrides: Partial<ReconcileVenueTransport> = {}): ReconcileVenueTransport & {
  placed: string[];
} {
  const placed: string[] = [];
  const base: ReconcileVenueTransport & { placed: string[] } = {
    placed,
    balance: async () => ({ balanceUsdt: '1000', availableUsdt: '800', realizedDailyPnlUsdt: '0' }),
    positions: async () => [],
    lookupOrder: async (_symbol, clientOrderId) => ({
      clientOrderId,
      venueOrderId: null,
      state: 'FILLED',
      filledQty: '1'
    }),
    readProtection: async () => ({
      state: 'MISSING',
      coveredQty: '0',
      stopPrice: null,
      reduceOnly: true
    }),
    placeProtection: async (_pos, stopPrice) => {
      placed.push(stopPrice);
      return { state: 'VERIFIED', coveredQty: '1', stopPrice, reduceOnly: true };
    },
    closePosition: async (_pos, clientOrderId) => ({
      clientOrderId,
      venueOrderId: null,
      state: 'FILLED',
      filledQty: '1'
    })
  };
  return { ...base, ...overrides, placed };
}

describe('historical position ownership', () => {
  it('does not apply a CLOSED stop or a finished intent to a new position', async () => {
    const { store, accountRef } = await openStore();
    const now = new Date().toISOString();
    await store.execute(
      `INSERT INTO execution_intents (
        account_ref, intent_id, client_order_id, cycle_id, symbol, side, intent_kind,
        order_state, protection_state, venue_order_id, payload_json, created_at, updated_at
      ) VALUES (?, 'old-intent', 'old-client', NULL, 'BTCUSDT', 'LONG', 'OPEN', 'FILLED', 'VERIFIED', NULL, ?, ?, ?)`,
      [accountRef, JSON.stringify({ stop: '50000' }), now, now]
    );
    await store.execute(
      `INSERT INTO managed_positions (
        account_ref, position_key, native_position_id, symbol, native_instrument,
        position_mode, side, qty, entry_price, stop_price, tp_price, leverage,
        ownership, protection_state, thesis_json, state, opened_at, updated_at, closed_at
      ) VALUES (?, 'BTCUSDT:ONE_WAY', NULL, 'BTCUSDT', 'BTCUSDT', 'ONE_WAY', 'LONG', '1', '68000', '50000', NULL, 5, 'MANAGED', 'VERIFIED', '{}', 'CLOSED', ?, ?, ?)`,
      [accountRef, now, now, now]
    );
    const venue = transport({
      positions: async () => [
        {
          positionKey: 'BTCUSDT:ONE_WAY',
          symbol: 'BTCUSDT',
          side: 'LONG',
          qty: '0.2',
          entryPrice: '69000'
        }
      ]
    });
    const recon = await reconcileAccountState({ store, accountRef, transport: venue });
    expect(venue.placed).toEqual([]);
    expect(recon.externalCredentialConflict).toBe(true);
    expect(recon.verifiedStops['BTCUSDT:ONE_WAY']).toBeNull();
  });
});

describe('ownership after order status change', () => {
  const now = () => new Date().toISOString();
  const pos = (entry = '69000', qty = '0.2') => ({
    positionKey: 'BTCUSDT:ONE_WAY',
    symbol: 'BTCUSDT',
    side: 'LONG' as const,
    qty,
    entryPrice: entry
  });

  async function insertIntent(
    store: RuntimeStore,
    accountRef: string,
    state: string,
    stop = '50000'
  ) {
    const at = now();
    await store.execute(
      `INSERT INTO execution_intents (
        account_ref, intent_id, client_order_id, cycle_id, symbol, side, intent_kind,
        order_state, protection_state, venue_order_id, payload_json, created_at, updated_at
      ) VALUES (?, 'intent-1', 'client-1', NULL, 'BTCUSDT', 'LONG', 'OPEN', ?, 'PENDING', NULL, ?, ?, ?)`,
      [accountRef, state, JSON.stringify({ stop, quantity: '1' }), at, at]
    );
  }

  it('does not adopt an external position when ACCEPTED becomes CANCELLED', async () => {
    const { store, accountRef } = await openStore();
    await insertIntent(store, accountRef, 'ACCEPTED');
    const venue = transport({
      positions: async () => [pos()],
      lookupOrder: async (_symbol, clientOrderId) => ({
        clientOrderId,
        venueOrderId: 'ord-1',
        state: 'CANCELLED',
        filledQty: '0'
      })
    });
    const recon = await reconcileAccountState({ store, accountRef, transport: venue });
    expect(venue.placed).toEqual([]);
    expect(recon.externalCredentialConflict).toBe(true);
    const owned = await store.execute(
      `SELECT state FROM managed_positions WHERE account_ref = ? AND state = 'OPEN'`,
      [accountRef]
    );
    expect(owned.rows).toHaveLength(0);
  });

  it('does not adopt a reopen that reuses a closed position key', async () => {
    const { store, accountRef } = await openStore();
    const at = now();
    await store.execute(
      `INSERT INTO managed_positions (
        account_ref, position_key, native_position_id, symbol, native_instrument,
        position_mode, side, qty, entry_price, stop_price, tp_price, leverage,
        ownership, protection_state, thesis_json, state, opened_at, updated_at, closed_at
      ) VALUES (?, 'BTCUSDT:ONE_WAY', NULL, 'BTCUSDT', 'BTCUSDT', 'ONE_WAY', 'LONG', '1', '68000', '50000', NULL, 5, 'MANAGED', 'VERIFIED', '{}', 'OPEN', ?, ?, NULL)`,
      [accountRef, at, at]
    );
    const gone = transport({ positions: async () => [] });
    await reconcileAccountState({ store, accountRef, transport: gone });
    const closed = await store.execute(
      `SELECT state FROM managed_positions WHERE account_ref = ? AND position_key = 'BTCUSDT:ONE_WAY'`,
      [accountRef]
    );
    expect(String(closed.rows[0]?.state)).toBe('CLOSED');

    const venue = transport({ positions: async () => [pos('69100')] });
    const recon = await reconcileAccountState({ store, accountRef, transport: venue });
    expect(venue.placed).toEqual([]);
    expect(recon.externalCredentialConflict).toBe(true);
    const reopened = await store.execute(
      `SELECT state FROM managed_positions WHERE account_ref = ? AND state = 'OPEN'`,
      [accountRef]
    );
    expect(reopened.rows).toHaveLength(0);
  });

  it('reconciles an ACCEPTED order that lookup reports FILLED and protects the actual partial qty', async () => {
    const { store, accountRef } = await openStore();
    await insertIntent(store, accountRef, 'ACCEPTED', '67000');
    const seenQty: string[] = [];
    const placedStops: string[] = [];
    const venue = transport({
      positions: async () => [pos('68400', '0.01')],
      lookupOrder: async (_symbol, clientOrderId) => ({
        clientOrderId,
        venueOrderId: 'ord-fill',
        state: 'PARTIAL',
        filledQty: '0.01'
      }),
      readProtection: async () => ({ state: 'MISSING', coveredQty: '0', stopPrice: null, reduceOnly: true }),
      placeProtection: async (position, stopPrice) => {
        seenQty.push(position.qty);
        placedStops.push(stopPrice);
        return { state: 'VERIFIED', coveredQty: position.qty, stopPrice, reduceOnly: true };
      }
    });
    const recon = await reconcileAccountState({ store, accountRef, transport: venue });
    expect(placedStops).toEqual(['67000']);
    expect(seenQty).toEqual(['0.01']);
    expect(recon.externalCredentialConflict).toBe(false);
    expect(recon.verifiedStops['BTCUSDT:ONE_WAY']).toBe('67000');
  });
});

describe('verified native stop', () => {
  it('keeps the obtained venue stop when a later read fails and does not place a second stop', async () => {
    const { store, accountRef } = await openStore();
    const at = new Date().toISOString();
    await store.execute(
      `INSERT INTO managed_positions (
        account_ref, position_key, native_position_id, symbol, native_instrument,
        position_mode, side, qty, entry_price, stop_price, tp_price, leverage,
        ownership, protection_state, thesis_json, state, opened_at, updated_at, closed_at
      ) VALUES (?, 'BTCUSDT:ONE_WAY', NULL, 'BTCUSDT', 'BTCUSDT', 'ONE_WAY', 'LONG', '0.2', '69000', '50000', NULL, 5, 'MANAGED', 'VERIFIED', '{}', 'OPEN', ?, ?, NULL)`,
      [accountRef, at, at]
    );
    let reads = 0;
    const venue = transport({
      positions: async () => [
        { positionKey: 'BTCUSDT:ONE_WAY', symbol: 'BTCUSDT', side: 'LONG', qty: '0.2', entryPrice: '69000' }
      ],
      readProtection: async (position) => {
        reads += 1;
        if (reads === 1) return { state: 'VERIFIED', coveredQty: position.qty, stopPrice: '67000', reduceOnly: true };
        throw new Error('readback failed');
      }
    });
    const recon = await reconcileAccountState({ store, accountRef, transport: venue });
    expect(venue.placed).toEqual([]);
    expect(recon.verifiedStops['BTCUSDT:ONE_WAY']).toBe('67000');
    expect(recon.verifiedStops['BTCUSDT:ONE_WAY']).not.toBe('50000');

    const moved = transport({
      positions: async () => [
        { positionKey: 'BTCUSDT:ONE_WAY', symbol: 'BTCUSDT', side: 'LONG', qty: '0.2', entryPrice: '69000' }
      ],
      readProtection: async (position) => ({
        state: 'VERIFIED',
        coveredQty: position.qty,
        stopPrice: '67150',
        reduceOnly: true
      })
    });
    const next = await reconcileAccountState({ store, accountRef, transport: moved });
    expect(moved.placed).toEqual([]);
    expect(next.verifiedStops['BTCUSDT:ONE_WAY']).toBe('67150');
  });
});

describe('external manual position', () => {
  it('reads protection and does not adopt or restop an untracked position', async () => {
    const { store, accountRef } = await openStore();
    const venue = transport({
      positions: async () => [
        {
          positionKey: 'ETHUSDT:ONE_WAY',
          symbol: 'ETHUSDT',
          side: 'SHORT',
          qty: '2',
          entryPrice: '3000'
        }
      ],
      readProtection: async () => ({
        state: 'VERIFIED',
        coveredQty: '2',
        stopPrice: '3100',
        reduceOnly: true
      })
    });
    const recon = await reconcileAccountState({ store, accountRef, transport: venue });
    expect(venue.placed).toEqual([]);
    expect(recon.externalCredentialConflict).toBe(true);
    expect(recon.protection['ETHUSDT:ONE_WAY']).toBe('VERIFIED');
    expect(recon.verifiedStops['ETHUSDT:ONE_WAY']).toBe('3100');
    const owned = await store.execute(
      `SELECT state FROM managed_positions WHERE account_ref = ? AND symbol = 'ETHUSDT'`,
      [accountRef]
    );
    expect(owned.rows).toHaveLength(0);
  });
});

describe('opposite-side candidate', () => {
  it('re-checks a Lead side flip through Risk and does not mix the tickets', async () => {
    const seen: string[] = [];
    let riskCalls = 0;
    const runner = new RoleRunner({
      providerCaller: async (req) => {
        if (req.role === 'risk') {
          riskCalls += 1;
          seen.push(req.user);
          const revised = req.user.includes('"side": "SHORT"');
          return JSON.stringify({
            stance: revised ? 'SHORT' : 'LONG',
            decision: revised ? 'APPROVE' : 'APPROVE',
            claimRefs: ['ev-1'],
            contraryRefs: [],
            reasoning: revised ? 'Final SHORT ticket is inside Owner caps.' : 'LONG ticket approved.',
            confidence: { value: 0.2, scale: 'probability_0_1' }
          });
        }
        if (req.role === 'execution') {
          return JSON.stringify({
            stance: 'LONG',
            claimRefs: ['ev-1'],
            contraryRefs: [],
            reasoning: 'Long limit.',
            confidence: { value: 0.7, scale: 'probability_0_1' },
            proposedStop: '67000',
            proposedTp: '72000',
            proposedOrderType: 'LIMIT_GTC',
            proposedLimitPrice: '68400'
          });
        }
        if (req.role === 'lead') {
          return JSON.stringify({
            stance: 'SHORT',
            claimRefs: ['ev-1'],
            contraryRefs: [],
            reasoning: 'Flip the side.',
            confidence: { value: 0.2, scale: 'probability_0_1' },
            proposedStop: '70000',
            proposedTp: '64000',
            proposedOrderType: 'MARKET',
            proposedLimitPrice: null
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
      cycleId: 'cycle-opposite-side',
      reason: 'owner',
      accountRef: 'paper:default',
      symbol: 'BTCUSDT',
      evidenceId: 'ev-1',
      configVersion: 1,
      policy: {
        minEntryConfidencePct: 90,
        requireTwoOfThreeAnalysts: false,
        maxLeverage: 5,
        allocationPerOrderUsdt: 200
      },
      marketSummary: { last: '68500' }
    });
    expect(riskCalls).toBe(2);
    expect(seen[0]).toContain('"side": "LONG"');
    expect(seen[1]).toContain('"side": "SHORT"');
    expect(seen[1]).toContain('MARKET');
    expect(seen[1]).toContain('70000');
    expect(out.verdict?.action).toBe('OPEN_SHORT');
    expect(out.verdict?.thesis?.side).toBe('SHORT');
    expect(out.verdict?.thesis?.orderType).toBe('MARKET');
    expect(out.verdict?.thesis?.stop).toBe('70000');
    expect(out.verdict?.thesis?.limitPrice).toBeNull();
    expect(out.verdict?.rejectionReason).toBeNull();
  });
});

describe('verified stop price', () => {
  it('confirms only a positive native readback and ignores a synthetic percent', () => {
    expect(verifiedVenueStop({ protectionState: 'VERIFIED', stopPrice: '67000' })).toEqual({
      stop: 67000,
      protectionStatus: 'confirmed'
    });
    expect(verifiedVenueStop({ protectionState: 'MISSING', stopPrice: '65000' })).toEqual({
      stop: 0,
      protectionStatus: 'missing'
    });
    expect(verifiedVenueStop({ protectionState: null, stopPrice: null }).stop).toBe(0);
    expect(verifiedVenueStop({ protectionState: 'VERIFIED', stopPrice: null }).protectionStatus).not.toBe('confirmed');
  });
});

describe('owner allocation', () => {
  it('uses the active profile order size instead of always dividing by N', () => {
    expect(ownerAllocationPerOrder(800, 3, 25)).toBe(200);
    expect(ownerAllocationPerOrder(800, 3, null)).toBe(266.66);
    expect(ownerAllocationPerOrder(0, 3, null)).toBe(0);
  });
});

describe('kill audit', () => {
  it('keeps the first latch, appends a redacted audit line, and does not change clear semantics', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mpu-kill-audit-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'kill.json');
    writeKill(file, {
      at: 100,
      reason: 'CLI kill user_id=private-user-42 person@example.com',
      source: 'cli',
      requestId: 'not-a-uuid'
    });
    writeKill(file, { at: 200, reason: 'second kill', source: 'office' });
    const latch = readKill(file);
    expect(latch?.at).toBe(100);
    expect(latch?.source).toBe('cli');
    expect(latch?.reason).not.toContain('private-user-42');
    expect(latch?.reason).not.toContain('person@example.com');
    const audit = readFileSync(file + '.audit.jsonl', 'utf8');
    expect(audit).not.toContain('private-user-42');
    expect(audit).not.toContain('person@example.com');
    expect(audit.trim().split('\n')).toHaveLength(2);
    appendKillAudit(file, {
      at: 300,
      source: 'channel',
      requestId: 'user-secret-id',
      result: 'activated',
      reason: 'token=secret-token-value'
    });
    const extra = readFileSync(file + '.audit.jsonl', 'utf8');
    expect(extra).not.toContain('user-secret-id');
    expect(extra).not.toContain('secret-token-value');
  });
});
