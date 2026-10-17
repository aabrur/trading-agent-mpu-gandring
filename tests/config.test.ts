import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { loadConfig, ConfigError } from '../server/config.js';

describe('paper-only safety switch', () => {
  it('refuses any mode other than PAPER', () => {
    for (const mode of ['LIVE', 'live', 'REAL', 'MAINNET']) {
      expect(() => loadConfig({ TRADING_MODE: mode })).toThrow(ConfigError);
    }
  });
  it('server process exits with code 2 when TRADING_MODE=LIVE', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'server/index.ts'], { env: { ...process.env, TRADING_MODE: 'LIVE', PORT: '0' }, encoding: 'utf8', timeout: 15000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/PAPER/);
  });
  it('falls back to mock when a provider has no key', () => {
    const c = loadConfig({ TRADING_MODE: 'PAPER', AGENT_RISK_PROVIDER: 'anthropic' });
    expect(c.agents.risk.provider).toBe('mock');
    expect(c.agents.risk.fellBackToMock).toBe(true);
  });
  it('maps a provider per agent when the key exists', () => {
    const c = loadConfig({ TRADING_MODE: 'PAPER', ANTHROPIC_API_KEY: 'sk-ant-test-0000000000000000', AGENT_RISK_PROVIDER: 'anthropic', AGENT_RISK_MODEL: 'my-model' });
    expect(c.agents.risk).toMatchObject({ provider: 'anthropic', model: 'my-model' });
    expect(c.agents.lead.provider).toBe('mock');
  });
  it('rejects N outside 1 to 4', () => {
    expect(() => loadConfig({ TRADING_MODE: 'PAPER', OPEN_ORDERS_N: '7' })).toThrow();
  });
});

describe('six agents', () => {
  it('the desk has exactly six agents, each with its own provider slot', async () => {
    const { AGENT_IDS } = await import('../server/config.js');
    expect(AGENT_IDS).toEqual(['lead', 'market', 'research', 'strategist', 'risk', 'execution']);
    const cfg = loadConfig({ TRADING_MODE: 'PAPER', AGENT_RISK_PROVIDER: 'mock', AGENT_EXECUTION_MODEL: 'm1' });
    expect(Object.keys(cfg.agents)).toHaveLength(6);
  });
});
