import { randomUUID } from 'node:crypto';
import type { RuntimeStore } from '../store/database.js';

export interface ExecutionAuthorityRecord {
  accountRef: string;
  holderId: string;
  writerEpoch: number;
  haltLatched: boolean;
  haltOrigin: string | null;
  haltReason: string | null;
  updatedAt: string;
}

export class ExecutionAuthorityService {
  constructor(
    private readonly store: RuntimeStore,
    public readonly defaultHolderId: string = `runtime-${randomUUID()}`
  ) {}

  async current(accountRef: string): Promise<ExecutionAuthorityRecord | null> {
    const res = await this.store.execute(
      `SELECT account_ref, holder_id, writer_epoch, halt_latched, halt_origin, halt_reason, updated_at
       FROM execution_authority
       WHERE account_ref = ?`,
      [accountRef]
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0]!;
    return {
      accountRef: String(row.account_ref),
      holderId: String(row.holder_id),
      writerEpoch: Number(row.writer_epoch),
      haltLatched: Number(row.halt_latched) === 1,
      haltOrigin: row.halt_origin === null ? null : String(row.halt_origin),
      haltReason: row.halt_reason === null ? null : String(row.halt_reason),
      updatedAt: String(row.updated_at)
    };
  }

  async claim(
    accountRef: string,
    holderId: string = this.defaultHolderId
  ): Promise<ExecutionAuthorityRecord> {
    const nowIso = new Date().toISOString();
    await this.store.transaction(async (tx) => {
      const existing = await tx.execute(
        `SELECT holder_id, writer_epoch FROM execution_authority WHERE account_ref = ?`,
        [accountRef]
      );
      if (existing.rows.length === 0) {
        await tx.execute(
          `INSERT INTO execution_authority (
            account_ref, holder_id, writer_epoch, halt_latched, halt_origin, halt_reason, updated_at
          ) VALUES (?, ?, 1, 0, NULL, NULL, ?)`,
          [accountRef, holderId, nowIso]
        );
        await tx.append({
          eventId: `auth-claim-${accountRef}-1`,
          scope: accountRef,
          kind: 'authority.claimed',
          createdAt: nowIso,
          correlationId: null,
          causationId: null,
          schemaVersion: 1,
          payload: { accountRef, holderId, writerEpoch: 1 }
        });
      } else {
        const currentHolder = String(existing.rows[0]!.holder_id);
        const currentEpoch = Number(existing.rows[0]!.writer_epoch);
        if (currentHolder !== holderId) {
          const nextEpoch = currentEpoch + 1;
          await tx.execute(
            `UPDATE execution_authority
             SET holder_id = ?, writer_epoch = ?, updated_at = ?
             WHERE account_ref = ?`,
            [holderId, nextEpoch, nowIso, accountRef]
          );
          await tx.append({
            eventId: `auth-claim-${accountRef}-${nextEpoch}-${randomUUID()}`,
            scope: accountRef,
            kind: 'authority.claimed',
            createdAt: nowIso,
            correlationId: null,
            causationId: null,
            schemaVersion: 1,
            payload: { accountRef, holderId, writerEpoch: nextEpoch }
          });
        }
      }
    });
    const out = await this.current(accountRef);
    if (!out) {
      throw new Error(`Failed to read execution_authority for ${accountRef}`);
    }
    return out;
  }

  async bumpEpoch(
    accountRef: string,
    nextHolderId: string = this.defaultHolderId
  ): Promise<ExecutionAuthorityRecord> {
    const nowIso = new Date().toISOString();
    await this.store.transaction(async (tx) => {
      const existing = await tx.execute(
        `SELECT writer_epoch FROM execution_authority WHERE account_ref = ?`,
        [accountRef]
      );
      if (existing.rows.length === 0) {
        await tx.execute(
          `INSERT INTO execution_authority (
            account_ref, holder_id, writer_epoch, halt_latched, halt_origin, halt_reason, updated_at
          ) VALUES (?, ?, 1, 0, NULL, NULL, ?)`,
          [accountRef, nextHolderId, nowIso]
        );
      } else {
        const nextEpoch = Number(existing.rows[0]!.writer_epoch) + 1;
        await tx.execute(
          `UPDATE execution_authority
           SET holder_id = ?, writer_epoch = ?, updated_at = ?
           WHERE account_ref = ?`,
          [nextHolderId, nextEpoch, nowIso, accountRef]
        );
        await tx.append({
          eventId: `auth-epoch-${accountRef}-${nextEpoch}-${randomUUID()}`,
          scope: accountRef,
          kind: 'authority.epoch_bumped',
          createdAt: nowIso,
          correlationId: null,
          causationId: null,
          schemaVersion: 1,
          payload: { accountRef, holderId: nextHolderId, writerEpoch: nextEpoch }
        });
      }
    });
    const out = await this.current(accountRef);
    if (!out) {
      throw new Error(`Failed to bump execution_authority epoch for ${accountRef}`);
    }
    return out;
  }

  async setHalt(
    accountRef: string,
    latched: boolean,
    origin: string | null,
    reason: string | null
  ): Promise<ExecutionAuthorityRecord> {
    const nowIso = new Date().toISOString();
    await this.store.transaction(async (tx) => {
      const existing = await tx.execute(
        `SELECT writer_epoch FROM execution_authority WHERE account_ref = ?`,
        [accountRef]
      );
      if (existing.rows.length === 0) {
        await tx.execute(
          `INSERT INTO execution_authority (
            account_ref, holder_id, writer_epoch, halt_latched, halt_origin, halt_reason, updated_at
          ) VALUES (?, ?, 1, ?, ?, ?, ?)`,
          [accountRef, this.defaultHolderId, latched ? 1 : 0, origin, reason, nowIso]
        );
      } else {
        await tx.execute(
          `UPDATE execution_authority
           SET halt_latched = ?, halt_origin = ?, halt_reason = ?, updated_at = ?
           WHERE account_ref = ?`,
          [latched ? 1 : 0, origin, reason, nowIso, accountRef]
        );
      }
      await tx.append({
        eventId: `auth-halt-${accountRef}-${randomUUID()}`,
        scope: accountRef,
        kind: latched ? 'authority.halted' : 'authority.unhalted',
        createdAt: nowIso,
        correlationId: null,
        causationId: null,
        schemaVersion: 1,
        payload: { accountRef, latched, origin, reason }
      });
    });
    const out = await this.current(accountRef);
    if (!out) {
      throw new Error(`Failed to update halt latch for ${accountRef}`);
    }
    return out;
  }
}
