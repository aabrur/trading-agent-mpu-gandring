#!/usr/bin/env node
/**
 * Verifies the current checkout with typecheck, tests, and build, or checks the
 * byte integrity of historical roadmap evidence without treating it as current proof.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1] ?? null; };
const root = path.resolve(option('--repo-root') ?? process.cwd());
const manifestPath = path.resolve(option('--manifest') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'roadmap', 'stage-gates.json'));
const config = JSON.parse(readFileSync(manifestPath, 'utf8'));
const target = option('--stage') ?? option('--verify') ?? option('--next') ?? 'S5';
const stage = config.stages.find(item => item.id === target);
const independent = args.includes('--independent') || args.length === 0;
const evidenceDir = path.resolve(option('--evidence-dir') ?? path.join(os.tmpdir(), 'mpu-stage-evidence', `${Date.now()}-${randomUUID()}`));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function fail(message) {
  console.error(`FAIL ${target}: ${message}`);
  process.exit(1);
}

function git(args, encoding = 'utf8') {
  return execFileSync('git', args, { cwd: root, encoding, maxBuffer: 20 * 1024 * 1024 });
}

function sourceTreeDigest(excludedDir) {
  const paths = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], 'buffer')
    .toString('utf8').split('\0').filter(Boolean).sort();
  const hash = createHash('sha256');
  for (const file of paths) {
    const absolute = path.resolve(root, file);
    if (absolute === excludedDir || absolute.startsWith(excludedDir + path.sep)) continue;
    if (['node_modules', 'dist', 'coverage', 'test-results'].some(part => file.split('/').includes(part))) continue;
    if (!existsSync(absolute)) continue;
    hash.update(file).update('\0').update(readFileSync(absolute)).update('\0');
  }
  return hash.digest('hex');
}

function runIndependent() {
  if (!stage) fail(`Unknown stage ${target}`);
  const historicalDir = path.resolve(root, 'docs/roadmap/stage-evidence');
  if (evidenceDir === historicalDir || evidenceDir.startsWith(historicalDir + path.sep)) {
    fail('Independent evidence must be written outside docs/roadmap/stage-evidence; historical S*.json files are immutable.');
  }
  mkdirSync(evidenceDir, { recursive: true });
  const commit = git(['rev-parse', 'HEAD']).trim();
  const sourceTreeSha256 = sourceTreeDigest(evidenceDir);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const emptyUserNpmConfig = path.join(evidenceDir, 'empty-user.npmrc');
  const emptyGlobalNpmConfig = path.join(evidenceDir, 'empty-global.npmrc');
  writeFileSync(emptyUserNpmConfig, '');
  writeFileSync(emptyGlobalNpmConfig, '');
  const sanitizedEnv = {
    CI: 'true',
    DOTENV_CONFIG_PATH: '__isolated_no_env__',
    NPM_CONFIG_USERCONFIG: emptyUserNpmConfig,
    NPM_CONFIG_GLOBALCONFIG: emptyGlobalNpmConfig,
  };
  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA']) {
    if (process.env[key]) sanitizedEnv[key] = process.env[key];
  }
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path');
  if (pathKey) sanitizedEnv[pathKey] = process.env[pathKey];
  const commands = [
    { id: 'typecheck', args: ['run', 'typecheck'] },
    { id: 'test', args: ['test'] },
    { id: 'build', args: ['run', 'build'] },
  ];
  const results = [];
  for (const command of commands) {
    const startedAt = new Date().toISOString();
    const result = spawnSync(npm, command.args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      shell: process.platform === 'win32',
      env: sanitizedEnv,
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const logName = `${command.id}.log`;
    const logPath = path.join(evidenceDir, logName);
    writeFileSync(logPath, output);
    results.push({
      id: command.id,
      command: `npm ${command.args.join(' ')}`,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: result.status === 0 ? 'PASS' : 'FAIL',
      exitCode: result.status ?? 1,
    artifact: logName,
      sha256: digest(readFileSync(logPath)),
      error: result.error?.message ?? null,
    });
    console.log(`${result.status === 0 ? 'PASS' : 'FAIL'} ${command.id}${result.status === 0 ? '' : ` (exit ${result.status ?? 1})`}`);
    if (result.status !== 0) break;
  }
  const sourceTreeSha256After = sourceTreeDigest(evidenceDir);
  const sourceStable = sourceTreeSha256After === sourceTreeSha256;
  const record = {
    schema: 'mpu-gandring.independent-evidence/v1',
    stage: target,
    status: results.length === commands.length && results.every(result => result.status === 'PASS') && sourceStable ? 'PASS' : 'FAIL',
    sourceSha: commit,
    sourceTreeSha256,
    sourceTreeSha256After,
    sourceStable,
    generatedAt: new Date().toISOString(),
    environment: { CI: 'true', DOTENV_CONFIG_PATH: '__isolated_no_env__', npmUserConfig: 'empty-user.npmrc', npmGlobalConfig: 'empty-global.npmrc' },
    criteria: results,
  };
  const recordPath = path.join(evidenceDir, `${target}-independent.json`);
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  if (record.status !== 'PASS') fail(`Independent verification failed. Evidence: ${recordPath}`);
  console.log(`PASS: Independent ${target} verification completed on ${commit.slice(0, 10)}; source tree ${sourceTreeSha256}.`);
  console.log(`Evidence: ${recordPath}`);
}

function runLegacy() {
  if (!stage) fail(`Unknown stage ${target}`);
  const evidenceDir = path.resolve(root, 'docs/roadmap/stage-evidence');
  const commit = git(['rev-parse', 'HEAD']).trim();
  for (const itemStage of config.stages.slice(0, config.stages.indexOf(stage) + 1)) {
    const recordPath = path.join(evidenceDir, `${itemStage.id}.json`);
    if (!existsSync(recordPath)) fail(`Missing legacy evidence record ${recordPath}`);
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    if (record.stage !== itemStage.id || !/^[0-9a-f]{40}$/.test(record.sourceSha ?? '')) fail(`${itemStage.id}: malformed historical record`);
    if (record.status !== 'PASS' || !Array.isArray(record.criteria)) fail(`${itemStage.id}: historical status is not PASS`);
    try { git(['merge-base', '--is-ancestor', record.sourceSha, commit]); }
    catch { if (record.sourceSha !== commit) fail(`${itemStage.id}: sourceSha is not an ancestor of current HEAD`); }
    for (const checkId of itemStage.checks) {
      const matches = record.criteria.filter(criterion => criterion.id === checkId);
      if (matches.length !== 1) fail(`${itemStage.id}/${checkId}: expected one historical criterion, got ${matches.length}`);
      const criterion = matches[0];
      if (criterion.status !== 'PASS' || criterion.exitCode !== 0 || typeof criterion.artifact !== 'string' || path.isAbsolute(criterion.artifact) || criterion.artifact.split(/[\\/]/).includes('..')) fail(`${itemStage.id}/${checkId}: malformed historical criterion`);
      let bytes;
      try { bytes = git(['show', `${record.sourceSha}:${criterion.artifact}`], 'buffer'); }
      catch { fail(`${itemStage.id}/${checkId}: source artifact did not exist at recorded sourceSha`); }
      if (criterion.sha256 !== digest(bytes)) fail(`${itemStage.id}/${checkId}: historical Git blob SHA256 mismatch`);
    }
  }
  console.log(`LEGACY INTEGRITY PASS: Historical ${target} records and source Git blobs match. This does not verify the current checkout, current tests, or current build.`);
}

if (!existsSync(manifestPath)) fail(`Missing manifest ${manifestPath}`);
if (args.includes('--next')) fail('--next cannot authorize roadmap progress from historical PASS records. Run --independent for current checkout evidence.');
if (independent) runIndependent();
else runLegacy();
