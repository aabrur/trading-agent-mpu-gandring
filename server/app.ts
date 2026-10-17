import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from './config.js';
import { AGENT_IDS } from './config.js';
import { Desk } from './desk.js';
import { makeCaller, type ModelCaller } from './providers/index.js';
import { moneySplit } from './money.js';
import { safe } from './redact.js';
import { sendToGrokBot } from './bridge.js';
import type { AgentId } from './types.js';

export function createApp(cfg: AppConfig, opts: { caller?: ModelCaller; reportsDir?: string | null; outboxPath?: string } = {}) {
  const desk = new Desk(cfg, opts.caller ?? makeCaller(cfg), { reportsDir: opts.reportsDir === undefined ? 'reports' : opts.reportsDir, outboxPath: opts.outboxPath });
  const app = express();
  app.use(express.json({ limit: '32kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, app: 'trading-agent-mpu-gandring', mode: cfg.tradingMode, marketSource: cfg.marketSource, bridge: cfg.bridge.enabled ? 'on' : 'off',
      agents: Object.fromEntries(AGENT_IDS.map((id) => [id, { provider: cfg.agents[id].provider, model: cfg.agents[id].model, fellBackToMock: cfg.agents[id].fellBackToMock }])) });
  });
  app.get('/api/state', (_req, res) => res.json(desk.snapshot()));
  app.get('/api/split', (req, res) => {
    try {
      res.json(moneySplit({ balance: Number(req.query.balance ?? desk.book.balance), safetyNet: Number(req.query.safetyNet ?? desk.book.safetyNet), n: Number(req.query.n ?? desk.book.n) }));
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  // Starts a debate and waits for the verdict (used by the CLI, scripts and Grok Bot routines).
  app.post('/api/debate', async (req, res) => {
    const symbol = String(req.body?.symbol ?? '').slice(0, 20);
    try { res.json({ ok: true, verdict: await desk.runDebate(symbol) }); }
    catch (e) { res.status(409).json({ ok: false, error: safe((e as Error).message) }); }
  });
  app.post('/api/command', async (req, res) => {
    const text = String(req.body?.text ?? '').slice(0, 500);
    const agent = req.body?.agent as AgentId | undefined;
    if (!text.trim()) return res.status(400).json({ ok: false, error: 'empty command' });
    if (agent && !AGENT_IDS.includes(agent)) return res.status(400).json({ ok: false, error: 'unknown agent' });
    res.json(await desk.command(text, agent));
  });

  // Harmless test event for the Grok Bot bridge. The routine prompt should ignore kind=probe.
  app.post('/api/bridge/probe', async (_req, res) => {
    res.json({ result: await sendToGrokBot(cfg, 'probe', { note: 'bridge probe, ignore' }, opts.outboxPath) });
  });

  // Serve the built UI in production (npm run build && npm start).
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDist = [path.resolve(here, '../../web'), path.resolve(here, '../dist/web'), path.resolve(process.cwd(), 'dist/web')].find((p) => existsSync(path.join(p, 'index.html')));
  if (webDist) {
    app.use(express.static(webDist));
    app.get(/^\/(?!api|ws).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
  }

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  const send = (ws: WebSocket, type: string, payload: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, payload })); };
  const broadcast = (type: string) => (payload: unknown) => { const msg = JSON.stringify({ type, payload }); for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(msg); };
  for (const ev of ['state', 'speech', 'fight', 'meter', 'verdict', 'log', 'status', 'debate']) desk.on(ev, broadcast(ev));
  wss.on('connection', (ws) => {
    send(ws, 'state', desk.snapshot());
    ws.on('message', async (buf) => {
      try {
        const msg = JSON.parse(String(buf).slice(0, 4000));
        if (msg?.type === 'command' && typeof msg.text === 'string') {
          const agent = AGENT_IDS.includes(msg.agent) ? msg.agent : undefined;
          send(ws, 'command_result', await desk.command(msg.text, agent));
        }
      } catch { /* ignore malformed frames */ }
    });
  });
  return { app, server, desk, wss };
}
