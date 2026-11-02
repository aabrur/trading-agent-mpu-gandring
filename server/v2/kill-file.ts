import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { safe } from '../redact.js';

/** File latch only. Release rules stay in the caller. Audit matches the official kill file. */
export const DEFAULT_KILL_FILE = 'data/kill-switch.json';
export type KillSource = 'cli' | 'office' | 'channel' | 'agent' | 'system';
const SOURCES: KillSource[] = ['cli', 'office', 'channel', 'agent', 'system'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export interface KillFileRecord {
  at: number;
  reason: string;
  source?: KillSource;
  requestId?: string;
}

export interface KillAuditRecord {
  at: number;
  source: KillSource;
  requestId: string;
  result: 'activated' | 'already_active' | 'flatten_completed' | 'flatten_failed' | 'persistence_failed';
  reason: string;
}

export function auditKillReason(reason: string): string {
  return safe(reason)
    .replace(/[\r\n\t]/g, ' ')
    .replace(/\b\d{15,22}\b/g, '[REDACTED_ID]')
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_ID]')
    .replace(/\b(?:user|owner|chat|channel)[_-]?id\s*[:=]\s*\S+/gi, '[REDACTED_ID]')
    .slice(0, 400);
}

function contextOf(source?: string, requestId?: string): { source: KillSource; requestId: string } {
  return {
    source: SOURCES.includes(source as KillSource) ? (source as KillSource) : 'system',
    requestId: requestId && UUID.test(requestId) ? requestId : randomUUID()
  };
}

export function appendKillAudit(
  file: string | null | undefined,
  event: KillAuditRecord
): { ok: boolean; error?: string } {
  if (!file) return { ok: true };
  try {
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    const context = contextOf(event.source, event.requestId);
    appendFileSync(
      file + '.audit.jsonl',
      JSON.stringify({
        at: event.at,
        ...context,
        result: event.result,
        reason: auditKillReason(event.reason)
      }) + '\n',
      { mode: 0o600 }
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, error: safe((error as Error).message) };
  }
}

export function readKill(file: string | null | undefined): KillFileRecord | null {
  if (!file || !existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      at?: unknown;
      reason?: unknown;
      source?: unknown;
      requestId?: unknown;
    };
    return {
      at: Number(raw?.at) || 0,
      reason: auditKillReason(String(raw?.reason ?? 'kill switch')),
      ...(SOURCES.includes(raw?.source as KillSource) ? { source: raw.source as KillSource } : {}),
      ...(typeof raw?.requestId === 'string' && UUID.test(raw.requestId) ? { requestId: raw.requestId } : {})
    };
  } catch {
    return { at: 0, reason: 'kill switch file present but unreadable' };
  }
}

export function writeKill(file: string | null | undefined, rec: KillFileRecord): void {
  const context = contextOf(rec.source, rec.requestId);
  const record: KillFileRecord = { at: rec.at, reason: auditKillReason(rec.reason), ...context };
  if (!file) return;
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  let activated = false;
  try {
    writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    activated = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  appendKillAudit(file, {
    at: Date.now(),
    ...context,
    result: activated ? 'activated' : 'already_active',
    reason: record.reason
  });
}

export function clearKill(file: string): boolean {
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}
