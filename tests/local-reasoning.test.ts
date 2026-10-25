import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoverLocalModels, localArgs, localAgentSettings, localAgentSettingsUpdate } from '../server/providers/local.js';
import { requireReasoning } from '../server/providers/reasoning.js';
import { loadConfig } from '../server/config.js';
import { makeCaller } from '../server/providers/index.js';
import { modelUpdates } from '../server/setup/models.js';
import { setEnv, readEnv } from '../cli/envfile.js';

afterEach(() => vi.unstubAllEnvs());

describe('native CLI reasoning contracts', () => {
  it.each([
    ['codex', '-c', 'model_reasoning_effort="high"'],
    ['claude', '--effort', 'high'],
    ['pi', '--thinking', 'high'],
    ['cline', '--thinking', 'high'],
    ['antigravity', '--effort', 'high'],
    ['hermes', '--reasoning', 'high'],
    ['openclaw', '--thinking', 'high'],
    ['copilot', '--reasoning-effort', 'high'],
    ['grok', '--reasoning-effort', 'high']
  ] as const)('saves and encodes %s native effort', (id, flag, value) => {
    expect(JSON.parse(localAgentSettingsUpdate(id, {effort: 'high'}, {}))[id].effort).toBe('high');
    const args = localArgs(id, 'default', 'folder', '', undefined, [], {}, {effort: 'high'}).args;
    expect(args.some((arg, index) => arg === flag && args[index + 1] === value)).toBe(true);
  });

  it('loads Codex default model capabilities before validating a cold reasoning request', async () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'mpu-codex-reasoning-'));
    const script = `if(process.argv.includes('--version')) console.log('1.0'); else if(process.argv.includes('login')) console.log('Logged in'); else {process.stdin.resume();process.stdin.on('end',()=>{const ok=process.argv.includes('model_reasoning_effort="max"');console.log(JSON.stringify({reply:ok?'connected':'missing effort'}));});}`;
    if (process.platform === 'win32') {
      writeFileSync(path.join(folder, 'codex.cmd'), '@"%dp0%\\fake.js"');
      writeFileSync(path.join(folder, 'fake.js'), script);
    } else writeFileSync(path.join(folder, 'codex'), `#!${process.execPath}\n${script}`, {mode: 0o755});
    writeFileSync(path.join(folder, 'config.toml'), 'model = "fixture-reasoner"\n');
    writeFileSync(path.join(folder, 'models_cache.json'), JSON.stringify({models: [{slug: 'fixture-reasoner', visibility: 'list', supported_reasoning_levels: [{effort: 'high'}, {effort: 'max'}]}]}));
    vi.stubEnv('PATH', folder);
    vi.stubEnv('CODEX_HOME', folder);
    vi.stubEnv('LOCAL_AGENT_SETTINGS', '{}');
    vi.stubEnv('LOCAL_CODEX_RESEARCH_TOOLS', 'off');
    const cfg = loadConfig({DEFAULT_PROVIDER: 'local', LOCAL_MODEL: 'codex:default', DEFAULT_REASONING_EFFORT: 'max'});
    const reply = await makeCaller(cfg)({agent: 'risk', task: 'chat', provider: 'local', model: 'codex:default', system: '', user: 'connected', context: {}, attempt: 1});
    expect(JSON.parse(reply)).toEqual({reply: 'connected'});
  });

  it('keeps Kilo aliases and uses each model variant catalog', async () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'mpu-kilo-models-'));
    const script = `console.log(process.argv.includes('models') ? 'kilo/~vendor/fixture\\n'+JSON.stringify({variants: {medium: {}, max: {}}},null,2) : '1.0');`;
    if (process.platform === 'win32') {
      writeFileSync(path.join(folder, 'kilo.cmd'), '@"%dp0%\\fake.js"');
      writeFileSync(path.join(folder, 'fake.js'), script);
    } else writeFileSync(path.join(folder, 'kilo'), `#!${process.execPath}\n${script}`, {mode: 0o755});
    vi.stubEnv('PATH', folder);
    vi.stubEnv('LOCAL_AGENT_SETTINGS', '{}');
    const catalog = await discoverLocalModels('kilo', true);
    expect(catalog.models.find(model => model.id === 'kilo/~vendor/fixture')?.reasoningLevels).toEqual(['medium', 'max']);
    expect(requireReasoning('local', 'kilo:kilo/~vendor/fixture', 'max')).toBe('max');
    expect(() => requireReasoning('local', 'kilo:kilo/~vendor/fixture', 'high')).toThrow();
    expect(localArgs('kilo', 'kilo/~vendor/fixture', folder, '', undefined, [], {}, {effort: 'max'}).args).toEqual(expect.arrayContaining(['--variant', 'max']));
  });

  it('preserves an explicit off value and rejects unsupported native flags', () => {
    expect(JSON.parse(localAgentSettingsUpdate('pi', {effort: 'off'}, {}))).toEqual({pi: {effort: 'off'}});
    expect(() => localArgs('openclaw', 'default', 'folder', '', undefined, [], {}, {effort: 'max'})).toThrow();
    expect(() => localArgs('kimi', 'default', 'folder', '', undefined, [], {}, {effort: 'high'})).toThrow();
    const updates = modelUpdates({}, {defaultProvider: 'local', defaultModel: 'pi:default', reasoning: {risk: 'off', lead: 'ultra', market: 'minimal'}});
    const config = loadConfig(Object.fromEntries(Object.entries(updates).filter(([,value]) => value !== null)));
    expect(config.reasoning).toMatchObject({risk: 'off', lead: 'ultra', market: 'minimal'});
  });

  it('restores native settings after the env writer escapes JSON on disk', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'mpu-native-settings-')), '.env');
    const settings = localAgentSettingsUpdate('pi', {model: 'openai/example', effort: 'off'}, {});
    setEnv(file, {LOCAL_AGENT_SETTINGS: settings});
    expect(localAgentSettings(readEnv(file))).toEqual({pi: {model: 'openai/example', effort: 'off'}});
  });

  it('discovers provider-qualified Pi models and their thinking capability', async () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'mpu-pi-models-'));
    const script = `const args=process.argv.slice(2); console.log(args.includes('--help') ? '--thinking <level> off, minimal, low, medium, high, xhigh, max' : args.includes('--list-models') ? 'provider model context max-out thinking images\\na same-id 128K 8K yes no\\nb same-id 128K 8K no no' : '1.0');`;
    if (process.platform === 'win32') {
      writeFileSync(path.join(folder, 'pi.cmd'), '@"%dp0%\\fake.js"');
      writeFileSync(path.join(folder, 'fake.js'), script);
    } else writeFileSync(path.join(folder, 'pi'), `#!${process.execPath}\n${script}`, {mode: 0o755});
    vi.stubEnv('PATH', folder);
    vi.stubEnv('LOCAL_AGENT_SETTINGS', '{}');
    const result = await discoverLocalModels('pi', true);
    expect(result.models.map(m => m.id)).toEqual(expect.arrayContaining(['a/same-id', 'b/same-id']));
    expect(requireReasoning('local', 'pi:a/same-id', 'med')).toBe('medium');
    expect(() => requireReasoning('local', 'pi:b/same-id', 'high')).toThrow();
  });
});
