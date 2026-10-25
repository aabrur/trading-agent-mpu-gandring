import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server/config.js';
import { dataSourcesStatus, saveDataSources } from '../server/setup/data-sources.js';
import { readEnv, setEnv } from '../cli/envfile.js';

afterEach(() => vi.unstubAllEnvs());
describe('data provider setup', () => {
  it('preserves saved keys on empty input and changes only the requested data provider', () => {
    vi.stubEnv('NEWS_PROVIDER', 'sample'); vi.stubEnv('CRYPTOPANIC_API_KEY', ''); vi.stubEnv('WHALE_ALERT_API_KEY', ''); vi.stubEnv('COINMARKETCAP_API_KEY', '');
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'mpu-source-settings-')), '.env');
    setEnv(file, { TRADING_MODE: 'LIVE', AUTO_TRADING: 'on', OPEN_ORDERS_N: '2', ASTER_SIGNER_PRIVATE_KEY: 'never-touch', CRYPTOPANIC_API_KEY: 'existing-news', WHALE_ALERT_API_KEY: 'existing-whale', COINMARKETCAP_API_KEY: 'existing-cmc' });
    const cfg = loadConfig({});
    const before = readFileSync(file, 'utf8');
    expect(saveDataSources(file, cfg, {}).ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(before);
    const result = saveDataSources(file, cfg, { whaleAlertKey: 'new-whale-secret', coinMarketCapKey: 'new-cmc-secret' });
    const saved = readEnv(file);
    expect(saved.CRYPTOPANIC_API_KEY).toBe('existing-news');
    expect(saved.WHALE_ALERT_API_KEY).toBe('new-whale-secret');
    expect(saved.COINMARKETCAP_API_KEY).toBe('new-cmc-secret');
    expect(saved.ASTER_SIGNER_PRIVATE_KEY).toBe('never-touch');
    expect(saved.TRADING_MODE).toBe('LIVE'); expect(saved.AUTO_TRADING).toBe('on'); expect(saved.OPEN_ORDERS_N).toBe('2');
    expect(JSON.stringify(result)).not.toContain('new-whale-secret');
    expect(JSON.stringify(result)).not.toContain('new-cmc-secret');
    expect(JSON.stringify(dataSourcesStatus(saved))).not.toContain('new-cmc-secret');
    expect(dataSourcesStatus(saved).coinMarketCapKeySet).toBe(true);
  });
  it('rejects malformed key input before writing settings', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'mpu-source-settings-')), '.env');
    setEnv(file, { TRADING_MODE: 'LIVE' });
    const before = readFileSync(file, 'utf8');
    expect(() => saveDataSources(file, loadConfig({}), { cryptoPanicKey: 'has whitespace' })).toThrow();
    expect(() => saveDataSources(file, loadConfig({}), { coinMarketCapKey: 'has whitespace' })).toThrow();
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});
