import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../server/config.js';
import { setEnv, readEnv } from '../cli/envfile.js';
import { createApp } from '../server/app.js';
import { localLoginStatus, openAgentLogin, runLocalAgent } from '../server/providers/local.js';

vi.mock('../server/providers/local.js', async original => ({
  ...await original<typeof import('../server/providers/local.js')>(),
  localLoginStatus: vi.fn(async () => ({connected: true, state: 'connected'})),
  openAgentLogin: vi.fn(async () => 'Sign in'),
  runLocalAgent: vi.fn(async () => '{"reply":"connected"}'),
  discoverLocalModels: vi.fn(async () => ({agentId: 'claude', installed: true, configuredModel: 'claude-opus-4-6', models: [], completeness: 'partial', authentication: 'authenticated'}))
}));
const apps: ReturnType<typeof createApp>[] = [];
afterEach(() => { for (const app of apps.splice(0)) { app.desk.stop(); app.lead.stop(); app.server.close(); } vi.clearAllMocks(); vi.unstubAllEnvs(); });
async function start() {
  for (const id of ['LEAD', 'MARKET', 'RESEARCH', 'STRATEGIST', 'RISK', 'EXECUTION']) { vi.stubEnv(`AGENT_${id}_PROVIDER`, ''); vi.stubEnv(`AGENT_${id}_MODEL`, ''); vi.stubEnv(`AGENT_${id}_REASONING`, ''); }
  vi.stubEnv('DEFAULT_REASONING_EFFORT', '');
  const envFile = path.join(mkdtempSync(path.join(tmpdir(), 'mpu-connect-')), '.env');
  setEnv(envFile, {TRADING_MODE: 'PAPER', DEFAULT_PROVIDER: 'mock', AGENT_RISK_PROVIDER: 'local', AGENT_RISK_MODEL: 'pi:owner-choice', AGENT_RISK_REASONING: 'med', SAFETY_NET: '123'});
  const cfg = loadConfig(readEnv(envFile));
  const app = createApp(cfg, {envFile, reportsDir: null, learningsPath: null}); apps.push(app);
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  return {app, envFile, url: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/setup/local-agents/connect`};
}
const post = (url: string, body: unknown) => fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
describe('Connect, configure, activate', () => {
  it('probes and applies inherited roles immediately while retaining explicit Owner assignments', async () => {
    const {app, envFile, url} = await start();
    const before = app.desk.snapshot();
    const response = await post(url, {id: 'claude'});
    expect(await response.json()).toMatchObject({ok: true, active: true, state: 'CONNECTED & ACTIVE', model: 'claude:claude-opus-4-6'});
    expect(openAgentLogin).not.toHaveBeenCalled();
    expect(runLocalAgent).toHaveBeenCalled();
    expect(app.desk.cfg.agents.lead.model).toBe('claude:claude-opus-4-6');
    expect(app.desk.cfg.agents.risk.model).toBe('pi:owner-choice');
    expect(app.desk.cfg.reasoning?.risk).toBe('med');
    expect(readEnv(envFile).SAFETY_NET).toBe('123');
    expect(app.desk.snapshot().mode).toBe(before.mode);
    expect(app.desk.snapshot().paper).toEqual(before.paper);
  });
  it('keeps saved and runtime configuration unchanged when model verification fails', async () => {
    const {app, envFile, url} = await start();
    const before = readEnv(envFile), active = structuredClone(app.desk.cfg.agents);
    vi.mocked(runLocalAgent).mockRejectedValueOnce(new Error('fixture failure'));
    expect(await (await post(url, {id: 'claude'})).json()).toMatchObject({ok: false, active: false, state: 'VERIFICATION FAILED'});
    expect(readEnv(envFile)).toEqual(before); expect(app.desk.cfg.agents).toEqual(active);
  });
  it('starts native sign-in and leaves configuration pending until continuation', async () => {
    const {envFile, url} = await start();
    vi.mocked(localLoginStatus).mockResolvedValueOnce({connected: false, state: 'signed-out'});
    const before = readEnv(envFile);
    expect(await (await post(url, {id: 'claude'})).json()).toMatchObject({ok: true, active: false, state: 'AUTHENTICATING'});
    expect(openAgentLogin).toHaveBeenCalledWith('claude'); expect(readEnv(envFile)).toEqual(before);
    expect(await (await post(url, {id: 'claude', continue: true})).json()).toMatchObject({active: true});
  });
});
