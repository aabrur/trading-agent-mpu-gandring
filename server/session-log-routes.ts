import type { Express } from 'express';
import { z } from 'zod';
import { localClient } from './setup/routes.js';
import { DEFAULT_SESSION_ROOT, getSessionLogger, listSessions, readSession, readSessionEvents, sessionFiles, diagnosticLines, type SessionLogger } from './session-log.js';

const querySchema = z.object({ q: z.string().max(300).optional(), level: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR']).optional(), source: z.string().max(120).optional(), correlationId: z.string().max(180).optional(), cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).strict();

/** Diagnostic archives expose only fixed files under a validated session, to local clients. */
export function mountSessionLogRoutes(app: Express, opts: { logger?: SessionLogger | null; root?: string } = {}) {
  const root = opts.root ?? opts.logger?.root ?? DEFAULT_SESSION_ROOT;
  const clients = new Map<string, { since: number; count: number }>();
  app.use('/api/logs/sessions', (req, res, next) => {
    if (!localClient({ remoteAddress: req.socket.remoteAddress, hostHeader: req.headers.host, origin: req.get('origin') }).ok) return res.status(403).json({ ok: false, error: 'Local diagnostic access required.' });
    if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Read-only diagnostic endpoint.' });
    const key = req.socket.remoteAddress ?? 'local', now = Date.now();
    const state = clients.get(key);
    if (!state || now - state.since >= 60_000) clients.set(key, { since: now, count: 1 });
    else if (++state.count > 120) return res.status(429).json({ ok: false, error: 'Too many diagnostic requests.' });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.get('/api/logs/sessions', async (req, res) => {
    const parsed = z.object({ limit: z.coerce.number().int().min(1).max(100).optional(), cursor: z.string().max(512).optional() }).strict().safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ ok: false, error: 'Invalid session query.' });
    try { res.json(await listSessions(root, { ...parsed.data, activeSessionId: (opts.logger ?? getSessionLogger())?.session.sessionId ?? null })); }
    catch { res.status(400).json({ ok: false, error: 'Session list unavailable or invalid cursor.' }); }
  });
  app.get('/api/logs/sessions/:id/events', async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ ok: false, error: 'Invalid event query.' });
    try { res.json(await readSessionEvents(root, String(req.params.id), parsed.data)); }
    catch { res.status(400).json({ ok: false, error: 'Session unavailable or invalid cursor.' }); }
  });
  app.get('/api/logs/sessions/:id/download', async (req, res) => {
    const parsed = z.object({ file: z.enum(['console', 'errors', 'events', 'session']) }).strict().safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ ok: false, error: 'Invalid diagnostic file.' });
    try {
      const sessionId = String(req.params.id);
      const files = await sessionFiles(root, sessionId, parsed.data.file);
      await readSession(root, sessionId);
      res.setHeader('Content-Type', parsed.data.file === 'session' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${sessionId}-${parsed.data.file}.${parsed.data.file === 'session' ? 'json' : parsed.data.file === 'events' ? 'jsonl' : 'log'}"`);
      for (const file of files) {
        for await (const line of diagnosticLines(file)) {
          if (res.destroyed) return;
          if (!res.write(line + '\n')) await new Promise<void>(resolve => {
            const finish = () => { res.off('drain', finish); res.off('close', finish); resolve(); };
            res.once('drain', finish); res.once('close', finish);
          });
        }
      }
      res.end();
    } catch {
      if (res.headersSent) res.destroy();
      else res.status(404).json({ ok: false, error: 'Diagnostic session unavailable.' });
    }
  });
  app.get('/api/logs/sessions/:id', async (req, res) => {
    try { res.json({ ok: true, session: await readSession(root, String(req.params.id)) }); }
    catch { res.status(404).json({ ok: false, error: 'Diagnostic session unavailable.' }); }
  });
}
