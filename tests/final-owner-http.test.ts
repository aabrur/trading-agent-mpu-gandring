import { expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';

it('T11 local ON/OFF persists, denies hostile origins, and never enables Auto Trading', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mpu-owner-http-'));
  const killFile = path.join(dir, 'kill.json');
  const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEFAULT_PROVIDER: 'mock', AUTO_TRADING: 'off' });
  const built = createApp(cfg, { reportsDir: null, conversationsPath: null, learningsPath: null, killFile, sessionLog: null });
  await new Promise<void>(resolve => built.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(built.server.address() as { port: number }).port}`;
  const post = (on: boolean, hostile = false) => fetch(`${url}/api/ops/kill`, { method: 'POST', headers: { 'content-type': 'application/json', ...(hostile ? { origin: 'https://hostile.example' } : {}) }, body: JSON.stringify({ on }) });
  try {
    expect((await post(true)).status).toBe(200);
    expect(built.desk.killed).toBe(true);
    expect(readFileSync(killFile, 'utf8')).toContain('kill switch');
    expect((await post(false, true)).status).toBe(403);
    expect(built.desk.killed).toBe(true);
    expect((await post(false)).status).toBe(200);
    expect(built.desk.killed).toBe(false);
    expect(cfg.auto.on).toBe(false);
    expect(built.desk.book.positions).toHaveLength(0);
  } finally { await new Promise<void>(resolve => built.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

it('history read/delete is local, role scoped and leaves independent journal bytes unchanged', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mpu-history-http-'));
  const journal = path.join(dir, 'independent-journal.json'); writeFileSync(journal, 'unchanged audit');
  const built = createApp(loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEFAULT_PROVIDER: 'mock', LEARNING: 'off' }), { reportsDir: null, conversationsPath: path.join(dir, 'conversations.json'), learningsPath: null, killFile: null, sessionLog: null });
  await built.desk.command('Hello', 'lead'); await built.desk.command('Hello', 'risk');
  built.desk.closeOperationalSession(); built.desk.activeChatSession();
  await new Promise<void>(resolve => built.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(built.server.address() as { port: number }).port}/api/chat/history`;
  try {
    const history = await fetch(`${url}/lead`).then(r => r.json()) as { sessions: { id: string }[] };
    const id = history.sessions[0].id;
    expect((await fetch(`${url}/lead/${id}?limit=1`)).status).toBe(200);
    expect((await fetch(`${url}/lead/${id}`, { headers: { origin: 'https://hostile.example' } })).status).toBe(403);
    expect((await fetch(`${url}/lead/${id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(400);
    expect((await fetch(`${url}/lead/${id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{"confirm":true}' })).status).toBe(200);
    expect(built.desk.listChatHistory('lead')).toHaveLength(0);
    expect(built.desk.listChatHistory('risk')).toHaveLength(1);
    expect(readFileSync(journal, 'utf8')).toBe('unchanged audit');
  } finally { await new Promise<void>(resolve => built.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
