import { describe, it, expect } from 'vitest';
import { parseCommand } from '../server/channels/commands.js';
import { discordCommandText, DIRECT_DISCORD_COMMANDS } from '../server/channels/discord.js';
import { killCmd } from '../cli/kill.js';
import { readKill } from '../server/killswitch.js';
import { mkdtempSync, rmSync } from 'node:fs';
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
