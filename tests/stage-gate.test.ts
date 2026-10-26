import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const script = path.join(root, 'scripts/mpu-gate.mjs');
const tempDirs: string[] = [];
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

function fixture(scripts: Record<string, string> = {
  typecheck: "node -e \"process.stdout.write('typecheck ok')\"",
  test: "node -e \"process.stdout.write('test ok')\"",
  build: "node -e \"process.stdout.write('build ok')\"",
}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mpu-gate-test-'));
  tempDirs.push(dir);
  mkdirSync(path.join(dir, 'docs/roadmap/stage-evidence'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { ...scripts, test: scripts.test } }));
  writeFileSync(path.join(dir, 'artifact.txt'), 'source artifact\n');
  writeFileSync(path.join(dir, 'docs/roadmap/stage-gates.json'), JSON.stringify({ stages: [{ id: 'S1', checks: ['one'] }] }));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Stage Gate Fixture'], { cwd: dir });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

function run(dir: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [script, ...args, '--repo-root', dir, '--manifest', path.join(dir, 'docs/roadmap/stage-gates.json')], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...extraEnv } });
}

function legacyRecord(dir: string, checksum?: string) {
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  const blob = execFileSync('git', ['show', `${sourceSha}:artifact.txt`], { cwd: dir });
  const record = { stage: 'S1', sourceSha, status: 'PASS', criteria: [{ id: 'one', status: 'PASS', exitCode: 0, artifact: 'artifact.txt', sha256: checksum ?? sha(blob) }] };
  const file = path.join(dir, 'docs/roadmap/stage-evidence/S1.json');
  writeFileSync(file, JSON.stringify(record));
  return file;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('stage-gate verification modes', () => {
  it('retains Windows runtime directories without inheriting provider or exchange credentials', () => {
    const dir = fixture({
      typecheck: "node -e \"if(process.env.OPENAI_API_KEY || process.env.BYBIT_API_SECRET) process.exit(9); if(process.platform === 'win32' && !process.env.LOCALAPPDATA) process.exit(8)\"",
      test: "node -e \"process.exit(0)\"",
      build: "node -e \"process.exit(0)\"",
    });
    const result = run(dir, ['--independent', '--stage', 'S1', '--evidence-dir', path.join(dir, 'evidence')], { OPENAI_API_KEY: 'synthetic-provider-secret', BYBIT_API_SECRET: 'synthetic-exchange-secret' });
    expect(result.status).toBe(0);
  });
  it('runs typecheck, tests, and build in isolated mode and writes a source-bound manifest outside roadmap history', () => {
    const dir = fixture();
    const evidence = path.join(dir, 'tmp-evidence');
    const result = run(dir, ['--independent', '--stage', 'S1', '--evidence-dir', evidence]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS: Independent S1 verification');
    const record = JSON.parse(readFileSync(path.join(evidence, 'S1-independent.json'), 'utf8'));
    expect(record.status).toBe('PASS');
    expect(record.sourceSha).toMatch(/^[0-9a-f]{40}$/);
    expect(record.sourceTreeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record.sourceTreeSha256After).toBe(record.sourceTreeSha256);
    expect(record.sourceStable).toBe(true);
    expect(record.criteria.map((item: { id: string }) => item.id)).toEqual(['typecheck', 'test', 'build']);
    expect(record.criteria.every((item: { sha256: string }) => /^[0-9a-f]{64}$/.test(item.sha256))).toBe(true);
    expect(record.environment).toEqual({ CI: 'true', DOTENV_CONFIG_PATH: '__isolated_no_env__', npmUserConfig: 'empty-user.npmrc', npmGlobalConfig: 'empty-global.npmrc' });
  });

  it('records a failed independent command and exits nonzero', () => {
    const dir = fixture({
      typecheck: "node -e \"process.exit(2)\"",
      test: "node -e \"process.exit(0)\"",
      build: "node -e \"process.exit(0)\"",
    });
    const evidence = path.join(dir, 'tmp-evidence');
    const result = run(dir, ['--independent', '--stage', 'S1', '--evidence-dir', evidence]);
    const record = JSON.parse(readFileSync(path.join(evidence, 'S1-independent.json'), 'utf8'));
    expect(result.status).toBe(1);
    expect(record.status).toBe('FAIL');
    expect(record.criteria).toHaveLength(1);
    expect(record.criteria[0].exitCode).not.toBe(0);
  });

  it('validates historical artifact hashes against Git blob bytes even when the checkout line endings differ', () => {
    const dir = fixture();
    legacyRecord(dir);
    writeFileSync(path.join(dir, 'artifact.txt'), 'source artifact\r\n');
    const result = run(dir, ['--verify', 'S1']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('LEGACY INTEGRITY PASS');
    expect(result.stdout).toContain('does not verify the current checkout');
  });

  it('rejects malformed source SHA and tampered historical evidence hashes', () => {
    const invalid = fixture();
    const invalidPath = legacyRecord(invalid);
    const invalidData = JSON.parse(readFileSync(invalidPath, 'utf8'));
    invalidData.sourceSha = 'not-a-sha';
    writeFileSync(invalidPath, JSON.stringify(invalidData));
    expect(run(invalid, ['--verify', 'S1']).status).toBe(1);

    const tampered = fixture();
    legacyRecord(tampered, '0'.repeat(64));
    const result = run(tampered, ['--verify', 'S1']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('historical Git blob SHA256 mismatch');
  });

  it('does not allow historical PASS records to authorize a next stage', () => {
    const dir = fixture();
    const result = run(dir, ['--next', 'S1']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cannot authorize roadmap progress from historical PASS records');
  });
});
