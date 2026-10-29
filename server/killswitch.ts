import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { safe } from './redact.js';

/**
 * The kill switch survives restarts. Pressing it writes this file; while the file exists the desk
 * starts killed (no new orders, auto off). Only the owner clears it, on the machine itself:
 * `npm run unkill -- --yes` or the authorized local Office OFF button. Release never places an order or enables Auto Trading.
 */
export const DEFAULT_KILL_FILE = 'data/kill-switch.json';
export type KillSource = 'cli' | 'office' | 'channel' | 'agent' | 'system';
export interface KillContext { source: KillSource; requestId: string }
export interface KillRecord { at: number; reason: string; source?: KillSource; requestId?: string }
export interface KillAuditRecord extends KillContext {
  at: number;
  result: 'activated' | 'already_active' | 'flatten_completed' | 'flatten_failed' | 'persistence_failed';
  reason: string;
}
const SOURCES: KillSource[] = ['cli', 'office', 'channel', 'agent', 'system'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function killContext(source: KillSource = 'system', requestId?: string): KillContext {
  return { source: SOURCES.includes(source) ? source : 'system', requestId: requestId && UUID.test(requestId) ? requestId : randomUUID() };
}
function auditReason(reason: string): string {
  return safe(reason).replace(/[\r\n\t]/g, ' ').replace(/\b\d{15,22}\b/g, '[REDACTED_ID]')
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_ID]')
    .replace(/\b(?:user|owner|chat|channel)[_-]?id\s*[:=]\s*\S+/gi, '[REDACTED_ID]').slice(0, 400);
}
/** Append-only local evidence. A failed append must be reported separately from activation. */
export function appendKillAudit(file: string | null | undefined, event: KillAuditRecord): { ok: boolean; error?: string } {
  if (!file) return { ok: true };
  try {
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    const context = killContext(event.source, event.requestId);
    appendFileSync(file + '.audit.jsonl', JSON.stringify({ at: event.at, ...context, result: event.result, reason: auditReason(event.reason) }) + '\n', { mode: 0o600 });
    return { ok: true };
  } catch (error) { return { ok: false, error: safe((error as Error).message) }; }
}

export function readKill(file: string | null | undefined): KillRecord | null {
  if (!file || !existsSync(file)) return null;
  try {
    const r = JSON.parse(readFileSync(file, 'utf8'));
    return {
      at: Number(r?.at) || 0, reason: auditReason(String(r?.reason ?? 'kill switch')),
      ...(SOURCES.includes(r?.source) ? { source: r.source as KillSource } : {}),
      ...(typeof r?.requestId === 'string' && UUID.test(r.requestId) ? { requestId: r.requestId } : {})
    };
  } catch {
    // Unreadable or corrupt still counts as killed (fail closed).
    return { at: 0, reason: 'kill switch file present but unreadable' };
  }
}
export function writeKill(file: string | null | undefined, rec: KillRecord) {
  const context = killContext(rec.source, rec.requestId);
  const record: KillRecord = { at: rec.at, reason: auditReason(rec.reason), ...context };
  if (!file) return { record, activated: false, audit: { ok: true } };
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  let activated = false;
  try {
    // Exclusive create preserves the first activation even across CLI/Office processes.
    writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    activated = true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const audit = appendKillAudit(file, { at: Date.now(), ...context, result: activated ? 'activated' : 'already_active', reason: record.reason });
  return { record: readKill(file)!, activated, audit };
}
export function clearKill(file: string): boolean {
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}
