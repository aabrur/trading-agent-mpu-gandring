import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The kill switch survives restarts. Pressing it writes this file; while the file exists the desk
 * starts killed (no new orders, auto off). Only the owner clears it, on the machine itself:
 * `npm run unkill -- --yes`, then restart the office. There is no HTTP route that clears it.
 */
export const DEFAULT_KILL_FILE = 'data/kill-switch.json';
export interface KillRecord { at: number; reason: string }

export function readKill(file: string | null | undefined): KillRecord | null {
  if (!file || !existsSync(file)) return null;
  try {
    const r = JSON.parse(readFileSync(file, 'utf8'));
    return { at: Number(r?.at) || 0, reason: String(r?.reason ?? 'kill switch') };
  } catch {
    // Unreadable or corrupt still counts as killed (fail closed).
    return { at: 0, reason: 'kill switch file present but unreadable' };
  }
}
export function writeKill(file: string | null | undefined, rec: KillRecord) {
  if (!file) return;
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  writeFileSync(file, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 });
}
export function clearKill(file: string): boolean {
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}
