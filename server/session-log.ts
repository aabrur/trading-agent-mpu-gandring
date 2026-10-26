import { randomUUID, createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { hostname } from 'node:os';
import { createReadStream, writeFileSync, renameSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, lstat, realpath, rename, writeFile, open } from 'node:fs/promises';
import path from 'node:path';
import { safe, registerSecrets } from './redact.js';

export type DiagnosticLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
export type SessionOutcome = 'CLEAN_SHUTDOWN' | 'STARTUP_FAILURE' | 'RUNTIME_ERROR' | 'INTERRUPTED' | 'UNCLEAN_TERMINATION';
export interface DiagnosticInput {
  source: string; eventName: string; message: string; level?: DiagnosticLevel; category?: string;
  status?: string; correlationId?: string | null; durationMs?: number; details?: Record<string, unknown>;
}
export interface SessionEvent extends DiagnosticInput {
  timestamp: string; sessionId: string; sequence: number; level: DiagnosticLevel; category: string;
  status: string; correlationId: string | null; details: Record<string, unknown>;
}
export interface SessionSummary {
  sessionId: string; parentSessionId: string | null; startedAt: string; endedAt: string | null;
  version: string; gitRevision: string | null; pid: number; hostFingerprint: string; entrypoint: string;
  mode: string; appMode: string; exchange: string | null; providers: Record<string, unknown>;
  configFingerprint: string | null; outcome: SessionOutcome | null; exitReason: string | null;
  durationMs: number | null; lastSequence: number; storageErrors: number; droppedEvents: number;
  segments: number; unclean?: { inferred: boolean; detectedAt: string; reason: string };
}
interface SessionOptions {
  root?: string; entrypoint?: string; version?: string; gitRevision?: string | null;
  parentSessionId?: string | null; maxFileBytes?: number; maxQueueBytes?: number;
  fallback?: (message: string) => void; isProcessAlive?: (pid: number) => boolean;
}
export const DEFAULT_SESSION_ROOT = path.resolve('data/logs/sessions');
const SESSION_ID = /^mpu-(\d{4}-\d{2}-\d{2})T\d{9}Z-[a-f0-9-]{36}$/;
const SECRET_FIELD = /authorization|password|passphrase|secret|token|api.?key|private.?key|seed|wallet|address|prompt|request.?body|response.?body|^body$|owner.?message|user.?message/i;
const originalStderr = process.stderr.write.bind(process.stderr);
const diagnosticContext = new AsyncLocalStorage<string>();
export function withDiagnosticContext<T>(correlationId: string, work: () => T): T { return diagnosticContext.run(correlationId, work); }

/** Bound and redact objects before they enter a queue, file, or HTTP response. */
export function sanitizeDiagnostic(value: unknown, depth = 0, seen = new WeakSet<object>(), budget = { chars: 32768, nodes: 500 }): unknown {
  if (--budget.nodes < 0 || budget.chars <= 0) return '[bounded]';
  if (value == null || typeof value === 'boolean') return value ?? null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') { const out = safe(value).slice(0, Math.min(8192, budget.chars)); budget.chars -= out.length; return out; }
  if (typeof value !== 'object') return String(value).slice(0, 100);
  if (depth >= 6 || seen.has(value)) return '[bounded]';
  seen.add(value);
  if (value instanceof Error) {
    return sanitizeDiagnostic({ name: value.name, message: value.message, stack: value.stack, code: 'code' in value ? value.code : undefined, cause: value.cause }, depth + 1, seen, budget);
  }
  if (Array.isArray(value)) return value.slice(0, 40).map(item => sanitizeDiagnostic(item, depth + 1, seen, budget));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 60)) out[safe(key).slice(0, 100)] = SECRET_FIELD.test(key) ? '[REDACTED]' : sanitizeDiagnostic(item, depth + 1, seen, budget);
  return out;
}
const text = (value: unknown, max = 8192) => safe(String(value ?? '')).slice(0, max);
const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');
const hostFingerprint = () => fingerprint(hostname());
export function registerDiagnosticSecrets(env: NodeJS.ProcessEnv) {
  for (const [key, value] of Object.entries(env)) if (SECRET_FIELD.test(key)) registerSecrets([value]);
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
async function atomicMetadata(directory: string, session: SessionSummary) {
  const tmp = path.join(directory, `session.${randomUUID()}.tmp`);
  await writeFile(tmp, JSON.stringify(sanitizeDiagnostic(session), null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, path.join(directory, 'session.json'));
}

export class SessionLogger {
  readonly root: string;
  readonly directory: string;
  readonly session: SessionSummary;
  private queue: { event: SessionEvent; bytes: number }[] = [];
  private queueBytes = 0;
  private sequence = 0;
  private writer: Promise<void> | null = null;
  private scheduled = false;
  private closed = false;
  private finishPromise: Promise<void> | null = null;
  private bytes = 0;
  private segment = 0;
  private lastFallback = 0;
  private droppedSinceDrain = 0;
  private inFlight: SessionEvent[] = [];
  runtimeReady = false;
  private constructor(private options: SessionOptions) {
    this.root = path.resolve(options.root ?? process.env.MPU_LOG_ROOT ?? DEFAULT_SESSION_ROOT);
    const now = new Date().toISOString();
    const sessionId = `mpu-${now.slice(0, 10)}T${now.slice(11, 23).replace(/[:.]/g, '')}Z-${randomUUID()}`;
    this.directory = path.join(this.root, now.slice(0, 10), sessionId);
    this.session = { sessionId, parentSessionId: options.parentSessionId ?? null, startedAt: now, endedAt: null,
      version: options.version ?? 'unknown', gitRevision: options.gitRevision ?? null, pid: process.pid,
      hostFingerprint: hostFingerprint(), entrypoint: text(options.entrypoint ?? 'application', 120),
      mode: 'UNKNOWN', appMode: 'UNKNOWN', exchange: null, providers: {}, configFingerprint: null,
      outcome: null, exitReason: null, durationMs: null, lastSequence: 0, storageErrors: 0, droppedEvents: 0, segments: 1 };
  }
  static async start(options: SessionOptions = {}) {
    const logger = new SessionLogger(options);
    registerDiagnosticSecrets(process.env);
    try {
      await mkdir(logger.directory, { recursive: true, mode: 0o700 });
      await Promise.all(['events.jsonl', 'console.log', 'errors.log'].map(file => writeFile(path.join(logger.directory, file), '', { flag: 'wx', mode: 0o600 })));
      await atomicMetadata(logger.directory, logger.session);
      await logger.recoverAbandoned();
    } catch (error) { logger.failure(error); }
    logger.write({ source: 'session', category: 'SESSION', eventName: 'session.start', status: 'started', message: 'Application startup' });
    await logger.flush();
    return logger;
  }
  private failure(error: unknown) {
    this.session.storageErrors++;
    if (Date.now() - this.lastFallback < 1000) return;
    this.lastFallback = Date.now();
    try { (this.options.fallback ?? (message => { originalStderr(message + '\n'); }))(`[session-log] diagnostic storage unavailable: ${text(error instanceof Error ? error.message : error, 500)}`); } catch { /* Diagnostic fallback cannot affect execution. */ }
  }
  private async recoverAbandoned() {
    const isAlive = this.options.isProcessAlive ?? alive;
    for await (const item of sessionDirectories(this.root)) {
      if (item.sessionId === this.session.sessionId) continue;
      try {
        const previous = await readSession(this.root, item.sessionId);
        if (previous.outcome || previous.hostFingerprint !== this.session.hostFingerprint || isAlive(previous.pid)) continue;
        // No shutdown time or event is invented. A subsequent observer records this inference.
        previous.outcome = 'UNCLEAN_TERMINATION';
        previous.unclean = { inferred: true, detectedAt: new Date().toISOString(), reason: 'No terminal metadata and the recorded process is no longer present' };
        previous.exitReason = 'Inferred on subsequent startup; actual exit time and cause unknown';
        await atomicMetadata(item.directory, previous);
        this.write({ source: 'session', category: 'SESSION', level: 'WARN', eventName: 'session.unclean_detected', status: 'inferred', message: 'An earlier session has no verified shutdown', details: { previousSessionId: previous.sessionId } });
      } catch (error) { this.failure(error); }
    }
  }
  updateContext(context: { mode?: string; appMode?: string; exchange?: string | null; providers?: Record<string, unknown>; configFingerprint?: string }) {
    try {
      if (context.mode) this.session.mode = text(context.mode, 30);
      if (context.appMode) this.session.appMode = text(context.appMode, 30);
      if (context.exchange !== undefined) this.session.exchange = context.exchange ? text(context.exchange, 60) : null;
      if (context.providers) this.session.providers = sanitizeDiagnostic(context.providers) as Record<string, unknown>;
      if (context.configFingerprint) this.session.configFingerprint = text(context.configFingerprint, 64);
      this.write({ source: 'session', category: 'CONFIG', eventName: 'configuration.loaded', message: 'Application configuration loaded', details: { mode: this.session.mode, appMode: this.session.appMode, exchange: this.session.exchange, providers: this.session.providers } });
    } catch (error) { this.failure(error); }
  }
  write(input: DiagnosticInput): SessionEvent | undefined {
    if (this.closed) return;
    try {
      if (input.eventName === 'service.ready') this.runtimeReady = true;
      const event: SessionEvent = { timestamp: new Date().toISOString(), sessionId: this.session.sessionId, sequence: ++this.sequence,
        level: input.level ?? 'INFO', category: text(input.category ?? input.source.split(':')[0].toUpperCase(), 60),
        source: text(input.source, 120), eventName: text(input.eventName, 120), status: text(input.status ?? 'observed', 80),
        message: text(input.message), correlationId: input.correlationId || diagnosticContext.getStore() ? text(input.correlationId || diagnosticContext.getStore(), 180) : null,
        ...(Number.isFinite(input.durationMs) ? { durationMs: input.durationMs } : {}), details: sanitizeDiagnostic(input.details ?? {}) as Record<string, unknown> };
      const bytes = Buffer.byteLength(JSON.stringify(event)) + 1;
      if (this.queueBytes + bytes > (this.options.maxQueueBytes ?? 8 * 1024 * 1024)) {
        this.session.droppedEvents++; this.droppedSinceDrain++;
        this.failure(new Error('Diagnostic queue saturated; events were not persisted'));
        this.schedule(); return;
      }
      this.queue.push({ event, bytes }); this.queueBytes += bytes; this.schedule(); return event;
    } catch (error) { this.failure(error); return; }
  }
  private schedule() {
    if (this.scheduled || this.writer) return;
    this.scheduled = true;
    setImmediate(() => { this.scheduled = false; void this.drain(); });
  }
  private filename(kind: 'events' | 'console' | 'errors') {
    const suffix = this.segment ? `.${String(this.segment).padStart(5, '0')}` : '';
    return path.join(this.directory, `${kind}${suffix}.${kind === 'events' ? 'jsonl' : 'log'}`);
  }
  private drain(): Promise<void> {
    if (this.writer) return this.writer;
    this.writer = (async () => {
      while (this.queue.length) {
        const batch = this.queue.splice(0, 64);
        this.inFlight = batch.map(item => item.event);
        this.queueBytes -= batch.reduce((sum, item) => sum + item.bytes, 0);
        while (batch.length) {
          const group: SessionEvent[] = [];
          let groupBytes = 0;
          const maxBytes = this.options.maxFileBytes ?? 16 * 1024 * 1024;
          if (this.bytes && this.bytes + batch[0].bytes > maxBytes) { this.segment++; this.bytes = 0; this.session.segments = this.segment + 1; }
          while (batch.length && (!group.length || this.bytes + groupBytes + batch[0].bytes <= maxBytes)) {
            const item = batch.shift()!; group.push(item.event); groupBytes += item.bytes;
          }
          const line = (event: SessionEvent) => `${event.timestamp} [${event.level}] [${event.category}] session=${event.sessionId} seq=${event.sequence} source=${event.source}${event.correlationId ? ` correlation=${event.correlationId}` : ''} ${event.message.replace(/[\r\n]/g, ' ')}${event.level === 'ERROR' && event.details.error ? ` ${JSON.stringify(event.details.error)}` : ''}\n`;
          let sourcePersisted = false;
          try {
            await appendFile(this.filename('events'), group.map(event => JSON.stringify(event) + '\n').join(''), { mode: 0o600 });
            sourcePersisted = true;
            this.session.lastSequence = group.at(-1)!.sequence; this.bytes += groupBytes;
            this.inFlight = this.inFlight.filter(event => event.sequence > this.session.lastSequence);
            await appendFile(this.filename('console'), group.map(line).join(''), { mode: 0o600 });
            const errors = group.filter(event => event.level === 'WARN' || event.level === 'ERROR');
            if (errors.length) await appendFile(this.filename('errors'), errors.map(line).join(''), { mode: 0o600 });
          } catch (error) {
            if (!sourcePersisted) this.session.droppedEvents += group.length;
            this.failure(error);
          }
        }
        this.inFlight = [];
        if (this.droppedSinceDrain) {
          const count = this.droppedSinceDrain; this.droppedSinceDrain = 0;
          this.write({ source: 'session', level: 'WARN', eventName: 'logging.events_lost', status: 'degraded', message: `${count} diagnostic events could not be queued`, details: { count } });
        }
      }
      try { await atomicMetadata(this.directory, this.session); } catch (error) { this.failure(error); }
    })().finally(() => { this.writer = null; if (this.queue.length) this.schedule(); });
    return this.writer;
  }
  async flush() {
    do { await this.drain(); } while (this.queue.length || this.writer);
  }
  /** Only process exit/fatal paths use synchronous I/O; never called by execution. */
  finishSync(outcome: SessionOutcome, reason: string) {
    if (this.session.outcome && !this.queue.length && !this.inFlight.length) return;
    try {
      this.closed = true;
      const pending = [...this.inFlight, ...this.queue.map(item => item.event)].filter(event => event.sequence > this.session.lastSequence);
      const terminal: SessionEvent = { timestamp: new Date().toISOString(), sessionId: this.session.sessionId, sequence: ++this.sequence, source: 'session', category: 'SESSION', level: outcome === 'CLEAN_SHUTDOWN' ? 'INFO' : 'ERROR', eventName: 'session.end', status: outcome, message: text(reason), correlationId: null, details: { outcome, exitFlush: true } };
      pending.push(terminal);
      // A separate tail avoids racing an append already submitted to the OS.
      writeFileSync(path.join(this.directory, 'events.99999.jsonl'), pending.map(event => JSON.stringify(event)).join('\n') + '\n', { mode: 0o600 });
      const transcript = pending.map(event => `${event.timestamp} [${event.level}] [${event.category}] session=${event.sessionId} seq=${event.sequence} ${event.message}${event.details.error ? ` ${JSON.stringify(event.details.error)}` : ''}`).join('\n') + '\n';
      writeFileSync(path.join(this.directory, 'console.99999.log'), transcript, { mode: 0o600 });
      writeFileSync(path.join(this.directory, 'errors.99999.log'), pending.filter(event => event.level === 'WARN' || event.level === 'ERROR').map(event => `${event.timestamp} [${event.level}] ${event.message} ${JSON.stringify(event.details)}`).join('\n'), { mode: 0o600 });
      this.session.outcome = outcome; this.session.exitReason = text(reason); this.session.endedAt = terminal.timestamp;
      this.session.durationMs = Date.parse(terminal.timestamp) - Date.parse(this.session.startedAt);
      this.session.lastSequence = terminal.sequence;
      const tmp = path.join(this.directory, 'session.exit.tmp');
      writeFileSync(tmp, JSON.stringify(sanitizeDiagnostic(this.session), null, 2) + '\n', { mode: 0o600 });
      renameSync(tmp, path.join(this.directory, 'session.json'));
    } catch (error) { this.failure(error); }
  }
  finish(outcome: SessionOutcome, reason: string): Promise<void> {
    if (this.finishPromise) return this.finishPromise;
    this.write({ source: 'session', category: 'SESSION', eventName: 'session.end', level: outcome === 'CLEAN_SHUTDOWN' ? 'INFO' : 'WARN', status: outcome, message: text(reason), details: { outcome } });
    this.closed = true;
    this.session.endedAt = new Date().toISOString(); this.session.outcome = outcome;
    this.session.exitReason = text(reason); this.session.durationMs = Date.parse(this.session.endedAt) - Date.parse(this.session.startedAt);
    this.finishPromise = (async () => {
      await this.flush();
      // Normal shutdown explicitly flushes the persisted diagnostic source to the filesystem.
      for (let segment = 0; segment <= this.segment; segment++) {
        const suffix = segment ? `.${String(segment).padStart(5, '0')}` : '';
        try { const file = await open(path.join(this.directory, `events${suffix}.jsonl`), 'r+'); try { await file.sync(); } finally { await file.close(); } } catch (error) { this.failure(error); }
      }
    })();
    return this.finishPromise;
  }
}

let active: SessionLogger | null = null;
export function setSessionLogger(logger: SessionLogger | null) { active = logger; }
export function getSessionLogger() { return active; }
/** This boundary must never throw into model, market, or execution code. */
export function recordDiagnostic(input: DiagnosticInput) { try { active?.write(input); } catch { /* Observational only. */ } }

async function* sessionDirectories(root: string) {
  let days: string[];
  try { days = (await readdir(root)).filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day)).sort().reverse(); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const day of days) {
    const dayPath = path.join(root, day);
    if (!(await lstat(dayPath)).isDirectory() || (await lstat(dayPath)).isSymbolicLink()) continue;
    for (const sessionId of (await readdir(dayPath)).filter(id => SESSION_ID.test(id)).sort().reverse()) {
      const directory = path.join(dayPath, sessionId), stat = await lstat(directory);
      if (stat.isDirectory() && !stat.isSymbolicLink()) yield { sessionId, directory };
    }
  }
}
export async function sessionDirectory(root: string, sessionId: string) {
  const match = SESSION_ID.exec(sessionId);
  if (!match) throw new Error('Invalid session ID');
  const base = await realpath(root), directory = path.join(base, match[1], sessionId);
  const resolved = await realpath(directory);
  if (resolved !== directory || !resolved.startsWith(base + path.sep)) throw new Error('Invalid session path');
  return directory;
}
export async function readSession(root: string, sessionId: string): Promise<SessionSummary> {
  const directory = await sessionDirectory(root, sessionId), file = path.join(directory, 'session.json');
  if ((await lstat(file)).isSymbolicLink() || (await lstat(file)).size > 128 * 1024) throw new Error('Invalid session metadata');
  const parsed = JSON.parse(await readFile(file, 'utf8')) as SessionSummary;
  if (parsed.sessionId !== sessionId) throw new Error('Invalid session metadata');
  return sanitizeDiagnostic(parsed) as SessionSummary;
}
function decodeCursor(cursor: string, kind: string) {
  if (cursor.length > 512 || !/^[\w-]+$/.test(cursor)) throw new Error('Invalid cursor');
  try { const value = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as Record<string, unknown>; if (value.kind !== kind) throw new Error(); return value; } catch { throw new Error('Invalid cursor'); }
}
const cursorFor = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString('base64url');
export async function listSessions(root: string, opts: { limit?: number; cursor?: string; activeSessionId?: string | null } = {}) {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 50));
  const cursor = opts.cursor ? decodeCursor(opts.cursor, 'sessions') : null;
  const after = cursor?.after;
  if (after != null && (typeof after !== 'string' || !SESSION_ID.test(after))) throw new Error('Invalid cursor');
  let started = !after;
  const sessions: SessionSummary[] = [];
  for await (const item of sessionDirectories(root)) {
    if (!started) { if (item.sessionId === after) started = true; continue; }
    if (sessions.length === limit) return { ok: true, activeSessionId: opts.activeSessionId ?? null, sessions, nextCursor: cursorFor({ kind: 'sessions', after: sessions.at(-1)!.sessionId }) };
    try { sessions.push(await readSession(root, item.sessionId)); } catch { /* Partial/corrupt sessions do not hide other sessions. */ }
  }
  return { ok: true, activeSessionId: opts.activeSessionId ?? null, sessions, nextCursor: null };
}
export async function sessionFiles(root: string, sessionId: string, kind: 'events' | 'console' | 'errors' | 'session') {
  const directory = await sessionDirectory(root, sessionId);
  const matcher = kind === 'session' ? /^session\.json$/ : new RegExp(`^${kind}(?:\\.\\d{5})?\\.${kind === 'events' ? 'jsonl' : 'log'}$`);
  const names = (await readdir(directory)).filter(name => matcher.test(name)).sort((a, b) => {
    const number = (v: string) => Number(v.match(/\.(\d{5})\./)?.[1] ?? 0);
    return number(a) - number(b);
  });
  const files: string[] = [];
  for (const name of names) { const file = path.join(directory, name), stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid session file'); files.push(file); }
  return files;
}
export async function* diagnosticLines(file: string) {
  const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: 64 * 1024 });
  let pending = '', oversized = false;
  try {
    for await (const chunk of stream) {
      for (const [index, part] of String(chunk).split('\n').entries()) {
        if (index) {
          if (!oversized) yield safe(pending.replace(/\r$/, ''));
          pending = ''; oversized = false;
        }
        if (!oversized && pending.length + part.length <= 128 * 1024) pending += part;
        else { pending = ''; oversized = true; }
      }
    }
    if (pending && !oversized) yield safe(pending);
  } finally { stream.destroy(); }
}
export async function readSessionEvents(root: string, sessionId: string, opts: { q?: string; level?: string; source?: string; correlationId?: string; cursor?: string; limit?: number }) {
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
  const cursor = opts.cursor ? decodeCursor(opts.cursor, 'events') : null;
  if (cursor && (cursor.sessionId !== sessionId || !Number.isSafeInteger(cursor.before) || Number(cursor.before) < 1)) throw new Error('Invalid cursor');
  const before = cursor ? Number(cursor.before) : Number.MAX_SAFE_INTEGER, query = opts.q?.toLowerCase();
  const events: SessionEvent[] = [];
  let matches = 0;
  let lastSequence = 0;
  for (const file of await sessionFiles(root, sessionId, 'events')) {
    for await (const line of diagnosticLines(file)) {
      let event: SessionEvent;
      try {
        event = sanitizeDiagnostic(JSON.parse(line)) as SessionEvent;
        if (!event || typeof event !== 'object' || typeof event.source !== 'string' || typeof event.message !== 'string' || !['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(event.level)) continue;
      } catch { continue; }
      if (event.sessionId !== sessionId || !Number.isSafeInteger(event.sequence) || event.sequence >= before) continue;
      if (event.sequence <= lastSequence) continue;
      lastSequence = event.sequence;
      if (opts.level && event.level !== opts.level || opts.source && !event.source.toLowerCase().includes(opts.source.toLowerCase()) || opts.correlationId && event.correlationId !== opts.correlationId) continue;
      if (query && !JSON.stringify(event).toLowerCase().includes(query)) continue;
      matches++; events.push(event); if (events.length > limit) events.shift();
    }
  }
  return { ok: true, events, nextCursor: matches > limit ? cursorFor({ kind: 'events', sessionId, before: events[0].sequence }) : null };
}
