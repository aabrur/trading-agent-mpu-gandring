import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SessionLogger, readSessionEvents, setSessionLogger } from '../server/session-log.js';
import { KronosClient } from '../server/market/kronos-client.js';
import { CalibrationTracker } from '../server/decision/calibration.js';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { LiveExecutor } from '../server/live/executor.js';
import { MemoryAdapter } from './fakes.js';

afterEach(() => { setSessionLogger(null); vi.restoreAllMocks(); });

it('correlates forecast fallback and observed calibration without persisting historical inputs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mpu-observer-'));
  const logger = await SessionLogger.start({ root }); setSessionLogger(logger);
  try {
    const client = new KronosClient({ fetchFn: vi.fn().mockRejectedValue(new Error('fixture worker timeout')) });
    const result = await client.predict({ candles: [{ c: 100 }, { c: 101 }, { c: 99 }], numPaths: 10, horizon: 2, seed: 1 });
    expect(result.workerAvailable).toBe(false);
    const tracker = new CalibrationTracker();
    tracker.recordForecast({ id: 'observed-decision', symbol: 'BTCUSDT', timestamp: 1, forecastProbability: 0.6, realizedOutcome: 1, context: 'private research context' });
    await logger.flush();
    const events = (await readSessionEvents(root, logger.session.sessionId, {})).events;
    const requested = events.find(event => event.eventName === 'forecast.requested')!;
    const fallback = events.find(event => event.eventName === 'forecast.fallback')!;
    expect(fallback.correlationId).toBe(requested.correlationId);
    expect(fallback).toMatchObject({ level: 'WARN', status: 'fallback', durationMs: expect.any(Number) });
    expect(events.find(event => event.eventName === 'calibration.recorded')).toMatchObject({ correlationId: 'observed-decision', details: { realizedOutcome: 1 } });
    expect(JSON.stringify(events)).not.toContain('private research context');
    expect(JSON.stringify(events)).not.toContain('candles');
  } finally { setSessionLogger(null); await logger.finish('CLEAN_SHUTDOWN', 'test'); await rm(root, { recursive: true, force: true }); }
});

it('retains existing execution journals and periodic reports independently of diagnostic failures', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mpu-observer-stores-'));
  const logger = await SessionLogger.start({ root: path.join(root, 'logs'), fallback: () => {} }); setSessionLogger(logger);
  const built = createApp(loadConfig({ TRADING_MODE: 'PAPER', DEFAULT_PROVIDER: 'mock', MARKET_SOURCE: 'sample' }), { reportsDir: path.join(root, 'reports'), learningsPath: null, conversationsPath: null, jevEnv: {}, sessionLog: logger });
  try {
    const journalPath = path.join(root, 'execution.json');
    const executor = new LiveExecutor(new MemoryAdapter(), 0, journalPath);
    await executor.open({ symbol: 'BTCUSDT', side: 'LONG', qty: 1, stop: 90, tp: 120, leverage: 2 });
    const journal = await readFile(journalPath, 'utf8');
    const report = await built.reporter.generate();
    const day = new Date(report.at).toISOString().slice(0, 10), stamp = new Date(report.at).toISOString().slice(11, 19).replace(/:/g, '');
    const reportFile = path.join(root, 'reports', day, `report-${stamp}.json`);
    const savedReport = await readFile(reportFile, 'utf8');
    await logger.flush();
    const events = (await readSessionEvents(logger.root, logger.session.sessionId, {})).events;
    expect(events.map(event => event.eventName)).toEqual(expect.arrayContaining(['journal.persisted', 'report.persisted']));
    await rm(logger.directory, { recursive: true });
    logger.write({ source: 'fixture', eventName: 'failure', message: 'diagnostic failure only' });
    await logger.flush();
    expect(await readFile(journalPath, 'utf8')).toBe(journal);
    expect(await readFile(reportFile, 'utf8')).toBe(savedReport);
  } finally { built.desk.stop(); await new Promise<void>(resolve => built.server.close(() => resolve())); setSessionLogger(null); await logger.finish('CLEAN_SHUTDOWN', 'test'); await rm(root, { recursive: true, force: true }); }
});
