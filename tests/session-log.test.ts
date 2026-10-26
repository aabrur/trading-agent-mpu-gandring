import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SessionLogger, listSessions, readSessionEvents, readSession, sanitizeDiagnostic, setSessionLogger, recordDiagnostic, registerDiagnosticSecrets } from '../server/session-log.js';
import { registerSecrets } from '../server/redact.js';

const roots: string[] = [];
async function root() { const dir = await mkdtemp(path.join(os.tmpdir(), 'mpu-session-test-')); roots.push(dir); return dir; }
afterEach(async () => { setSessionLogger(null); vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('persistent diagnostic sessions', () => {
  it('creates distinct durable sessions, writes a clean outcome and retains earlier runs', async () => {
    const dir = await root();
    const first = await SessionLogger.start({ root: dir, entrypoint: 'fixture', version: '0.4.0' });
    first.write({ source: 'fixture', eventName: 'ready', message: 'Service ready' });
    await first.finish('CLEAN_SHUTDOWN', 'fixture complete');
    const second = await SessionLogger.start({ root: dir, entrypoint: 'fixture' });
    expect(second.session.sessionId).not.toBe(first.session.sessionId);
    const saved = await readSession(dir, first.session.sessionId);
    expect(saved).toMatchObject({ outcome: 'CLEAN_SHUTDOWN', exitReason: 'fixture complete', durationMs: expect.any(Number) });
    expect((await readSessionEvents(dir, first.session.sessionId, {})).events.map(e => e.eventName)).toContain('ready');
    expect((await listSessions(dir, { activeSessionId: second.session.sessionId })).sessions).toHaveLength(2);
    await second.finish('INTERRUPTED', 'test signal');
  });

  it('marks a dead prior session conservatively and leaves a concurrently living session open', async () => {
    const dir = await root();
    const first = await SessionLogger.start({ root: dir });
    await first.flush();
    const metadata = { ...first.session, pid: 99999999 };
    await writeFile(path.join(first.directory, 'session.json'), JSON.stringify(metadata));
    const second = await SessionLogger.start({ root: dir, isProcessAlive: pid => pid === process.pid });
    const recovered = await readSession(dir, first.session.sessionId);
    expect(recovered).toMatchObject({ outcome: 'UNCLEAN_TERMINATION', endedAt: null, unclean: { inferred: true } });
    const third = await SessionLogger.start({ root: dir });
    expect((await readSession(dir, second.session.sessionId)).outcome).toBeNull();
    await Promise.all([first.finish('CLEAN_SHUTDOWN', 'test'), second.finish('CLEAN_SHUTDOWN', 'test'), third.finish('CLEAN_SHUTDOWN', 'test')]);
  });

  it('orders concurrent events, rotates without deleting, searches older content before pagination', async () => {
    const dir = await root();
    const logger = await SessionLogger.start({ root: dir, maxFileBytes: 2048 });
    await Promise.all(Array.from({ length: 80 }, async (_, i) => logger.write({ source: i % 2 ? 'exchange' : 'agent:market', level: i % 2 ? 'WARN' : 'DEBUG', eventName: 'sample', message: `needle-${i}`, correlationId: 'decision-1', details: { retry: i } })));
    await logger.flush();
    const page = await readSessionEvents(dir, logger.session.sessionId, { q: 'needle', limit: 7, source: 'exchange', level: 'WARN', correlationId: 'decision-1' });
    expect(page.events).toHaveLength(7);
    expect(page.events.every(e => e.level === 'WARN' && e.source === 'exchange')).toBe(true);
    expect(page.events.map(e => e.sequence)).toEqual([...page.events.map(e => e.sequence)].sort((a, b) => a - b));
    expect(page.nextCursor).not.toBeNull();
    const older = await readSessionEvents(dir, logger.session.sessionId, { q: 'needle', limit: 7, cursor: page.nextCursor! });
    expect(older.events.at(-1)!.sequence).toBeLessThan(page.events[0].sequence);
    expect((await readdir(logger.directory)).filter(name => /^events/.test(name)).length).toBeGreaterThan(1);
    await logger.finish('CLEAN_SHUTDOWN', 'test');
  });

  it('sanitizes before disk, including errors and nested secret fields, without recording bodies or prompts', async () => {
    const dir = await root(), secret = 'fixture-session-sensitive-value';
    registerSecrets([secret]);
    const logger = await SessionLogger.start({ root: dir });
    logger.write({ source: 'exchange', eventName: 'failed', level: 'ERROR', message: `Failed ${secret}`, details: { error: Object.assign(new Error(`timeout ${secret}`), { code: 'ETIMEDOUT' }), authorization: 'short', body: { owner: 'private-body' }, prompt: 'private-prompt', nested: { apiKey: secret } } });
    await logger.finish('RUNTIME_ERROR', 'fixture');
    const disk = await readFile(path.join(logger.directory, 'events.jsonl'), 'utf8');
    expect(disk).not.toContain(secret);
    expect(disk).not.toContain('private-body');
    expect(disk).not.toContain('private-prompt');
    expect(disk).toContain('ETIMEDOUT');
    expect(disk).toContain('stack');
    expect(JSON.stringify(sanitizeDiagnostic({ circular: undefined, amount: 1n }))).toContain('1');
  });

  it('absorbs storage failure and queue saturation without throwing into a caller', async () => {
    const dir = await root(), fallback = vi.fn();
    const logger = await SessionLogger.start({ root: dir, maxQueueBytes: 2048, fallback });
    setSessionLogger(logger);
    for (let i = 0; i < 100; i++) expect(() => recordDiagnostic({ source: 'test', eventName: 'volume', message: 'x'.repeat(1000) })).not.toThrow();
    await logger.flush();
    expect(logger.session.droppedEvents).toBeGreaterThan(0);
    expect(fallback).toHaveBeenCalled();
    await rm(logger.directory, { recursive: true });
    expect(() => logger.write({ source: 'test', eventName: 'storage', message: 'still trading' })).not.toThrow();
    await logger.flush();
    expect(logger.session.storageErrors).toBeGreaterThan(0);
    await logger.finish('CLEAN_SHUTDOWN', 'test');
  });

  it('rejects arbitrary paths and invalid cursors', async () => {
    const dir = await root(), logger = await SessionLogger.start({ root: dir });
    await expect(readSession(dir, '../.env')).rejects.toThrow();
    await expect(readSessionEvents(dir, logger.session.sessionId, { cursor: '../.env' })).rejects.toThrow();
    await logger.finish('CLEAN_SHUTDOWN', 'test');
  });

  it('bounds large-volume pages, skips corrupt lines and registers credentials loaded after bootstrap', async () => {
    const dir = await root(), logger = await SessionLogger.start({ root: dir, maxFileBytes: 65536 });
    for (let i = 0; i < 6000; i++) logger.write({ source: 'volume', eventName: 'volume.sample', message: `event ${i}` });
    const secret = 'fixture-late-environment-credential';
    registerDiagnosticSecrets({ VENUE_API_KEY: secret });
    logger.write({ source: 'volume', eventName: 'volume.error', level: 'ERROR', message: `provider failed ${secret}`, details: { error: new Error(secret) } });
    await logger.flush();
    await appendFile(path.join(logger.directory, 'events.jsonl'), '\nnull\n{}\ninvalid-json\n' + 'x'.repeat(200000) + '\n');
    const page = await readSessionEvents(dir, logger.session.sessionId, { source: 'volume', limit: 20 });
    expect(page.events).toHaveLength(20);
    expect(page.nextCursor).not.toBeNull();
    expect(JSON.stringify(page)).not.toContain(secret);
    expect(logger.session.droppedEvents).toBe(0);
    expect(logger.session.lastSequence).toBe(6002);
    expect(logger.session.segments).toBeGreaterThan(1);
    await logger.finish('CLEAN_SHUTDOWN', 'volume fixture');
  });
});
