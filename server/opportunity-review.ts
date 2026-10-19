import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { MarketSnapshot } from './types.js';
import type { Side } from './exchange/types.js';
import { safe, log } from './redact.js';
import { sanitizeUntrusted } from './untrusted.js';

export interface ReviewInput {
  id: string; symbol: string; side: Side | null;
  reasonKind: 'hold' | 'veto' | 'risk-reject' | 'execution-failed';
  reason: string; at: number; horizonMs: number;
  reference: { price: number; source: MarketSnapshot['source']; fetchedAt: number; example: boolean };
  evidence: Record<string, unknown>;
}
export interface OpportunityReview extends ReviewInput {
  updatedAt?: number;
  status: 'pending' | 'observed' | 'unavailable';
  observedAt: number | null; observedPrice: number | null; directionalMovePct: number | null;
}
/** Retrospective observations only. Never consulted by execution, guards or lesson promotion. */
export class OpportunityReviews {
  private items: OpportunityReview[] = [];
  constructor(private file: string | null = null) {
    if (file && existsSync(file)) try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as OpportunityReview[];
      if (Array.isArray(saved)) this.items = saved.filter((r) => r.id && Number.isFinite(r.at) && r.horizonMs > 0).slice(-500);
    } catch { log('[opportunity review] local history could not be read'); }
  }
  record(input: ReviewInput) {
    if (this.items.some((r) => r.id === input.id)) return;
    const eligible = input.side != null && input.reference.price > 0 && Number.isFinite(input.reference.price) && !input.reference.example && input.reference.source !== 'sample' && input.horizonMs > 0 && Number.isFinite(input.horizonMs) && input.reference.fetchedAt <= input.at && input.at - input.reference.fetchedAt <= input.horizonMs;
    this.items.push({ ...input, reason: safe(sanitizeUntrusted(input.reason, 1000).text), updatedAt: input.at, status: eligible ? 'pending' : 'unavailable', observedAt: null, observedPrice: null, directionalMovePct: null });
    this.items = this.items.slice(-500); this.save();
  }
  observe(snapshot: MarketSnapshot, now = Date.now()) {
    let changed = false;
    for (const r of this.items) {
      if (r.status !== 'pending' || now < r.at + r.horizonMs) continue;
      if (now > r.at + 2 * r.horizonMs) { r.status = 'unavailable'; r.updatedAt = now; changed = true; continue; }
      if (r.symbol !== snapshot.symbol) continue;
      if (snapshot.fetchedAt < r.at + r.horizonMs && now <= r.at + 2 * r.horizonMs) continue;
      const valid = snapshot.fetchedAt >= r.at + r.horizonMs && snapshot.fetchedAt <= r.at + 2 * r.horizonMs && snapshot.fetchedAt <= now && now - snapshot.fetchedAt <= r.horizonMs && !snapshot.example && snapshot.source === r.reference.source && snapshot.last > 0 && Number.isFinite(snapshot.last);
      r.status = valid ? 'observed' : 'unavailable';
      r.updatedAt = now;
      if (valid) {
        r.observedPrice = snapshot.last; r.observedAt = snapshot.fetchedAt;
        r.directionalMovePct = Number(((snapshot.last / r.reference.price - 1) * 100 * (r.side === 'SHORT' ? -1 : 1)).toFixed(8));
      }
      changed = true;
    }
    if (changed) this.save();
  }
  since(at: number) { return structuredClone(this.items.filter((r) => r.at > at || (r.updatedAt ?? r.observedAt ?? r.at) > at)); }
  private save() {
    if (!this.file) return;
    try { mkdirSync(path.dirname(this.file), { recursive: true }); writeFileSync(this.file + '.tmp', JSON.stringify(this.items)); renameSync(this.file + '.tmp', this.file); }
    catch { log('[opportunity review] local history could not be saved'); }
  }
}
