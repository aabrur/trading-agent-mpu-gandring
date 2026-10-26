#!/usr/bin/env node
/**
 * Native Stage Gate Engine for Mpu Gandring.
 *
 * Enforces strict serial roadmap progression:
 * - Stage N cannot begin until all predecessors (Stage 1..N-1) are 100% verified (PASS).
 * - Stage verification requires immutable SHA-256 artifact fingerprints and Git commit ancestor binding.
 * - Zero phantom dependencies: 100% native Node.js and local workspace verification.
 *
 * Usage:
 *   node scripts/mpu-gate.mjs --verify S1
 *   node scripts/mpu-gate.mjs --next S2
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const options = process.argv.slice(2);
const pick = (flag, fallback) => {
  const i = options.indexOf(flag);
  return i >= 0 ? options[i + 1] : fallback;
};

const mode = options.includes('--next') ? 'next' : options.includes('--verify') ? 'verify' : null;
const target = pick(mode === 'next' ? '--next' : '--verify');
const workspace = path.resolve(pick('--repo-root', process.cwd()));
const manifestPath = path.resolve(pick('--manifest', path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'roadmap', 'stage-gates.json')));
const evidenceDir = path.resolve(pick('--evidence-dir', path.join(workspace, 'docs', 'roadmap', 'stage-evidence')));

function stop(message) {
  console.error(`BLOCK ${target ?? ''}: ${message}`);
  process.exit(1);
}

if (!mode || !target) {
  stop('Usage: node scripts/mpu-gate.mjs --verify <StageId> OR node scripts/mpu-gate.mjs --next <StageId>');
}

if (!existsSync(manifestPath)) {
  stop(`Missing stage manifest: ${manifestPath}`);
}

const config = JSON.parse(readFileSync(manifestPath, 'utf8'));
const stages = config.stages;
const ix = stages.findIndex(s => s.id === target);
if (ix < 0) {
  stop(`Unknown stage ID: ${target}`);
}

let commit;
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();
} catch {
  stop(`Workspace ${workspace} must be a valid Git repository checkout.`);
}

const sha256 = buf => createHash('sha256').update(buf).digest('hex');

function validRelative(ref) {
  if (typeof ref !== 'string' || !ref.length || path.isAbsolute(ref)) return null;
  const resolved = path.resolve(workspace, ref);
  if (resolved !== workspace && !resolved.startsWith(workspace + path.sep)) return null;
  return resolved;
}

function verifyStage(stage) {
  const evidenceFile = path.join(evidenceDir, `${stage.id}.json`);
  if (!existsSync(evidenceFile)) {
    return `Missing evidence record: ${evidenceFile}`;
  }

  let record;
  try {
    record = JSON.parse(readFileSync(evidenceFile, 'utf8'));
  } catch {
    return `Invalid JSON in evidence file: ${evidenceFile}`;
  }

  if (record.stage !== stage.id || !/^[0-9a-f]{40}$/.test(record.sourceSha)) {
    return `${stage.id}: Missing or malformed stage ID or 40-hex sourceSha`;
  }

  // Verify that record.sourceSha is an ancestor of or matches current commit
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', record.sourceSha, commit], { cwd: workspace, stdio: 'ignore' });
  } catch {
    return `${stage.id}: sourceSha (${record.sourceSha.slice(0, 7)}) is not an ancestor of current HEAD (${commit.slice(0, 7)})`;
  }

  if (record.status !== 'PASS') {
    return `${stage.id}: Status is ${record.status}, expected PASS`;
  }

  if (!Array.isArray(record.criteria)) {
    return `${stage.id}: Missing criteria array in evidence record`;
  }

  // Validate all expected checks from the manifest
  for (const checkId of stage.checks) {
    const matching = record.criteria.filter(c => c.id === checkId);
    if (matching.length !== 1) {
      return `${stage.id}/${checkId}: Expected exactly 1 criterion record, found ${matching.length}`;
    }
    const item = matching[0];
    if (item.status !== 'PASS' || item.exitCode !== 0) {
      return `${stage.id}/${checkId}: Check failed (status=${item.status}, exitCode=${item.exitCode})`;
    }
    const artifactPath = validRelative(item.artifact);
    if (!artifactPath || !existsSync(artifactPath)) {
      return `${stage.id}/${checkId}: Missing artifact file at ${item.artifact}`;
    }
    const computedHash = sha256(readFileSync(artifactPath));
    if (item.sha256 !== computedHash) {
      return `${stage.id}/${checkId}: Artifact SHA256 mismatch (expected ${item.sha256}, got ${computedHash})`;
    }
  }

  return null;
}

// In --verify mode, verify all stages up to and including target.
// In --next mode, verify all stages before target to ensure prerequisites are satisfied.
const stagesToCheck = stages.slice(0, mode === 'next' ? ix : ix + 1);

for (const stage of stagesToCheck) {
  const err = verifyStage(stage);
  if (err) stop(err);
}

if (mode === 'next') {
  console.log(`PASS: All prerequisite stages before ${target} passed 100%. Authorized to START ${target} on commit ${commit.slice(0, 10)}.`);
} else {
  console.log(`PASS: Stage ${target} evidence is complete, verified, and 100% compliant on commit ${commit.slice(0, 10)}.`);
}
