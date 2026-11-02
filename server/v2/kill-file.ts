import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_KILL_FILE = 'data/kill-switch.json';

export interface KillFileRecord {
  at: number;
  reason: string;
  source?: string;
}

export function readKill(file: string | null | undefined): KillFileRecord | null {
  if (!file || !existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { at?: unknown; reason?: unknown; source?: unknown };
    return {
      at: Number(raw?.at) || 0,
      reason: String(raw?.reason ?? 'kill switch'),
      ...(typeof raw?.source === 'string' ? { source: raw.source } : {})
    };
  } catch {
    return { at: 0, reason: 'kill switch file present but unreadable' };
  }
}

export function writeKill(file: string | null | undefined, rec: KillFileRecord): void {
  if (!file) return;
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const record = { at: rec.at, reason: rec.reason, ...(rec.source ? { source: rec.source } : {}) };
  try {
    writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

export function clearKill(file: string): boolean {
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}
