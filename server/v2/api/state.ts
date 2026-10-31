import type express from 'express';
import { z } from 'zod';
import {
  DEFAULT_SESSION_ROOT,
  diagnosticLines,
  getSessionLogger,
  listSessions,
  readSession,
  readSessionEvents,
  recordDiagnostic,
  sessionFiles,
  type SessionLogger
} from '../../session-log.js';
import { isLocalLoopbackClient, TIMEFRAMES, type OfficeRuntime } from '../contracts.js';

const clientLogBodySchema = z.object({
  level: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR']).optional(),
  eventName: z.string().max(120).optional(),
  message: z.string().max(4000),
  details: z.record(z.string(), z.unknown()).optional()
}).strict();

const sessionEventsQuerySchema = z.object({
  q: z.string().max(300).optional(),
  level: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR']).optional(),
  source: z.string().max(120).optional(),
  correlationId: z.string().max(180).optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional()
}).strict();

export function mountStateRoutes(
  app: express.Express,
  runtime: OfficeRuntime,
  options: {
    sessionLogger?: SessionLogger | null;
    sessionLogRoot?: string;
    instanceId?: string;
  } = {}
): void {
  const sessionRoot = options.sessionLogRoot ?? options.sessionLogger?.root ?? DEFAULT_SESSION_ROOT;

  app.get('/api/health', (_req, res) => {
    const state = runtime.snapshot();
    res.json({
      ok: true,
      runtimeGeneration: 'v2',
      instanceId: options.instanceId ?? null,
      version: state.version ?? '0.0.0.4.11',
      mode: state.mode,
      appMode: state.appMode,
      venue: state.venue?.name ?? state.live?.exchange ?? null,
      killed: state.killed,
      paused: state.paused,
      runtimeIdentity: state.runtimeIdentity
    });
  });

  app.get('/api/state', (_req, res) => {
    res.json(runtime.snapshot());
  });

  app.get('/api/jev', (_req, res) => {
    const state = runtime.snapshot();
    res.json({
      ok: true,
      jev: state.jev ?? {
        enabled: false,
        provider: 'openrouter',
        model: 'unconfigured',
        mode: 'off',
        health: 'unavailable'
      }
    });
  });

  app.get('/api/split', (_req, res) => {
    const state = runtime.snapshot();
    let balance = state.financial.balance;
    if ((balance.availability === 'UNAVAILABLE' || balance.value === null) && state.mode === 'PAPER' && state.paper.balance > 0) {
      balance = { value: state.paper.balance, availability: 'AVAILABLE' };
    }
    if (balance.availability === 'UNAVAILABLE' || balance.value === null) {
      res.json({
        ok: true,
        availability: 'UNAVAILABLE',
        balance: null,
        safetyNet: state.paper.safetyNet,
        n: state.paper.n,
        moneyTrade: null,
        perOrder: null,
        canOpen: false
      });
      return;
    }
    const safetyNet = state.paper.safetyNet;
    const n = state.paper.n;
    const moneyTrade = Math.max(0, balance.value - safetyNet);
    const perOrder = n > 0 ? Math.floor((moneyTrade / n) * 100) / 100 : 0;
    res.json({
      ok: true,
      availability: 'AVAILABLE',
      balance: balance.value,
      safetyNet,
      n,
      moneyTrade,
      perOrder,
      canOpen: perOrder > 0 && perOrder >= state.paper.minOrderUsdt
    });
  });

  app.get('/api/candles', async (req, res) => {
    const symbol = String(req.query.symbol ?? 'BTCUSDT').trim().toUpperCase();
    const rawTf = String(req.query.tf ?? '15m').trim();
    const tf = (TIMEFRAMES as readonly string[]).includes(rawTf) ? rawTf : '15m';

    const hub = (runtime as any).marketHub;
    if (hub && typeof hub.snapshot === 'function') {
      try {
        let snap = hub.snapshot(symbol);
        let bars = snap.closed?.[tf] ?? [];
        if (bars.length === 0 && typeof hub.bootstrapSymbol === 'function') {
          await hub.bootstrapSymbol(symbol).catch(() => {});
          snap = hub.snapshot(symbol);
          bars = snap.closed?.[tf] ?? [];
        }
        if (bars.length > 0) {
          const candles = bars.map((b: any) => ({
            time: Math.floor(b.startAt / 1000),
            open: Number(b.open),
            high: Number(b.high),
            low: Number(b.low),
            close: Number(b.close),
            volume: Number(b.volume),
            confirmed: true
          }));
          const openBar = snap.open?.[tf];
          if (openBar) {
            candles.push({
              time: Math.floor(openBar.startAt / 1000),
              open: Number(openBar.open),
              high: Number(openBar.high),
              low: Number(openBar.low),
              close: Number(openBar.close),
              volume: Number(openBar.volume),
              confirmed: false
            });
          }
          const last = snap.last?.value !== null ? Number(snap.last.value) : null;
          res.json({
            symbol,
            tf,
            source: 'bybit',
            dataType: 'reference',
            example: false,
            fetchedAt: Date.now(),
            last,
            candles,
            availability: 'AVAILABLE'
          });
          return;
        }
      } catch {
        // Fall back to unavailable response
      }
    }

    res.json({
      symbol,
      tf,
      source: 'bybit_unavailable',
      dataType: 'reference',
      example: false,
      fetchedAt: Date.now(),
      last: null,
      candles: [],
      availability: 'UNAVAILABLE'
    });
  });

  app.post('/api/logs/client', (req, res) => {
    const check = isLocalLoopbackClient({
      remoteAddress: req.socket.remoteAddress,
      hostHeader: req.headers.host,
      origin: req.get('origin')
    });
    if (!check.ok) {
      res.status(403).json({ ok: false, error: check.reason });
      return;
    }
    const parsed = clientLogBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Invalid client diagnostic payload.' });
      return;
    }
    recordDiagnostic({
      source: 'web-client',
      category: 'CLIENT',
      level: parsed.data.level ?? 'INFO',
      eventName: parsed.data.eventName ?? 'client.log',
      message: parsed.data.message,
      details: parsed.data.details
    });
    res.json({ ok: true });
  });

  const rateWindow = new Map<string, { since: number; count: number }>();
  app.use('/api/logs/sessions', (req, res, next) => {
    const check = isLocalLoopbackClient({
      remoteAddress: req.socket.remoteAddress,
      hostHeader: req.headers.host,
      origin: req.get('origin')
    });
    if (!check.ok) {
      res.status(403).json({ ok: false, error: 'Local diagnostic access required.' });
      return;
    }
    if (req.method !== 'GET') {
      res.status(405).json({ ok: false, error: 'Read-only diagnostic endpoint.' });
      return;
    }
    const key = req.socket.remoteAddress ?? 'local';
    const now = Date.now();
    const win = rateWindow.get(key);
    if (!win || now - win.since >= 60_000) {
      rateWindow.set(key, { since: now, count: 1 });
    } else {
      win.count += 1;
      if (win.count > 120) {
        res.status(429).json({ ok: false, error: 'Too many diagnostic requests.' });
        return;
      }
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  app.get('/api/logs/sessions', async (req, res) => {
    const parsed = z.object({
      limit: z.coerce.number().int().min(1).max(100).optional(),
      cursor: z.string().max(512).optional()
    }).strict().safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Invalid session query.' });
      return;
    }
    try {
      const activeSessionId = (options.sessionLogger ?? getSessionLogger())?.session.sessionId ?? null;
      const list = await listSessions(sessionRoot, { ...parsed.data, activeSessionId });
      res.json(list);
    } catch {
      res.status(400).json({ ok: false, error: 'Session list unavailable or invalid cursor.' });
    }
  });

  app.get('/api/logs/sessions/:id/events', async (req, res) => {
    const parsed = sessionEventsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Invalid event query.' });
      return;
    }
    try {
      res.json(await readSessionEvents(sessionRoot, String(req.params.id), parsed.data));
    } catch {
      res.status(400).json({ ok: false, error: 'Session unavailable or invalid cursor.' });
    }
  });

  app.get('/api/logs/sessions/:id/download', async (req, res) => {
    const parsed = z.object({
      file: z.enum(['console', 'errors', 'events', 'session'])
    }).strict().safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Invalid diagnostic file.' });
      return;
    }
    try {
      const sessionId = String(req.params.id);
      const files = await sessionFiles(sessionRoot, sessionId, parsed.data.file);
      await readSession(sessionRoot, sessionId);
      const ext = parsed.data.file === 'session' ? 'json' : parsed.data.file === 'events' ? 'jsonl' : 'log';
      res.setHeader(
        'Content-Type',
        parsed.data.file === 'session' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8'
      );
      res.setHeader('Content-Disposition', `attachment; filename="${sessionId}-${parsed.data.file}.${ext}"`);
      for (const file of files) {
        for await (const line of diagnosticLines(file)) {
          if (res.destroyed) return;
          if (!res.write(`${line}\n`)) {
            await new Promise<void>((resolve) => {
              const finish = () => {
                res.off('drain', finish);
                res.off('close', finish);
                resolve();
              };
              res.once('drain', finish);
              res.once('close', finish);
            });
          }
        }
      }
      res.end();
    } catch {
      if (res.headersSent) res.destroy();
      else res.status(404).json({ ok: false, error: 'Diagnostic session unavailable.' });
    }
  });

  app.get('/api/logs/sessions/:id', async (req, res) => {
    try {
      res.json({ ok: true, session: await readSession(sessionRoot, String(req.params.id)) });
    } catch {
      res.status(404).json({ ok: false, error: 'Diagnostic session unavailable.' });
    }
  });
}
