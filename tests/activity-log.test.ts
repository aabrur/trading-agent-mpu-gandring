import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { onActivity, publishActivity, type ActivityEntry } from '../server/activity.js';
import { recordResearchActivity } from '../server/providers/local.js';
import { makeCaller } from '../server/providers/index.js';
import { registerSecrets } from '../server/redact.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TradeLog } from '../web/src/components/Panels.js';
import { I18nProvider } from '../web/src/i18n.js';
import type { DeskState } from '../web/src/types.js';
import * as market from '../server/market/index.js';
import { sampleSnapshot } from '../server/market/sample.js';

afterEach(() => vi.restoreAllMocks());
const fixture = () => createApp(loadConfig({ TRADING_MODE: 'PAPER', DEFAULT_PROVIDER: 'mock', MARKET_SOURCE: 'sample', DEBATE_PACE_MS: '0' }), { reportsDir: null, learningsPath: null, jevEnv: {} });
async function listen(built: ReturnType<typeof fixture>) {
  await new Promise<void>(resolve => built.server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(built.server.address() as AddressInfo).port}`;
}
async function close(built: ReturnType<typeof fixture>) {
  built.desk.stop();
  await new Promise<void>(resolve => built.server.close(() => resolve()));
}

describe('unified activity log', () => {
  it('streams structured MCP failures without tool arguments/results and retains the full bounded log in snapshots', async () => {
    const built = fixture();
    const base = await listen(built);
    const client = new WebSocket(`${base.replace('http', 'ws')}/ws`);
    try {
      await new Promise<void>((resolve, reject) => { client.once('message', () => resolve()); client.once('error', reject); });
      const received = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Missing live activity event')), 2000);
        client.on('message', raw => { const event = JSON.parse(String(raw)); if (event.type === 'log' && event.payload.kind === 'mcp') { clearTimeout(timer); resolve(event.payload); } });
      });
      recordResearchActivity(JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'mpu_research', tool: 'market_news', arguments: { private: 'not-for-logs' }, result: { isError: true, content: 'not-for-logs' } } }));
      expect(await received).toMatchObject({ source: 'mpu_research', level: 'error', status: 'failed', text: 'mpu_research/market_news: failed' });
      expect(JSON.stringify(built.desk.snapshot().logs)).not.toContain('not-for-logs');
      for (let i = 0; i < 2100; i++) built.desk.recordActivity({ kind: 'process', source: 'fixture', level: 'info', text: `event ${i}` });
      const logs = built.desk.snapshot().logs;
      expect(logs).toHaveLength(2000);
      expect(logs[0].text).toBe('event 100');
      expect(logs.at(-1)?.text).toBe('event 2099');
    } finally { client.terminate(); await close(built); }
    const count = built.desk.logs.length;
    publishActivity({ kind: 'process', source: 'fixture', level: 'info', text: 'after close' });
    expect(built.desk.logs).toHaveLength(count);
  });

  it('accepts local browser errors, redacts credentials and rejects cross-origin or oversized diagnostic input', async () => {
    const built = fixture();
    const base = await listen(built);
    const secret = 'fixture-private-diagnostic-key';
    registerSecrets([secret]);
    const post = (body: unknown, origin = base) => fetch(`${base}/api/logs/client`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) });
    try {
      expect((await post({ message: `Request failed token=${secret}`, level: 'error', event: 'request' })).ok).toBe(true);
      expect(built.desk.logs.at(-1)).toMatchObject({ source: 'browser:request', level: 'error' });
      expect(JSON.stringify(built.desk.snapshot())).not.toContain(secret);
      expect((await post({ message: 'foreign error', level: 'error', event: 'error' }, 'https://untrusted.example')).status).toBe(403);
      expect((await post({ message: 'x'.repeat(1001), level: 'error', event: 'error' })).status).toBe(400);
      expect((await post({ message: 'bad payload', level: 'error', event: 'error', requestBody: secret })).status).toBe(400);
      expect(built.desk.logs.filter(line => line.kind === 'frontend')).toHaveLength(1);
      await fetch(`${base}/api/missing?private=not-for-logs`);
      expect(built.desk.logs.at(-1)).toMatchObject({ kind: 'backend', level: 'warn', text: 'GET /api/missing · HTTP 404', status: '404' });
      const malformed = await fetch(`${base}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not-for-logs' });
      expect(malformed.status).toBe(400);
      expect(built.desk.logs.some(line => line.text === 'Malformed JSON request')).toBe(true);
      expect(JSON.stringify(built.desk.logs)).not.toContain('not-for-logs');
      for (let i = 0; i < 27; i++) await post({ message: 'rate fixture', level: 'warn', event: 'error' });
      expect((await post({ message: 'rate fixture', level: 'warn', event: 'error' })).status).toBe(429);
    } finally { await close(built); }
  });

  it('records model failures with agent and duration while excluding prompts', async () => {
    const cfg = loadConfig({ TRADING_MODE: 'PAPER' });
    const events: ActivityEntry[] = [];
    const stop = onActivity(entry => events.push(entry));
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('provider connection refused'));
    try {
      await expect(makeCaller(cfg)({ provider: 'openai', model: 'fixture-model', agent: 'lead', task: 'chat', system: 'private-system-prompt', user: 'private-user-message', context: {}, attempt: 1 })).rejects.toThrow('connection refused');
      expect(events.at(-1)).toMatchObject({ agent: 'lead', level: 'error', status: 'failed', durationMs: expect.any(Number) });
      expect(JSON.stringify(events)).not.toContain('private-system-prompt');
      expect(JSON.stringify(events)).not.toContain('private-user-message');
    } finally { stop(); }
  });

  it('keeps trade/chat history separate from system diagnostics and exposes distinct tool filters', async () => {
    const built = fixture();
    try {
      const position = built.desk.book.open({ symbol: 'BTCUSDT', side: 'LONG', qty: 0.01, entry: 60000, stop: 59000, margin: 200, leverage: 3 });
      built.desk.book.close(position.id, 61000, 'fixture close');
      built.desk.recordError('exchange', 'protection read failed');
      built.desk.addRoomMessage({ from: 'owner', to: 'research', text: 'Owner history fixture' });
      const html = renderToStaticMarkup(createElement(I18nProvider, { children: createElement(TradeLog, { state: built.desk.snapshot() as DeskState }) }));
      expect(html).not.toContain('fixture close');
      expect(html).not.toContain('Owner history fixture');
      expect(html).toContain('protection read failed');
      expect(html).toContain('level-error');
      expect(html).toContain('Search activity log');
      for (const category of ['tool', 'mcp', 'plugin', 'process', 'frontend', 'backend']) expect(html).toContain(`value="${category}"`);
      expect(html).not.toContain('Tools / MCP / Plugins / Processes');
      const historyHtml = renderToStaticMarkup(createElement(I18nProvider, { children: createElement(TradeLog, { state: built.desk.snapshot() as DeskState, view: 'history' }) }));
      expect(historyHtml).toContain('fixture close');
      expect(historyHtml).toContain('Owner history fixture');
      expect(historyHtml).toContain('Boss → Research Analyst');
      expect(historyHtml).not.toContain('protection read failed');
      expect(historyHtml).toContain('Search history');
    } finally { await close(built); }
  });
});

describe('Office discussion command contract', () => {
  it('sends a group chat to six agents and a targeted chat to just the selected agent without opening orders', async () => {
    vi.spyOn(market, 'getSnapshot').mockResolvedValue(sampleSnapshot('BTCUSDT'));
    const built = fixture();
    const base = await listen(built);
    try {
      const post = (text: string, agent?: string) => fetch(`${base}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, agent }) });
      expect(await (await post('@all Hello team')).json()).toMatchObject({ ok: true });
      const room = built.desk.roomHistory;
      expect(room.filter(message => message.from === 'owner')).toHaveLength(1);
      expect(new Set(room.filter(message => message.from !== 'owner').map(message => message.from)).size).toBe(6);
      const start = room.length;
      expect(await (await post('Hello there', 'risk')).json()).toMatchObject({ ok: true });
      expect(room.slice(start).map(message => message.from)).toEqual(['owner', 'risk']);
      expect(built.desk.logs.filter(line => line.kind === 'chat')).toHaveLength(room.length);
      expect(built.desk.book.positions).toHaveLength(0);
    } finally { await close(built); }
  });
});
