import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

describe('Native Stage Gate Validator (scripts/mpu-gate.mjs)', () => {
  const root = path.resolve(__dirname, '..');

  it('allows starting Stage 1 via --next S1', () => {
    const out = execFileSync('node', ['scripts/mpu-gate.mjs', '--next', 'S1', '--repo-root', '.'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(out).toContain('PASS: All prerequisite stages before S1 passed 100%');
  });

  it('authorizes starting Stage 3 via --next S3 when Stage 1 and Stage 2 are complete', () => {
    const out = execFileSync('node', ['scripts/mpu-gate.mjs', '--next', 'S3', '--repo-root', '.'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(out).toContain('PASS: All prerequisite stages before S3 passed 100%. Authorized to START S3');
  });

  it('authorizes starting Stage 4 via --next S4 when Stages 1, 2, and 3 are complete', () => {
    const out = execFileSync('node', ['scripts/mpu-gate.mjs', '--next', 'S4', '--repo-root', '.'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(out).toContain('PASS: All prerequisite stages before S4 passed 100%. Authorized to START S4');
  });

  it('authorizes starting Stage 5 via --next S5 when Stages 1 through 4 are complete', () => {
    const out = execFileSync('node', ['scripts/mpu-gate.mjs', '--next', 'S5', '--repo-root', '.'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(out).toContain('PASS: All prerequisite stages before S5 passed 100%. Authorized to START S5');
  });

  it('verifies completing Stage 5 via --verify S5 when all 5 stages are 100% compliant', () => {
    const out = execFileSync('node', ['scripts/mpu-gate.mjs', '--verify', 'S5', '--repo-root', '.'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(out).toContain('PASS: Stage S5 evidence is complete, verified, and 100% compliant');
  });
});
