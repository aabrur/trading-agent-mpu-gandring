// Inbound chat commands (signed webhooks) and the office Setup routes for channels.
// Inbound: signature first, then the allowlist, then the safe command parser. Anything else gets a refusal or 401/403.
// Setup: same localhost-only rules as the rest of the Setup wizard; saving secrets also needs local mode on 127.0.0.1.
import express from 'express';
import { z } from 'zod';
import type { RouteCtx } from '../setup/routes.js';
import { localClient } from '../setup/routes.js';
import { walletAccess } from '../wallet.js';
import { setupEnv } from '../setup/core.js';
import { safe, log } from '../redact.js';
import { allowed, parseCommand, runCommand } from './commands.js';
import { verifyDiscord, verifyMeta, verifySlack, sameToken } from './verify.js';
import { whatsappSend } from './adapters.js';
import type { DeskLead } from './supervisor.js';
import { CHANNEL_GUIDES, CHANNEL_LINKS_CHECKED_ON, NOT_SHIPPED, SUPERVISOR_ENV } from './guide.js';
import { channelStatus, saveChannel, testChannel, telegramChats, isChannel, discordRegisterCommand } from './setup.js';
import { CHANNELS } from './config.js';

type RawReq = express.Request & { rawBody?: Buffer };
const raw = (req: RawReq): Buffer => (Buffer.isBuffer(req.body) ? req.body : req.rawBody ?? Buffer.alloc(0));

/** The public-facing webhook server for chat commands. It runs on its own port (CHANNEL_WEBHOOK_PORT, default 8788) and has
 *  ONLY these routes, so a tunnel or reverse proxy pointed at it can never reach the office, the kill switch or setup. */
export function createInboundApp(c: RouteCtx & { lead: DeskLead; onKill?: () => void }): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use('/api/channels/discord', express.json({ limit: '32kb', verify: (req, _res, buf) => { (req as RawReq).rawBody = Buffer.from(buf); } }));
  app.use('/api/channels/whatsapp', express.json({ limit: '64kb', verify: (req, _res, buf) => { (req as RawReq).rawBody = Buffer.from(buf); } }));
  const cc = () => c.lead.cfg;
  const inLim = c.limiter(30, 60_000);
  const limited = (req: express.Request, res: express.Response) => { if (inLim(req.ip ?? '')) return false; res.status(429).end(); return true; };

  // ---- Discord Interactions Endpoint ----
  app.post('/api/channels/discord', async (req: RawReq, res) => {
    const d = cc().discord;
    if (!d.inbound) return res.status(404).json({ error: 'Discord commands are off (set DISCORD_PUBLIC_KEY)' });
    if (limited(req, res)) return;
    if (!verifyDiscord(d.publicKey, raw(req), req.get('X-Signature-Timestamp'), req.get('X-Signature-Ed25519'))) return res.status(401).json({ error: 'invalid request signature' });
    const b = req.body as { type?: number; data?: { name?: string; options?: Array<{ value?: unknown }> }; member?: { user?: { id?: string } }; user?: { id?: string } };
    if (b.type === 1) return res.json({ type: 1 });
    const reply = (content: string) => res.json({ type: 4, data: { content: safe(content).slice(0, 1990), flags: 64, allowed_mentions: { parse: [] } } });
    if (b.type !== 2) return reply('Only slash commands are supported.');
    if (!cc().commands) return reply('Chat commands are off on this desk (CHANNEL_COMMANDS=off).');
    if (!allowed(d.allowed, b.member?.user?.id ?? b.user?.id)) return reply('You are not on this desk\'s allowlist.');
    const text = [b.data?.name ?? '', ...(b.data?.options ?? []).map((o) => String(o.value ?? ''))].join(' ');
    const p = parseCommand(text);
    if (p.ok && p.cmd === 'kill' && p.confirm) { reply('Kill switch triggered. The result follows in the channel.'); const r = await runCommand(c.desk, p, c.onKill); void c.lead.hub.send('discord', r); return; }
    reply(await runCommand(c.desk, p, c.onKill));
  });

  // ---- Slack slash command (form encoded; signature over the raw body) ----
  app.post('/api/channels/slack', express.raw({ type: '*/*', limit: '16kb' }), async (req: RawReq, res) => {
    const s = cc().slack;
    if (!s.inbound) return res.status(404).json({ error: 'Slack commands are off (set SLACK_SIGNING_SECRET)' });
    if (limited(req, res)) return;
    const body = raw(req);
    if (!verifySlack(s.signingSecret, body, req.get('X-Slack-Request-Timestamp'), req.get('X-Slack-Signature'))) return res.status(401).json({ error: 'invalid request signature' });
    const f = new URLSearchParams(body.toString('utf8'));
    const reply = (text: string) => res.json({ response_type: 'ephemeral', text: safe(text).slice(0, 3900) });
    if (!cc().commands) return reply('Chat commands are off on this desk (CHANNEL_COMMANDS=off).');
    if (!allowed(s.allowed, f.get('user_id'))) return reply('You are not on this desk\'s allowlist.');
    const p = parseCommand(f.get('text') || 'help');
    if (p.ok && p.cmd === 'kill' && p.confirm) { reply('Kill switch triggered. The result follows in the channel.'); const r = await runCommand(c.desk, p, c.onKill); void c.lead.hub.send('slack', r); return; }
    reply(await runCommand(c.desk, p, c.onKill));
  });

  // ---- WhatsApp Cloud API webhook ----
  app.get('/api/channels/whatsapp', (req, res) => {
    const w = cc().whatsapp;
    if (!w.inbound) return res.status(404).end();
    if (req.query['hub.mode'] === 'subscribe' && sameToken(w.verifyToken, String(req.query['hub.verify_token'] ?? '')) && /^[\w-]{1,128}$/.test(String(req.query['hub.challenge'] ?? ''))) return res.type('text/plain').send(String(req.query['hub.challenge']));
    res.status(403).end();
  });
  app.post('/api/channels/whatsapp', async (req: RawReq, res) => {
    const w = cc().whatsapp;
    if (!w.inbound) return res.status(404).end();
    if (limited(req, res)) return;
    if (!verifyMeta(w.appSecret, raw(req), req.get('X-Hub-Signature-256'))) return res.status(401).end();
    res.sendStatus(200); // acknowledge fast; Meta retries otherwise
    const b = req.body as { entry?: Array<{ changes?: Array<{ value?: { messages?: Array<{ from?: string; type?: string; text?: { body?: string } }> } }> }> };
    for (const m of (b.entry ?? []).flatMap((e) => (e.changes ?? []).flatMap((ch) => ch.value?.messages ?? []))) {
      if (m.type !== 'text' || !m.from) continue;
      if (!cc().commands || !allowed(w.allowed, m.from)) { log('[desk lead] ignored a WhatsApp message from a number not on the allowlist (or commands off)'); continue; }
      const r = await runCommand(c.desk, parseCommand(m.text?.body ?? ''), c.onKill);
      await whatsappSend(w, r, c.fetchImpl ?? fetch, m.from, true); // reply inside the 24 hour window they just opened
    }
  });

  app.get('/', (_req, res) => res.type('text/plain').send('Mpu Gandring chat webhooks. Nothing else lives here.'));
  app.use((_req, res) => res.status(404).end());
  return app;
}

/** Office Setup wizard routes for channels (main office server, localhost only). */
export function mountChannelSetupRoutes(app: express.Express, c: RouteCtx) {
  const lim = c.limiter(30, 60_000);
  const local = (req: express.Request) => localClient({ remoteAddress: req.socket.remoteAddress, hostHeader: req.headers.host ?? null, origin: (req.headers.origin as string | undefined) ?? null });
  const keyEntry = (req: express.Request) => walletAccess({ appMode: c.cfg.appMode, host: c.cfg.host, remoteAddress: req.socket.remoteAddress, hostHeader: req.headers.host ?? null, origin: (req.headers.origin as string | undefined) ?? null });
  const gate = (req: express.Request, res: express.Response, secrets = false) => {
    const a = secrets ? keyEntry(req) : local(req);
    if (!a.ok) { res.status(403).json({ ok: false, error: a.reason }); return false; }
    if (!lim(req.socket.remoteAddress ?? '')) { res.status(429).json({ ok: false, error: 'slow down' }); return false; }
    return true;
  };
  app.get('/api/setup/channels', (req, res) => {
    if (!gate(req, res)) return;
    const k = keyEntry(req);
    res.json({ ok: true, linksCheckedOn: CHANNEL_LINKS_CHECKED_ON, entry: { available: k.ok, reason: k.reason }, status: channelStatus(setupEnv(c.envFile)), supervisorEnv: SUPERVISOR_ENV, notShipped: NOT_SHIPPED, discordRegister: discordRegisterCommand(),
      guides: CHANNELS.map((ch) => { const g = CHANNEL_GUIDES[ch]; return { channel: ch, ...g, fields: g.fields.map((f) => ({ env: f.env, label: f.label, secret: f.secret, required: f.required, hint: f.hint })) }; }) });
  });
  const SaveBody = z.object({ channel: z.enum(CHANNELS), values: z.record(z.string(), z.string().max(700)), commands: z.boolean().optional() }).strict();
  app.post('/api/setup/channels/save', (req, res) => {
    if (!gate(req, res, true)) return;
    const p = SaveBody.safeParse(req.body);
    if (!p.success) return res.status(400).json({ ok: false, error: 'invalid request' });
    const r = saveChannel(c.envFile, p.data.channel, p.data.values, { commands: p.data.commands });
    res.status(r.ok ? 200 : 422).json(r);
  });
  app.post('/api/setup/channels/test', async (req, res) => {
    if (!gate(req, res)) return;
    const ch = (req.body as { channel?: unknown })?.channel;
    if (!isChannel(ch)) return res.status(400).json({ ok: false, error: 'unknown channel' });
    const r = await testChannel(setupEnv(c.envFile), ch, c.fetchImpl ?? fetch);
    res.status(r.ok ? 200 : 422).json(r);
  });
  app.post('/api/setup/channels/telegram-chats', async (req, res) => {
    if (!gate(req, res)) return;
    res.json(await telegramChats((setupEnv(c.envFile).TELEGRAM_BOT_TOKEN ?? '').trim(), c.fetchImpl ?? fetch));
  });
}
