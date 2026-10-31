import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeStore, StoreConflictError, StoreWriteError } from '../../server/v2/store/database.js';
import { SCHEMA_VERSION } from '../../server/v2/store/schema.js';
import type { DomainEvent } from '../../server/v2/contracts.js';

const tempDirs: string[] = [];

function createTempDbPath(name = 'runtime.sqlite'): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'mpu-rebirth-store-'));
  tempDirs.push(dir);
  return path.join(dir, '.mpu-gandring', 'rebirth', name);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows file handle release may trail close by a tick.
    }
  }
});

describe('T02 durable store, schema and crash recovery', () => {
  it('native_driver_opens_offline_on_supported_node', async () => {
    const dbFile = createTempDbPath();
    const originalFetch = globalThis.fetch;
    let networkCalled = false;
    globalThis.fetch = (async () => {
      networkCalled = true;
      throw new Error('Unexpected network call during local file: open');
    }) as typeof fetch;

    try {
      const store = await RuntimeStore.open(dbFile);
      const pragmas = await store.pragmas();
      expect(pragmas.foreignKeys).toBe(1);
      expect(pragmas.journalMode.toLowerCase()).toBe('wal');
      expect(pragmas.synchronous).toBeGreaterThanOrEqual(2);

      const mig = await store.execute('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1');
      expect(Number(mig.rows[0]?.version)).toBe(SCHEMA_VERSION);

      const seq = await store.append({
        eventId: 'evt-offline-1',
        scope: 'system',
        kind: 'runtime.boot',
        createdAt: '2026-10-31T09:00:00.000Z',
        correlationId: 'corr-1',
        causationId: null,
        schemaVersion: 1,
        payload: { ok: true }
      });
      expect(seq).toBe(1);
      await store.close();

      const reopened = await RuntimeStore.open(dbFile);
      const rows = await reopened.execute('SELECT seq, event_id, kind FROM events WHERE event_id = ?', ['evt-offline-1']);
      expect(rows.rows).toHaveLength(1);
      expect(Number(rows.rows[0]?.seq)).toBe(1);
      await reopened.close();

      expect(networkCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('transaction_rollback_preserves_projection', async () => {
    const dbFile = createTempDbPath();
    const store = await RuntimeStore.open(dbFile);

    await store.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO accounts (account_ref, venue, network, mode, native_identity_hash, subaccount_ref, lifecycle_state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['acct-paper-1', 'bybit', 'testnet', 'PAPER', 'hash-paper-1', null, 'ACTIVE', '2026-10-31T09:00:00.000Z', '2026-10-31T09:00:00.000Z']
      );
      await tx.append({
        eventId: 'evt-acct-created',
        scope: 'acct-paper-1',
        kind: 'account.registered',
        createdAt: '2026-10-31T09:00:00.000Z',
        correlationId: null,
        causationId: null,
        schemaVersion: 1,
        payload: { accountRef: 'acct-paper-1' }
      });
    });

    await expect(
      store.transaction(async (tx) => {
        await tx.append({
          eventId: 'evt-rolled-back',
          scope: 'acct-paper-1',
          kind: 'account.mutated',
          createdAt: '2026-10-31T09:01:00.000Z',
          correlationId: null,
          causationId: null,
          schemaVersion: 1,
          payload: { step: 'before-error' }
        });
        await tx.execute(
          `UPDATE accounts SET lifecycle_state = ? WHERE account_ref = ?`,
          ['DRAINING', 'acct-paper-1']
        );
        throw new Error('simulated failure mid-transaction');
      })
    ).rejects.toThrow('simulated failure mid-transaction');

    const acct = await store.execute('SELECT lifecycle_state FROM accounts WHERE account_ref = ?', ['acct-paper-1']);
    expect(acct.rows[0]?.lifecycle_state).toBe('ACTIVE');

    const events = await store.execute('SELECT event_id FROM events ORDER BY seq ASC');
    expect(events.rows.map((r) => r.event_id)).toEqual(['evt-acct-created']);

    await store.close();
  });

  it('duplicate_event_returns_original_seq', async () => {
    const dbFile = createTempDbPath();
    const store = await RuntimeStore.open(dbFile);

    const baseEvent: DomainEvent = {
      eventId: 'evt-idem-1',
      scope: 'system',
      kind: 'settings.saved',
      createdAt: '2026-10-31T09:02:00.000Z',
      correlationId: 'corr-idem',
      causationId: null,
      schemaVersion: 1,
      payload: { version: 1, mode: 'PAPER' }
    };

    const firstSeq = await store.append(baseEvent);
    const secondSeq = await store.append({ ...baseEvent });
    expect(secondSeq).toBe(firstSeq);

    await expect(
      store.append({
        ...baseEvent,
        payload: { version: 2, mode: 'LIVE' }
      })
    ).rejects.toBeInstanceOf(StoreConflictError);

    await store.close();
  });

  it('torn_apply_recovers', async () => {
    const dbFile = createTempDbPath();
    const store = await RuntimeStore.open(dbFile);

    await store.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO config_versions (version, payload_json, checksum, created_at) VALUES (?, ?, ?, ?)`,
        [1, JSON.stringify({ mode: 'PAPER', maxPositions: 3 }), 'chk-1', '2026-10-31T09:00:00.000Z']
      );
      await tx.execute(
        `INSERT INTO active_config (singleton_id, active_version, saved_version, updated_at) VALUES (1, 1, 1, ?)`,
        ['2026-10-31T09:00:00.000Z']
      );
      await tx.execute(
        `INSERT INTO config_versions (version, payload_json, checksum, created_at) VALUES (?, ?, ?, ?)`,
        [2, JSON.stringify({ mode: 'PAPER', maxPositions: 4 }), 'chk-2', '2026-10-31T09:01:00.000Z']
      );
      await tx.execute(
        `INSERT INTO config_applies (request_id, candidate_version, expected_active_version, status, subsystem_json, reason, created_at, updated_at)
         VALUES (?, ?, ?, 'PREPARING', '{}', NULL, ?, ?)`,
        ['req-torn-1', 2, 1, '2026-10-31T09:01:00.000Z', '2026-10-31T09:01:00.000Z']
      );
    });
    await store.close();

    // Child process starts an uncommitted write and dies before commit (SIGKILL).
    const childScript = `
      import { RuntimeStore } from './server/v2/store/database.js';
      const s = await RuntimeStore.open(${JSON.stringify(dbFile)});
      void s.transaction(async (tx) => {
        await tx.execute("UPDATE active_config SET active_version = 2 WHERE singleton_id = 1");
        process.stdout.write("IN_TX\\n");
        await new Promise((r) => setTimeout(r, 30000));
      });
    `;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childScript], {
        cwd: path.resolve(import.meta.dirname, '../..'),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
      let killed = false;
      child.stdout.on('data', (chunk: Buffer) => {
        if (!killed && chunk.toString('utf8').includes('IN_TX')) {
          killed = true;
          child.kill('SIGKILL');
        }
      });
      child.on('error', reject);
      child.on('close', () => resolve());
    });

    const recovered = await RuntimeStore.open(dbFile);
    const active = await recovered.execute('SELECT active_version FROM active_config WHERE singleton_id = 1');
    expect(Number(active.rows[0]?.active_version)).toBe(1);

    const applies = await recovered.execute('SELECT status, reason FROM config_applies WHERE request_id = ?', ['req-torn-1']);
    expect(applies.rows[0]?.status).toBe('FAILED');
    expect(String(applies.rows[0]?.reason ?? '')).toMatch(/interrupted|torn|recovered/i);

    // Two writers contending for the same (account_ref, intent_id): exactly one wins.
    await recovered.execute(
      `INSERT INTO accounts (account_ref, venue, network, mode, native_identity_hash, subaccount_ref, lifecycle_state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['acct-contend', 'bybit', 'testnet', 'TESTNET', 'hash-contend', null, 'ACTIVE', '2026-10-31T09:05:00.000Z', '2026-10-31T09:05:00.000Z']
    );

    const secondWriter = await RuntimeStore.open(dbFile);
    const insertIntent = (writer: RuntimeStore, clientOrderId: string) =>
      writer.transaction((tx) =>
        tx.execute(
          `INSERT INTO execution_intents (account_ref, intent_id, client_order_id, symbol, side, intent_kind, order_state, protection_state, payload_json, created_at, updated_at)
           VALUES (?, ?, ?, 'BTCUSDT', 'LONG', 'OPEN', 'JOURNALED', 'PENDING', '{}', ?, ?)`,
          ['acct-contend', 'intent-shared-1', clientOrderId, '2026-10-31T09:06:00.000Z', '2026-10-31T09:06:00.000Z']
        )
      );

    const outcomes = await Promise.allSettled([
      insertIntent(recovered, 'coid-writer-a'),
      insertIntent(secondWriter, 'coid-writer-b')
    ]);
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    await secondWriter.close();
    await recovered.close();
  }, 30000);

  it('disk_write_failure_is_visible', async () => {
    const dbFile = createTempDbPath();
    const store = await RuntimeStore.open(dbFile);

    store.simulateWriteFailure('ENOSPC: simulated disk full');
    await expect(
      store.append({
        eventId: 'evt-disk-fail',
        scope: 'system',
        kind: 'intent.journaled',
        createdAt: '2026-10-31T09:10:00.000Z',
        correlationId: null,
        causationId: null,
        schemaVersion: 1,
        payload: { intentId: 'i-1' }
      })
    ).rejects.toBeInstanceOf(StoreWriteError);

    store.simulateWriteFailure(null);
    const check = await store.execute('SELECT event_id FROM events WHERE event_id = ?', ['evt-disk-fail']);
    expect(check.rows).toHaveLength(0);

    // Also verify real SQLite read-only query_only rejection surfaces StoreWriteError.
    await store.execute('PRAGMA query_only = ON');
    await expect(
      store.append({
        eventId: 'evt-readonly-fail',
        scope: 'system',
        kind: 'intent.journaled',
        createdAt: '2026-10-31T09:11:00.000Z',
        correlationId: null,
        causationId: null,
        schemaVersion: 1,
        payload: { intentId: 'i-2' }
      })
    ).rejects.toBeInstanceOf(StoreWriteError);
    await store.execute('PRAGMA query_only = OFF');
    chmodSync(dbFile, 0o600);

    await store.close();
  });
});
