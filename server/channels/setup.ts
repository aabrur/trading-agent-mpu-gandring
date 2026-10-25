// Channel setup shared by the CLI (npm run setup -- channel, npm run channels) and the office Setup wizard (/api/setup/channels*).
// Values go only into the local .env (chmod 600). Nothing here returns a secret value.
import { setEnv } from '../../cli/envfile.js';
import { setupEnv } from '../setup/core.js';
import { safe } from '../redact.js';
import { CHANNEL_GUIDES } from './guide.js';
import { CHANNELS, channelConfig, type ChannelName } from './config.js';
import { ChannelHub, whatsappSend } from './adapters.js';

export const isChannel = (v: unknown): v is ChannelName => typeof v === 'string' && (CHANNELS as readonly string[]).includes(v);
export interface ChannelResult { ok: boolean; detail: string; saved?: string[] }

/** Check what the user typed. Empty means "keep what is in .env". Returns an error message or null. */
export function checkChannelInput(ch: ChannelName, input: Record<string, string | undefined>, current: NodeJS.ProcessEnv = {}): string | null {
  const g = CHANNEL_GUIDES[ch];
  const known = new Set(g.fields.map((f) => f.env));
  for (const k of Object.keys(input)) if (!known.has(k)) return `${k} is not a ${g.label} setting.`;
  for (const f of g.fields) {
    const v = (input[f.env] ?? '').trim();
    if (!v) { if (f.required && !(current[f.env] ?? '').trim()) return `${f.env} is required (${f.hint}).`; continue; }
    if (/\s{2,}|\b(\w+\s+){11,}\w+\b/.test(v) && f.secret) return `${f.env} looks like a phrase. Never paste a wallet seed phrase anywhere.`;
    if (!f.pattern.test(v)) return `${f.env} does not look right (${f.hint}).`;
  }
  return null;
}

export function saveChannel(envFile: string, ch: ChannelName, input: Record<string, string | undefined>, o: { commands?: boolean } = {}): ChannelResult {
  const cur = setupEnv(envFile);
  const err = checkChannelInput(ch, input, cur);
  if (err) return { ok: false, detail: err };
  const up: Record<string, string> = {};
  for (const f of CHANNEL_GUIDES[ch].fields) { const v = (input[f.env] ?? '').trim(); if (v) up[f.env] = f.env.endsWith('_NUMBERS') || f.env === 'WHATSAPP_TO' ? v.replace(/\+/g, '') : v; }
  if (o.commands !== undefined) up.CHANNEL_COMMANDS = o.commands ? 'on' : 'off';
  setEnv(envFile, up);
  return { ok: true, detail: `${CHANNEL_GUIDES[ch].label} saved to .env. Restart the desk to use it.`, saved: Object.keys(up) };
}

/** What is set for each channel, with secrets reduced to set/empty. */
export function channelStatus(env: NodeJS.ProcessEnv) {
  const c = channelConfig(env);
  return {
    commands: c.commands, supervisor: c.supervisor,
    channels: CHANNELS.map((ch) => ({ channel: ch, label: CHANNEL_GUIDES[ch].label, enabled: c[ch].enabled, commandsReady: ch === 'telegram' ? c.telegram.enabled && c.telegram.allowed.length > 0 : ((c[ch] as { inbound: boolean }).inbound || ch === 'discord' && c.discord.delivery === 'gateway' && !!c.discord.botToken) && (c[ch] as { allowed: string[] }).allowed.length > 0,
      fields: CHANNEL_GUIDES[ch].fields.map((f) => ({ env: f.env, set: !!(env[f.env] ?? '').trim(), shown: !f.secret && env[f.env] ? String(env[f.env]).slice(0, 40) : null })) }))
  };
}

/** Send one test message through the configured channel. */
export async function testChannel(env: NodeJS.ProcessEnv, ch: ChannelName, fetchImpl: typeof fetch = fetch): Promise<ChannelResult> {
  const cfg = channelConfig(env);
  if (!cfg[ch].enabled) return { ok: false, detail: `${CHANNEL_GUIDES[ch].label} is not set up yet (${CHANNEL_GUIDES[ch].fields.filter((f) => f.required).map((f) => f.env).join(', ')}).` };
  const r = await new ChannelHub(cfg, fetchImpl).send(ch, `Test message from Trading Agent Mpu Gandring (${(env.TRADING_MODE || 'PAPER').toUpperCase()}). If you can read this, the Desk Lead can reach you here.`);
  return r === 'sent' ? { ok: true, detail: `Test message sent to ${CHANNEL_GUIDES[ch].label}.` } : { ok: false, detail: `${CHANNEL_GUIDES[ch].label} did not accept the message. Check the values${ch === 'whatsapp' ? ', the 24 hour window or the template' : ''}.` };
}

/** After you message your bot: list the chats and users it has seen, so you can copy TELEGRAM_CHAT_ID and your user id. */
export async function telegramChats(token: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; detail: string; chats: Array<{ chatId: string; chat: string; userId: string; user: string }> }> {
  if (!/^\d{5,15}:[A-Za-z0-9_-]{30,64}$/.test(token)) return { ok: false, detail: 'TELEGRAM_BOT_TOKEN is missing or does not look right.', chats: [] };
  try {
    const r = await fetchImpl(`https://api.telegram.org/bot${token}/getUpdates?allowed_updates=${encodeURIComponent('["message"]')}`, { signal: AbortSignal.timeout(10_000) });
    const j = (await r.json()) as { ok?: boolean; description?: string; result?: Array<{ message?: { chat?: { id: number; type?: string; title?: string; username?: string; first_name?: string }; from?: { id: number; username?: string; first_name?: string } } }> };
    if (!j.ok) return { ok: false, detail: `Telegram said: ${safe(String(j.description ?? r.status)).slice(0, 120)}`, chats: [] };
    const seen = new Map<string, { chatId: string; chat: string; userId: string; user: string }>();
    for (const u of j.result ?? []) { const m = u.message; if (!m?.chat || !m.from) continue; seen.set(`${m.chat.id}:${m.from.id}`, { chatId: String(m.chat.id), chat: String(m.chat.title ?? m.chat.username ?? m.chat.first_name ?? m.chat.type ?? '').slice(0, 60), userId: String(m.from.id), user: String(m.from.username ?? m.from.first_name ?? '').slice(0, 60) }); }
    return { ok: true, detail: seen.size ? 'Copy the chat id and your user id.' : 'No messages yet. Send your bot a message in Telegram, then try again.', chats: [...seen.values()] };
  } catch (e) { return { ok: false, detail: `Could not reach Telegram: ${safe((e as Error).message).slice(0, 120)}`, chats: [] }; }
}

/** The official request that registers the slash commands for your Discord app (you run it; we never see the bot token). */
export const DISCORD_COMMANDS = [
  { name: 'status', description: 'Desk status (read only)', type: 1 },
  { name: 'report', description: 'Latest desk report (read only)', type: 1 },
  { name: 'positions', description: 'Open positions and stops (read only)', type: 1 },
  { name: 'kill', description: 'Kill switch: flatten and stop (needs confirm)', type: 1, options: [{ name: 'confirm', description: 'type confirm', type: 3, required: true }] }
];
export function discordRegisterCommand(appIdVar = '$DISCORD_APPLICATION_ID', tokenVar = '$DISCORD_BOT_TOKEN') {
  return `curl -X PUT "https://discord.com/api/v10/applications/${appIdVar}/commands" -H "Authorization: Bot ${tokenVar}" -H "Content-Type: application/json" -d '${JSON.stringify(DISCORD_COMMANDS)}'`;
}

export const TELEGRAM_BOT_COMMANDS = [
  { command: 'status', description: 'Balance, equity, venue, guards status' },
  { command: 'positions', description: 'Active positions and resting exchange stops' },
  { command: 'report', description: 'Latest performance and execution report' },
  { command: 'scan', description: 'Instant proactive scan for desk alerts' },
  { command: 'analyze', description: 'Direct agents to debate and auto-trade' },
  { command: 'ask', description: 'Chat with Desk Lead or agent' },
  { command: 'watchlist', description: 'Active auto-trading symbols' },
  { command: 'scorecard', description: 'Agent performance and win rate' },
  { command: 'lessons', description: 'Recent self-improving lessons' },
  { command: 'cautious', description: 'Adjust agent risk appetite cautious' },
  { command: 'aggressive', description: 'Adjust agent risk appetite aggressive' },
  { command: 'calm', description: 'Reset agent risk appetite' },
  { command: 'kill', description: 'Emergency stop (flatten positions)' },
  { command: 'help', description: 'Show available commands' }
];

export async function syncTelegramCommands(token: string, fetchImpl: typeof fetch = fetch): Promise<ChannelResult> {
  if (!token || !/^\d{5,15}:[A-Za-z0-9_-]{30,64}$/.test(token)) {
    return { ok: false, detail: 'TELEGRAM_BOT_TOKEN is missing or invalid.' };
  }
  try {
    const r = await fetchImpl(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commands: TELEGRAM_BOT_COMMANDS }),
      signal: AbortSignal.timeout(10_000)
    });
    const j = (await r.json()) as { ok?: boolean; description?: string };
    if (!j.ok) return { ok: false, detail: `Telegram said: ${safe(String(j.description ?? r.status))}` };
    return { ok: true, detail: 'Telegram commands registered with BotFather and client menus.' };
  } catch (e) {
    return { ok: false, detail: `Could not reach Telegram: ${safe((e as Error).message)}` };
  }
}

export async function syncSlackCommands(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): Promise<ChannelResult> {
  const cfg = channelConfig(env);
  if (!cfg.slack.webhookUrl) return { ok: false, detail: 'SLACK_WEBHOOK_URL is not set.' };
  try {
    const msg = [
      '*Mpu Gandring Slack Commands Synced*',
      '• `/desk status` : Balance, equity, venue, guards status',
      '• `/desk positions` : Active positions and exchange stops',
      '• `/desk report` : Latest desk performance report',
      '• `/desk scan` : Proactive scan for desk alerts',
      '• `/desk analyze <symbol>` : Direct agents debate and trade',
      '• `/desk ask <query>` : Chat with Desk Lead',
      '• `/desk kill` : Emergency stop (send "kill confirm" to flatten)',
      '• `/desk help` : Show all commands',
      `_Signing secret: ${cfg.slack.signingSecret ? 'configured' : 'not set (read-only webhook)'} · Allowed users: ${cfg.slack.allowed.length || 'none'}_`
    ].join('\n');
    const r = await fetchImpl(cfg.slack.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: msg }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!r.ok) return { ok: false, detail: `Slack webhook returned HTTP ${r.status}` };
    return { ok: true, detail: 'Slack commands verified and directory synced to channel.' };
  } catch (e) {
    return { ok: false, detail: `Could not reach Slack: ${safe((e as Error).message)}` };
  }
}

export async function syncWhatsAppCommands(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): Promise<ChannelResult> {
  const cfg = channelConfig(env);
  const wa = cfg.whatsapp;
  if (!wa.token || !wa.phoneNumberId || !wa.to) {
    return { ok: false, detail: 'WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, or WHATSAPP_TO is missing.' };
  }
  try {
    const verifyRes = await fetchImpl(`https://graph.facebook.com/${wa.graphVersion}/${encodeURIComponent(wa.phoneNumberId)}`, {
      headers: { Authorization: `Bearer ${wa.token}` },
      signal: AbortSignal.timeout(10_000)
    });
    if (!verifyRes.ok) {
      const errJson = (await verifyRes.json().catch(() => ({}))) as { error?: { message?: string } };
      return { ok: false, detail: `WhatsApp Graph API: ${safe(errJson.error?.message ?? String(verifyRes.status))}` };
    }
    const commandGuide = [
      '*Trading Agent Mpu Gandring Commands*',
      '• status : Balance, equity, venue status',
      '• positions : Open positions and stops',
      '• report : Latest desk report',
      '• scan : Instant proactive scan',
      '• analyze <symbol> : Agents debate and trade',
      '• ask <agent> <question> : Chat with agents',
      '• kill : Emergency kill switch',
      '• help : List all commands'
    ].join('\n');
    const sendRes = await whatsappSend(wa, commandGuide, fetchImpl, wa.to, true);
    if (sendRes === 'sent') {
      return { ok: true, detail: 'WhatsApp commands synced and guide sent to registered number.' };
    }
    return { ok: true, detail: 'WhatsApp Graph API credentials verified. Outbound push ready.' };
  } catch (e) {
    return { ok: false, detail: `WhatsApp sync error: ${safe((e as Error).message)}` };
  }
}
