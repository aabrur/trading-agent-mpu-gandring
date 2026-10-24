import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { AgentId } from './types.js';
import { sanitizeUntrusted } from './untrusted.js';
import { safe, log } from './redact.js';

export type LessonKind = 'loss' | 'stop' | 'error' | 'scan' | 'correction' | 'review' | 'note';
export type LessonStatus = 'new' | 'confirmed' | 'promoted';
export type EvaluationStatus = 'candidate' | 'supported' | 'disputed' | 'inactive';
export type LessonRole = AgentId | 'desk';

export interface EvidenceRef {
  type: 'trade' | 'decision' | 'message' | 'financial' | 'scan';
  id: string;
  accountScope?: string;
  note?: string;
}

export interface Lesson {
  id: string; key: string; role: LessonRole; kind: LessonKind; symbol?: string;
  happened: string; rootCause: string; lesson: string;
  condition?: string;
  evaluationStatus?: EvaluationStatus;
  evidenceRefs?: EvidenceRef[];
  sourceTradeIds?: string[];
  sourceDecisionIds?: string[];
  sourceMessageIds?: string[];
  accountScope?: string;
  status: LessonStatus; count: number; firstAt: number; lastAt: number; source: 'desk' | 'grokbot' | 'owner';
}

export interface LessonInput {
  role: LessonRole; kind: LessonKind; symbol?: string;
  happened: string; rootCause: string; lesson: string;
  condition?: string;
  evaluationStatus?: EvaluationStatus;
  evidenceRefs?: EvidenceRef[];
  sourceTradeIds?: string[];
  sourceDecisionIds?: string[];
  sourceMessageIds?: string[];
  accountScope?: string;
  source?: Lesson['source']; key?: string;
}

// Lessons are advice, never authorization to raise configured guards or spend reserved capital.
// Explicit risk-profile settings remain separate from automatically learned text.
/** Lesson text never changes configuration; explicit Owner commands do. */
export function loosensGuard(_text: string): boolean { return false; }

const clean = (s: string, n: number) => safe(sanitizeUntrusted(String(s ?? ''), n).text).replace(/\s+/g, ' ').trim();
export const lessonKey = (role: string, kind: string, lesson: string) => `${role}|${kind}|${lesson.toLowerCase().replace(/[0-9.,%$-]+/g, '#').replace(/[^a-z#]+/g, ' ').trim().slice(0, 120)}`;

export class Learnings {
  items: Lesson[] = [];
  refused = 0;
  constructor(private file: string | null, public promoteAfter = 2, private max = 300) {
    if (file && existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        if (Array.isArray(raw?.lessons)) this.items = raw.lessons.filter((l: Lesson) => l && typeof l.lesson === 'string' && !loosensGuard(l.lesson)).slice(-max);
      } catch (e) { log('[learnings] could not read', safe((e as Error).message)); }
    }
  }

  /** Stores or reinforces a lesson. Promotes faster (promoteAfter = 2) so the desk adapts quickly. */
  add(input: LessonInput): { lesson: Lesson; event: LessonStatus } | null {
    const happened = clean(input.happened, 240), rootCause = clean(input.rootCause, 200), text = clean(input.lesson, 240);
    if (text.length < 8) return null;
    if (loosensGuard(text)) { this.refused++; log(`[learnings] refused a lesson for ${input.role}: violates hard safety rule`); return null; }
    const key = input.key ?? lessonKey(input.role, input.kind, text);
    const now = Date.now();
    const hit = this.items.find((x) => x.key === key);
    let lesson: Lesson, event: LessonStatus;

    const sourceTradeIds = Array.isArray(input.sourceTradeIds) ? [...new Set(input.sourceTradeIds.filter(Boolean))] : undefined;
    const sourceDecisionIds = Array.isArray(input.sourceDecisionIds) ? [...new Set(input.sourceDecisionIds.filter(Boolean))] : undefined;
    const sourceMessageIds = Array.isArray(input.sourceMessageIds) ? [...new Set(input.sourceMessageIds.filter(Boolean))] : undefined;
    const evidenceRefs = Array.isArray(input.evidenceRefs) ? input.evidenceRefs.filter(r => r && r.id) : undefined;
    const condition = input.condition ? clean(input.condition, 160) : undefined;
    const accountScope = input.accountScope ? clean(input.accountScope, 80) : undefined;

    if (hit) {
      const existingTrades = new Set(hit.sourceTradeIds ?? []);
      const existingDecisions = new Set(hit.sourceDecisionIds ?? []);
      const existingMessages = new Set(hit.sourceMessageIds ?? []);

      let hasNewEvidence = false;
      if (sourceTradeIds) {
        for (const tid of sourceTradeIds) { if (!existingTrades.has(tid)) { existingTrades.add(tid); hasNewEvidence = true; } }
        hit.sourceTradeIds = [...existingTrades];
      }
      if (sourceDecisionIds) {
        for (const did of sourceDecisionIds) { if (!existingDecisions.has(did)) { existingDecisions.add(did); hasNewEvidence = true; } }
        hit.sourceDecisionIds = [...existingDecisions];
      }
      if (sourceMessageIds) {
        for (const mid of sourceMessageIds) { if (!existingMessages.has(mid)) { existingMessages.add(mid); hasNewEvidence = true; } }
        hit.sourceMessageIds = [...existingMessages];
      }
      if (evidenceRefs) {
        const existingRefs = hit.evidenceRefs ?? [];
        const seenKeys = new Set(existingRefs.map(r => `${r.type}:${r.id}`));
        const freshRefs: EvidenceRef[] = [];
        for (const r of evidenceRefs) {
          const k = `${r.type}:${r.id}`;
          if (!seenKeys.has(k)) {
            seenKeys.add(k);
            freshRefs.push(r);
          }
        }
        hit.evidenceRefs = [...existingRefs, ...freshRefs].slice(-20);
      }

      // Do not double count identical evidence instances if no new independent evidence is added and it's the exact same observation
      if (!sourceTradeIds?.length || hasNewEvidence) {
        hit.count++;
      }
      hit.lastAt = now;
      hit.happened = happened || hit.happened;
      if (input.symbol) hit.symbol = input.symbol;
      if (condition) hit.condition = condition;
      if (accountScope) hit.accountScope = accountScope;

      if (input.evaluationStatus) {
        hit.evaluationStatus = input.evaluationStatus;
      } else if (!hit.evaluationStatus) {
        hit.evaluationStatus = (hit.sourceTradeIds?.length || hit.evidenceRefs?.length) ? 'supported' : 'candidate';
      }

      const next: LessonStatus = hit.count >= this.promoteAfter ? 'promoted' : 'confirmed';
      if (next === 'promoted' && (loosensGuard(hit.lesson) || hit.evaluationStatus === 'disputed' || hit.evaluationStatus === 'inactive')) {
        this.refused++;
        hit.status = 'confirmed';
      } else {
        hit.status = next;
      }
      lesson = hit;
      event = hit.status;
      this.items = [...this.items.filter((x) => x !== hit), hit];
    } else {
      const evaluationStatus: EvaluationStatus = input.evaluationStatus ??
        ((sourceTradeIds?.length || evidenceRefs?.length) ? 'supported' : 'candidate');

      lesson = {
        id: `L${now.toString(36)}${Math.random().toString(36).slice(2, 5)}`,
        key, role: input.role, kind: input.kind, symbol: input.symbol,
        happened, rootCause, lesson: text,
        condition,
        evaluationStatus,
        evidenceRefs,
        sourceTradeIds,
        sourceDecisionIds,
        sourceMessageIds,
        accountScope,
        status: 'new',
        count: 1,
        firstAt: now,
        lastAt: now,
        source: input.source ?? 'desk'
      };
      if (this.promoteAfter <= 1 && evaluationStatus !== 'disputed' && evaluationStatus !== 'inactive') {
        lesson.status = 'promoted';
      }
      this.items.push(lesson);
      event = lesson.status;
      if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
    }
    this.save();
    return { lesson, event };
  }

  standingRules(role?: AgentId): Lesson[] {
    return this.items.filter((x) =>
      x.status === 'promoted' &&
      x.evaluationStatus !== 'inactive' &&
      x.evaluationStatus !== 'disputed' &&
      (!role || x.role === role || x.role === 'desk' || x.role === 'lead') &&
      !loosensGuard(x.lesson)
    );
  }

  forRole(role: AgentId, n = 5): string[] {
    return this.items.filter((x) =>
      x.status !== 'promoted' &&
      x.evaluationStatus !== 'inactive' &&
      (x.role === role || x.role === 'desk')
    ).slice(-n).reverse().map((x) => `[${x.status}] ${x.kind}${x.symbol ? ` ${x.symbol}` : ''}: ${x.lesson}`);
  }

  /** Deterministic ranking and filtering of experience by role, symbol, account scope, and evidence status. */
  queryRelevant(opts: { role: AgentId | 'desk' | 'lead'; symbol?: string; accountScope?: string; mode?: string; limit?: number }): Lesson[] {
    const limit = opts.limit ?? 5;
    const scored = this.items.filter(x => x.evaluationStatus !== 'inactive').map(item => {
      let score = 0;
      // Role match
      if (item.role === opts.role) score += 10;
      else if (item.role === 'desk' || item.role === 'lead') score += 5;
      else score -= 2;

      // Symbol match
      if (opts.symbol && item.symbol) {
        if (item.symbol.toUpperCase() === opts.symbol.toUpperCase()) score += 12;
        else score -= 4;
      } else if (!item.symbol) {
        score += 3; // general rule applies to any symbol
      }

      // Account scope & trading mode match
      if (opts.accountScope && item.accountScope) {
        if (item.accountScope === opts.accountScope) score += 8;
        else score -= 3;
      } else if (opts.mode && item.accountScope) {
        if (item.accountScope.startsWith(`${opts.mode}:`)) score += 4;
        else score -= 2;
      } else {
        score += 1;
      }

      // Evaluation status
      if (item.evaluationStatus === 'supported') score += 6;
      else if (item.evaluationStatus === 'candidate') score += 2;
      else if (item.evaluationStatus === 'disputed') score -= 12;

      // Evidence presence
      if (item.sourceTradeIds?.length || item.sourceDecisionIds?.length || item.evidenceRefs?.length) score += 4;

      // Status
      if (item.status === 'promoted') score += 3;

      return { item, score };
    });

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score !== a.score ? b.score - a.score : b.item.lastAt - a.item.lastAt)
      .slice(0, limit)
      .map(s => s.item);
  }

  formatForPrompt(lessons: Lesson[]): string {
    return lessons.map(l => {
      const evidenceParts: string[] = [];
      if (l.sourceTradeIds?.length) evidenceParts.push(`trade:${l.sourceTradeIds.join(',')}`);
      if (l.sourceDecisionIds?.length) evidenceParts.push(`decision:${l.sourceDecisionIds.join(',')}`);
      if (l.sourceMessageIds?.length) evidenceParts.push(`msg:${l.sourceMessageIds.join(',')}`);
      const evidenceStr = evidenceParts.length ? ` [Evidence: ${evidenceParts.join(' ')}]` : '';
      const scopeStr = l.accountScope ? ` [Scope: ${l.accountScope}]` : '';
      const condStr = l.condition ? ` [When: ${l.condition}]` : '';
      return `[ID: ${l.id}] (${l.evaluationStatus ?? l.status}) ${l.role}${l.symbol ? ` on ${l.symbol}` : ''}${scopeStr}${condStr}: ${l.lesson}${evidenceStr}`;
    }).join('\n');
  }

  since(t: number): Lesson[] { return this.items.filter((x) => x.lastAt >= t).reverse(); }
  recent(n = 12): Lesson[] { return this.items.slice(-n).reverse(); }

  private save() {
    if (!this.file) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ note: 'Trading Agent Mpu Gandring desk lessons. Advice only, never a setting. Guards are enforced in code.', lessons: this.items }, null, 2) + '\n');
      renameSync(tmp, this.file);
    } catch (e) {
      log('[learnings] could not write', safe((e as Error).message));
    }
  }
}
