import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const APP_VERSION = '0.0.0.4.6';
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
    'Conversation continuity across reload and backend restarts with persistent conversation sessions.',
    'Traceable evidence-based learning: links closed trades, decisions, and execution facts to lessons.',
    'Deterministic experience retrieval matching role, symbol, account scope, and evaluation status.'
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

export interface ApplyUpdateOptions {
  force?: boolean;
}

export function applyUpdate(
  cwd = process.cwd(),
  runner?: (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string },
  options?: ApplyUpdateOptions
): ApplyUpdateResult {
  const previousVersion = readLocalVersion(cwd);
  const exec = runner ?? ((cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 120_000, shell: process.platform === 'win32' });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  });

  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  // 1. Check if working tree has tracked modifications.
  const statusCheck = exec('git', ['status', '--porcelain']);
  const dirtyLines = (statusCheck.stdout || '').split('\n').filter((l) => l.trim().length > 0);
  const hasTrackedChanges = dirtyLines.some((l) => !l.startsWith('??'));

  if (hasTrackedChanges) {
    if (options?.force) {
      exec('git', ['stash', 'push', '-m', `mpu-auto-stash-${Date.now()}`]);
      exec('git', ['checkout', '--', '.']);
    } else {
      const stash = exec('git', ['stash', 'push', '-m', `mpu-auto-stash-${Date.now()}`]);
      if (stash.status !== 0) {
        exec('git', ['checkout', '--', 'bin/mpu.mjs', 'package-lock.json']);
      }
    }
  }

  // 2. Fetch origin main
  const fetchRes = exec('git', ['fetch', 'origin', 'main']);
  if (fetchRes.status !== 0) {
    const detail = (fetchRes.stderr || fetchRes.stdout || 'git fetch origin main failed').trim().slice(0, 300);
    return {
      ok: false,
      previousVersion,
      currentVersion: previousVersion,
      updated: false,
      output: detail,
      message: `Update fetch failed: ${detail}`
    };
  }

  // 3. Fast-forward merge or pull
  let pull = exec('git', ['pull', '--ff-only', 'origin', 'main']);
  if (pull.status !== 0) {
    if (options?.force) {
      const reset = exec('git', ['reset', '--hard', 'origin/main']);
      if (reset.status !== 0) {
        const detail = (reset.stderr || reset.stdout || 'git reset --hard failed').trim().slice(0, 300);
        return {
          ok: false,
          previousVersion,
          currentVersion: previousVersion,
          updated: false,
          output: detail,
          message: `Force update reset failed: ${detail}`
        };
      }
      pull = { status: 0, stdout: 'Reset to origin/main successfully.', stderr: '' };
    } else {
      const detail = (pull.stderr || pull.stdout || 'git pull failed').trim().slice(0, 300);
      return {
        ok: false,
        previousVersion,
        currentVersion: previousVersion,
        updated: false,
        output: detail,
        message: `Could not fast-forward automatically: ${detail}. You can use Force Update to sync cleanly.`
      };
    }
  }

  const alreadyUpToDate = /already up to date/i.test(pull.stdout);
  if (!alreadyUpToDate || options?.force) {
    // 4. Install dependencies if package or lockfile changed
    const ci = exec(npmCmd, ['ci']);
    if (ci.status !== 0) {
      exec(npmCmd, ['install', '--no-audit', '--no-fund']);
    }

    // 5. Rebuild application
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
