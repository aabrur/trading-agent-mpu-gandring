import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LOCAL_AGENTS, discoverLocalModels, localAgentSettings, localAgentSettingsUpdate, localArgs, localEnvironment, localExecutable, localLoginStatus, localReply, localSelection, runLocalAgent } from '../server/providers/local.js';
import { loadConfig } from '../server/config.js';
import { savePreferences } from '../server/setup/preferences.js';
import { setEnv, readEnv } from '../cli/envfile.js';

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe('existing agent integration', () => {
  it.each(LOCAL_AGENTS.map((agent) => [agent.id, agent.bin] as const))('confirms %s only after native auth or a valid model reply', async (id, name) => {
    const folder = mkdtempSync(path.join(tmpdir(), 'mpu-login-check-'));
    const entry = path.join(folder, process.platform === 'win32' ? 'fake.js' : name);
    if (process.platform === 'win32') writeFileSync(path.join(folder, `${name}.cmd`), '@"%dp0%\\fake.js"');
    const script = (source: string) => writeFileSync(entry, process.platform === 'win32' ? source : `#!${process.execPath}\n${source}`, { mode: 0o755 });
    vi.stubEnv('PATH', folder);
    vi.stubEnv('BYBIT_API_KEY', 'must-not-leak');
    const guard = 'if(process.env.BYBIT_API_KEY)process.exit(9);';
    script(`${guard}console.log('{"loggedIn":false,"reply":"not connected"}');process.exit(${id === 'codex' ? 1 : 0});`);
    expect((await localLoginStatus(id, true)).connected).toBe(false);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 20_000);
    script(`${guard}console.log('{"loggedIn":true,"reply":"connected"}');`);
    expect((await localLoginStatus(id, true)).connected).toBe(true);
  });
  it('does not call models for passive status checks or accept unknown executables', async () => {
    expect(await localLoginStatus('unknown', true)).toEqual({ connected: false, state: 'missing' });
    const folder = mkdtempSync(path.join(tmpdir(), 'mpu-passive-check-'));
    const name = process.platform === 'win32' ? 'pi.cmd' : 'pi';
    writeFileSync(path.join(folder, name), process.platform === 'win32' ? '@"%dp0%\\fake.js"' : `#!${process.execPath}\nprocess.exit(99);`, { mode: 0o755 });
    writeFileSync(path.join(folder, 'fake.js'), 'process.exit(99);');
    vi.stubEnv('PATH', folder);
    expect(await localLoginStatus('pi')).toEqual({ connected: false, state: 'unknown' });
  });
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
    expect(localArgs('grok', 'default', 'folder').args).toEqual(expect.arrayContaining(['--deny', '*', '--disable-web-search', '--permission-mode', 'dontAsk', '--output-format', 'plain']));
    expect(localArgs('antigravity', 'default', 'folder', 'hello').args).toEqual(expect.arrayContaining(['--dangerously-skip-permissions', '--disable-slash-commands', '--input-format', 'stream-json', '--output-format', 'stream-json']));
    expect(localArgs('antigravity', 'gemini-3.8-flash-high', 'folder', 'hello').args).toEqual(expect.arrayContaining(['--model', 'gemini-3.8-flash-high', '--input-format', 'stream-json']));
    expect(localArgs('antigravity', 'default', 'folder', 'hello').args).not.toContain('hello');
  });
  it('runs the added agents in their non-acting modes', () => {
    const hermes = localArgs('hermes', 'default', 'folder', 'hello').args;
    expect(hermes).toEqual(expect.arrayContaining(['chat', '--query-file', path.join('folder', 'prompt.txt'), '-Q', '--safe-mode', '-t', 'todo']));
    expect(hermes).not.toContain('--yolo');
    expect(hermes).not.toContain('hello');
    expect(localArgs('openclaw', 'default', 'folder', 'hello').args).toEqual(['agent', '--message-file', path.join('folder', 'prompt.txt'), '--local', '--json']);
    expect(localArgs('copilot', 'default', 'folder', 'hello').args).toEqual(expect.arrayContaining(['-p', '-', '-s', '--available-tools', '--disable-builtin-mcps']));
    expect(localArgs('copilot', 'default', 'folder', 'hello').args.join(' ')).not.toMatch(/allow-all|yolo/);
    const cursor = localArgs('cursor', 'auto', 'folder', 'hello').args;
    expect(cursor).toEqual(expect.arrayContaining(['-p', '-', '--mode', 'ask', '--output-format', 'json', '--model', 'auto']));
    expect(cursor).not.toContain('hello');
    expect(cursor.join(' ')).not.toMatch(/--force|--yolo/);
    expect(localArgs('qwen', 'default', 'folder', 'hello').args).toEqual(expect.arrayContaining(['--approval-mode', 'plan', '-p', '-']));
    const opencode = localArgs('opencode', 'default', 'folder', 'hello');
    expect(opencode.args).toEqual(['run', '--format', 'json']);
    expect(JSON.parse(opencode.env.OPENCODE_CONFIG_CONTENT).permission['*']).toBe('deny');
    expect(localArgs('muse', 'default', 'folder', 'hello').args).toEqual(expect.arrayContaining(['exec', '--prompt-file', path.join('folder', 'prompt.txt')]));
    expect(localArgs('muse', 'default', 'folder', 'hello').args.join(' ')).not.toMatch(/disable-approval|yolo/);
  });
  it('applies per-agent effort and provider only where the CLI supports them', () => {
    expect(localArgs('hermes', 'default', 'folder', 'hi', undefined, [], {}, { effort: 'high', provider: 'openrouter' }).args).toEqual(expect.arrayContaining(['--reasoning', 'high', '--provider', 'openrouter']));
    expect(localArgs('copilot', 'default', 'folder', 'hi', undefined, [], {}, { effort: 'low' }).args).toEqual(expect.arrayContaining(['--reasoning-effort', 'low']));
    expect(localArgs('openclaw', 'default', 'folder', 'hi', undefined, [], {}, { effort: 'adaptive' }).args).toEqual(expect.arrayContaining(['--thinking', 'adaptive']));
    expect(localArgs('claude', 'default', 'folder', 'hi', undefined, [], {}, { effort: 'high' }).args).not.toContain('high');
  });
  it('validates and stores per-agent settings without touching other agents', () => {
    const saved = localAgentSettingsUpdate('hermes', { model: 'anthropic/claude-sonnet-5-5', effort: 'high', provider: 'openrouter' }, { LOCAL_AGENT_SETTINGS: JSON.stringify({ codex: { model: 'gpt-6-astra' } }) });
    expect(JSON.parse(saved)).toEqual({ codex: { model: 'gpt-6-astra' }, hermes: { model: 'anthropic/claude-sonnet-5-5', effort: 'high', provider: 'openrouter' } });
    expect(localAgentSettings({ LOCAL_AGENT_SETTINGS: saved }).hermes?.effort).toBe('high');
    expect(JSON.parse(localAgentSettingsUpdate('hermes', { model: 'default' }, { LOCAL_AGENT_SETTINGS: saved })).hermes).toBeUndefined();
    expect(() => localAgentSettingsUpdate('claude', { effort: 'high' })).toThrow();
    expect(() => localAgentSettingsUpdate('copilot', { effort: 'ultra' })).toThrow();
    expect(() => localAgentSettingsUpdate('codex', { provider: 'openrouter' })).toThrow();
    expect(() => localAgentSettingsUpdate('codex', { model: '--yolo' })).toThrow();
    expect(() => localAgentSettingsUpdate('unknown', {})).toThrow();
    expect(localAgentSettings({ LOCAL_AGENT_SETTINGS: '{"claude":{"effort":"high"},"hermes":{"provider":"--x"}}' })).toEqual({});
    expect(localAgentSettings({ LOCAL_AGENT_SETTINGS: 'not json' })).toEqual({});
  });
  it('never puts prompt in args and keeps all agent commands safely below Win32 32KB limit even with 100k char prompt', () => {
    const hugePrompt = 'A'.repeat(100_000);
    for (const agent of LOCAL_AGENTS) {
      const { args } = localArgs(agent.id, 'default', 'folder', hugePrompt);
      const totalLen = args.reduce((sum, a) => sum + a.length + 1, 0);
      expect(totalLen).toBeLessThan(1000);
      expect(args).not.toContain(hugePrompt);
    }
  });
  it('finds npm shims whose entry script has no extension, like Kilo and Cline', () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'mpu-npm-shim-'));
    const entry = path.join(folder, 'node_modules', '@kilocode', 'cli', 'bin', 'kilo');
    mkdirSync(path.dirname(entry), { recursive: true });
    writeFileSync(entry, '#!/usr/bin/env node\nconsole.log("kilo")\n');
    writeFileSync(path.join(folder, 'kilo.cmd'), '@ECHO off\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@kilocode\\cli\\bin\\kilo" %*\r\n');
    writeFileSync(path.join(folder, 'cline.cmd'), '"%_prog%"  "%dp0%\\node_modules\\cline\\bin\\cline" %*\r\n');
    mkdirSync(path.join(folder, 'node_modules', 'cline', 'bin'), { recursive: true });
    writeFileSync(path.join(folder, 'node_modules', 'cline', 'bin', 'cline'), 'not a node script');
    if (process.platform !== 'win32') return;
    expect(localExecutable('kilo', { PATH: folder })).toEqual({ file: process.execPath, prefix: [entry] });
    expect(localExecutable('cline', { PATH: folder })).toBeNull();
  });
  it('uses the saved default model when the desk selection is the configured model', async () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'mpu-default-model-'));
    const fake = `process.stdin.resume();process.stdin.on('end',()=>{const i=process.argv.indexOf('--model');console.log(JSON.stringify({reply:i<0?'none':process.argv[i+1]}));});`;
    if (process.platform === 'win32') { writeFileSync(path.join(folder, 'claude.cmd'), '@"%dp0%\\fake.js"'); writeFileSync(path.join(folder, 'fake.js'), fake); }
    else writeFileSync(path.join(folder, 'claude'), `#!${process.execPath}\n${fake}`, { mode: 0o755 });
    vi.stubEnv('PATH', folder);
    vi.stubEnv('LOCAL_AGENT_SETTINGS', JSON.stringify({ claude: { model: 'sonnet' } }));
    expect(JSON.parse(await runLocalAgent('claude:default', 'x'))).toEqual({ reply: 'sonnet' });
    expect(JSON.parse(await runLocalAgent('claude:opus', 'x'))).toEqual({ reply: 'opus' });
  });
  it('extracts model text from Codex, Claude, Kilo, Cline, and Antigravity envelopes', () => {
    const reply = '{"reply":"connected"}';
    expect(localReply(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: reply } }))).toBe(reply);
    expect(localReply(JSON.stringify({ type: 'result', result: reply }))).toBe(reply);
    expect(localReply(JSON.stringify({ type: 'text', part: { text: reply } }))).toBe(reply);
    expect(localReply(JSON.stringify({ type: 'say', say: 'text', text: reply }))).toBe(reply);
    expect(localReply(JSON.stringify({ type: 'run_result', text: reply }))).toBe(reply);
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
    vi.stubEnv('LOCAL_CODEX_RESEARCH_TOOLS', 'off'); vi.stubEnv('LOCAL_CODEX_MCP_TOOLS', '{}');
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

it('exposes every registered discovery adapter without claiming curated access', async () => {
  vi.stubEnv('PATH', mkdtempSync(path.join(tmpdir(), 'mpu-no-cli-')));
  const results = await Promise.all(LOCAL_AGENTS.map(agent => discoverLocalModels(agent.id, true)));
  expect(results).toHaveLength(LOCAL_AGENTS.length);
  expect(results.every(result => !result.installed && result.authentication === 'unknown' && result.completeness === 'unavailable')).toBe(true);
  expect(results.every(result => result.models.every(model => model.source === 'curated' || model.source === 'configured'))).toBe(true);
});
