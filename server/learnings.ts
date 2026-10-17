import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { AgentId } from './types.js';
import { sanitizeUntrusted } from './untrusted.js';
import { safe, log } from './redact.js';

// The desk's memory (self-improving). After losses, stops, errors, scan alerts and owner
// corrections the desk writes a lesson: what happened, root cause, lesson, status.
// The same lesson seen again is "confirmed"; seen PROMOTE_AFTER times (default 3) it is
// "promoted" into the standing rules that go into every prompt of that role.
// A lesson is advice, never a setting. It cannot change a cap in code, and any lesson or
// promotion whose lesson text (the part that reaches prompts) reads like loosening a guard (bigger size, more leverage, no or wider stop,
// skip risk, touch the safety net) is refused before it is stored or promoted.

export type LessonKind = 'loss' | 'stop' | 'error' | 'scan' | 'correction' | 'review' | 'note';
export type LessonStatus = 'new' | 'confirmed' | 'promoted';
export type LessonRole = AgentId | 'desk';
export interface Lesson {
  id: string; key: string; role: LessonRole; kind: LessonKind; symbol?: string;
  happened: string; rootCause: string; lesson: string;
  status: LessonStatus; count: number; firstAt: number; lastAt: number; source: 'desk' | 'grokbot' | 'owner';
}
export interface LessonInput { role: LessonRole; kind: LessonKind; symbol?: string; happened: string; rootCause: string; lesson: string; source?: Lesson['source']; key?: string }

const LOOSEN: RegExp[] = [
  /\b(increase|raise|higher|bigger|larger|double|triple|max(imum)?|more|add)\s+(the\s+|our\s+|my\s+|some\s+)?(leverage|size|sizing|position size|risk|exposure|allocation|margin)\b/i,
  /\b(no|skip|skipping|remove|removing|disable|disabling|without|widen|wider|loosen|ignore|ignoring|bypass|bypassing|turn off|drop|cancel|use|lower|reduce|shrink|spend|trade)\s+(the\s+|a\s+|our\s+|any\s+|into\s+the\s+)?(stops?|stop[- ]loss(es)?|sl|risk gate|risk manager|risk check|daily loss( stop| limit)?|daily stop|safety net|kill switch|guards?|caps?|limits?)\b/i,
  /\b(stops?|stop[- ]loss|safety net|risk gate|daily loss|guards?|caps?)\s+(is|are)\s+(not needed|unnecessary|optional|useless|too tight)\b/i,
  /\b([5-9]|\d{2,})\s?x\b/i,
  /\b(all[- ]in|martingale|average down|averaging down|revenge trad(e|ing)|retry (the )?order|resend)\b/i,
  /\b(withdraw|transfer funds|send funds|private key)\b/i,
  /\bn\s*(=|to)\s*([5-9]|\d{2,})\b/i
];

/** True when text reads like it would loosen a guard. Such lessons are never stored or promoted. */
export function loosensGuard(text: string): boolean { return LOOSEN.some((r) => r.test(text)); }

const clean = (s: string, n: number) => safe(sanitizeUntrusted(String(s ?? ''), n).text).replace(/\s+/g, ' ').trim();
/** Same situation, same key: numbers and case do not matter. */
export const lessonKey = (role: string, kind: string, lesson: string) => `${role}|${kind}|${lesson.toLowerCase().replace(/[0-9.,%$-]+/g, '#').replace(/[^a-z#]+/g, ' ').trim().slice(0, 120)}`;

export class Learnings {
  items: Lesson[] = [];
  refused = 0;
  constructor(private file: string | null, public promoteAfter = 3, private max = 300) {
    if (file && existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        if (Array.isArray(raw?.lessons)) this.items = raw.lessons.filter((l: Lesson) => l && typeof l.lesson === 'string' && !loosensGuard(l.lesson)).slice(-max);
      } catch (e) { log('[learnings] could not read', safe((e as Error).message)); }
    }
  }

  /** Stores or reinforces a lesson. Returns null when it is empty or would loosen a guard. */
  add(input: LessonInput): { lesson: Lesson; event: LessonStatus } | null {
    const happened = clean(input.happened, 240), rootCause = clean(input.rootCause, 200), text = clean(input.lesson, 240);
    if (text.length < 8) return null;
    if (loosensGuard(text)) { this.refused++; log(`[learnings] refused a lesson for ${input.role}: it would loosen a guard`); return null; }
    const key = input.key ?? lessonKey(input.role, input.kind, text);
    const now = Date.now();
    const hit = this.items.find((x) => x.key === key);
    let lesson: Lesson, event: LessonStatus;
    if (hit) {
      hit.count++; hit.lastAt = now; hit.happened = happened || hit.happened; if (input.symbol) hit.symbol = input.symbol;
      const next: LessonStatus = hit.count >= this.promoteAfter ? 'promoted' : 'confirmed';
      // promotion is checked again: a standing rule can never loosen a guard
      if (next === 'promoted' && loosensGuard(hit.lesson)) { this.refused++; hit.status = 'confirmed'; }
      else hit.status = next;
      lesson = hit; event = hit.status;
      this.items = [...this.items.filter((x) => x !== hit), hit];
    } else {
      lesson = { id: `L${now.toString(36)}${Math.random().toString(36).slice(2, 5)}`, key, role: input.role, kind: input.kind, symbol: input.symbol, happened, rootCause, lesson: text, status: 'new', count: 1, firstAt: now, lastAt: now, source: input.source ?? 'desk' };
      if (this.promoteAfter <= 1) lesson.status = 'promoted';
      this.items.push(lesson); event = lesson.status;
      if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
    }
    this.save();
    return { lesson, event };
  }

  /** Promoted lessons for a role plus desk-wide ones: injected into prompts as standing rules. */
  standingRules(role?: AgentId): Lesson[] {
    return this.items.filter((x) => x.status === 'promoted' && (!role || x.role === role || x.role === 'desk' || x.role === 'lead') && !loosensGuard(x.lesson));
  }
  /** Latest non-promoted lessons for a role (plus desk-wide), newest first, as short lines. */
  forRole(role: AgentId, n = 5): string[] {
    return this.items.filter((x) => x.status !== 'promoted' && (x.role === role || x.role === 'desk')).slice(-n).reverse()
      .map((x) => `[${x.status}] ${x.kind}${x.symbol ? ` ${x.symbol}` : ''}: ${x.lesson}`);
  }
  since(t: number): Lesson[] { return this.items.filter((x) => x.lastAt >= t).reverse(); }
  recent(n = 12): Lesson[] { return this.items.slice(-n).reverse(); }

  private save() {
    if (!this.file) return;
    try { mkdirSync(path.dirname(this.file), { recursive: true }); writeFileSync(this.file, JSON.stringify({ note: 'Trading Agent Mpu Gandring desk lessons. Advice only, never a setting. Guards are enforced in code.', lessons: this.items }, null, 2) + '\n'); }
    catch (e) { log('[learnings] could not write', safe((e as Error).message)); }
  }
}
