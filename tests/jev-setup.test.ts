import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { setEnv } from '../cli/envfile.js';
import { jevSetupInfo, saveJevSetup } from '../server/setup/jev.js';

describe('Jev BYOK setup', () => {
  it('does not echo keys and prefers the dedicated Jev OpenRouter key', () => {
    const env = { OPENROUTER_API_KEY: 'shared-or-secret', JEV_OPENROUTER_API_KEY: 'dedicated-jev-secret', JEV_ENABLED: 'true', TRADING_MODE: 'PAPER' };
    const info = jevSetupInfo(env, 'PAPER', { requests: 0, success: 0, errors: 0, timeouts: 0, lastLatencyMs: null, lastModel: null, lastCost: null, lastInputTokens: null, lastError: null });
    const json = JSON.stringify(info);
    expect(json).not.toContain('shared-or-secret');
    expect(json).not.toContain('dedicated-jev-secret');
    expect(info.dedicatedKeySet).toBe(true);
    expect(info.openrouterKeySet).toBe(true);
    expect(info.keySource).toBe('jev');
    expect(info.model).toBe('typesafe/jev-1.14');
  });

  it('writes enablement without treating a stored key as consent to trade', () => {
    const envFile = path.join(mkdtempSync(path.join(tmpdir(), 'mg-jev-')), '.env');
    saveJevSetup(envFile, { enabled: true, mode: 'shadow', key: 'jev-only-secret' });
    const text = readFileSync(envFile, 'utf8');
    expect(text).toMatch(/JEV_ENABLED=true/);
    expect(text).toMatch(/JEV_MODE=shadow/);
    expect(text).toMatch(/JEV_MODEL=typesafe\/jev-1.14/);
    expect(text).toMatch(/JEV_OPENROUTER_API_KEY=jev-only-secret/);
  });
});

describe('Jev setup API', () => {
  const servers: ReturnType<typeof createApp>[] = [];
  afterEach(() => { for (const a of servers.splice(0)) { a.desk.stop(); a.server.close(); } });

  it('saves settings, hides keys, and tests only when asked', async () => {
    const envFile = path.join(mkdtempSync(path.join(tmpdir(), 'mg-jev-api-')), '.env');
    setEnv(envFile, { TRADING_MODE: 'PAPER', AUTO_TRADING: 'off' });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      model: 'typesafe/jev-1.14',
      answers: { reachable: { type: 'noul', noul: 0.9 } }
    }), { status: 200 }));
    const a = createApp(loadConfig({ TRADING_MODE: 'PAPER', HOST: '127.0.0.1', MARKET_SOURCE: 'sample', AUTO_TRADING: 'off' }), {
      reportsDir: null, learningsPath: null, envFile, jevFetch: fetchImpl as unknown as typeof fetch, jevEnv: { TRADING_MODE: 'PAPER' }
    });
    servers.push(a);
    await new Promise<void>((r) => a.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(a.server.address() as AddressInfo).port}`;

    const get1 = await (await fetch(`${base}/api/setup/jev`)).json();
    expect(get1.ok).toBe(true);
    expect(get1.enabled).toBe(false);
    expect(JSON.stringify(get1)).not.toMatch(/sk-|secret/i);
    expect(fetchImpl).not.toHaveBeenCalled();

    const post = await fetch(`${base}/api/setup/jev`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, mode: 'shadow', key: 'jev-setup-secret-value' }) });
    const saved = await post.json();
    expect(saved.ok).toBe(true);
    expect(JSON.stringify(saved)).not.toContain('jev-setup-secret-value');
    expect(readFileSync(envFile, 'utf8')).toContain('jev-setup-secret-value');
    expect(fetchImpl).not.toHaveBeenCalled();

    const test = await fetch(`${base}/api/setup/jev/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const tested = await test.json();
    expect(tested.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(tested)).not.toContain('jev-setup-secret-value');
  });
});
