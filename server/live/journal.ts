import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Position, ClosedTrade } from '../types.js';
import type { OrderRecord, Side } from '../exchange/types.js';
import { recordDiagnostic } from '../session-log.js';

export interface ExecutionIntent {
  clientId: string; symbol: string; side: Side; kind: 'open' | 'close'; requestedQty: number;
  stop?: number; tp?: number | null; leverage?: number; positionId?: string; exitCause?: ClosedTrade['exitCause'];
  awaitingQty?: number;
  awaitingObservedQty?: number;
  accountedQty: number; accountedValue: number | null; record: OrderRecord | null; at: number;
}

export interface DailyLossState { key: string; startEquity: number; lossHit: boolean }

const inProcessLocks = new Set<string>();

function acquireLock(lockPath: string, maxAttempts = 2): () => void {
  const norm = path.resolve(lockPath);
  let acquired = false;
  const token = randomUUID();
  let lastErr: unknown = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (!inProcessLocks.has(norm)) {
      try {
        const fd = openSync(lockPath, 'wx');
        try {
          writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token }));
        } finally {
          closeSync(fd);
        }
        inProcessLocks.add(norm);
        acquired = true;
        break;
      } catch (e: any) {
        lastErr = e;
        if (e?.code === 'EEXIST') {
          try {
            const raw = readFileSync(lockPath, 'utf8');
            const data = JSON.parse(raw);
            let definitelyDead = false;
            if (Number.isSafeInteger(data.pid) && data.pid > 0) {
              try { process.kill(data.pid, 0); }
              catch (error) { definitelyDead = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
            }
            // Age and EPERM never establish death. Only a positively dead PID is recoverable.
            if (definitelyDead && readFileSync(lockPath, 'utf8') === raw) { unlinkSync(lockPath); continue; }
          } catch { /* Unknown ownership fails closed. */ }
        }
      }
    }

  }

  if (!acquired) {
    const conflictErr = new Error(`Conflicting journal lock: write in progress for ${path.basename(lockPath, '.lock')}`);
    if (lastErr) (conflictErr as any).cause = lastErr;
    throw conflictErr;
  }

  return () => {
    inProcessLocks.delete(norm);
    try {
      if (existsSync(lockPath) && JSON.parse(readFileSync(lockPath, 'utf8')).token === token) unlinkSync(lockPath);
    } catch {}
  };
}

/** Local ownership evidence and cumulative fill checkpoints. Contains no credentials. */
export class ExecutionJournal {
  intents: ExecutionIntent[] = [];
  positions: Position[] = [];
  closed: ClosedTrade[] = [];
  dailyLoss: DailyLossState | null = null;
  protectionClients: { symbol: string; clientId: string }[] = [];
  renameFn = renameSync;
  constructor(private file: string | null = null, private venue = '') {
    if (file && existsSync(file)) {
      let saved: { venue: string; intents: ExecutionIntent[]; positions: Position[]; closed: ClosedTrade[]; protectionClients?: { symbol: string; clientId: string }[]; dailyLoss?: DailyLossState } | null = null;
      try {
        const raw = readFileSync(file, 'utf8');
        saved = JSON.parse(raw);
      } catch (readErr) {
        const bak = `${file}.bak`;
        if (existsSync(bak)) {
          try {
            const bakRaw = readFileSync(bak, 'utf8');
            saved = JSON.parse(bakRaw);
            try { writeFileSync(file, bakRaw); } catch {}
            recordDiagnostic({
              source: 'journal',
              category: 'JOURNAL',
              eventName: 'journal.recovered',
              status: 'recovered',
              message: 'Primary journal corrupted; recovered from last-good backup',
              details: { file, backup: bak }
            });
          } catch {}
        }
        if (!saved) throw readErr;
      }
      if (!saved) throw new Error('Execution journal is unreadable and no valid backup exists.');
      if (saved.venue !== venue || !Array.isArray(saved.intents) || !Array.isArray(saved.positions) || !Array.isArray(saved.closed)) throw new Error('Execution journal does not match this venue/network; inspect the local journal before starting.');
      this.intents = saved.intents; this.positions = saved.positions; this.closed = saved.closed; this.protectionClients = saved.protectionClients ?? [];
      if (saved.dailyLoss) {
        const day = saved.dailyLoss;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day.key) || !Number.isFinite(day.startEquity) || day.startEquity < 0 || typeof day.lossHit !== 'boolean') throw new Error('Invalid persisted daily loss state; inspect the local journal before starting.');
        this.dailyLoss = { ...day };
      }
    }
  }
  save(renameAttempts = 5) {
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const lockPath = `${this.file}.lock`;
    const releaseLock = acquireLock(lockPath);
    const tmp = `${this.file}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 6)}.tmp`;
    try {
      const payload = JSON.stringify({
        venue: this.venue,
        intents: this.intents,
        positions: this.positions,
        closed: this.closed,
        protectionClients: this.protectionClients,
        dailyLoss: this.dailyLoss
      });
      writeFileSync(tmp, payload);

      let renamed = false;
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < renameAttempts; attempt++) {
        try {
          this.renameFn(tmp, this.file);
          renamed = true;
          break;
        } catch (e: any) {
          lastErr = e;
          if (['EPERM', 'EBUSY', 'EEXIST', 'EACCES'].includes(e?.code) && attempt < renameAttempts - 1) {
            // Synchronous compatibility calls never sleep. Production retries use saveAsync().
          } else {
            break;
          }
        }
      }

      if (!renamed) {
        try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
        throw lastErr ?? new Error('Failed to rename journal temp file');
      }

      try {
        writeFileSync(`${this.file}.bak`, payload);
      } catch {}

      recordDiagnostic({
        source: 'journal',
        category: 'JOURNAL',
        eventName: 'journal.persisted',
        status: 'persisted',
        message: 'Execution journal persisted',
        correlationId: this.intents.at(-1)?.clientId,
        details: { venue: this.venue, intents: this.intents.length, positions: this.positions.length, closed: this.closed.length }
      });
    } catch (error) {
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
      recordDiagnostic({
        source: 'journal',
        category: 'JOURNAL',
        eventName: 'journal.failed',
        level: 'ERROR',
        status: 'failed',
        message: 'Execution journal persistence failed',
        details: { error }
      });
      throw error;
    } finally {
      releaseLock();
    }
  }
  private writes: Promise<void> = Promise.resolve();
  saveAsync(): Promise<void> {
    const write = this.writes.then(async () => {
      for (let attempt = 0; ; attempt++) {
        try { this.save(1); return; }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (attempt >= 4 || !(['EPERM', 'EBUSY', 'EEXIST', 'EACCES'].includes(code ?? '') || /Conflicting journal lock/.test(String(error)))) throw error;
          await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 25));
        }
      }
    });
    this.writes = write.catch(() => {});
    return write;
  }

  checkpoint(positions: Position[], closed: ClosedTrade[], asynchronous = false) {
    this.positions = structuredClone(positions.filter((p) => p.ownership !== 'external'));
    this.closed = structuredClone(closed.slice(0, 100));
    // Keep unresolved orders regardless of age; retain recent terminal evidence.
    const terminal = this.intents.filter((i) => this.settled(i));
    const keep = new Set(terminal.slice(-200).map((i) => i.clientId));
    this.intents = this.intents.filter((i) => !this.settled(i) || keep.has(i.clientId));
    return asynchronous ? this.saveAsync() : this.save();
  }
  settled(i: ExecutionIntent) {
    return !!i.record && ['filled', 'cancelled', 'rejected'].includes(i.record.status) && i.accountedQty >= i.record.filledQty;
  }
}
