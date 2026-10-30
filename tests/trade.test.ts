import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tradeEnv, officeUrl, repoRoot, backendEntry, envFilePath, serviceAfterExit, nextServiceBackoff, launcherExitFacts } from '../cli/trade.js';
import { servicePlan, TASK } from '../cli/autostart.js';

describe('npm run trade', () => {
  it('forces full auto in local mode, leaves Grok Bot mode alone', () => {
    expect(tradeEnv({ AUTO_TRADING: 'off' }, { APP_MODE: 'local' }).AUTO_TRADING).toBe('on');
    expect(tradeEnv({}, {}).AUTO_TRADING).toBe('on');
    expect(tradeEnv({ AUTO_TRADING: 'off' }, { APP_MODE: 'grokbot' }).AUTO_TRADING).toBe('off');
  });
  it('prints a reachable office URL', () => {
    expect(officeUrl('0.0.0.0', '8787')).toBe('http://127.0.0.1:8787');
    expect(officeUrl('127.0.0.1', '9000')).toBe('http://127.0.0.1:9000');
  });
});

describe('autostart service files', () => {
  const o = { node: '/usr/local/bin/node', repo: '/Users/me/trading-agent-mpu-gandring', home: '/Users/me', uid: 501 };
  const secretish = /API_KEY|SECRET|PRIVATE_KEY|PASSPHRASE|TOKEN|EnvironmentVariables|Environment=/;
  it('macOS launchd: run at login, restart on crash, no keys', () => {
    const p = servicePlan('darwin', o);
    expect(p.file?.replace(/\\/g, '/')).toBe('/Users/me/Library/LaunchAgents/com.mpugandring.trading-agent.plist');
    expect(p.content).toContain('<key>RunAtLoad</key><true/>');
    expect(p.content).toContain('<key>SuccessfulExit</key><false/>');
    expect(p.content).toContain('--service');
    expect(p.content).not.toMatch(secretish);
  });
  it('Windows: schtasks at logon, no keys', () => {
    const p = servicePlan('win32', { ...o, node: 'C:\\Program Files\\nodejs\\node.exe', repo: 'C:\\Users\\me\\tamg', home: 'C:\\Users\\me' });
    expect(p.install[0]).toEqual(expect.arrayContaining(['schtasks', '/Create', '/SC', 'ONLOGON']));
    expect(p.content).toContain('cli\\trade.ts');
    expect(p.content).not.toMatch(secretish);
  });
  it('Windows task command keeps a spaced project path and the service entry', () => {
    const repo = 'C:\\Users\\me\\My Desk\\tamg';
    const node = 'C:\\Program Files\\nodejs\\node.exe';
    const p = servicePlan('win32', { node, repo, home: 'C:\\Users\\me' });
    expect(p.content).toContain('cd /d "' + repo + '"');
    expect(p.content).toContain('"' + node + '"');
    expect(p.content).toContain('--service');
    expect(p.content).toContain('cli\\trade.ts');
    expect(p.install[0]).toContain(TASK);
    expect(p.content).not.toContain('dist\\server\\dist');
  });
  it('Linux systemd --user: restart on failure, but not after a guard refusal (exit 2), no keys', () => {
    const p = servicePlan('linux', { ...o, repo: '/home/me/tamg', home: '/home/me' });
    expect(p.file?.replace(/\\/g, '/')).toBe('/home/me/.config/systemd/user/trading-agent-mpu-gandring.service');
    expect(p.content).toContain('Restart=on-failure');
    expect(p.content).toContain('RestartPreventExitStatus=2');
    expect(p.content).not.toMatch(secretish);
  });
});

describe('compiled and source launcher roots', () => {
  it('resolves both layouts to the project, not a nested dist path', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mpu root '));
    try {
      writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'trading-agent-mpu-gandring' }));
      mkdirSync(path.join(root, 'cli'), { recursive: true });
      mkdirSync(path.join(root, 'dist', 'server', 'cli'), { recursive: true });
      const source = repoRoot(pathToFileURL(path.join(root, 'cli', 'trade.ts')).href);
      const compiled = repoRoot(pathToFileURL(path.join(root, 'dist', 'server', 'cli', 'trade.js')).href);
      expect(path.resolve(source)).toBe(path.resolve(root));
      expect(path.resolve(compiled)).toBe(path.resolve(root));
      const backend = backendEntry(compiled);
      expect(backend.replace(/\\/g, '/')).toBe(path.join(root, 'dist/server/server/index.js').replace(/\\/g, '/'));
      expect(backend.includes(`${path.sep}dist${path.sep}server${path.sep}dist${path.sep}`)).toBe(false);
      expect(envFilePath(compiled)).toBe(path.join(root, '.env'));
      expect(existsSync(envFilePath(compiled))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('keeps service backoff and guard-refusal exits', () => {
    expect(serviceAfterExit(1, { stopping: false, service: true })).toEqual({ restart: true });
    expect(serviceAfterExit(0, { stopping: false, service: true })).toEqual({ exit: 0 });
    expect(serviceAfterExit(2, { stopping: false, service: true })).toEqual({ exit: 0 });
    expect(serviceAfterExit(2, { stopping: false, service: false })).toEqual({ exit: 2 });
    expect(nextServiceBackoff(5_000, 1_000)).toEqual({ wait: 5_000, next: 10_000 });
    expect(nextServiceBackoff(120_000, 1_000).next).toBe(120_000);
    expect(nextServiceBackoff(40_000, 11 * 60_000)).toEqual({ wait: 5_000, next: 10_000 });
  });
  it('records ordinary launcher exit facts without treating a requested restart as unexpected', () => {
    const crashed = launcherExitFacts({ code: 1, signal: null, pid: 42, restartRequested: false, stopping: false });
    expect(crashed).toMatchObject({ code: 1, signal: null, pid: 42, restartRequested: false, unexpected: true });
    expect(crashed.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const restarted = launcherExitFacts({ code: null, signal: 'SIGTERM', pid: 7, restartRequested: true, stopping: false });
    expect(restarted).toMatchObject({ signal: 'SIGTERM', pid: 7, restartRequested: true, unexpected: false });
    expect(launcherExitFacts({ code: null, signal: null, pid: 3, restartRequested: false, stopping: false, error: 'spawn ENOENT' }).spawnError).toBe('spawn ENOENT');
  });
});
