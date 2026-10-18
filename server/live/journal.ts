import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { Position, ClosedTrade } from '../types.js';
import type { OrderRecord, Side } from '../exchange/types.js';

export interface ExecutionIntent {
  clientId: string; symbol: string; side: Side; kind: 'open' | 'close'; requestedQty: number;
  stop?: number; tp?: number | null; leverage?: number; positionId?: string;
  awaitingQty?: number;
  awaitingObservedQty?: number;
  accountedQty: number; accountedValue: number | null; record: OrderRecord | null; at: number;
}

/** Local ownership evidence and cumulative fill checkpoints. Contains no credentials. */
export class ExecutionJournal {
  intents: ExecutionIntent[] = [];
  positions: Position[] = [];
  closed: ClosedTrade[] = [];
  protectionClients: { symbol: string; clientId: string }[] = [];
  constructor(private file: string | null = null, private venue = '') {
    if (file && existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as { venue: string; intents: ExecutionIntent[]; positions: Position[]; closed: ClosedTrade[]; protectionClients?: { symbol: string; clientId: string }[] };
      if (saved.venue !== venue || !Array.isArray(saved.intents) || !Array.isArray(saved.positions) || !Array.isArray(saved.closed)) throw new Error('Execution journal does not match this venue/network; inspect the local journal before starting.');
      this.intents = saved.intents; this.positions = saved.positions; this.closed = saved.closed; this.protectionClients = saved.protectionClients ?? [];
    }
  }
  save() {
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ venue: this.venue, intents: this.intents, positions: this.positions, closed: this.closed, protectionClients: this.protectionClients }));
    renameSync(tmp, this.file);
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
