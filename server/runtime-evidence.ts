import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AppConfig } from './config.js';
import { APP_VERSION } from './updater.js';
import { DEFAULT_TRADING_SETTINGS, resolveTradingSettings, TRADING_ENV, tradingSettingsFromConfig, type TradingSettings } from './trading-settings.js';

const ROLE_FILES = ['head-of-trading', 'technical-market', 'macro-research', 'trading-systems', 'head-of-risk', 'execution-trader'].map(role => `grokbot/roles/${role}.md`);
const CANONICAL_FILES = [...ROLE_FILES, 'grokbot/BOOTSTRAP.md', 'grokbot/OPERATIONS.md', 'docs/external-agent-operations.md'];

/** Capture once at application initialization, rather than relabeling old code with a later checkout. */
export function captureRuntimeIdentity(repoRoot = process.cwd()) {
  let sha: string | null = null, dirty: boolean | null = null;
  try {
    const options = { cwd: repoRoot, encoding: 'utf8' as const, timeout: 2000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
    const head = execFileSync('git', ['rev-parse', 'HEAD'], options).trim();
    if (/^[a-f0-9]{40}$/i.test(head)) sha = head;
    dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], options).trim().length > 0;
  } catch { /* Source archives need not contain Git metadata. */ }
  return {
    appVersion: APP_VERSION,
    processStartedAt: Date.now() - Math.round(process.uptime() * 1000),
    nodeVersion: process.version,
    repository: { sha, dirty, observedAt: Date.now(), scope: 'checkout_at_app_initialization' as const },
    canonicalProfiles: CANONICAL_FILES.map(file => {
      try { return { path: file, sha256: createHash('sha256').update(readFileSync(path.join(repoRoot, file))).digest('hex') }; }
      catch { return { path: file, sha256: null }; }
    }),
    installedProfiles: { status: 'UNAVAILABLE' as const, version: null, reason: 'Native platform profiles and routines require host readback; source files do not attest deployment.' }
  };
}
export type RuntimeIdentity = ReturnType<typeof captureRuntimeIdentity>;

/** Saved-file diagnostics never mutate cfg or reload the process environment. */
export function runtimeEvidence(cfg: AppConfig, identity: RuntimeIdentity, savedEnv?: Record<string, string | undefined>) {
  const network = cfg.live?.network ?? 'paper';
  let saved: { status: 'available' | 'unavailable'; profile: string | null; minEntryConfidencePct: number | null; thresholdOrigin: 'saved_network_profile' | 'saved_legacy' | 'source_default' | 'unknown'; matchesActive: boolean | null; source: 'saved_file_only' } = {
    status: 'unavailable', profile: null, minEntryConfidencePct: null, thresholdOrigin: 'unknown', matchesActive: null, source: 'saved_file_only'
  };
  if (savedEnv) {
    try {
      const base = { ...DEFAULT_TRADING_SETTINGS } as TradingSettings;
      for (const [key, envName] of Object.entries(TRADING_ENV)) {
        const value = savedEnv[envName];
        if (value != null && value !== '') Object.assign(base, { [key]: Number(value) });
      }
      const selected = network === 'paper'
        ? { profile: savedEnv.PAPER_TRADING_PROFILE || 'current', values: base }
        : resolveTradingSettings(savedEnv, base, network);
      const minimum = selected.values.minEntryConfidencePct;
      if (!Number.isFinite(minimum) || minimum < 0 || minimum > 100) throw new Error('Invalid saved threshold');
      const networkThreshold = network === 'paper' ? undefined : savedEnv[`${network.toUpperCase()}_DESK_MIN_ENTRY_CONFIDENCE_PCT`];
      const thresholdOrigin = networkThreshold != null && networkThreshold !== '' ? 'saved_network_profile' : savedEnv.MIN_ENTRY_CONFIDENCE_PCT != null && savedEnv.MIN_ENTRY_CONFIDENCE_PCT !== '' ? 'saved_legacy' : 'source_default';
      saved = { status: 'available', profile: selected.profile, minEntryConfidencePct: minimum, thresholdOrigin, matchesActive: minimum === cfg.risk.minEntryConfidencePct && selected.profile === cfg.tradingProfile, source: 'saved_file_only' };
    } catch { /* A malformed saved profile remains unavailable instead of changing active settings. */ }
  }
  return {
    ...identity,
    observedAt: Date.now(),
    active: { source: 'running_cfg' as const, mode: cfg.tradingMode, venue: cfg.live?.exchange ?? cfg.exchange.name, network, profile: cfg.tradingProfile, values: tradingSettingsFromConfig(cfg) },
    saved,
    routine: {
      ownerCadenceMin: cfg.auto.intervalMin,
      scheduler: cfg.appMode === 'grokbot' ? 'native_platform' as const : 'server_auto' as const,
      serverAutoDisabled: cfg.appMode === 'grokbot',
      phaseStatus: 'UNKNOWN' as const, scheduledAt: null, actualStartedAt: null, lastRunAt: null, nextRunAt: null,
      reason: 'Interval alone does not establish scheduling phase. Read actual native routine settings and run timestamps on its host.'
    }
  };
}
