import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const APP_VERSION = '0.0.0.3.4';
export const REPO_RAW_PKG_URL = 'https://raw.githubusercontent.com/aabrur/trading-agent-mpu-gandring/main/package.json';
export const REPO_URL = 'https://github.com/aabrur/trading-agent-mpu-gandring';

export interface UpdateStatus {
  ok: boolean;
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  commit: string | null;
  releaseUrl: string;
  checkedAt: number;
  notes: string[];
  error?: string;
}

export function compareVersions(a: string, b: string): number {
  const clean = (v: string) => v.replace(/^v/i, '').trim().split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pa = clean(a);
  const pb = clean(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

export function readLocalVersion(cwd = process.cwd()): string {
  try {
    const raw = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as { appVersion?: string; version?: string };
    return raw.appVersion || raw.version || APP_VERSION;
  } catch {
    return APP_VERSION;
  }
}

function getLocalCommit(cwd = process.cwd()): string | null {
  try {
    const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, encoding: 'utf8', timeout: 2500 });
    return r.status === 0 ? r.stdout.trim() || null : null;
  } catch {
    return null;
  }
}

export async function checkUpdate(fetchImpl: typeof fetch = fetch, cwd = process.cwd()): Promise<UpdateStatus> {
  const currentVersion = readLocalVersion(cwd);
  const commit = getLocalCommit(cwd);
  const defaultNotes = [
    'Optional Jev decision sidecar over OpenRouter: regime, news, whale and conflict review. Off by default. Never places orders.',
    'News publication time stays distinct from ingest time. Keyword hits are reported claims, not auto-veto.',
    'Whale missing USD amounts stay unknown. Provider labels are not automatic high-confidence attribution.',
    'Instant live balance display in TopBar and Portfolio (Paper/Live Book) with multi-country currency converter after Connect Wallet or API Key setup',
    'Autonomous agent execution (Buy/Long, Sell/Short, Close, Hold) with interactive Token Picker chips and Max Open Positions (N = 1..4) in Desk Ops Auto Trade'
  ];

  let timer: NodeJS.Timeout | null = null;
  try {
    const ctrl = new AbortController();
    timer = setTimeout(() => ctrl.abort(), 4500);
    timer.unref?.();
    const sep = REPO_RAW_PKG_URL.includes('?') ? '&' : '?';
    const res = await fetchImpl(`${REPO_RAW_PKG_URL}${sep}t=${Date.now()}`, { signal: ctrl.signal, headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' } });
    if (!res.ok) {
      return {
        ok: true,
        currentVersion,
        latestVersion: currentVersion,
        updateAvailable: false,
        commit,
        releaseUrl: REPO_URL,
        checkedAt: Date.now(),
        notes: defaultNotes
      };
    }
    const pkg = (await res.json()) as { appVersion?: string; version?: string; changelog?: string[] };
    const rawRemote = String(pkg.appVersion || (pkg.version === '0.1.0' ? '0.0.0.1.0' : pkg.version) || currentVersion).replace(/^v/i, '');
    const updateAvailable = compareVersions(rawRemote, currentVersion) > 0;
    const latestVersion = updateAvailable ? rawRemote : currentVersion;
    return {
      ok: true,
      currentVersion,
      latestVersion,
      updateAvailable,
      commit,
      releaseUrl: `${REPO_URL}/releases/tag/v${latestVersion}`,
      checkedAt: Date.now(),
      notes: Array.isArray(pkg.changelog) && pkg.changelog.length > 0 ? pkg.changelog : defaultNotes
    };
  } catch (e) {
    return {
      ok: true,
      currentVersion,
      latestVersion: currentVersion,
      updateAvailable: false,
      commit,
      releaseUrl: REPO_URL,
      checkedAt: Date.now(),
      notes: defaultNotes,
      error: (e as Error).message
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ApplyUpdateResult {
  ok: boolean;
  previousVersion: string;
  currentVersion: string;
  updated: boolean;
  output: string;
  message: string;
}

export function applyUpdate(
  cwd = process.cwd(),
  runner?: (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string }
): ApplyUpdateResult {
  const previousVersion = readLocalVersion(cwd);
  const exec = runner ?? ((cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 60_000, shell: process.platform === 'win32' });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  });

  const pull = exec('git', ['pull', '--ff-only', 'origin', 'main']);
  if (pull.status !== 0) {
    const detail = (pull.stderr || pull.stdout || 'git pull failed').trim().slice(0, 300);
    return {
      ok: false,
      previousVersion,
      currentVersion: previousVersion,
      updated: false,
      output: detail,
      message: `Update check finished. Could not fast-forward automatically: ${detail}`
    };
  }

  const alreadyUpToDate = /already up to date/i.test(pull.stdout);
  if (!alreadyUpToDate) {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const build = exec(npmCmd, ['run', 'build']);
    if (build.status !== 0) {
      const detail = (build.stderr || build.stdout || 'build failed').trim().slice(0, 300);
      return {
        ok: false,
        previousVersion,
        currentVersion: readLocalVersion(cwd),
        updated: false,
        output: detail,
        message: `Pulled latest changes, but build reported an error: ${detail}`
      };
    }
  }

  const currentVersion = readLocalVersion(cwd);
  return {
    ok: true,
    previousVersion,
    currentVersion,
    updated: !alreadyUpToDate || compareVersions(currentVersion, previousVersion) > 0,
    output: (pull.stdout || 'Already up to date.').trim().slice(0, 300),
    message: alreadyUpToDate
      ? `You are already on the latest version v${currentVersion}.`
      : `Updated to v${currentVersion}. Refresh or restart the office to load all changes.`
  };
}
