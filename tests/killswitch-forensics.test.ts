import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendKillAudit, killContext, readKill, writeKill } from '../server/killswitch.js';
import { killCmd } from '../cli/kill.js';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { LiveExecutor } from '../server/live/executor.js';
import { MemoryAdapter } from './fakes.js';

const dirs: string[] = [];
const fixture = () => { const dir = mkdtempSync(path.join(tmpdir(), 'mpu-kill-audit-')); dirs.push(dir); return path.join(dir, 'kill.json'); };
const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) {
    app.auto.stop(); app.reporter.stop(); app.lead.stop(); app.desk.stop();
    if (app.server.listening) await new Promise<void>(resolve => app.server.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('kill activation evidence', () => {
  it('preserves the first CLI activation when the API follows it', () => {
    const file = fixture();
    writeKill(file, { at: 100, reason: 'CLI emergency kill switch' });
    writeKill(file, { at: 200, reason: 'kill switch' });
    expect(readKill(file)).toMatchObject({ at: 100, reason: 'CLI emergency kill switch' });
  });

  it('does not replace a malformed persisted activation', () => {
    const file = fixture();
    writeFileSync(file, '{corrupt');
    writeKill(file, { at: 200, reason: 'kill switch' });
    expect(readFileSync(file, 'utf8')).toBe('{corrupt');
    expect(readKill(file)).toMatchObject({ at: 0, reason: 'kill switch file present but unreadable' });
  });

  it('keeps one activation record with append-only records for repeated requests', async () => {
    const file = fixture(), context = killContext('cli');
    writeKill(file, { at: 100, reason: 'CLI emergency kill switch', ...context });
    const original = readFileSync(file, 'utf8');
    await Promise.all(Array.from({ length: 12 }, () => Promise.resolve().then(() => writeKill(file, { at: 200, reason: 'Office kill switch', ...killContext('office') }))));
    expect(readFileSync(file, 'utf8')).toBe(original);
    const rows = readFileSync(file + '.audit.jsonl', 'utf8').trim().split('\n').map(row => JSON.parse(row));
    expect(rows).toHaveLength(13);
    expect(rows[0]).toMatchObject({ source: 'cli', requestId: context.requestId, result: 'activated' });
    expect(rows.slice(1).every(row => row.result === 'already_active')).toBe(true);
  });

  it('redacts credentials and user identifiers and rejects identifier-shaped correlation data', () => {
    const file = fixture();
    appendKillAudit(file, { at: 100, source: 'channel', requestId: 'user-secret-id', result: 'activated', reason: 'token=secret-token-value user_id=private-user-42 123456789012345678 person@example.com' });
    const text = readFileSync(file + '.audit.jsonl', 'utf8');
    for (const value of ['secret-token-value', 'private-user-42', '123456789012345678', 'person@example.com', 'user-secret-id']) expect(text).not.toContain(value);
    expect(JSON.parse(text).requestId).toMatch(/^[a-f0-9-]{36}$/);
  });

  it('reports append failure without claiming complete CLI confirmation and still notifies the Office', async () => {
    const file = fixture(); mkdirSync(file + '.audit.jsonl');
    const notify = vi.fn(async () => new Response('{"ok":true}'));
    vi.stubGlobal('fetch', notify);
    const result = await killCmd(['confirm'], file);
    expect(readKill(file)?.source).toBe('cli');
    expect(result).toMatchObject({ ok: false, text: expect.stringContaining('audit recording failed') });
    expect(result.text).not.toContain('KILL SWITCH ENGAGED');
    expect(notify).toHaveBeenCalledOnce();
  });

  it('CLI followed by authenticated local API preserves the original source and correlation', async () => {
    const file = fixture(), context = killContext('cli');
    writeKill(file, { at: 100, reason: 'CLI emergency kill switch', ...context });
    const app = createApp(loadConfig({ MARKET_SOURCE: 'sample', APP_MODE: 'grokbot' }), { killFile: file, reportsDir: null, learningsPath: null }); apps.push(app);
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const response = await fetch(base + '/api/kill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: true, requestId: context.requestId }) });
    expect(response.status).toBe(200);
    expect(readKill(file)).toMatchObject({ at: 100, source: 'cli', requestId: context.requestId, reason: 'CLI emergency kill switch' });
    const rows = readFileSync(file + '.audit.jsonl', 'utf8').trim().split('\n').map(row => JSON.parse(row));
    expect(rows.some(row => row.source === 'office' && row.requestId === context.requestId && row.result === 'flatten_completed')).toBe(true);
  });

  it('reports API forensic confirmation unavailable when audit append fails', async () => {
    const file = fixture(); mkdirSync(file + '.audit.jsonl');
    const app = createApp(loadConfig({ MARKET_SOURCE: 'sample', APP_MODE: 'grokbot' }), { killFile: file, reportsDir: null, learningsPath: null }); apps.push(app);
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const response = await fetch(base + '/api/kill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(await response.json()).toMatchObject({ killed: true, auditConfirmed: false, notes: expect.arrayContaining([expect.stringContaining('audit append failed')]) });
    expect(readKill(file)).not.toBeNull();
  });

  it('concurrent and subsequent emergency requests do not submit duplicate closes for an already closed position', async () => {
    const adapter = new MemoryAdapter(), executor = new LiveExecutor(adapter, 0), file = fixture();
    const app = createApp(loadConfig({ MARKET_SOURCE: 'sample', APP_MODE: 'grokbot' }), { executor, killFile: file, reportsDir: null, learningsPath: null }); apps.push(app);
    const pos = app.desk.book.open({ symbol: 'BTCUSDT', side: 'LONG', qty: 1, entry: 60000, stop: 59000, tp: null, margin: 1000, leverage: 2 });
    pos.ownership = 'managed'; adapter.pos = [{ ...pos, unrealizedPnl: 0 }];
    await Promise.all([app.desk.kill(killContext('office')), app.desk.kill(killContext('channel'))]);
    await app.desk.kill(killContext('office'));
    expect(adapter.closes).toBe(1);
    expect(app.desk.killed).toBe(true);
  });
});
