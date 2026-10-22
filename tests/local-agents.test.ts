import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { localArgs, localEnvironment, localExecutable, localReply, localSelection, runLocalAgent } from '../server/providers/local.js';
import { loadConfig } from '../server/config.js';
import { savePreferences } from '../server/setup/preferences.js';
import { setEnv, readEnv } from '../cli/envfile.js';

afterEach(() => vi.unstubAllEnvs());
describe('existing agent integration', () => {
  it('never forwards venue keys or model tokens, and rejects arbitrary executables/models', () => {
    expect(localEnvironment({ PATH: 'path', USERPROFILE: 'profile', BYBIT_API_KEY: 'secret', OPENAI_API_KEY: 'secret', AGENT_EVENT_SECRET: 'secret', ANTHROPIC_AUTH_TOKEN: 'secret' })).toEqual({ PATH: 'path', USERPROFILE: 'profile' });
    expect(localExecutable('cmd.exe')).toBeNull();
    expect(() => localSelection('codex:--dangerously-bypass-approvals-and-sandbox')).toThrow();
    expect(() => localSelection('unknown:default')).toThrow();
    expect(localSelection('antigravity:gemini-3.8-flash-high')).toEqual({ id: 'antigravity', model: 'gemini-3.8-flash-high' });
    expect(localSelection('agy:gemini-3.8-flash-high')).toEqual({ id: 'antigravity', model: 'gemini-3.8-flash-high' });
    const cfg = loadConfig({ DEFAULT_PROVIDER: 'local', LOCAL_MODEL: 'claude:sonnet' });
    expect(cfg.agents.risk).toEqual({ provider: 'local', model: 'claude:sonnet', fellBackToMock: false });
    const cfgAgy = loadConfig({ DEFAULT_PROVIDER: 'local', LOCAL_MODEL: 'antigravity:gemini-3.8-flash-high' });
    expect(cfgAgy.agents.risk).toEqual({ provider: 'local', model: 'antigravity:gemini-3.8-flash-high', fellBackToMock: false });
  });
  it('uses constrained native modes instead of bypassing agent permissions', () => {
    expect(localArgs('codex', 'default', 'folder').args).toEqual(expect.arrayContaining(['--sandbox', 'read-only', '--disable', 'shell_tool']));
    expect(localArgs('claude', 'opus', 'folder').args).toEqual(expect.arrayContaining(['--tools', '', '--strict-mcp-config', '--model', 'opus']));
    expect(localArgs('pi', 'default', 'folder').args).toContain('--no-tools');
    expect(localArgs('kimi', 'default', 'folder').args).toContain('--agent-file');
    expect(JSON.parse(localArgs('kilo', 'default', 'folder').env.KILO_CONFIG_CONTENT).permission['*']).toBe('deny');
    expect(localArgs('cline', 'default', 'folder').args).toEqual(expect.arrayContaining(['--auto-approve', 'false']));
    expect(localArgs('grok', 'default', 'folder').args).toEqual(expect.arrayContaining(['--tools', '', '--deny', '*']));
    expect(localArgs('antigravity', 'default', 'folder', 'hello').args).toEqual(expect.arrayContaining(['--dangerously-skip-permissions', '--disable-slash-commands', '--output-format', 'json', '--print', 'hello']));
    expect(localArgs('antigravity', 'gemini-3.8-flash-high', 'folder', 'hello').args).toEqual(expect.arrayContaining(['--model', 'gemini-3.8-flash-high', '--print', 'hello']));
  });
  it('extracts model text from Codex, Claude, Kilo, Cline, and Antigravity envelopes', () => {
    const reply = '{"reply":"connected"}';
    expect(localReply(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: reply } }))).toBe(reply);
    expect(localReply(JSON.stringify({ type: 'result', result: reply }))).toBe(reply);
    expect(localReply(JSON.stringify({ type: 'text', part: { text: reply } }))).toBe(reply);
    expect(localReply(JSON.stringify({ type: 'say', say: 'text', text: reply }))).toBe(reply);
    expect(localReply(JSON.stringify({ response: reply }))).toBe(reply);
    expect(localReply(reply)).toBe(reply);
  });
  it('runs a discovered CLI with stdin, isolated working directory, and no exported desk secrets', async () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'mpu-fake-cli-'));
    const fake = `let input='';process.stdin.on('data',v=>input+=v);process.stdin.on('end',()=>{if(process.env.BYBIT_API_KEY||process.env.OPENAI_API_KEY)process.exit(3);if(!process.argv.includes('read-only'))process.exit(4);console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({reply:input})}}));});`;
    if (process.platform === 'win32') {
      writeFileSync(path.join(folder, 'codex.cmd'), '@"%dp0%\\fake.js"');
      writeFileSync(path.join(folder, 'fake.js'), fake);
    } else writeFileSync(path.join(folder, 'codex'), `#!${process.execPath}\n${fake}`, { mode: 0o755 });
    vi.stubEnv('PATH', folder); vi.stubEnv('BYBIT_API_KEY', 'forbidden-secret'); vi.stubEnv('OPENAI_API_KEY', 'forbidden-secret');
    const prompt = 'data only: $(do-not-run) & "quoted"';
    expect(JSON.parse(await runLocalAgent('codex:default', prompt))).toEqual({ reply: prompt });
  });
});

describe('desk settings in the office', () => {
  const values = { appMode: 'local', balance: 1000, safetyNet: 200, n: 3, dailyLoss: 3, auto: false, debateInterval: 15, reportInterval: 60 };
  it('saves settings without changing trading mode or existing secrets', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'mpu-settings-')), '.env');
    setEnv(file, { TRADING_MODE: 'TESTNET', OPENAI_API_KEY: 'existing-secret' });
    expect(savePreferences(file, {}, values).ok).toBe(true);
    const saved = readEnv(file);
    expect(saved.TRADING_MODE).toBe('TESTNET'); expect(saved.OPENAI_API_KEY).toBe('existing-secret'); expect(saved.OPEN_ORDERS_N).toBe('3'); expect(saved.AUTO_TRADING).toBe('off');
    const before = readFileSync(file, 'utf8');
    expect(savePreferences(file, {}, { ...values, dailyLoss: 0 }).ok).toBe(false);
    expect(savePreferences(file, {}, { ...values, safetyNet: 1001 }).ok).toBe(false);
    expect(savePreferences(file, {}, { ...values, TRADING_MODE: 'LIVE' }).ok).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
  it('creates a Grok Bot signing secret locally without returning it', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'mpu-settings-')), '.env');
    const response = savePreferences(file, {}, { ...values, appMode: 'grokbot' });
    expect(response.ok).toBe(true);
    const secret = readEnv(file).AGENT_EVENT_SECRET;
    expect(secret.length).toBeGreaterThanOrEqual(24);
    expect(JSON.stringify(response)).not.toContain(secret);
  });
});
