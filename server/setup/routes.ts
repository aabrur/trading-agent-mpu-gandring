// Office routes for the Setup wizard and the Desk ops panel. Same shared modules as the CLI (server/setup/*, server/sizing.ts).
// Every route here answers only to a browser on this computer (loopback client, localhost Host header, same-origin).
// Key entry additionally needs local mode and an office bound to 127.0.0.1 (the Connect wallet rule).
// Not possible here, on purpose: releasing the kill switch (CLI only: npm run unkill -- --yes).
import type express from 'express';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Desk } from '../desk.js';
import { AGENT_IDS } from '../config.js';
import { EXCHANGES, ADAPTER_STATUS, type ExchangeName } from '../exchange/index.js';
import { walletAccess } from '../wallet.js';
import { safe } from '../redact.js';
import { sizeTicket } from '../sizing.js';
import { sanitizeUntrusted } from '../untrusted.js';
import { VENUE_GUIDES, guideSteps, envFields, MODES, MODE_INFO, LIVE_CONFIRM_PHRASE, LINKS_CHECKED_ON } from './guide.js';
import { saveVenueKeys, setVenue, setTradingMode, setupEnv, maskedStatus } from './core.js';
import { doctor } from './doctor.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const hostOk = (h: string) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(h);
/** A request from a browser or CLI on this computer, not from the network and not cross-site. */
export function localClient(o: { remoteAddress?: string | null; hostHeader?: string | null; origin?: string | null }): { ok: boolean; reason: string } {
  if (!o.remoteAddress || !LOOPBACK.has(o.remoteAddress)) return { ok: false, reason: 'only available from this computer (localhost).' };
  if (!o.hostHeader || !hostOk(o.hostHeader)) return { ok: false, reason: 'open the office at http://127.0.0.1 or http://localhost.' };
  if (o.origin && !hostOk(o.origin.replace(/^https?:\/\//, ''))) return { ok: false, reason: 'cross-origin request refused.' };
  return { ok: true, reason: 'local' };
}

export const UNKILL_COMMAND = 'npm run unkill -- --yes';
type Limiter = (k: string) => boolean;
export interface RouteCtx { cfg: AppConfig; desk: Desk; envFile: string; fetchImpl?: typeof fetch; limiter: (n: number, ms: number) => Limiter }

const Venue = z.enum(EXCHANGES as unknown as [ExchangeName, ...ExchangeName[]]);
const KeysBody = z.object({ venue: Venue, network: z.enum(['testnet', 'mainnet']), key: z.string().max(300), secret: z.string().max(400), third: z.string().max(300).optional() }).strict();
const ModeBody = z.object({ mode: z.enum(MODES), confirm: z.string().max(100).optional() }).strict();
const OpenBody = z.object({ symbol: z.string().min(2).max(20), side: z.enum(['LONG', 'SHORT']), stop: z.number().positive(), tp: z.number().positive().optional(), leverage: z.number().positive().max(100).optional() }).strict();
const SizeBody = z.object({ symbol: z.string().min(2).max(20), side: z.enum(['LONG', 'SHORT']), entry: z.number().positive().optional(), stop: z.number().positive(), leverage: z.number().positive().max(100).optional() }).strict();
const LessonBody = z.object({ role: z.enum([...AGENT_IDS, 'desk'] as unknown as [string, ...string[]]), lesson: z.string().min(8).max(300), kind: z.enum(['loss', 'stop', 'error', 'scan', 'correction', 'review', 'note']).default('note'), happened: z.string().max(400).default(''), rootCause: z.string().max(300).default('') }).strict();

export function mountSetupRoutes(app: express.Express, c: RouteCtx) {
  const lim = c.limiter(30, 60_000);
  const local = (req: express.Request) => localClient({ remoteAddress: req.socket.remoteAddress, hostHeader: req.headers.host ?? null, origin: (req.headers.origin as string | undefined) ?? null });
  const keyEntry = (req: express.Request) => walletAccess({ appMode: c.cfg.appMode, host: c.cfg.host, remoteAddress: req.socket.remoteAddress, hostHeader: req.headers.host ?? null, origin: (req.headers.origin as string | undefined) ?? null });
  const gate = (req: express.Request, res: express.Response, keys = false) => {
    const a = keys ? keyEntry(req) : local(req);
    if (!a.ok) { res.status(403).json({ ok: false, error: a.reason }); return false; }
    if (!lim(req.socket.remoteAddress ?? '')) { res.status(429).json({ ok: false, error: 'slow down' }); return false; }
    return true;
  };

  app.get('/api/setup', (req, res) => {
    if (!gate(req, res)) return;
    const k = keyEntry(req);
    res.json({ ok: true, linksCheckedOn: LINKS_CHECKED_ON, modes: MODES.map((m) => ({ mode: m, info: MODE_INFO[m] })), liveConfirmPhrase: LIVE_CONFIRM_PHRASE,
      keyEntry: { available: k.ok, reason: k.reason }, running: { mode: c.cfg.tradingMode, appMode: c.cfg.appMode }, status: maskedStatus(setupEnv(c.envFile)), unkill: UNKILL_COMMAND,
      venues: EXCHANGES.map((v) => ({ venue: v, label: VENUE_GUIDES[v].label, kind: VENUE_GUIDES[v].kind, status: ADAPTER_STATUS[v], connectWallet: VENUE_GUIDES[v].connectWallet, login: VENUE_GUIDES[v].login, extra: VENUE_GUIDES[v].extra ?? null })) });
  });
  app.get('/api/setup/guide/:venue', (req, res) => {
    if (!gate(req, res)) return;
    const v = Venue.safeParse(req.params.venue); const net = req.query.network === 'mainnet' ? 'mainnet' : 'testnet';
    if (!v.success) return res.status(404).json({ ok: false, error: 'unknown venue' });
    const g = VENUE_GUIDES[v.data];
    res.json({ ok: true, venue: v.data, network: net, note: g.networks[net].note ?? null, steps: guideSteps(v.data, net, c.cfg.appMode === 'grokbot' ? 'grokbot' : 'local'), fields: envFields(v.data, net), permissionsOn: g.permissionsOn, permissionsOff: g.permissionsOff, ip: g.ip, docs: g.docs, connectWallet: g.connectWallet });
  });
  // Masked inputs from the Setup wizard. The body is never logged or echoed; the answer names the saved variables only.
  app.post('/api/setup/keys', async (req, res) => {
    if (!gate(req, res, true)) return;
    const p = KeysBody.safeParse(req.body);
    if (!p.success) return res.status(400).json({ ok: false, error: 'bad request: venue, network, key, secret (and third for OKX/dYdX)' });
    try { const r = await saveVenueKeys(c.envFile, p.data.venue, p.data.network, p.data, { fetchImpl: c.fetchImpl }); res.status(r.ok ? 200 : 400).json(r); }
    catch (e) { res.status(400).json({ ok: false, detail: safe((e as Error).message) }); }
  });
  app.post('/api/setup/venue', (req, res) => {
    if (!gate(req, res, true)) return;
    const v = String(req.body?.venue ?? '');
    const r = setVenue(c.envFile, v); res.status(r.ok ? 200 : 400).json(r);
  });
  app.post('/api/setup/mode', async (req, res) => {
    if (!gate(req, res, true)) return;
    const p = ModeBody.safeParse(req.body);
    if (!p.success) return res.status(400).json({ ok: false, detail: 'mode must be PAPER, TESTNET or LIVE' });
    const r = await setTradingMode(c.envFile, p.data.mode, { confirm: p.data.confirm, fetchImpl: c.fetchImpl });
    res.status(r.ok ? 200 : 400).json(r);
  });
  app.post('/api/setup/doctor', async (req, res) => {
    if (!gate(req, res)) return;
    try { res.json({ ok: true, lines: await doctor(setupEnv(c.envFile), c.fetchImpl ?? fetch) }); }
    catch (e) { res.status(500).json({ ok: false, error: safe((e as Error).message) }); }
  });
}

export function mountOpsRoutes(app: express.Express, c: RouteCtx) {
  const lim = c.limiter(60, 60_000);
  const gate = (req: express.Request, res: express.Response) => {
    const a = localClient({ remoteAddress: req.socket.remoteAddress, hostHeader: req.headers.host ?? null, origin: (req.headers.origin as string | undefined) ?? null });
    if (!a.ok) { res.status(403).json({ ok: false, error: a.reason }); return false; }
    if (!lim(req.socket.remoteAddress ?? '')) { res.status(429).json({ ok: false, error: 'slow down' }); return false; }
    return true;
  };
  app.post('/api/ops/size', async (req, res) => {
    if (!gate(req, res)) return;
    const p = SizeBody.safeParse(req.body); if (!p.success) return res.status(400).json({ ok: false, text: 'symbol, side, stop (entry optional: live price)' });
    const s = c.desk.snapshot();
    let entry = p.data.entry;
    if (!entry) { const t = c.desk.tickers[p.data.symbol.toUpperCase()]; entry = t ? Number((t as { last: number }).last) : undefined; }
    if (!entry) return res.status(400).json({ ok: false, text: 'no live price yet for that symbol: enter an entry price' });
    const r = await sizeTicket(c.cfg, setupEnv(c.envFile), { balance: s.paper.balance, equity: s.paper.equity, safetyNet: s.paper.safetyNet, n: s.paper.n, open: s.paper.positions.length, used: s.paper.usedMargin, mode: s.mode }, { ...p.data, entry }, c.fetchImpl ?? fetch);
    res.json(r);
  });
  // Same single execution path as everything else: risk gate caps, money split, required stop, daily stop, kill switch.
  app.post('/api/ops/open', async (req, res) => {
    if (!gate(req, res)) return;
    const p = OpenBody.safeParse(req.body);
    if (!p.success) return res.status(400).json({ ok: false, reply: 'no stop: every ticket needs a stop price. Not opening without one.' });
    res.json(await c.desk.gbOpen({ ...p.data, agent: 'execution' }));
  });
  app.post('/api/ops/close', async (req, res) => {
    if (!gate(req, res)) return;
    const target = String(req.body?.symbol ?? '').slice(0, 20); if (!target) return res.status(400).json({ ok: false, reply: 'symbol or all' });
    res.json(await c.desk.gbClose(target, 'closed from the office'));
  });
  app.post('/api/ops/scan', (req, res) => { if (!gate(req, res)) return; res.json({ ok: true, findings: c.desk.scan() }); });
  app.get('/api/ops/lessons', (req, res) => { if (!gate(req, res)) return; res.json({ ok: true, lessons: c.desk.learnings.recent(30), standingRules: c.desk.learnings.standingRules(), refused: c.desk.learnings.refused }); });
  app.post('/api/ops/lessons', (req, res) => {
    if (!gate(req, res)) return;
    const p = LessonBody.safeParse(req.body); if (!p.success) return res.status(400).json({ ok: false, error: 'role and a lesson of 8+ characters' });
    const r = c.desk.learn({ ...p.data, role: p.data.role as never, lesson: sanitizeUntrusted(p.data.lesson, 300).text, source: 'owner' });
    if (!r) return res.status(422).json({ ok: false, error: 'refused: empty, learning off, or it would loosen a guard' });
    res.json({ ok: true, lesson: r.lesson });
  });
  app.get('/api/ops/kill', (req, res) => {
    if (!gate(req, res)) return;
    res.json({ ok: true, killed: c.desk.killed, killedAt: c.desk.killedAt || null, release: c.desk.killed ? `Only on this machine, in a terminal: ${UNKILL_COMMAND}, then restart the office.` : null, unkillCommand: UNKILL_COMMAND });
  });
}
