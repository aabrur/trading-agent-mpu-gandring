import { DiscordBotBody, inspectDiscordBot, syncDiscordCommands, discordCommandText, discordRefusal, type DiscordInteraction } from './discord.js';
import { channelConfig } from './config.js';
import { setEnv } from '../../cli/envfile.js';
import { registerSecrets } from '../redact.js';
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
import { channelStatus, checkChannelInput, saveChannel, testChannel, telegramChats, isChannel, discordRegisterCommand, syncTelegramCommands, syncSlackCommands, syncWhatsAppCommands } from './setup.js';
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
    const b = req.body as DiscordInteraction;
    if (b.type === 1) return res.json({ type: 1 });
    const reply = (content: string) => res.json({ type: 4, data: { content: safe(content).slice(0, 1990), flags: 64, allowed_mentions: { parse: [] } } });
    if (b.type !== 2) return reply('Only slash commands are supported.');
    if (!cc().commands) return reply('Chat commands are off on this desk (CHANNEL_COMMANDS=off).');
    if (!allowed(d.allowed, b.member?.user?.id ?? b.user?.id)) return reply('You are not on this desk\'s allowlist.');
    const refusal = discordRefusal(cc(), b);
    if (refusal) return reply(refusal);
    const text = discordCommandText(b.data);
    const p = parseCommand(text);
    if (p.ok && p.cmd === 'kill' && p.confirm) { reply('Kill switch triggered. The result follows in the channel.'); const r = await runCommand(c.desk, p, c.onKill); void c.lead.hub.send('discord', r); return; }
    if (b.token && b.application_id) {
      res.json({type: 5, data: {flags: 64}});
      let content: string;
      try { content = await runCommand(c.desk, p, c.onKill, `discord:${b.member?.user?.id ?? b.user?.id}`); }
      catch { content = 'The desk could not complete this command.'; }
      try { await (c.fetchImpl ?? fetch)(`https://discord.com/api/v10/webhooks/${b.application_id}/${b.token}/messages/@original`, {method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({content: safe(content).slice(0,1990), allowed_mentions: {parse: []}}), signal: AbortSignal.timeout(8000)}); } catch { log('[discord] deferred response failed'); }
      return;
    }
    reply(await runCommand(c.desk, p, c.onKill, `discord:${b.member?.user?.id ?? b.user?.id}`));
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
    reply(await runCommand(c.desk, p, c.onKill, `slack:${f.get('team_id')}:${f.get('user_id')}`));
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
      const r = await runCommand(c.desk, parseCommand(m.text?.body ?? ''), c.onKill, `whatsapp:${m.from}`);
      await whatsappSend(w, r, c.fetchImpl ?? fetch, m.from, true); // reply inside the 24 hour window they just opened
    }
  });

  app.get('/', (_req, res) => res.type('text/plain').send('Mpu Gandring chat webhooks. Nothing else lives here.'));
  app.use((_req, res) => res.status(404).end());
  return app;
}

/** Office Setup wizard routes for channels (main office server, localhost only). */
export function mountChannelSetupRoutes(app: express.Express, c: RouteCtx & { lead?: DeskLead }) {
  const writeLim = c.limiter(30, 60_000);
  // Reads (guides, status) get a roomier limit so clicking through the wizard never locks it; writes stay at the tight limit.
  const readLim = c.limiter(300, 60_000);
  const lim = (k: string, req?: { method?: string }) => (req?.method === 'GET' ? readLim(k) : writeLim(k));
  const local = (req: express.Request) => localClient({ remoteAddress: req.socket.remoteAddress, hostHeader: req.headers.host ?? null, origin: (req.headers.origin as string | undefined) ?? null });
  const keyEntry = (req: express.Request) => walletAccess({ appMode: c.cfg.appMode, host: c.cfg.host, remoteAddress: req.socket.remoteAddress, hostHeader: req.headers.host ?? null, origin: (req.headers.origin as string | undefined) ?? null });
  const gate = (req: express.Request, res: express.Response, secrets = false) => {
    const a = secrets ? keyEntry(req) : local(req);
    if (!a.ok) { res.status(403).json({ ok: false, error: a.reason }); return false; }
    if (!lim(req.socket.remoteAddress ?? '', req)) { res.status(429).json({ ok: false, error: 'slow down' }); return false; }
    return true;
  };
  app.get('/api/setup/channels', (req, res) => {
    if (!gate(req, res)) return;
    const k = keyEntry(req);
    res.json({ ok: true, linksCheckedOn: CHANNEL_LINKS_CHECKED_ON, entry: { available: k.ok, reason: k.reason }, discordConnection: c.lead?.discordStatus ?? 'unknown', status: channelStatus(setupEnv(c.envFile)), supervisorEnv: SUPERVISOR_ENV, notShipped: NOT_SHIPPED, discordRegister: discordRegisterCommand(),
      guides: CHANNELS.map((ch) => { const g = CHANNEL_GUIDES[ch]; return { channel: ch, ...g, fields: g.fields.map((f) => ({ env: f.env, label: f.label, secret: f.secret, required: f.required, hint: f.hint })) }; }) });
  });
  app.post('/api/setup/channels/discord-bot', async (req, res) => {
    if (!gate(req, res, true)) return;
    const parsed = DiscordBotBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, detail: 'Enter a bot token and valid server/channel selections.' });
    const env = setupEnv(c.envFile), token = parsed.data.token || env.DISCORD_BOT_TOKEN || '';
    registerSecrets([token]);
    if (!token) return res.status(400).json({ok: false, detail: 'Enter the Bot Token in the masked input.'});
    try {
      const result = await inspectDiscordBot(token, parsed.data.guildId, c.fetchImpl ?? fetch);
      res.json({ok: true, ...result});
    } catch (error) { res.status(422).json({ok: false, detail: safe((error as Error).message)}); }
  });
  app.post('/api/setup/channels/discord-sync', async (req, res) => {
    if (!gate(req, res, true)) return;
    const env = setupEnv(c.envFile);
    try { res.json({ok: true, ...await syncDiscordCommands(env.DISCORD_BOT_TOKEN || '', env.DISCORD_APPLICATION_ID || '', env.DISCORD_GUILD_ID || '', c.fetchImpl ?? fetch), detail: '/mpu commands registered and verified.'}); }
    catch (error) { res.status(422).json({ok: false, detail: safe((error as Error).message)}); }
  });
  app.post('/api/setup/channels/telegram-sync', async (req, res) => {
    if (!gate(req, res, true)) return;
    const env = setupEnv(c.envFile);
    const r = await syncTelegramCommands((env.TELEGRAM_BOT_TOKEN ?? '').trim(), c.fetchImpl ?? fetch);
    res.status(r.ok ? 200 : 422).json(r);
  });
  app.post('/api/setup/channels/slack-sync', async (req, res) => {
    if (!gate(req, res, true)) return;
    const env = setupEnv(c.envFile);
    const r = await syncSlackCommands(env, c.fetchImpl ?? fetch);
    res.status(r.ok ? 200 : 422).json(r);
  });
  app.post('/api/setup/channels/whatsapp-sync', async (req, res) => {
    if (!gate(req, res, true)) return;
    const env = setupEnv(c.envFile);
    const r = await syncWhatsAppCommands(env, c.fetchImpl ?? fetch);
    res.status(r.ok ? 200 : 422).json(r);
  });
  const SaveBody = z.object({ channel: z.enum(CHANNELS), values: z.record(z.string(), z.string().max(700)), commands: z.boolean().optional() }).strict();
  app.post('/api/setup/channels/save', async (req, res) => {
    if (!gate(req, res, true)) return;
    const p = SaveBody.safeParse(req.body);
    if (!p.success) return res.status(400).json({ ok: false, error: 'invalid request' });
    if (p.data.channel === 'discord') {
      const env = setupEnv(c.envFile), token = p.data.values.DISCORD_BOT_TOKEN || env.DISCORD_BOT_TOKEN;
      if (token) {
        registerSecrets([token]);
        try {
          const guildId = p.data.values.DISCORD_GUILD_ID || env.DISCORD_GUILD_ID;
          const channelId = p.data.values.DISCORD_CHANNEL_ID || env.DISCORD_CHANNEL_ID;
          const inspected = await inspectDiscordBot(token, guildId, c.fetchImpl ?? fetch);
          if (!guildId || !channelId || !inspected.channels.some(channel => channel.id === channelId)) throw new Error('Select a server and eligible text channel first.');
          p.data.values.DISCORD_APPLICATION_ID = inspected.application.id;
          p.data.values.DISCORD_DELIVERY = inspected.delivery;
          if (inspected.application.verify_key) p.data.values.DISCORD_PUBLIC_KEY = inspected.application.verify_key;
          // Validate fields before the externally visible command registration.
          const error = checkChannelInput('discord', p.data.values, env);
          if (error) throw new Error(error);
          await syncDiscordCommands(token, inspected.application.id, guildId, c.fetchImpl ?? fetch);
        } catch (error) { return res.status(422).json({ok: false, detail: safe((error as Error).message)}); }
      }
    }
    const r = saveChannel(c.envFile, p.data.channel, p.data.values, { commands: p.data.commands });
    if (r.ok && p.data.channel === 'discord') {
      const next = setupEnv(c.envFile);
      for (const [key, value] of Object.entries(next)) if (key.startsWith('DISCORD_') || key === 'CHANNEL_COMMANDS') process.env[key] = value;
      c.lead?.reload(channelConfig(next));
      r.detail = 'Discord saved and applied. /mpu registered and verified when Bot API is configured.';
    }
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
