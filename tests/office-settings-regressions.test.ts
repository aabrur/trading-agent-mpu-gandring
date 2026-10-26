import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { readEnv, setEnv } from '../cli/envfile.js';

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) {
    app.auto.stop(); app.reporter.stop(); app.lead.stop(); app.desk.stop();
    await new Promise<void>(resolve => app.server.close(() => resolve()));
  }
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});
async function start() {
  const envFile = path.join(mkdtempSync(path.join(tmpdir(), 'mpu-office-settings-')), '.env');
  const env = { TRADING_MODE: 'PAPER', TRADING_PROFILE: 'current', DEFAULT_PROVIDER: 'mock', MARKET_SOURCE: 'sample', AUTO_TRADING: 'off', PAPER_BALANCE: '1000', SAFETY_NET: '200', OPEN_ORDERS_N: '4', DAILY_LOSS_LIMIT_PCT: '3', REPORT_INTERVAL_MIN: '60' };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  setEnv(envFile, env);
  const app = createApp(loadConfig(env), { envFile, reportsDir: null, learningsPath: null, killFile: null });
  apps.push(app);
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return { ...app, base, envFile };
}
const post = (base: string, route: string, body = {}) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

it('applies saved desk preferences immediately without resetting positions or the daily loss baseline', async () => {
  const app = await start();
  const day = structuredClone(app.desk.day);
  app.desk.killed = true; app.desk.paused = true;
  const response = await post(app.base, '/api/setup/preferences', { appMode: 'local', balance: 1000, safetyNet: 250, n: 3, dailyLoss: 2, auto: false, debateInterval: 20, reportInterval: 15, maxHoldHours: 4 });
  expect(await response.json()).toMatchObject({ ok: true, applied: true });
  expect(app.desk.book.safetyNet).toBe(250);
  expect(app.desk.book.n).toBe(3);
  expect(app.desk.cfg.risk.dailyLossLimitPct).toBe(2);
  expect(app.desk.cfg.reports.intervalMin).toBe(15);
  expect(app.desk.cfg.auto).toMatchObject({ on: false, intervalMin: 20, maxHoldHours: 4 });
  expect(app.desk.day).toEqual(day);
  expect(app.desk.killed).toBe(true);
  expect(app.desk.paused).toBe(true);
  expect(readEnv(app.envFile).TRADING_MODE).toBe('PAPER');
});

it('does not reset realized paper equity when saving an unrelated desk setting', async () => {
  const app = await start();
  app.desk.book.balance = 950;
  await post(app.base, '/api/setup/preferences', { appMode: 'local', balance: 1000, safetyNet: 200, n: 4, dailyLoss: 3, auto: false, debateInterval: 20, reportInterval: 15 });
  expect(app.desk.book.balance).toBe(950);
});

describe.each(['/api/setup/restart', '/api/ops/restart'])('%s', route => {
  it('reports an invalid saved configuration instead of claiming it was applied', async () => {
    const app = await start();
    setEnv(app.envFile, { OPEN_ORDERS_N: '9' });
    const response = await post(app.base, route);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false });
    expect(app.desk.book.n).toBe(4);
  });

  it('requests a managed restart before touching the running exchange or safety state', async () => {
    const app = await start();
    vi.stubEnv('MPU_MANAGED', '1');
    const descriptor = Object.getOwnPropertyDescriptor(process, 'send');
    const send = vi.fn(() => true);
    Object.defineProperty(process, 'send', { configurable: true, writable: true, value: send });
    const reload = vi.spyOn(app.desk, 'reloadRuntimeConfig');
    try {
      const response = await post(app.base, route);
      expect(await response.json()).toMatchObject({ ok: true, restart: 'process' });
      expect(reload).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'mpu:restart' }));
    } finally {
      if (descriptor) Object.defineProperty(process, 'send', descriptor);
      else delete process.send;
    }
  });
});
