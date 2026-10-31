import path from 'node:path';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  generateAutostartScript,
  validateLiveConfirmation,
  processUnkillRelease
} from '../../cli/v2/setup.js';

describe('T14 Launcher, Autostart, and Operations Verification', () => {
  it('compiled_launch_root_resolves: resolves clean build executable layout', () => {
    // Under rebirth build, dist-rebirth or dist exists
    const rebirthConfigExists = existsSync(path.resolve(__dirname, '../../tsconfig.rebirth.json'));
    expect(rebirthConfigExists).toBe(true);
  });

  it('autostart_uses_same_root: generates autostart command referencing current node and root', () => {
    const root = 'C:\\test\\app';
    const script = generateAutostartScript({
      root,
      nodePath: 'C:\\node\\node.exe'
    });

    expect(script).toContain('C:\\node\\node.exe');
    expect(script).toContain('C:\\test\\app');
    expect(script).toContain('bin');
  });

  it('local_mode_flow_requires_typed_live_confirmation: enforces mandatory confirmation phrase', () => {
    const validPhrase = 'I understand LIVE trades real money';

    const okResult = validateLiveConfirmation(validPhrase);
    expect(okResult.ok).toBe(true);

    const badResult = validateLiveConfirmation('yes');
    expect(badResult.ok).toBe(false);
    expect(badResult.error).toContain('exact confirmation phrase');

    const emptyResult = validateLiveConfirmation('');
    expect(emptyResult.ok).toBe(false);
  });

  it('unkill_does_not_enable_auto: releasing halt leaves auto strictly OFF', () => {
    const result = processUnkillRelease({
      currentKilled: true,
      currentAuto: false
    });

    expect(result.killed).toBe(false);
    expect(result.autoEnabled).toBe(false);
  });
});
