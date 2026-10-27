import { afterEach, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { buildReport } from '../server/reports.js';
import { sendToGrokBot } from '../server/bridge.js';

vi.mock('../server/bridge.js', () => ({ sendToGrokBot: vi.fn(async () => 'off') }));
afterEach(() => vi.restoreAllMocks());

const routes = ['/api/debate', '/api/auto/cycle', '/api/kill', '/api/unkill', '/api/reports/now', '/api/bridge/probe'];

it('requires local Host and Origin before dispatching every formerly unguarded mutation', async () => {
  const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEFAULT_PROVIDER: 'mock', AUTO_TRADING: 'off' });
  const built = createApp(cfg, { reportsDir: null, learningsPath: null, conversationsPath: null, killFile: null, sessionLog: null });
  const debate = vi.spyOn(built.desk, 'runDebate').mockRejectedValue(new Error('isolated debate fixture'));
  const cycle = vi.spyOn(built.auto, 'cycle').mockResolvedValue({ ran: [], skipped: 'fixture' });
  const kill = vi.spyOn(built.desk, 'kill').mockResolvedValue(['fixture']);
  const unkill = vi.spyOn(built.desk, 'unkill').mockReturnValue(true);
  const stop = vi.spyOn(built.auto, 'stop').mockImplementation(() => {});
  const report = vi.spyOn(built.reporter, 'generate').mockResolvedValue(buildReport(built.desk, 0));
  vi.mocked(sendToGrokBot).mockClear();
  await new Promise<void>((resolve) => built.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(built.server.address() as AddressInfo).port}`;
  let receivedHost: string | undefined;
  built.server.prependListener('request', (req) => { receivedHost = req.headers.host; });
  // Send the actual Host header, which fetch may replace with the URL's host.
  const post = (route: string, headers: Record<string, string> = {}, body: object = {}) => new Promise<{ status: number | undefined }>((resolve, reject) => {
    const req = request(base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      res.on('error', reject);
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
  try {
    for (const route of routes) {
      expect((await post(route, { origin: 'https://untrusted.example' })).status).toBe(403);
      expect((await post(route, { host: 'untrusted.example', origin: 'http://localhost:5173' })).status).toBe(403);
      expect(receivedHost).toBe('untrusted.example');
    }
    expect((await post('/api/kill', { origin: 'https://untrusted.example' }, { action: 'release' })).status).toBe(403);
    for (const operation of [debate, cycle, kill, unkill, stop, report, vi.mocked(sendToGrokBot)]) expect(operation).not.toHaveBeenCalled();

    // Browser and CLI requests keep the same handlers; all effects are mocked.
    const localHeaders: Record<string, string>[] = [{ origin: 'http://localhost:5173' }, {}];
    for (const headers of localHeaders) {
      for (const route of routes) expect((await post(route, headers)).status).toBe(route === '/api/debate' ? 409 : 200);
    }
    for (const operation of [debate, cycle, kill, unkill, stop, report, vi.mocked(sendToGrokBot)]) expect(operation).toHaveBeenCalledTimes(2);
    expect((await post('/api/kill', {}, { action: 'release' })).status).toBe(200);
    expect(unkill).toHaveBeenCalledTimes(3);
    expect(kill).toHaveBeenCalledTimes(2);
  } finally {
    built.desk.stop();
    await new Promise<void>((resolve) => built.server.close(() => resolve()));
  }
});

it('leaves external agent and TradingView requests behind their dedicated credentials', async () => {
  const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', APP_MODE: 'grokbot', AGENT_EVENT_SECRET: 'isolated-test-token-0000000000', TRADINGVIEW_PASSPHRASE: 'isolated-test-passphrase' });
  const built = createApp(cfg, { reportsDir: null, learningsPath: null, conversationsPath: null, killFile: null, sessionLog: null });
  await new Promise<void>((resolve) => built.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(built.server.address() as AddressInfo).port}`;
  try {
    for (const route of ['/api/agent-event', '/api/gb/open', '/api/tradingview']) {
      const response = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://external.example' }, body: '{}' });
      expect(response.status).toBe(401);
    }
  } finally {
    built.desk.stop();
    await new Promise<void>((resolve) => built.server.close(() => resolve()));
  }
});
