import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { Position, ClosedTrade } from '../types.js';
import type { OrderRecord, Side } from '../exchange/types.js';
import { recordDiagnostic } from '../session-log.js';

export interface ExecutionIntent {
  clientId: string; symbol: string; side: Side; kind: 'open' | 'close'; requestedQty: number;
  stop?: number; tp?: number | null; leverage?: number; positionId?: string;
  awaitingQty?: number;
  awaitingObservedQty?: number;
  accountedQty: number; accountedValue: number | null; record: OrderRecord | null; at: number;
}

export interface DailyLossState { key: string; startEquity: number; lossHit: boolean }

/** Local ownership evidence and cumulative fill checkpoints. Contains no credentials. */
export class ExecutionJournal {
  intents: ExecutionIntent[] = [];
  positions: Position[] = [];
  closed: ClosedTrade[] = [];
  dailyLoss: DailyLossState | null = null;
  protectionClients: { symbol: string; clientId: string }[] = [];
  constructor(private file: string | null = null, private venue = '') {
    if (file && existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as { venue: string; intents: ExecutionIntent[]; positions: Position[]; closed: ClosedTrade[]; protectionClients?: { symbol: string; clientId: string }[]; dailyLoss?: DailyLossState };
      if (saved.venue !== venue || !Array.isArray(saved.intents) || !Array.isArray(saved.positions) || !Array.isArray(saved.closed)) throw new Error('Execution journal does not match this venue/network; inspect the local journal before starting.');
      this.intents = saved.intents; this.positions = saved.positions; this.closed = saved.closed; this.protectionClients = saved.protectionClients ?? [];
      if (saved.dailyLoss) {
        const day = saved.dailyLoss;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day.key) || !Number.isFinite(day.startEquity) || day.startEquity < 0 || typeof day.lossHit !== 'boolean') throw new Error('Invalid persisted daily loss state; inspect the local journal before starting.');
        this.dailyLoss = { ...day };
      }
    }
  }
  save() {
    if (!this.file) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ venue: this.venue, intents: this.intents, positions: this.positions, closed: this.closed, protectionClients: this.protectionClients, dailyLoss: this.dailyLoss }));
      renameSync(tmp, this.file);
      recordDiagnostic({ source: 'journal', category: 'JOURNAL', eventName: 'journal.persisted', status: 'persisted', message: 'Execution journal persisted', correlationId: this.intents.at(-1)?.clientId, details: { venue: this.venue, intents: this.intents.length, positions: this.positions.length, closed: this.closed.length } });
    } catch (error) {
      recordDiagnostic({ source: 'journal', category: 'JOURNAL', eventName: 'journal.failed', level: 'ERROR', status: 'failed', message: 'Execution journal persistence failed', details: { error } });
      throw error;
    }
  }
  checkpoint(positions: Position[], closed: ClosedTrade[]) {
    this.positions = structuredClone(positions.filter((p) => p.ownership !== 'external'));
    this.closed = structuredClone(closed.slice(0, 100));
    // Keep unresolved orders regardless of age; retain recent terminal evidence.
    const terminal = this.intents.filter((i) => this.settled(i));
    const keep = new Set(terminal.slice(-200).map((i) => i.clientId));
    this.intents = this.intents.filter((i) => !this.settled(i) || keep.has(i.clientId));
    this.save();
  }
  settled(i: ExecutionIntent) {
    return !!i.record && ['filled', 'cancelled', 'rejected'].includes(i.record.status) && i.accountedQty >= i.record.filledQty;
  }
}
