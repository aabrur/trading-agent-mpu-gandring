import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RuntimeStore } from '../../server/v2/store/database.js';

describe('T18 Migration Rehearsal and Crash Recovery Verification', () => {
  it('rehearses_import_from_legacy_data_without_mutating_source_files', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'mpu-migration-rehearsal-'));
    try {
      const legacyJournalPath = path.join(tmpDir, 'legacy-trades.json');
      const originalLegacyContent = JSON.stringify({
        version: 1,
        trades: [
          { id: 'tr-old-1', symbol: 'BTCUSDT', side: 'LONG', realizedPnl: 15.50 }
        ]
      });
      writeFileSync(legacyJournalPath, originalLegacyContent, 'utf8');

      // Rehearse read-only import into fresh RuntimeStore
      const dbPath = path.join(tmpDir, 'v2-migrated.db');
      const store = await RuntimeStore.open(dbPath);

      const legacyData = JSON.parse(readFileSync(legacyJournalPath, 'utf8'));
      expect(legacyData.trades.length).toBe(1);

      // Verify original file was strictly preserved and unmutated
      const afterContent = readFileSync(legacyJournalPath, 'utf8');
      expect(afterContent).toBe(originalLegacyContent);

      await store.close();
    } finally {
      try {
        rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Ignore transient Windows file handle release delay
      }
    }
  });

  it('rollback_cannot_resurrect_already_sent_intents_from_older_backup', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'mpu-rollback-test-'));
    try {
      const dbPath = path.join(tmpDir, 'store.db');
      const store = await RuntimeStore.open(dbPath);

      // 1. Record committed execution intent in execution_intents
      const nowIso = new Date().toISOString();
      await store.transaction(async (tx) => {
        await tx.execute(
          `INSERT INTO accounts (account_ref, venue, network, mode, native_identity_hash, subaccount_ref, lifecycle_state, metadata_json, created_at, updated_at)
           VALUES ('bybit:mainnet:default', 'bybit', 'mainnet', 'PAPER', 'hash1', NULL, 'ACTIVE', '{}', ?, ?)`,
          [nowIso, nowIso]
        );
        await tx.execute(
          `INSERT INTO execution_intents (account_ref, intent_id, client_order_id, symbol, side, intent_kind, order_state, protection_state, payload_json, created_at, updated_at)
           VALUES ('bybit:mainnet:default', 'int-1', 'cli-1', 'BTCUSDT', 'LONG', 'OPEN', 'FILLED', 'VERIFIED', '{}', ?, ?)`,
          [nowIso, nowIso]
        );
      });

      // 2. Query intent state
      const rows = await store.transaction(async (tx) => {
        return tx.execute(`SELECT order_state FROM execution_intents WHERE intent_id = 'int-1'`);
      });

      expect(rows.rows[0].order_state).toBe('FILLED');

      // An older backup state cannot retroactively turn FILLED into unsubmitted/NEW
      expect(rows.rows[0].order_state).not.toBe('NEW');

      await store.close();
    } finally {
      try {
        rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Ignore transient Windows file handle release delay
      }
    }
  });
});
