import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, symlink, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { SessionLogger, readSessionEvents, setSessionLogger } from '../server/session-log.js';
import { registerSecrets } from '../server/redact.js';
import { LiveExecutor } from '../server/live/executor.js';
import { MemoryAdapter } from './fakes.js';

const roots: string[] = [];
async function temp() { const dir = await mkdtemp(path.join(os.tmpdir(), 'mpu-session-api-')); roots.push(dir); return dir; }
afterEach(async () => { setSessionLogger(null); vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('session archive integration', () => {
  it('serves paged redacted history, downloads and live WebSocket activity through the same source', async () => {
    const root = await temp(), logger = await SessionLogger.start({ root });
    const secret = 'fixture-session-api-secret'; registerSecrets([secret]);
    const built = createApp(loadConfig({ TRADING_MODE: 'PAPER', DEFAULT_PROVIDER: 'mock', MARKET_SOURCE: 'sample' }), { reportsDir: null, learningsPath: null, conversationsPath: null, jevEnv: {}, sessionLog: logger });
    await new Promise<void>(resolve => built.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(built.server.address() as AddressInfo).port}`;
    const client = new WebSocket(base.replace('http', 'ws') + '/ws');
    try {
      await new Promise<void>((resolve, reject) => { client.once('message', () => resolve()); client.once('error', reject); });
      const received = new Promise<Record<string, unknown>>(resolve => client.on('message', raw => { const event = JSON.parse(String(raw)); if (event.type === 'log' && event.payload.source === 'fixture') resolve(event.payload); }));
      built.desk.recordActivity({ kind: 'backend', source: 'fixture', level: 'warn', text: `Archived failure ${secret}`, correlationId: 'decision-1' });
      expect((await received).text).not.toContain(secret);
      for (let i = 0; i < 30; i++) logger.write({ source: 'order', eventName: 'order.observed', message: `older ${i}`, correlationId: 'decision-1' });
      await logger.flush();
      const listing = await (await fetch(base + '/api/logs/sessions')).json();
      expect(listing.activeSessionId).toBe(logger.session.sessionId);
      const endpoint = `${base}/api/logs/sessions/${logger.session.sessionId}`;
      expect((await (await fetch(endpoint)).json()).session.pid).toBe(process.pid);
      const page = await (await fetch(endpoint + '/events?source=order&limit=5&correlationId=decision-1')).json();
      expect(page.events).toHaveLength(5);
      const older = await (await fetch(endpoint + '/events?limit=5&cursor=' + page.nextCursor)).json();
      expect(older.events.at(-1).sequence).toBeLessThan(page.events[0].sequence);
      const warning = await (await fetch(endpoint + '/events?level=WARN&q=Archived')).json();
      expect(warning.events).toHaveLength(1);
      for (const file of ['events', 'console', 'errors', 'session']) {
        const response = await fetch(endpoint + '/download?file=' + file);
        expect(response.ok).toBe(true);
        expect(response.headers.get('content-disposition')).toContain('attachment');
        expect(await response.text()).not.toContain(secret);
      }
      expect((await fetch(endpoint + '/events', { headers: { origin: 'https://hostile.example' } })).status).toBe(403);
      expect((await fetch(endpoint + '/download?file=../../.env')).status).toBe(400);
      expect((await fetch(endpoint + '/events?limit=50000')).status).toBe(400);
      expect((await fetch(endpoint + '/events?cursor=arbitrary')).status).toBe(400);
      expect((await fetch(endpoint, { method: 'POST' })).status).toBe(405);
    } finally {
      client.terminate(); built.desk.stop(); await new Promise<void>(resolve => built.server.close(() => resolve()));
      await logger.finish('CLEAN_SHUTDOWN', 'fixture complete');
    }
  });

  it('correlates ordinary fills, partial fills, rejections and reconciliation without changing orders on logger failure', async () => {
    const run = async (logger: SessionLogger | null) => {
      setSessionLogger(logger);
      const adapter = new MemoryAdapter(), executor = new LiveExecutor(adapter, 0);
      const originalRead = adapter.getOrder.bind(adapter);
      vi.spyOn(adapter, 'getOrder').mockImplementation(async (symbol, id) => {
        const record = await originalRead(symbol, id);
        if (record.orderId === 'c1') return { ...record, status: 'partial' as const, filledQty: record.filledQty / 2 };
        if (adapter.failPlace && record.status === 'unknown') return { ...record, status: 'rejected' as const };
        return record;
      });
      const order = { symbol: 'BTCUSDT', side: 'LONG' as const, qty: 2, stop: 90, tp: 120, leverage: 2 };
      const first = await executor.open(order);
      const partial = await executor.close('BTCUSDT', 'LONG', 2, first.clientId);
      await executor.refreshPending();
      adapter.failPlace = true;
      const rejected = await executor.open({ ...order, symbol: 'ETHUSDT' });
      return { first, partial, rejected, sends: adapter.placed.length, closes: adapter.closes };
    };
    const baseline = await run(null);
    const root = await temp(), logger = await SessionLogger.start({ root, fallback: () => {} });
    const observed = await run(logger);
    await logger.flush();
    expect(observed.partial.qty).toBe(1);
    expect(observed.rejected.record?.status).toBe('rejected');
    expect({ filled: observed.first.qty, partial: observed.partial.qty, rejected: observed.rejected.ok, sends: observed.sends, closes: observed.closes }).toEqual({ filled: baseline.first.qty, partial: baseline.partial.qty, rejected: baseline.rejected.ok, sends: baseline.sends, closes: baseline.closes });
    const events = (await readSessionEvents(root, logger.session.sessionId, { correlationId: observed.partial.clientId })).events;
    expect(events.map(event => event.eventName)).toEqual(expect.arrayContaining(['order.intent', 'order.submission', 'order.reconciled', 'order.pending_reconciled']));
    expect(events.every(event => event.correlationId === observed.partial.clientId)).toBe(true);
    await rm(logger.directory, { recursive: true });
    const faulted = await run(logger);
    await logger.flush();
    expect([faulted.first.qty, faulted.partial.qty, faulted.rejected.ok, faulted.sends, faulted.closes]).toEqual([baseline.first.qty, baseline.partial.qty, baseline.rejected.ok, baseline.sends, baseline.closes]);
    expect(logger.session.storageErrors).toBeGreaterThan(0);
    await logger.finish('CLEAN_SHUTDOWN', 'fixture');
  });

  it('rejects a directory junction escaping the diagnostic root', async () => {
    const root = await temp(), outside = await temp(), logger = await SessionLogger.start({ root });
    await logger.finish('CLEAN_SHUTDOWN', 'fixture');
    const id = `mpu-2026-01-01T000000000Z-00000000-0000-0000-0000-000000000000`;
    await mkdir(path.join(root, '2026-01-01'));
    await symlink(outside, path.join(root, '2026-01-01', id), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(readSessionEvents(root, id, {})).rejects.toThrow('Invalid session path');
  });
});
