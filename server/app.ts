import express from 'express';
import { onActivity } from './activity.js';
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
import { getSnapshot } from './market/index.js';
import { normSymbol } from './commands.js';
import type { AgentId } from './types.js';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { sanitizeUntrusted } from './untrusted.js';
import type { LiveExecutor } from './live/executor.js';
import { AutoTrader } from './auto.js';
import { Reporter } from './reports.js';
import { mountResearchRoutes } from './research/routes.js';
import { WalletConnector, walletAccess, walletInfo, findSecretLike } from './wallet.js';
import { EXCHANGES, ADAPTER_STATUS, type ExchangeName, type Network } from './exchange/index.js';
import { mountSetupRoutes, mountOpsRoutes, localClient } from './setup/routes.js';
import { DeskLead } from './channels/supervisor.js';
import { createInboundApp, mountChannelSetupRoutes } from './channels/routes.js';
import { APP_VERSION, checkUpdate, applyUpdate } from './updater.js';

const sameSecret = (given: string, want: string) => {
  const a = Buffer.from(given), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
};
/** Tiny fixed-window limiter, per key. */
function limiter(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; at: number }>();
  return (key: string) => {
    const now = Date.now(), h = hits.get(key);
    if (!h || now - h.at > windowMs) { hits.set(key, { n: 1, at: now }); return true; }
    h.n++; return h.n <= max;
  };
}
const AGENTS = ['lead', 'market', 'research', 'strategist', 'risk', 'execution'] as const;
const AgentEventSchema = z.object({
  agent: z.enum(AGENTS),
  kind: z.enum(['say', 'status', 'proposal']),
  text: z.string().max(600).optional(),
  stance: z.enum(['LONG', 'SHORT', 'NEUTRAL']).optional(),
  confidence: z.number().min(0).max(1).optional(),
  status: z.enum(['idle', 'reading', 'thinking', 'typing', 'arguing', 'fighting', 'executing', 'journaling']).optional(),
  target: z.enum(AGENTS).optional(),
  symbol: z.string().max(20).optional(),
  action: z.enum(['OPEN_LONG', 'OPEN_SHORT', 'CLOSE', 'HOLD']).optional(),
  stop: z.number().positive().optional(), tp: z.number().positive().optional()
}).strict();
const TradingViewSchema = z.object({
  passphrase: z.string().max(200),
  symbol: z.string().min(2).max(40),
  action: z.string().max(20),
  price: z.union([z.number(), z.string()]).optional(),
  note: z.string().max(500).optional()
});

/** Grok Bot mode has no model provider at all: the Grok Bot agents are the brains. */
export const noModelCaller: ModelCaller = async () => { throw new Error('no model calls in Grok Bot mode'); };

const GbOpenSchema = z.object({
  symbol: z.string().min(2).max(20), side: z.enum(['LONG', 'SHORT']),
  stop: z.number().positive().optional(), tp: z.number().positive().optional(), leverage: z.number().positive().max(100).optional(),
  agent: z.enum(AGENTS).optional(), confidence: z.number().min(0).max(1).optional(), reason: z.string().max(300).optional()
}).strict();
const GbLessonSchema = z.object({
  role: z.enum([...AGENTS, 'desk']), kind: z.enum(['loss', 'stop', 'error', 'scan', 'correction', 'review', 'note']).default('note'),
  symbol: z.string().max(20).optional(), happened: z.string().max(400).default(''), rootCause: z.string().max(300).default(''), lesson: z.string().min(8).max(300)
}).strict();

export function createApp(cfg: AppConfig, opts: { caller?: ModelCaller; reportsDir?: string | null; outboxPath?: string; executor?: LiveExecutor | null; learningsPath?: string | null; conversationsPath?: string | null; envFile?: string; wallet?: WalletConnector; killFile?: string | null; setupFetch?: typeof fetch; channelFetch?: typeof fetch; jevFetch?: typeof fetch; jevEnv?: NodeJS.ProcessEnv } = {}) {
  const caller = opts.caller ?? (cfg.appMode === 'grokbot' ? noModelCaller : makeCaller(cfg));
  const desk = new Desk(cfg, caller, { settingsFile: opts.envFile ?? (process.env.VITEST ? undefined : process.env.DOTENV_PATH ?? '.env'), opportunityReviewsPath: opts.reportsDir === null ? null : undefined, reportsDir: opts.reportsDir === undefined ? 'reports' : opts.reportsDir, outboxPath: opts.outboxPath, executor: opts.executor ?? null, learningsPath: opts.learningsPath, conversationsPath: opts.conversationsPath, killFile: opts.killFile ?? null, jevFetch: opts.jevFetch, jevEnv: opts.jevEnv });
  const auto = new AutoTrader(desk);
  const reporter = new Reporter(desk, opts.reportsDir === undefined ? 'reports' : opts.reportsDir, opts.outboxPath);
  const app = express();
  const unsubscribeActivity = onActivity(entry => desk.recordActivity(entry));
  const frontendLogLimit = limiter(30, 60_000);
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      if (!req.path.startsWith('/api/') || req.path === '/api/logs/client') return;
      if (res.statusCode >= 400 || req.method !== 'GET' || req.path === '/api/research') desk.recordActivity({
        kind: 'backend', source: 'http', level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
        text: `${req.method} ${req.path} · HTTP ${res.statusCode}`, status: String(res.statusCode), durationMs: Date.now() - started,
      });
    });
    next();
  });
  app.use('/api/command', express.json({ limit: '256kb' }));
  app.use(express.json({ limit: '32kb' }));
  app.post('/api/logs/client', (req, res) => {
    const access = localClient({ remoteAddress: req.socket.remoteAddress, hostHeader: req.headers.host, origin: req.get('origin') });
    if (!access.ok) return res.status(403).json({ ok: false });
    if (!frontendLogLimit(req.socket.remoteAddress || '')) return res.status(429).json({ ok: false });
    const parsed = z.object({ message: z.string().min(1).max(1000), level: z.enum(['error', 'warn']), event: z.enum(['error', 'unhandledrejection', 'websocket', 'request']) }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false });
    desk.recordActivity({ kind: 'frontend', source: `browser:${parsed.data.event}`, level: parsed.data.level, text: parsed.data.message, status: 'reported' });
    res.json({ ok: true });
  });

  app.get('/api/health', (_req, res) => {
    const fellBackAgents = cfg.appMode !== 'grokbot' ? AGENT_IDS.filter((id) => cfg.agents[id].fellBackToMock) : [];
    res.json({
      ok: true, app: 'trading-agent-mpu-gandring', version: APP_VERSION, mode: cfg.tradingMode, appMode: cfg.appMode,
      exchange: cfg.live?.exchange ?? cfg.exchange.name,
      killed: desk.killed,
      tradingviewWebhook: cfg.tradingview.webhookEnabled ? 'on' : 'off',
      agentEvents: cfg.agentEvents.enabled ? 'on' : 'off',
      marketSource: cfg.marketSource,
      bridge: cfg.bridge.enabled ? 'on' : 'off',
      agents: Object.fromEntries(AGENT_IDS.map((id) => [id, cfg.appMode === 'grokbot' ? { provider: 'grokbot', model: 'Grok Bot agent', fellBackToMock: false } : { provider: cfg.agents[id].provider, model: cfg.agents[id].model, fellBackToMock: cfg.agents[id].fellBackToMock }])),
      providers: {
        warnings: fellBackAgents.length ? `Agents falling back to mock: ${fellBackAgents.join(', ')}` : null,
        states: Object.fromEntries(AGENT_IDS.map((id) => {
          const a = cfg.agents[id];
          return [id, {
            provider: a.provider,
            model: a.model,
            fellBackToMock: a.fellBackToMock,
            status: a.provider === 'mock' ? (a.fellBackToMock ? 'FELL_BACK_TO_MOCK' : 'MOCK_SELECTED') : (a.provider === 'local' ? 'LOCAL_ACCOUNT' : 'CONFIGURED')
          }];
        }))
      }
    });
  });
  app.get('/api/state', (_req, res) => res.json(desk.snapshot()));
  app.get('/api/jev', (_req, res) => res.json({ ok: true, ...desk.jev.status(), lastDecision: desk.jevLast }));
  app.get('/api/conversations', (_req, res) => res.json({ ok: true, conversations: desk.listConversations() }));
  app.post('/api/conversations/new', (req, res) => {
    const access = localClient({ remoteAddress: req.socket.remoteAddress, hostHeader: req.headers.host, origin: req.get('origin') });
    if (!access.ok) return res.status(403).json({ ok: false, error: access.reason });
    const id = `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    res.json({ ok: true, conversationId: id });
  });

  // Self-update adapter: check version status and apply git fast-forward update on localhost.
  app.get('/api/update/status', async (_req, res) => {
    res.json(await checkUpdate(opts.setupFetch ?? fetch));
  });
  app.post('/api/update/apply', (req, res) => {
    const a = walletAccess({ appMode: cfg.appMode, host: cfg.host, remoteAddress: req.socket.remoteAddress, hostHeader: req.headers.host ?? null, origin: (req.headers.origin as string | undefined) ?? null });
    if (!a.ok) return res.status(403).json({ ok: false, error: a.reason });
    res.json(applyUpdate());
  });

  // Connect wallet (EXPERIMENTAL). Local mode, office on 127.0.0.1, loopback clients only. Never accepts a private key or seed.
  const wallet = opts.wallet ?? new WalletConnector({ envFile: opts.envFile ?? process.env.DOTENV_PATH ?? '.env', fetchImpl: opts.setupFetch });
  const walletLimit = limiter(20, 60_000);
  const access = (req: express.Request) => walletAccess({ appMode: cfg.appMode, host: cfg.host, remoteAddress: req.socket.remoteAddress, hostHeader: req.headers.host ?? null, origin: (req.headers.origin as string | undefined) ?? null });
  const WalletStart = z.object({ venue: z.enum(EXCHANGES as unknown as [ExchangeName, ...ExchangeName[]]), network: z.enum(['testnet', 'mainnet']), mainAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/), chainId: z.number().int().positive().max(2 ** 40) }).strict();
  const WalletApprove = z.object({ id: z.string().regex(/^[0-9a-f]{32}$/), signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) }).strict();
  app.get('/api/wallet', (req, res) => {
    const a = access(req);
    res.json({ available: a.ok, reason: a.reason, appMode: cfg.appMode, current: cfg.exchange.name, experimental: true,
      venues: EXCHANGES.map((v) => ({ ...walletInfo(v), status: ADAPTER_STATUS[v] })) });
  });
  app.get('/api/wallet/balance', async (req, res) => {
    const a = access(req); if (!a.ok) return res.status(403).json({ ok: false, error: a.reason });
    const rawVenue = String(req.query.venue ?? cfg.live?.exchange ?? cfg.exchange.name).toLowerCase();
    const venue = (EXCHANGES.includes(rawVenue as ExchangeName) ? rawVenue : cfg.exchange.name) as ExchangeName;
    const network: Network = req.query.network === 'mainnet' || (req.query.network !== 'testnet' && cfg.tradingMode === 'LIVE') ? 'mainnet' : 'testnet';
    const address = typeof req.query.address === 'string' ? req.query.address.slice(0, 120) : undefined;
    res.json(await wallet.readVenueBalance(venue, network, address));
  });
  app.post('/api/wallet/start', (req, res) => {
    const a = access(req); if (!a.ok) return res.status(403).json({ ok: false, error: a.reason });
    if (!walletLimit(req.socket.remoteAddress ?? '')) return res.status(429).json({ ok: false, error: 'slow down' });
    const bad = findSecretLike(req.body); if (bad) return res.status(400).json({ ok: false, error: `refused: the request contains ${bad}. Never paste a private key or seed phrase here.` });
    const p = WalletStart.safeParse(req.body); if (!p.success) return res.status(400).json({ ok: false, error: 'bad request' });
    try { res.json({ ok: true, ...wallet.start(p.data.venue, p.data.network, p.data.mainAddress, p.data.chainId) }); }
    catch (e) { res.status(400).json({ ok: false, error: safe((e as Error).message) }); }
  });
  app.post('/api/wallet/approve', async (req, res) => {
    const a = access(req); if (!a.ok) return res.status(403).json({ ok: false, error: a.reason });
    if (!walletLimit(req.socket.remoteAddress ?? '')) return res.status(429).json({ ok: false, error: 'slow down' });
    const p = WalletApprove.safeParse(req.body); if (!p.success) return res.status(400).json({ ok: false, error: 'bad request (only an approval id and a signature are accepted)' });
    try {
      const out = await wallet.approve(p.data.id, p.data.signature);
      cfg.exchange.name = out.venue;
      desk.emit('state', desk.snapshot());
      res.json(out);
    } catch (e) { res.status(400).json({ ok: false, error: safe((e as Error).message) }); }
  });
  // Setup wizard and Desk ops panel (same shared modules as npm run setup / npm run gb). Localhost only.
  const routeCtx = { cfg, desk, auto, envFile: opts.envFile ?? process.env.DOTENV_PATH ?? '.env', fetchImpl: opts.setupFetch, limiter };
  mountSetupRoutes(app, routeCtx);
  mountResearchRoutes(app, desk);
  mountOpsRoutes(app, routeCtx);
  // Desk Lead supervisor and chat channels. Inbound chat webhooks get their own server (see channels/routes.ts).
  const onKill = () => auto.stop();
  const lead = new DeskLead(desk, cfg.channels, opts.channelFetch ?? fetch, onKill);
  mountChannelSetupRoutes(app, routeCtx);
  const inbound = createInboundApp({ ...routeCtx, fetchImpl: opts.channelFetch ?? routeCtx.fetchImpl, lead, onKill });
  // Closed 15m candles for the price chart. Cached briefly so the UI cannot hammer public APIs.
  const candleCache = new Map<string, { at: number; body: unknown }>();
  app.get('/api/candles', async (req, res) => {
    const symbol = normSymbol(String(req.query.symbol ?? cfg.watchlist[0] ?? 'BTCUSDT')).slice(0, 20);
    const hit = candleCache.get(symbol);
    if (hit && Date.now() - hit.at < 20_000) return res.json(hit.body);
    const snap = await getSnapshot(symbol, cfg.marketSource, cfg.tradingMode !== 'PAPER');
    const body = {
      symbol, source: snap.source, example: snap.example, last: snap.last, change24hPct: snap.change24hPct,
      candles: snap.candles.slice(-200).map((c) => ({ time: Math.floor(c.t / 1000), open: c.o, high: c.h, low: c.l, close: c.c }))
    };
    candleCache.set(symbol, { at: Date.now(), body });
    res.json(body);
  });
  app.get('/api/split', (req, res) => {
    try {
      res.json(moneySplit({ balance: Number(req.query.balance ?? desk.book.balance), safetyNet: Number(req.query.safetyNet ?? desk.book.safetyNet), n: Number(req.query.n ?? desk.book.n), orderSizePct: req.query.orderSizePct == null ? cfg.risk.orderSizePct : Number(req.query.orderSizePct) }));
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  // Starts a debate and waits for the verdict (used by the CLI, scripts and Grok Bot routines).
  app.post('/api/debate', async (req, res) => {
    const symbol = String(req.body?.symbol ?? '').slice(0, 20);
    try { res.json({ ok: true, verdict: await desk.runDebate(symbol) }); }
    catch (e) { res.status(409).json({ ok: false, error: safe((e as Error).message) }); }
  });
  app.post('/api/command', async (req, res) => {
    const access = localClient({ remoteAddress: req.socket.remoteAddress, hostHeader: req.headers.host, origin: req.get('origin') });
    if (!access.ok) return res.status(403).json({ ok: false, error: access.reason });
    const text = String(req.body?.text ?? '');
    if (text.length > 32000) return res.status(400).json({ ok: false, error: 'Message exceeds 32000 characters' });
    const agent = req.body?.agent as AgentId | undefined;
    if (!text.trim()) return res.status(400).json({ ok: false, error: 'empty command' });
    if (agent && !AGENT_IDS.includes(agent)) return res.status(400).json({ ok: false, error: 'unknown agent' });
    const conversationId = req.body?.conversationId ?? 'office';
    if (typeof conversationId !== 'string' || !/^[a-zA-Z0-9:_-]{1,100}$/.test(conversationId)) return res.status(400).json({ ok: false, error: 'Invalid conversation id' });
    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', cancel);
    try { res.json(await desk.command(text, agent, conversationId, controller.signal)); }
    finally { res.removeListener('close', cancel); }
  });

  app.get('/api/reports', (_req, res) => res.json({ reports: desk.reports.slice(0, 50) }));
  app.post('/api/reports/now', async (_req, res) => res.json({ ok: true, report: await reporter.generate() }));
  app.post('/api/auto/cycle', async (_req, res) => res.json({ ok: true, ...(await auto.cycle()) }));

  // Kill switch: pause, cancel, flatten. Persisted: stays on across restarts until `npm run unkill -- --yes` (CLI only).
  app.post('/api/kill', async (_req, res) => { auto.stop(); res.json({ ok: true, notes: await desk.kill() }); });

  // Grok Bot mode: agent turns from the user's own Grok Bot team. Off unless APP_MODE=grokbot and AGENT_EVENT_SECRET is set.
  const agentLimit = limiter(120, 60_000);
  app.post('/api/agent-event', async (req, res) => {
    if (!cfg.agentEvents.enabled) return res.status(404).json({ ok: false, error: 'agent events are off (APP_MODE=grokbot and AGENT_EVENT_SECRET enable them)' });
    const auth = String(req.get('authorization') ?? '').replace(/^Bearer\s+/i, '') || String(req.get('x-agent-key') ?? '');
    if (!auth || !sameSecret(auth, cfg.agentEvents.secret)) return res.status(401).json({ ok: false, error: 'bad or missing secret' });
    if (!agentLimit('all')) return res.status(429).json({ ok: false, error: 'slow down' });
    const parsed = AgentEventSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: 'invalid event', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).slice(0, 5) });
    const ev = { ...parsed.data, text: parsed.data.text ? sanitizeUntrusted(parsed.data.text, 600).text : undefined };
    res.json(await desk.onAgentEvent(ev as never));
  });

  // Keyless agent CLI (npm run gb). Needs AGENT_EVENT_SECRET as a Bearer token. Orders take the same
  // single execution path as the desk: risk gate caps, money split, stop loss, daily stop, kill switch.
  const gbLimit = limiter(60, 60_000);
  const gbAuth = (req: express.Request, res: express.Response) => {
    if (!cfg.agentEvents.secret) { res.status(404).json({ ok: false, error: 'set AGENT_EVENT_SECRET (npm run setup -- --yes --generate-agent-secret) to use npm run gb' }); return false; }
    const auth = String(req.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!auth || !sameSecret(auth, cfg.agentEvents.secret)) { res.status(401).json({ ok: false, error: 'bad or missing secret' }); return false; }
    if (!gbLimit('all')) { res.status(429).json({ ok: false, error: 'slow down' }); return false; }
    return true;
  };
  app.post('/api/gb/open', async (req, res) => {
    if (!gbAuth(req, res)) return;
    const p = GbOpenSchema.safeParse(req.body);
    if (!p.success) return res.status(400).json({ ok: false, error: 'invalid ticket', issues: p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).slice(0, 5) });
    if (p.data.reason) await desk.onAgentEvent({ agent: p.data.agent ?? 'lead', kind: 'say', text: sanitizeUntrusted(p.data.reason, 300).text } as never);
    res.json(await desk.gbOpen(p.data, true));
  });
  app.post('/api/gb/close', async (req, res) => {
    if (!gbAuth(req, res)) return;
    const target = String(req.body?.symbol ?? '').slice(0, 20);
    if (!target) return res.status(400).json({ ok: false, error: 'symbol or all' });
    res.json(await desk.gbClose(target, String(req.body?.reason ?? 'Grok Bot close').slice(0, 120)));
  });
  app.post('/api/gb/scan', (req, res) => { if (!gbAuth(req, res)) return; res.json({ ok: true, findings: desk.scan() }); });
  app.get('/api/gb/lessons', (req, res) => {
    if (!gbAuth(req, res)) return;
    res.json({ ok: true, lessons: desk.learnings.recent(Math.min(100, Number(req.query.n ?? 30) || 30)), standingRules: desk.learnings.standingRules(), refused: desk.learnings.refused });
  });
  app.post('/api/gb/lessons', (req, res) => {
    if (!gbAuth(req, res)) return;
    const p = GbLessonSchema.safeParse(req.body);
    if (!p.success) return res.status(400).json({ ok: false, error: 'invalid lesson', issues: p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).slice(0, 5) });
    const r = desk.learn({ ...p.data, source: 'grokbot' });
    if (!r) return res.status(422).json({ ok: false, error: cfg.learning.on ? 'refused: empty, or it would loosen a guard (lessons can never loosen guards)' : 'learning is off (LEARNING=off)' });
    res.json({ ok: true, event: r.event, lesson: r.lesson });
  });

  // TradingView alert webhook. TradingView cannot send headers, so the passphrase is in the JSON body.
  // The alert is an untrusted signal: it starts a debate, it never places an order by itself.
  const tvLimit = limiter(1, 60_000);
  app.post('/api/tradingview', async (req, res) => {
    if (!cfg.tradingview.webhookEnabled) return res.status(404).json({ ok: false, error: 'TradingView webhook is off (set TRADINGVIEW_PASSPHRASE)' });
    const parsed = TradingViewSchema.safeParse(req.body);
    if (!parsed.success || !sameSecret(parsed.data.passphrase, cfg.tradingview.passphrase)) return res.status(401).json({ ok: false, error: 'bad request or passphrase' });
    const symbol = normSymbol(parsed.data.symbol.replace(/^[A-Z]+:/i, '').replace(/\.P$/i, ''));
    if (!symbol) return res.status(400).json({ ok: false, error: 'unknown symbol' });
    if (!tvLimit(symbol)) return res.status(429).json({ ok: false, error: 'one alert per symbol per minute' });
    const price = Number(parsed.data.price);
    const sig = { source: 'tradingview' as const, symbol, action: sanitizeUntrusted(parsed.data.action, 20).text.toLowerCase(), price: Number.isFinite(price) && price > 0 ? price : null, note: sanitizeUntrusted(parsed.data.note ?? '', 300).text, at: Date.now() };
    void sendToGrokBot(cfg, 'signal', { ...sig }, opts.outboxPath);
    res.json(await desk.onSignal(sig));
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

  app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    const isMalformedJson = error instanceof SyntaxError && error.status === 400;
    const status = error.status && error.status >= 400 && error.status < 600 ? error.status : 500;
    const msg = isMalformedJson ? 'Malformed JSON request' : error.message;
    if (status >= 500) {
      desk.recordError('http', msg);
    } else {
      desk.recordActivity({ kind: 'backend', source: 'http', level: 'warn', text: msg, status: String(status) });
    }
    if (res.headersSent) return next(error);
    res.status(status).json({ ok: false, error: status >= 500 ? 'The request failed. See the activity log.' : 'Invalid request.' });
  });

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 128 * 1024 });
  wss.on('error', () => { /* ignore */ });
  const send = (ws: WebSocket, type: string, payload: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, payload })); };
  const broadcast = (type: string) => (payload: unknown) => { const msg = JSON.stringify({ type, payload }); for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(msg); };
  const eventTypes = ['state', 'speech', 'fight', 'meter', 'verdict', 'log', 'status', 'debate', 'report', 'execution', 'room'] as const;
  const listeners = eventTypes.map((ev) => {
    const fn = broadcast(ev);
    desk.on(ev, fn);
    return { ev, fn };
  });
  const origClose = server.close.bind(server);
  const cleanup = () => {
    unsubscribeActivity();
    for (const { ev, fn } of listeners) desk.off(ev, fn);
    for (const c of wss.clients) {
      try { c.terminate(); } catch { /* ignore */ }
    }
    try { wss.close(); } catch { /* ignore */ }
  };
  server.close = function (cb?: (err?: Error) => void) {
    cleanup();
    return origClose(cb);
  };
  server.on('close', cleanup);
  wss.on('connection', (ws, request) => {
    const owner = localClient({ remoteAddress: request.socket.remoteAddress, hostHeader: request.headers.host, origin: request.headers.origin });
    ws.on('error', () => { /* ignore */ });
    send(ws, 'state', desk.snapshot());
    ws.on('message', async (buf) => {
      try {
        const msg = JSON.parse(String(buf));
        if (msg?.type === 'command' && typeof msg.text === 'string') {
          if (!owner.ok) { send(ws, 'command_result', { ok: false, reply: owner.reason, command: 'invalid' }); return; }
          const agent = AGENT_IDS.includes(msg.agent) ? msg.agent : undefined;
          send(ws, 'command_result', await desk.command(msg.text, agent));
        }
      } catch { /* ignore malformed frames */ }
    });
  });
  const close = (cb?: (err?: Error) => void) => server.close(cb);
  return { app, server, desk, wss, auto, reporter, lead, inbound, close };
}
