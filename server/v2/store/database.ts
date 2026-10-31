import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient, type Client, type InValue, type ResultSet } from '@libsql/client';
import type {
  DomainEvent,
  QueryResult,
  SqlValue,
  StoreTransaction
} from '../contracts.js';
import { prepareDomainEvent } from './events.js';
import { SCHEMA_STATEMENTS, SCHEMA_VERSION } from './schema.js';

export const DEFAULT_STORE_FILE = path.resolve('.mpu-gandring/rebirth/runtime.sqlite');

export class StoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreConflictError';
  }
}

export class StoreWriteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StoreWriteError';
  }
}

function toQueryResult(rs: ResultSet): QueryResult {
  const rows: Array<Record<string, SqlValue>> = rs.rows.map((row) => {
    const out: Record<string, SqlValue> = {};
    for (const col of rs.columns) {
      const raw = row[col] as unknown;
      if (
        raw === null ||
        typeof raw === 'string' ||
        typeof raw === 'number' ||
        typeof raw === 'bigint' ||
        raw instanceof Uint8Array
      ) {
        out[col] = raw;
      } else if (raw instanceof ArrayBuffer) {
        out[col] = new Uint8Array(raw);
      } else if (raw === undefined) {
        out[col] = null;
      } else {
        out[col] = String(raw);
      }
    }
    return out;
  });
  return {
    rows,
    rowsAffected: rs.rowsAffected
  };
}

function isWriteSql(sql: string): boolean {
  return /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i.test(sql);
}

function wrapDbError(error: unknown, isWrite: boolean): Error {
  if (error instanceof StoreConflictError || error instanceof StoreWriteError) {
    return error;
  }
  const msg = error instanceof Error ? error.message : String(error);
  if (/UNIQUE constraint failed/i.test(msg)) {
    return new StoreConflictError(msg);
  }
  if (isWrite || /READONLY|FULL|IOERR|CORRUPT|CANTOPEN|PERM|ENOSPC|attempt to write a readonly database/i.test(msg)) {
    return new StoreWriteError(msg, { cause: error });
  }
  return error instanceof Error ? error : new Error(msg);
}

export class RuntimeStore {
  private writeFaultMessage: string | null = null;
  private closed = false;
  private queryOnly = false;
  private writeLock: Promise<void> = Promise.resolve();

  private constructor(
    public readonly filePath: string,
    private readonly client: Client
  ) {}

  static async open(file: string = DEFAULT_STORE_FILE): Promise<RuntimeStore> {
    if (/^(https?|libsql|wss?):/i.test(file.trim())) {
      throw new StoreWriteError('RuntimeStore forbids remote database URLs; use a local file path.');
    }
    const resolvedFile = file.startsWith('file:')
      ? path.resolve(new URL(file).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
      : path.resolve(file);

    mkdirSync(path.dirname(resolvedFile), { recursive: true, mode: 0o700 });
    const fileUrl = pathToFileURL(resolvedFile).href;
    const client = createClient({
      url: fileUrl,
      timeout: 5000,
      concurrency: 1
    });

    const store = new RuntimeStore(resolvedFile, client);
    try {
      await client.execute('PRAGMA journal_mode = WAL');
      await client.execute('PRAGMA synchronous = FULL');
      await client.execute('PRAGMA foreign_keys = ON');

      const pragmas = await store.pragmas();
      if (pragmas.foreignKeys !== 1 || pragmas.journalMode.toLowerCase() !== 'wal' || pragmas.synchronous < 2) {
        throw new StoreWriteError(
          `SQLite durability pragmas unsupported: foreign_keys=${pragmas.foreignKeys}, journal_mode=${pragmas.journalMode}, synchronous=${pragmas.synchronous}`
        );
      }

      await store.migrateAndRecover();
      return store;
    } catch (error) {
      client.close();
      throw wrapDbError(error, true);
    }
  }

  simulateWriteFailure(reason: string | null): void {
    this.writeFaultMessage = reason;
  }

  private assertWritable(): void {
    if (this.closed) {
      throw new StoreWriteError('RuntimeStore is closed.');
    }
    if (this.writeFaultMessage) {
      throw new StoreWriteError(this.writeFaultMessage);
    }
    if (this.queryOnly) {
      throw new StoreWriteError('SQLITE_READONLY: attempt to write a readonly database (query_only=ON)');
    }
  }

  async pragmas(): Promise<{ foreignKeys: number; journalMode: string; synchronous: number }> {
    const fk = await this.client.execute('PRAGMA foreign_keys');
    const jm = await this.client.execute('PRAGMA journal_mode');
    const sync = await this.client.execute('PRAGMA synchronous');
    return {
      foreignKeys: Number(Object.values(fk.rows[0] ?? {})[0] ?? 0),
      journalMode: String(Object.values(jm.rows[0] ?? {})[0] ?? ''),
      synchronous: Number(Object.values(sync.rows[0] ?? {})[0] ?? 0)
    };
  }

  private async migrateAndRecover(): Promise<void> {
    await this.transaction(async (tx) => {
      for (const ddl of SCHEMA_STATEMENTS) {
        await tx.execute(ddl);
      }
      const now = new Date().toISOString();
      await tx.execute(
        `INSERT OR IGNORE INTO schema_migrations (version, applied_at, backup_manifest_json) VALUES (?, ?, ?)`,
        [SCHEMA_VERSION, now, null]
      );
      await tx.execute(
        `UPDATE config_applies
         SET status = 'FAILED',
             reason = 'Recovered interrupted PREPARING config apply on startup',
             updated_at = ?
         WHERE status = 'PREPARING'`,
        [now]
      );
    });
  }

  async execute(sql: string, args: SqlValue[] = []): Promise<QueryResult> {
    return this.withInProcessLock(async () => {
      const queryOnlyMatch = sql.match(/^\s*PRAGMA\s+query_only\s*=\s*(ON|OFF|1|0)\s*;?\s*$/i);
      if (queryOnlyMatch) {
        const flag = queryOnlyMatch[1]!.toUpperCase();
        this.queryOnly = flag === 'ON' || flag === '1';
      }
      const write = isWriteSql(sql);
      if (write) {
        this.assertWritable();
      } else if (this.closed) {
        throw new StoreWriteError('RuntimeStore is closed.');
      }
      try {
        const rs = await this.client.execute({
          sql,
          args: args as InValue[]
        });
        return toQueryResult(rs);
      } catch (error) {
        throw wrapDbError(error, write);
      }
    });
  }

  private async withInProcessLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.writeLock;
    let release!: () => void;
    this.writeLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  async transaction<T>(fn: (tx: StoreTransaction) => Promise<T>): Promise<T> {
    this.assertWritable();
    return this.withInProcessLock(async () => {
      this.assertWritable();
      const rawTx = await this.client.transaction('write');
      try {
        const txAdapter: StoreTransaction = {
          execute: async (sql: string, args: SqlValue[] = []): Promise<QueryResult> => {
            const write = isWriteSql(sql);
            if (write) this.assertWritable();
            try {
              const rs = await rawTx.execute({
                sql,
                args: args as InValue[]
              });
              return toQueryResult(rs);
            } catch (err) {
              throw wrapDbError(err, write);
            }
          },
          append: async (event: DomainEvent): Promise<number> => {
            this.assertWritable();
            const prepared = prepareDomainEvent(event);
            const existing = await txAdapter.execute(
              `SELECT seq, payload_digest FROM events WHERE event_id = ?`,
              [prepared.eventId]
            );
            if (existing.rows.length > 0) {
              const row = existing.rows[0]!;
              if (String(row.payload_digest) !== prepared.payloadDigest) {
                throw new StoreConflictError(
                  `Conflicting payload for existing eventId "${prepared.eventId}"`
                );
              }
              return Number(row.seq);
            }

            await txAdapter.execute(
              `INSERT INTO events (
                event_id, scope, kind, created_at, correlation_id, causation_id, schema_version, payload_json, payload_digest
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                prepared.eventId,
                prepared.scope,
                prepared.kind,
                prepared.createdAt,
                prepared.correlationId,
                prepared.causationId,
                prepared.schemaVersion,
                prepared.payloadJson,
                prepared.payloadDigest
              ]
            );
            const inserted = await txAdapter.execute(
              `SELECT seq FROM events WHERE event_id = ?`,
              [prepared.eventId]
            );
            return Number(inserted.rows[0]?.seq ?? 0);
          }
        };

        const result = await fn(txAdapter);
        this.assertWritable();
        await rawTx.commit();
        return result;
      } catch (error) {
        try {
          if (!rawTx.closed) {
            await rawTx.rollback();
          }
        } catch {
          // Preserve original error on rollback cleanup.
        }
        throw error;
      } finally {
        rawTx.close();
      }
    });
  }

  async append(event: DomainEvent): Promise<number> {
    return this.transaction((tx) => tx.append(event));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.writeLock;
    this.client.close();
  }
}
