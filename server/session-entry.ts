import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify, formatWithOptions } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { SessionLogger, getSessionLogger, setSessionLogger, sanitizeDiagnostic } from './session-log.js';

let starting: Promise<SessionLogger> | null = null;

export function beginApplicationSession(entrypoint: string, workspace = process.cwd()) {
  const active = getSessionLogger();
  if (active) return Promise.resolve(active);
  if (starting) return starting;
  starting = (async () => {
    let version = 'unknown', revision: string | null = null;
    try { const pkg = JSON.parse(await readFile(path.resolve(workspace, 'package.json'), 'utf8')) as { appVersion?: string; version?: string }; version = pkg.appVersion ?? pkg.version ?? version; } catch { /* Version is optional outside a checkout. */ }
    try { revision = (await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: workspace, timeout: 1000, windowsHide: true })).stdout.trim(); } catch { /* Installed packages need not contain Git metadata. */ }
    const maxBytes = Number(process.env.MPU_LOG_FILE_BYTES), queueBytes = Number(process.env.MPU_LOG_QUEUE_BYTES);
    const logger = await SessionLogger.start({ root: path.resolve(workspace, process.env.MPU_LOG_ROOT ?? 'data/logs/sessions'), entrypoint, version, gitRevision: revision, parentSessionId: process.env.MPU_PARENT_SESSION_ID ?? null,
      ...(Number.isFinite(maxBytes) && maxBytes >= 1024 ? { maxFileBytes: maxBytes } : {}),
      ...(Number.isFinite(queueBytes) && queueBytes >= 1024 ? { maxQueueBytes: queueBytes } : {}) });
    setSessionLogger(logger);
    logger.updateContext({ mode: process.env.TRADING_MODE?.toUpperCase() ?? 'PAPER', appMode: process.env.APP_MODE?.toUpperCase() ?? 'LOCAL', exchange: process.env.EXCHANGE ?? null });
    let terminal = false, fatal = false, interrupted: string | null = null;
    let consoleDepth = 0;
    const pendingStreams = new Map<string, string>();
    const oversizedStreams = new Set<string>();
    const captureLine = (source: string, line: string) => {
      if (!line) return;
      let message = line;
      try { message = JSON.stringify(sanitizeDiagnostic(JSON.parse(line))); } catch { /* Non-JSON output is redacted by the writer. */ }
      logger.write({ source, category: 'CONSOLE', eventName: source === 'stderr' ? 'stderr.line' : 'stdout.line', level: source === 'stderr' ? 'ERROR' : 'INFO', message });
    };
    for (const [source, stream] of [['stdout', process.stdout], ['stderr', process.stderr]] as const) {
      const originalWrite = stream.write.bind(stream);
      stream.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
        if (!consoleDepth) {
          try {
            const parts = (typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')).split('\n');
            for (const [index, part] of parts.entries()) {
              if (index) {
                if (!oversizedStreams.has(source)) captureLine(source, pendingStreams.get(source) ?? '');
                else logger.write({ source, category: 'CONSOLE', eventName: 'console.line_omitted', level: 'WARN', message: 'Oversized console line omitted' });
                pendingStreams.set(source, ''); oversizedStreams.delete(source);
              }
              const pending = pendingStreams.get(source) ?? '';
              if (pending.length + part.length > 32768) { oversizedStreams.add(source); pendingStreams.set(source, ''); }
              else if (!oversizedStreams.has(source)) pendingStreams.set(source, pending + part);
            }
          } catch { /* Native write behavior is always preserved. */ }
        }
        return Reflect.apply(originalWrite, stream, [chunk, ...args]) as boolean;
      }) as typeof stream.write;
    }
    const flushStreamLines = () => { for (const [source, line] of pendingStreams) if (!oversizedStreams.has(source)) captureLine(source, line); pendingStreams.clear(); };
    const outcome = (code: number) => interrupted ? 'INTERRUPTED' as const : fatal || code ? logger.runtimeReady ? 'RUNTIME_ERROR' as const : 'STARTUP_FAILURE' as const : 'CLEAN_SHUTDOWN' as const;
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      const original = console[method].bind(console);
      console[method] = (...args: unknown[]) => {
        try {
          const message = formatWithOptions({ depth: 4, maxArrayLength: 40, maxStringLength: 8192 }, ...args.map(arg => sanitizeDiagnostic(arg)));
          logger.write({ source: `console:${method}`, category: 'CONSOLE', eventName: `console.${method}`, level: method === 'error' ? 'ERROR' : method === 'warn' ? 'WARN' : method === 'debug' ? 'DEBUG' : 'INFO', message });
        } catch { /* Preserve original console behavior even if formatting fails. */ }
        consoleDepth++;
        try { original(...args); } finally { consoleDepth--; }
      };
    }
    process.on('uncaughtExceptionMonitor', error => {
      fatal = true;
      logger.write({ source: 'process', category: 'SESSION', eventName: 'process.uncaught_exception', level: 'ERROR', status: 'failed', message: 'Uncaught exception', details: { error } });
    });
    process.on('warning', warning => logger.write({ source: 'process', level: 'WARN', eventName: 'process.warning', message: warning.message, details: { error: warning } }));
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const handler = () => {
        interrupted = signal;
        logger.write({ source: 'process', category: 'SESSION', eventName: 'process.signal', status: signal, message: `Received ${signal}` });
        // Existing server/supervisor handlers retain ownership of their shutdown flow.
        if (process.listenerCount(signal) > 0) return;
        void logger.finish('INTERRUPTED', signal).finally(() => { process.kill(process.pid, signal); });
      };
      process.once(signal, handler);
    }
    process.on('beforeExit', code => {
      if (terminal) return;
      terminal = true;
      flushStreamLines();
      void logger.finish(outcome(code), interrupted ?? `Process completed with exit code ${code}`);
    });
    process.on('exit', code => {
      flushStreamLines();
      logger.finishSync(outcome(code), interrupted ?? `Process exited with code ${code}`);
    });
    return logger;
  })();
  return starting;
}

export function configurationFingerprint(config: unknown) {
  return createHash('sha256').update(JSON.stringify(sanitizeDiagnostic(config))).digest('hex');
}

export async function runApplicationEntry(entrypoint: string, run: () => Promise<unknown>) {
  const logger = await beginApplicationSession(entrypoint);
  try { await run(); }
  catch (error) {
    logger.write({ source: 'startup', category: 'SESSION', eventName: 'startup.failed', level: 'ERROR', status: 'failed', message: 'Application startup failed', details: { error } });
    await logger.finish('STARTUP_FAILURE', error instanceof Error ? error.message : String(error));
    // Keep the original exception and Node exit semantics, including its stack on stderr.
    throw error;
  }
}
