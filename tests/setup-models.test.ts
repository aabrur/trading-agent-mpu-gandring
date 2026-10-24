import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { readEnv, setEnv } from '../cli/envfile.js';
import { MODEL_CHOICES, modelChoices, modelSetupInfo, modelUpdates } from '../server/setup/models.js';
import { makeCaller, type ModelCaller } from '../server/providers/index.js';
import { LOCAL_AGENTS } from '../server/providers/local.js';

describe('curated provider and model setup', () => {
  it('lists visible models from the installed Codex catalog instead of limiting the account to two models', () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'mpu-codex-catalog-'));
    writeFileSync(path.join(folder, 'models_cache.json'), JSON.stringify({ models: [
      { slug: 'gpt-extra-local', display_name: 'Extra local', visibility: 'list' },
      { slug: 'hidden-local', visibility: 'hide' }
    ] }));
    vi.stubEnv('CODEX_HOME', folder);
    try {
      const choices = modelSetupInfo({}).providers.find((provider) => provider.provider === 'local')!.models;
      expect(choices.some((model) => model.id === 'codex:gpt-extra-local')).toBe(true);
      expect(choices.some((model) => model.id === 'codex:hidden-local')).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });
  it('shows 10 API providers with 20 curated AI models each and dated token sources', () => {
    const entries = Object.entries(MODEL_CHOICES);
    expect(entries.length).toBe(12);
    for (const [p, models] of entries) {
      if (p === 'mock') expect(models.length).toBe(1);
      else if (p === 'local') expect(models.length).toBe(LOCAL_AGENTS.flatMap((a) => a.models).length);
      else expect(models.length).toBe(20);
      expect(new Set(models.map((m) => m.id)).size).toBe(models.length);
      expect(models.filter((m) => m.tags.some((t) => t.startsWith('Free'))).length).toBeLessThanOrEqual(6);
      expect(models.some((m) => /image|tts|embedding|:batch/.test(m.id))).toBe(false);
      if (!['openrouter', 'together', 'fireworks', 'local'].includes(p)) expect(models.some((m) => m.id.includes('/'))).toBe(false);
    }
    const info = modelSetupInfo({ DEFAULT_PROVIDER: 'openai', OPENAI_API_KEY: 'secret-not-for-output' });
    expect(info.usageSource.asOf).toBe('2026-10-16');
    expect(info.providers.length).toBe(12);
    expect(info.providers.find((p) => p.provider === 'openai')!.keySet).toBe(true);
    expect(JSON.stringify(info)).not.toContain('secret-not-for-output');
  });

  it('preserves existing custom models only for their saved provider', () => {
    const env = { DEFAULT_PROVIDER: 'openai', AGENT_RISK_PROVIDER: 'anthropic', AGENT_RISK_MODEL: 'my-existing-claude' };
    expect(modelChoices(env, 'anthropic').some((m) => m.id === 'my-existing-claude')).toBe(true);
    expect(modelChoices(env, 'openai').some((m) => m.id === 'my-existing-claude')).toBe(false);
    expect(() => modelUpdates(env, { defaultProvider: 'openai', defaultModel: 'claude-opus-5-5' })).toThrow(/selected provider/);
    expect(() => modelUpdates(env, { defaultProvider: 'mock', defaultModel: 'mock-desk-v1', agents: { risk: { provider: 'openai', model: 'claude-opus-5-5' } } })).toThrow(/risk/);
  });

  it('applies default choices to all agents, clears stale overrides, and supports individual mappings', () => {
    const env = { DEFAULT_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'test-claude-key', OPENAI_API_KEY: 'test-openai-key', AGENT_RISK_PROVIDER: 'anthropic', AGENT_RISK_MODEL: 'claude-opus-5-5' };
    const updates = modelUpdates(env, { defaultProvider: 'openai', defaultModel: 'gpt-6-luna' });
    const applied = Object.fromEntries(Object.entries({ ...env, ...updates }).filter(([, v]) => v !== null)) as Record<string, string>;
    expect(Object.values(loadConfig(applied).agents).every((a) => a.provider === 'openai' && a.model === 'gpt-6-luna')).toBe(true);
    const individual = modelUpdates(env, { defaultProvider: 'openai', defaultModel: 'gpt-6-luna', agents: { risk: { provider: 'anthropic', model: 'claude-opus-5-5' } } });
    expect(individual.AGENT_RISK_MODEL).toBe('claude-opus-5-5');
    expect(() => modelUpdates({}, { defaultProvider: 'mock', defaultModel: 'mock-desk-v1', keys: { openai: 'key\nTRADING_MODE=LIVE' } })).toThrow(/key input/);
  });

  it('sends the selected OpenAI frontier model with supported reasoning parameters', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] })));
    try {
      const call = makeCaller(loadConfig({ OPENAI_API_KEY: 'fake-test-key' }));
      for (const { id: model } of MODEL_CHOICES.openai) {
        await call({ provider: 'openai', model, agent: 'risk', task: 'risk', system: 'system', user: 'user', context: {}, attempt: 1 });
        const body = JSON.parse(String(request.mock.calls.at(-1)![1]!.body));
        expect(body.model).toBe(model);
        if (/^(gpt-6|gpt-5|o1|o3|o4)/.test(model)) {
          expect(body).not.toHaveProperty('temperature');
          expect(body).not.toHaveProperty('max_tokens');
          expect(body.max_completion_tokens).toBe(2048);
        } else {
          expect(body.temperature).toBe(0.6);
          expect(body.max_tokens).toBe(2048);
        }
      }
    } finally { request.mockRestore(); }
  });
});

describe('model setup API', () => {
  const servers: ReturnType<typeof createApp>[] = [];
  afterEach(() => { for (const a of servers.splice(0)) { a.desk.stop(); a.server.close(); } });
  async function start(appMode = 'local', caller?: ModelCaller) {
    const envFile = path.join(mkdtempSync(path.join(tmpdir(), 'mg-models-')), '.env');
    setEnv(envFile, { TRADING_MODE: 'PAPER', AUTO_TRADING: 'off', OPENAI_API_KEY: 'existing-openai-secret' });
    const a = createApp(loadConfig({ TRADING_MODE: 'PAPER', APP_MODE: appMode, HOST: '127.0.0.1', MARKET_SOURCE: 'sample', AUTO_TRADING: 'off', DEBATE_PACE_MS: '0' }), { reportsDir: null, learningsPath: null, envFile, caller });
    servers.push(a);
    await new Promise<void>((r) => a.server.listen(0, '127.0.0.1', r));
    return { base: `http://127.0.0.1:${(a.server.address() as AddressInfo).port}`, envFile };
  }
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const choice = { defaultProvider: 'openai', defaultModel: 'gpt-6-luna' };

  it('routes the next chat through the newly saved provider rather than the old mock configuration', async () => {
    const caller = vi.fn<ModelCaller>(async () => JSON.stringify({ reply: 'Local model fixture response.' }));
    const { base } = await start('local', caller);
    await post(`${base}/api/setup/models`, { defaultProvider: 'local', defaultModel: 'codex:default' });
    expect((await post(`${base}/api/command`, { text: 'hello there', agent: 'lead' })).status).toBe(200);
    expect(caller).toHaveBeenCalled();
    expect(caller.mock.calls.at(-1)![0]).toMatchObject({ provider: 'local', model: 'codex:default', task: 'chat' });
    const state = await (await fetch(`${base}/api/state`)).json();
    expect(state.chats.lead.some((line: { text: string }) => line.text === 'Local model fixture response.')).toBe(true);
  });

  it('applies a saved local provider to the running desk without restarting or changing trading state', async () => {
    const { base } = await start();
    const before = await (await fetch(`${base}/api/state`)).json();
    const response = await post(`${base}/api/setup/models`, { defaultProvider: 'local', defaultModel: 'codex:default' });
    expect(response.status).toBe(200);
    const running = await (await fetch(`${base}/api/state`)).json();
    expect(running.agents.lead.provider).toBe('local');
    expect(running.agents.lead.model).toBe('codex:default');
    expect(running.agents.lead.fellBackToMock).toBe(false);
    expect(running.mode).toBe(before.mode);
    expect(running.killed).toBe(before.killed);
    expect(running.portfolio).toEqual(before.portfolio);
  });

  it.each(LOCAL_AGENTS.map((agent) => agent.id))('saves and applies a custom CLI model for %s to every running agent', async (id) => {
    const { base } = await start();
    const model = `${id}:provider/custom-model-v2`;
    expect((await post(`${base}/api/setup/models`, { defaultProvider: 'local', defaultModel: model })).status).toBe(200);
    const state = await (await fetch(`${base}/api/state`)).json();
    for (const agent of Object.values(state.agents) as { provider: string; model: string }[]) {
      expect(agent.provider).toBe('local');
      expect(agent.model).toBe(model);
    }
    expect((await post(`${base}/api/setup/models`, { defaultProvider: 'local', defaultModel: `${id}:--bad-flag` })).status).toBe(400);
  });

  it('clears old per-agent overrides from the saved summary when applying a new default', async () => {
    const { base } = await start();
    await post(`${base}/api/setup/models`, { defaultProvider: 'local', defaultModel: 'codex:default', agents: { risk: { provider: 'local', model: 'claude:sonnet' } } });
    await fetch(`${base}/api/setup/models`);
    await post(`${base}/api/setup/models`, { defaultProvider: 'local', defaultModel: 'pi:default' });
    const info = await (await fetch(`${base}/api/setup/models`)).json();
    expect(info.agents.find((agent: { id: string }) => agent.id === 'risk')).toMatchObject({ model: 'pi:default', custom: false });
  });

  it('saves masked keys and selections, keeps blank keys, and does not change trading settings', async () => {
    const { base, envFile } = await start();
    const response = await post(`${base}/api/setup/models`, { ...choice, keys: { openai: 'new-openai-secret' } });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('new-openai-secret');
    expect((await post(`${base}/api/setup/models`, { ...choice, keys: { openai: '' } })).status).toBe(200);
    const saved = readEnv(envFile);
    expect(saved.OPENAI_API_KEY).toBe('new-openai-secret');
    expect(saved.OPENAI_MODEL).toBe('gpt-6-luna');
    expect(saved.TRADING_MODE).toBe('PAPER');
    expect(saved.AUTO_TRADING).toBe('off');
    const info = await (await fetch(`${base}/api/setup/models`)).text();
    expect(info).not.toContain('new-openai-secret');
    expect(info).not.toContain('existing-openai-secret');
  });

  it('rejects invalid pairings and cross-origin writes before changing the file', async () => {
    const { base, envFile } = await start();
    const before = readFileSync(envFile, 'utf8');
    expect((await post(`${base}/api/setup/models`, { ...choice, defaultModel: 'claude-opus-5-5' })).status).toBe(400);
    expect((await post(`${base}/api/setup/models`, choice, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(`${base}/api/setup/models`, { ...choice, TRADING_MODE: 'LIVE' })).status).toBe(400);
    expect(readFileSync(envFile, 'utf8')).toBe(before);
  });

  it('keeps model key entry disabled in Grok Bot mode', async () => {
    const { base } = await start('grokbot');
    expect((await post(`${base}/api/setup/models`, { ...choice, keys: { openai: 'not-allowed' } })).status).toBe(403);
  });
});
