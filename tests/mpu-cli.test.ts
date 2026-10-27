import { describe, it, expect, vi } from 'vitest';
import { parseCommand } from '../server/channels/commands.js';
import { discordCommandText, DIRECT_DISCORD_COMMANDS } from '../server/channels/discord.js';
import { killCmd } from '../cli/kill.js';
import { readKill } from '../server/killswitch.js';
import { preferencesInfo, savePreferences } from '../server/setup/preferences.js';
import { readEnv } from '../cli/envfile.js';
import { getVersionInfo, runVersionCli } from '../cli/version.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('channel commands without mpu prefix', () => {
  it('parses direct commands without mpu', () => {
    expect(parseCommand('status')).toMatchObject({ ok: true, cmd: 'status' });
    expect(parseCommand('/status')).toMatchObject({ ok: true, cmd: 'status' });
    expect(parseCommand('positions')).toMatchObject({ ok: true, cmd: 'positions' });
    expect(parseCommand('/positions')).toMatchObject({ ok: true, cmd: 'positions' });
    expect(parseCommand('/scan')).toMatchObject({ ok: true, cmd: 'scan' });
    expect(parseCommand('/report')).toMatchObject({ ok: true, cmd: 'report' });
    expect(parseCommand('/analyze BTCUSDT')).toMatchObject({ ok: true, cmd: 'analyze', symbol: 'BTCUSDT' });
  });

  it('gracefully strips accidental mpu or desk prefix', () => {
    expect(parseCommand('mpu status')).toMatchObject({ ok: true, cmd: 'status' });
    expect(parseCommand('/mpu status')).toMatchObject({ ok: true, cmd: 'status' });
    expect(parseCommand('mpu positions')).toMatchObject({ ok: true, cmd: 'positions' });
    expect(parseCommand('desk positions')).toMatchObject({ ok: true, cmd: 'positions' });
  });

  it('translates Discord direct slash commands cleanly', () => {
    expect(discordCommandText({ name: 'status' })).toBe('status');
    expect(discordCommandText({ name: 'positions' })).toBe('positions');
    expect(discordCommandText({ name: 'report' })).toBe('report');
    expect(discordCommandText({ name: 'analyze', options: [{ name: 'symbol', value: 'ETHUSDT' }] })).toBe('analyze ETHUSDT');
    expect(discordCommandText({ name: 'ask', options: [{ name: 'text', value: 'trend?' }] })).toBe('ask trend?');
    expect(discordCommandText({ name: 'ask', options: [{ name: 'text', value: 'trend?' }, { name: 'agent', value: 'market' }] })).toBe('ask market trend?');
    expect(discordCommandText({ name: 'open', options: [{ name: 'side', value: 'long' }, { name: 'symbol', value: 'BTCUSDT' }] })).toBe('open long BTCUSDT');
    expect(discordCommandText({ name: 'close', options: [{ name: 'symbol', value: 'BTCUSDT' }] })).toBe('close BTCUSDT');
    expect(discordCommandText({ name: 'kill', options: [{ name: 'confirm', value: 'confirm' }] })).toBe('kill confirm');
  });

  it('unrolls legacy /mpu interaction gracefully', () => {
    expect(discordCommandText({ name: 'mpu', options: [{ name: 'status' }] })).toBe('status');
    expect(discordCommandText({ name: 'mpu', options: [{ name: 'positions' }] })).toBe('positions');
  });

  it('exports direct Discord commands without /mpu wrapper', () => {
    expect(DIRECT_DISCORD_COMMANDS.some(c => c.name === 'status')).toBe(true);
    expect(DIRECT_DISCORD_COMMANDS.some(c => c.name === 'positions')).toBe(true);
    expect(DIRECT_DISCORD_COMMANDS.some(c => c.name === 'mpu')).toBe(false);
  });
});

describe('mpu kill command', () => {
  it('requires confirm to engage kill switch', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'mpu-kill-test-'));
    const killFile = path.join(tmp, 'kill-switch.json');
    try {
      const res = await killCmd([], killFile);
      expect(res.ok).toBe(false);
      expect(res.text).toContain('mpu kill confirm');
      expect(readKill(killFile)).toBeNull();

      const confRes = await killCmd(['confirm'], killFile);
      expect(confRes.ok).toBe(true);
      expect(confRes.text).toContain('KILL SWITCH ENGAGED');
      expect(readKill(killFile)).not.toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('maxHoldHours preferences support', () => {
  it('reads maxHoldHours from preferencesInfo correctly', () => {
    expect(preferencesInfo({ MAX_HOLD_HOURS: '4' }).maxHoldHours).toBe(4);
    expect(preferencesInfo({ MAX_HOLD_HOURS: '0' }).maxHoldHours).toBe(0);
    expect(preferencesInfo({ MAX_HOLD_HOURS: '24' }).maxHoldHours).toBe(24);
    expect(preferencesInfo({}).maxHoldHours).toBe(0);
  });

  it('persists and validates maxHoldHours through savePreferences', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'mpu-pref-test-'));
    const envFile = path.join(tmp, '.env');
    writeFileSync(envFile, 'APP_MODE=local\n', 'utf8');
    try {
      const basePayload = {
        appMode: 'local' as const,
        balance: 1000,
        safetyNet: 200,
        n: 2,
        dailyLoss: 5,
        auto: true,
        debateInterval: 15,
        reportInterval: 60
      };

      const res0 = savePreferences(envFile, {}, { ...basePayload, maxHoldHours: 0 });
      expect(res0.ok).toBe(true);
      expect(readEnv(envFile).MAX_HOLD_HOURS).toBe('0');

      const res4 = savePreferences(envFile, {}, { ...basePayload, maxHoldHours: 4 });
      expect(res4.ok).toBe(true);
      expect(readEnv(envFile).MAX_HOLD_HOURS).toBe('4');

      const res24 = savePreferences(envFile, {}, { ...basePayload, maxHoldHours: 24 });
      expect(res24.ok).toBe(true);
      expect(readEnv(envFile).MAX_HOLD_HOURS).toBe('24');

      const resNegative = savePreferences(envFile, {}, { ...basePayload, maxHoldHours: -1 });
      expect(resNegative.ok).toBe(false);

      const resExcessive = savePreferences(envFile, {}, { ...basePayload, maxHoldHours: 9999 });
      expect(resExcessive.ok).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('mpu version CLI', () => {
  it('retrieves structured version information', async () => {
    const info = await getVersionInfo();
    expect(info.app).toBe('trading-agent-mpu-gandring');
    expect(info.appVersion).toBe('0.0.0.4.3');
    expect(info.version).toBe('0.4.3');
    expect(info.node).toMatch(/^v\d+/);
    expect(['win32', 'linux', 'darwin']).toContain(info.platform);
    expect(typeof info.tradingMode).toBe('string');
  });

  it('prints short version with --short', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((msg) => { logs.push(String(msg)); });
    try {
      await runVersionCli(['--short']);
      expect(logs.some(l => l.trim() === '0.0.0.4.3')).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('prints json version with --json', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((msg) => { logs.push(String(msg)); });
    try {
      await runVersionCli(['--json']);
      const output = logs.join('\n');
      const parsed = JSON.parse(output);
      expect(parsed.appVersion).toBe('0.0.0.4.3');
      expect(parsed.version).toBe('0.4.3');
      expect(parsed.app).toBe('trading-agent-mpu-gandring');
    } finally {
      spy.mockRestore();
    }
  });
});
