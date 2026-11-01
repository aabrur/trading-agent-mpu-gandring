import { safe } from '../redact.js';
import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createPublicKey, timingSafeEqual, verify as edVerify } from 'node:crypto';
import WebSocket from 'ws';

export interface TelegramChannelConfig {
  enabled: boolean;
  botToken?: string;
  chatId?: string;
  ownerUserIds?: string[];
}

export interface DiscordChannelConfig {
  enabled: boolean;
  botToken?: string;
  channelId?: string;
  webhookUrl?: string;
  ownerUserIds?: string[];
}

export interface SlackChannelConfig {
  enabled: boolean;
  webhookUrl?: string;
  signingSecret?: string;
  ownerUserIds?: string[];
}

export interface WhatsAppChannelConfig {
  enabled: boolean;
  token?: string;
  phoneNumberId?: string;
  to?: string;
  verifyToken?: string;
  appSecret?: string;
  ownerPhoneNumbers?: string[];
}

export interface ChannelConfig {
  telegram?: TelegramChannelConfig;
  discord?: DiscordChannelConfig;
  slack?: SlackChannelConfig;
  whatsapp?: WhatsAppChannelConfig;
}

export interface InboundChannelMessage {
  channel: 'telegram' | 'discord' | 'slack' | 'whatsapp';
  senderId: string;
  text: string;
  timestamp: number;
}

export interface InboundReply {
  authorized: boolean;
  replyText?: string;
  reason?: string;
}

export interface ChannelSupervisorOptions {
  executeCommand?: (commandText: string) => Promise<string>;
  transport?: (channel: string, text: string) => Promise<boolean>;
}

const TIMEOUT_MS = 8000;
const dmChannelCache = new Map<string, string>();

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  return fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
}

export async function resolveDiscordDmChannel(
  token: string,
  userId: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const key = `${token}:${userId}`;
  const cached = dmChannelCache.get(key);
  if (cached) return cached;
  const res = await postJson(
    'https://discord.com/api/v10/users/@me/channels',
    { recipient_id: userId },
    { Authorization: `Bot ${token}` },
    fetchImpl
  );
  if (!res.ok) throw new Error(`Could not open DM channel with Discord user: HTTP ${res.status}`);
  const data = (await res.json()) as { id?: string };
  if (!data?.id) throw new Error('Could not open DM channel with Discord user.');
  dmChannelCache.set(key, data.id);
  return data.id;
}

export async function telegramSend(
  token: string,
  chatId: string,
  text: string,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  if (!token || !chatId) return false;
  try {
    const res = await postJson(
      `https://api.telegram.org/bot${token}/sendMessage`,
      { chat_id: chatId, text: safe(text).slice(0, 4000), disable_web_page_preview: true },
      {},
      fetchImpl
    );
    return res.ok;
  } catch (err) {
    console.error('[channels:telegram] delivery failed:', (err as Error).message);
    return false;
  }
}

export async function discordSend(
  cfg: {
    botToken?: string;
    channelId?: string;
    allowed?: string[];
    webhookUrl?: string;
  },
  text: string,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  const botToken = cfg.botToken?.trim();
  const allowed = cfg.allowed ?? [];
  const targets: string[] = [];

  if (botToken && allowed.length > 0) {
    for (const uid of allowed) {
      try {
        const dm = await resolveDiscordDmChannel(botToken, uid, fetchImpl);
        if (dm && !targets.includes(dm)) targets.push(dm);
      } catch (err) {
        console.error(`[channels:discord] DM resolve failed for ${uid}:`, (err as Error).message);
      }
    }
  }

  if (botToken && cfg.channelId && !targets.includes(cfg.channelId)) {
    targets.push(cfg.channelId);
  }

  if (botToken && targets.length > 0) {
    const headers = { Authorization: `Bot ${botToken}` };
    const body = { content: safe(text).slice(0, 1990), allowed_mentions: { parse: [] } };
    let anySent = false;
    for (const t of targets) {
      try {
        const r = await postJson(`https://discord.com/api/v10/channels/${t}/messages`, body, headers, fetchImpl);
        if (r.ok) anySent = true;
      } catch (e) {
        console.error(`[channels:discord] message to ${t} failed:`, (e as Error).message);
      }
    }
    return anySent;
  }

  if (cfg.webhookUrl) {
    try {
      const r = await postJson(cfg.webhookUrl, { content: safe(text).slice(0, 1990), allowed_mentions: { parse: [] } }, {}, fetchImpl);
      return r.ok;
    } catch (e) {
      console.error('[channels:discord] webhook send failed:', (e as Error).message);
      return false;
    }
  }

  return false;
}

export async function slackSend(
  webhookUrl: string,
  text: string,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  if (!webhookUrl) return false;
  try {
    const r = await postJson(webhookUrl, { text: safe(text).slice(0, 3900) }, {}, fetchImpl);
    return r.ok;
  } catch (err) {
    console.error('[channels:slack] delivery failed:', (err as Error).message);
    return false;
  }
}

export async function whatsappSend(
  cfg: {
    token?: string;
    phoneNumberId?: string;
    to?: string;
    graphVersion?: string;
  },
  text: string,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  const { token, phoneNumberId, to, graphVersion = 'v26.0' } = cfg;
  if (!token || !phoneNumberId || !to) return false;
  try {
    const r = await postJson(
      `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(phoneNumberId)}/messages`,
      { messaging_product: 'whatsapp', to, type: 'text', text: { body: safe(text).slice(0, 4000), preview_url: false } },
      { Authorization: `Bearer ${token}` },
      fetchImpl
    );
    return r.ok;
  } catch (err) {
    console.error('[channels:whatsapp] delivery failed:', (err as Error).message);
    return false;
  }
}

export async function broadcastChannelMessage(
  env: NodeJS.ProcessEnv,
  text: string,
  fetchImpl: typeof fetch = fetch
): Promise<Record<string, boolean>> {
  const results: Record<string, boolean> = {};

  // Telegram
  const tgToken = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
  const tgChatId = (env.TELEGRAM_CHAT_ID ?? '').trim();
  if (tgToken && tgChatId) {
    results.telegram = await telegramSend(tgToken, tgChatId, text, fetchImpl);
  }

  // Discord
  const dcBot = (env.DISCORD_BOT_TOKEN ?? '').trim();
  const dcChannel = (env.DISCORD_CHANNEL_ID ?? '').trim();
  const dcAllowed = (env.DISCORD_ALLOWED_USER_IDS ?? '').split(/[\s,]+/).filter(Boolean);
  const dcWebhook = (env.DISCORD_WEBHOOK_URL ?? '').trim();
  if ((dcBot && (dcChannel || dcAllowed.length > 0)) || dcWebhook) {
    results.discord = await discordSend({ botToken: dcBot, channelId: dcChannel, allowed: dcAllowed, webhookUrl: dcWebhook }, text, fetchImpl);
  }

  // Slack
  const slackUrl = (env.SLACK_WEBHOOK_URL ?? '').trim();
  if (slackUrl) {
    results.slack = await slackSend(slackUrl, text, fetchImpl);
  }

  // WhatsApp
  const waToken = (env.WHATSAPP_ACCESS_TOKEN ?? '').trim();
  const waPhoneId = (env.WHATSAPP_PHONE_NUMBER_ID ?? '').trim();
  const waTo = (env.WHATSAPP_TO ?? '').trim();
  if (waToken && waPhoneId && waTo) {
    results.whatsapp = await whatsappSend({ token: waToken, phoneNumberId: waPhoneId, to: waTo }, text, fetchImpl);
  }

  return results;
}

export const V2_CHANNELS = ['telegram', 'discord', 'slack', 'whatsapp'] as const;
export type V2ChannelName = (typeof V2_CHANNELS)[number];

export function isChannelV2(v: unknown): v is V2ChannelName {
  return typeof v === 'string' && (V2_CHANNELS as readonly string[]).includes(v);
}

export const CHANNEL_LINKS_CHECKED_ON = '2026-11-01';

export const SUPERVISOR_ENV = [
  { env: 'CHANNEL_COMMANDS', text: 'on lets allowlisted users send status, report, positions, kill. Default off.' },
  { env: 'SUPERVISOR', text: 'off disables the Desk Lead. Default on when a channel is set.' },
  { env: 'SUPERVISOR_INTERVAL_MIN', text: 'minutes between Desk Lead checks. Default 5.' },
  { env: 'ALERT_COOLDOWN_MIN', text: 'minutes before the same alert repeats (it repeats sooner if it gets worse). Default 30.' }
];

export const NOT_SHIPPED = {
  michat: 'MiChat publishes no bot or developer API (checked michat.sg, its terms, privacy policy and app store pages on 2026-10-17), and its terms forbid automation software and bots. Nothing is shipped; use Telegram, Discord, Slack or WhatsApp.',
  email: 'Sending needs an SMTP client dependency or a provider-specific API, and inbound email cannot be authenticated well enough to accept commands. Use a channel above; most of them also notify by email or phone.'
};

export const DISCORD_COMMANDS = [
  { name: 'status', description: 'Desk status (read only)', type: 1 },
  { name: 'report', description: 'Latest desk report (read only)', type: 1 },
  { name: 'positions', description: 'Open positions and stops (read only)', type: 1 },
  { name: 'kill', description: 'Kill switch (requires confirmation)', type: 1 }
];

export function discordRegisterCommand(appIdVar = '$DISCORD_APPLICATION_ID', tokenVar = '$DISCORD_BOT_TOKEN'): string {
  return `curl -X PUT "https://discord.com/api/v10/applications/${appIdVar}/commands" -H "Authorization: Bot ${tokenVar}" -H "Content-Type: application/json" -d '${JSON.stringify(DISCORD_COMMANDS)}'`;
}

export const DiscordBotBody = z.object({
  token: z.string().optional(),
  guildId: z.string().optional()
});

export const V2_CHANNEL_GUIDES: Record<V2ChannelName, {
  label: string;
  official: string;
  outbound: string;
  inbound: string;
  publicUrl: boolean;
  fields: Array<{ env: string; label: string; secret: boolean; required: boolean; hint: string }>;
  steps: Array<{ title: string; text: string; links: Array<{ label: string; url: string; login?: boolean }> }>;
  notes: string[];
  docs: Array<{ label: string; url: string }>;
}> = {
  telegram: {
    label: 'Telegram',
    official: 'Official Telegram Bot API (no third party bot frameworks, no Telegram user account libraries)',
    outbound: 'sendMessage to your chat ID',
    inbound: 'getUpdates long polling from this computer: no public URL, port forward, tunnel or webhook needed',
    publicUrl: false,
    fields: [
      { env: 'TELEGRAM_BOT_TOKEN', label: 'Bot token from @BotFather', secret: true, required: true, hint: 'format: 123456:ABC-DEF...' },
      { env: 'TELEGRAM_CHAT_ID', label: 'Your chat ID (start a chat with your bot first)', secret: false, required: true, hint: 'numbers only, negative for groups' },
      { env: 'TELEGRAM_ALLOWED_USER_IDS', label: 'User IDs allowed to send commands (empty = alerts only, no commands)', secret: false, required: false, hint: 'space or comma separated' }
    ],
    steps: [
      { title: 'Create your bot with @BotFather', text: 'Open Telegram, start a chat with @BotFather, type /newbot and follow the prompts. It will give you a bot token.', links: [{ label: 'Open @BotFather', url: 'https://t.me/BotFather' }] },
      { title: 'Start your bot and get your chat ID', text: 'Send /start to your new bot. Then click Find my chat below to discover your chat ID and user ID.', links: [] }
    ],
    notes: ['Telegram commands use long polling directly from this computer.'],
    docs: [{ label: 'Telegram Bot API', url: 'https://core.telegram.org/bots/api' }]
  },
  discord: {
    label: 'Discord',
    official: 'Official Discord Bot API and Webhooks',
    outbound: 'Bot message or Webhook',
    inbound: 'Gateway WebSocket or Interactions webhook',
    publicUrl: false,
    fields: [
      { env: 'DISCORD_BOT_TOKEN', label: 'Bot token from Discord Developer Portal', secret: true, required: false, hint: 'starts with M, N or O' },
      { env: 'DISCORD_CHANNEL_ID', label: 'Server channel ID for broadcast', secret: false, required: false, hint: 'right click channel -> Copy ID' },
      { env: 'DISCORD_ALLOWED_USER_IDS', label: 'Allowed user IDs for direct message chat', secret: false, required: false, hint: 'your user ID' },
      { env: 'DISCORD_WEBHOOK_URL', label: 'Webhook URL (simpler, alerts only)', secret: true, required: false, hint: 'https://discord.com/api/webhooks/...' }
    ],
    steps: [
      { title: 'Create Discord Bot', text: 'Create an application on the Discord Developer Portal, add a Bot, and copy the Bot Token.', links: [{ label: 'Discord Developers', url: 'https://discord.com/developers/applications' }] }
    ],
    notes: ['Bot API supports two-way DM commands; Webhooks are alert-only.'],
    docs: [{ label: 'Discord API', url: 'https://discord.com/developers/docs/intro' }]
  },
  slack: {
    label: 'Slack',
    official: 'Official Slack Webhooks and Bot API',
    outbound: 'Incoming Webhook',
    inbound: 'Slack Events API',
    publicUrl: true,
    fields: [
      { env: 'SLACK_WEBHOOK_URL', label: 'Incoming Webhook URL', secret: true, required: true, hint: 'https://hooks.slack.com/services/...' },
      { env: 'SLACK_SIGNING_SECRET', label: 'Signing secret (for inbound commands)', secret: true, required: false, hint: 'from Basic Information' },
      { env: 'SLACK_ALLOWED_USER_IDS', label: 'Allowed user IDs for commands', secret: false, required: false, hint: 'U...' }
    ],
    steps: [
      { title: 'Create Incoming Webhook', text: 'Create an app in Slack API portal, enable Incoming Webhooks, and add to your channel.', links: [{ label: 'Slack Apps', url: 'https://api.slack.com/apps' }] }
    ],
    notes: ['Incoming Webhooks deliver alerts to your chosen Slack channel.'],
    docs: [{ label: 'Slack Webhooks', url: 'https://api.slack.com/messaging/webhooks' }]
  },
  whatsapp: {
    label: 'WhatsApp',
    official: 'Meta WhatsApp Business Cloud API',
    outbound: 'Cloud API /messages',
    inbound: 'Meta Webhooks',
    publicUrl: true,
    fields: [
      { env: 'WHATSAPP_ACCESS_TOKEN', label: 'Access Token', secret: true, required: true, hint: 'from Meta Developers' },
      { env: 'WHATSAPP_PHONE_NUMBER_ID', label: 'Phone Number ID', secret: false, required: true, hint: 'digits only' },
      { env: 'WHATSAPP_TO', label: 'Your recipient WhatsApp number', secret: false, required: true, hint: 'country code, digits only' },
      { env: 'WHATSAPP_TEMPLATE_NAME', label: 'Utility template name (for alerts outside 24h)', secret: false, required: false, hint: 'e.g. desk_alert' }
    ],
    steps: [
      { title: 'Meta Cloud API Setup', text: 'Set up WhatsApp Business Cloud API in Meta Developer Portal and get your credentials.', links: [{ label: 'Meta Developers', url: 'https://developers.facebook.com/' }] }
    ],
    notes: ['Free-form text only reaches within 24h of your last message unless an approved template is used.'],
    docs: [{ label: 'WhatsApp Cloud API', url: 'https://developers.facebook.com/docs/whatsapp/cloud-api' }]
  }
};

export function channelStatusV2(env: NodeJS.ProcessEnv) {
  const tgToken = !!(env.TELEGRAM_BOT_TOKEN ?? '').trim();
  const tgChat = !!(env.TELEGRAM_CHAT_ID ?? '').trim();
  const tgAllowed = (env.TELEGRAM_ALLOWED_USER_IDS ?? '').split(/[\s,]+/).filter(Boolean);

  const dcBot = !!(env.DISCORD_BOT_TOKEN ?? '').trim();
  const dcChannel = !!(env.DISCORD_CHANNEL_ID ?? '').trim();
  const dcAllowed = (env.DISCORD_ALLOWED_USER_IDS ?? '').split(/[\s,]+/).filter(Boolean);
  const dcWebhook = !!(env.DISCORD_WEBHOOK_URL ?? '').trim();

  const slWebhook = !!(env.SLACK_WEBHOOK_URL ?? '').trim();
  const slSecret = !!(env.SLACK_SIGNING_SECRET ?? '').trim();
  const slAllowed = (env.SLACK_ALLOWED_USER_IDS ?? '').split(/[\s,]+/).filter(Boolean);

  const waToken = !!(env.WHATSAPP_ACCESS_TOKEN ?? '').trim();
  const waPhone = !!(env.WHATSAPP_PHONE_NUMBER_ID ?? '').trim();
  const waTo = !!(env.WHATSAPP_TO ?? '').trim();
  const waAllowed = (env.WHATSAPP_ALLOWED_NUMBERS ?? '').split(/[\s,]+/).filter(Boolean);

  const tgEnabled = tgToken && tgChat;
  const dcEnabled = (dcBot && (dcChannel || dcAllowed.length > 0)) || dcWebhook;
  const slEnabled = slWebhook;
  const waEnabled = waToken && waPhone && waTo;

  return {
    commands: /^on$/i.test((env.CHANNEL_COMMANDS ?? '').trim()),
    supervisor: {
      on: (tgEnabled || dcEnabled || slEnabled || waEnabled) && !/^off$/i.test((env.SUPERVISOR ?? '').trim()),
      intervalMin: Math.max(1, Number(env.SUPERVISOR_INTERVAL_MIN) || 5),
      cooldownMin: Math.max(1, Number(env.ALERT_COOLDOWN_MIN) || 30)
    },
    channels: [
      {
        channel: 'telegram',
        label: 'Telegram',
        enabled: tgEnabled,
        commandsReady: tgEnabled && tgAllowed.length > 0,
        fields: [
          { env: 'TELEGRAM_BOT_TOKEN', set: tgToken, shown: null },
          { env: 'TELEGRAM_CHAT_ID', set: tgChat, shown: env.TELEGRAM_CHAT_ID ?? null },
          { env: 'TELEGRAM_ALLOWED_USER_IDS', set: tgAllowed.length > 0, shown: env.TELEGRAM_ALLOWED_USER_IDS ?? null }
        ]
      },
      {
        channel: 'discord',
        label: 'Discord',
        enabled: dcEnabled,
        commandsReady: dcBot && dcAllowed.length > 0,
        fields: [
          { env: 'DISCORD_BOT_TOKEN', set: dcBot, shown: null },
          { env: 'DISCORD_CHANNEL_ID', set: dcChannel, shown: env.DISCORD_CHANNEL_ID ?? null },
          { env: 'DISCORD_GUILD_ID', set: !!(env.DISCORD_GUILD_ID ?? '').trim(), shown: env.DISCORD_GUILD_ID ?? null },
          { env: 'DISCORD_APPLICATION_ID', set: !!(env.DISCORD_APPLICATION_ID ?? '').trim(), shown: env.DISCORD_APPLICATION_ID ?? null },
          { env: 'DISCORD_DELIVERY', set: !!(env.DISCORD_DELIVERY ?? '').trim(), shown: env.DISCORD_DELIVERY ?? null },
          { env: 'DISCORD_WEBHOOK_URL', set: dcWebhook, shown: null },
          { env: 'DISCORD_PUBLIC_KEY', set: !!(env.DISCORD_PUBLIC_KEY ?? '').trim(), shown: null },
          { env: 'DISCORD_ALLOWED_USER_IDS', set: dcAllowed.length > 0, shown: env.DISCORD_ALLOWED_USER_IDS ?? null }
        ]
      },
      {
        channel: 'slack',
        label: 'Slack',
        enabled: slEnabled,
        commandsReady: slEnabled && slSecret && slAllowed.length > 0,
        fields: [
          { env: 'SLACK_WEBHOOK_URL', set: slWebhook, shown: null },
          { env: 'SLACK_SIGNING_SECRET', set: slSecret, shown: null },
          { env: 'SLACK_ALLOWED_USER_IDS', set: slAllowed.length > 0, shown: env.SLACK_ALLOWED_USER_IDS ?? null }
        ]
      },
      {
        channel: 'whatsapp',
        label: 'WhatsApp',
        enabled: waEnabled,
        commandsReady: waEnabled && waAllowed.length > 0,
        fields: [
          { env: 'WHATSAPP_ACCESS_TOKEN', set: waToken, shown: null },
          { env: 'WHATSAPP_PHONE_NUMBER_ID', set: waPhone, shown: env.WHATSAPP_PHONE_NUMBER_ID ?? null },
          { env: 'WHATSAPP_TO', set: waTo, shown: env.WHATSAPP_TO ?? null },
          { env: 'WHATSAPP_TEMPLATE_NAME', set: !!(env.WHATSAPP_TEMPLATE_NAME ?? '').trim(), shown: env.WHATSAPP_TEMPLATE_NAME ?? null },
          { env: 'WHATSAPP_APP_SECRET', set: !!(env.WHATSAPP_APP_SECRET ?? '').trim(), shown: null },
          { env: 'WHATSAPP_VERIFY_TOKEN', set: !!(env.WHATSAPP_VERIFY_TOKEN ?? '').trim(), shown: null },
          { env: 'WHATSAPP_ALLOWED_NUMBERS', set: waAllowed.length > 0, shown: env.WHATSAPP_ALLOWED_NUMBERS ?? null }
        ]
      }
    ]
  };
}

export async function testChannelV2(
  env: NodeJS.ProcessEnv,
  channel: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; detail: string }> {
  const msg = `Test message from Trading Agent Mpu Gandring (${(env.TRADING_MODE || 'PAPER').toUpperCase()}). If you can read this, the Desk Lead can reach you here.`;
  if (channel === 'telegram') {
    const token = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
    const chatId = (env.TELEGRAM_CHAT_ID ?? '').trim();
    if (!token || !chatId) return { ok: false, detail: 'Telegram is not configured (TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID required).' };
    const ok = await telegramSend(token, chatId, msg, fetchImpl);
    return ok ? { ok: true, detail: 'Test message sent to Telegram.' } : { ok: false, detail: 'Telegram did not accept the message.' };
  }
  if (channel === 'discord') {
    const dcBot = (env.DISCORD_BOT_TOKEN ?? '').trim();
    const dcChannel = (env.DISCORD_CHANNEL_ID ?? '').trim();
    const dcAllowed = (env.DISCORD_ALLOWED_USER_IDS ?? '').split(/[\s,]+/).filter(Boolean);
    const dcWebhook = (env.DISCORD_WEBHOOK_URL ?? '').trim();
    if (!((dcBot && (dcChannel || dcAllowed.length > 0)) || dcWebhook)) {
      return { ok: false, detail: 'Discord is not configured (Bot Token and server/channel or allowed user IDs required).' };
    }
    const ok = await discordSend({ botToken: dcBot, channelId: dcChannel, allowed: dcAllowed, webhookUrl: dcWebhook }, msg, fetchImpl);
    return ok ? { ok: true, detail: 'Test message sent to Discord.' } : { ok: false, detail: 'Discord did not accept the message.' };
  }
  if (channel === 'slack') {
    const webhook = (env.SLACK_WEBHOOK_URL ?? '').trim();
    if (!webhook) return { ok: false, detail: 'Slack is not configured (SLACK_WEBHOOK_URL required).' };
    const ok = await slackSend(webhook, msg, fetchImpl);
    return ok ? { ok: true, detail: 'Test message sent to Slack.' } : { ok: false, detail: 'Slack did not accept the message.' };
  }
  if (channel === 'whatsapp') {
    const token = (env.WHATSAPP_ACCESS_TOKEN ?? '').trim();
    const phoneId = (env.WHATSAPP_PHONE_NUMBER_ID ?? '').trim();
    const to = (env.WHATSAPP_TO ?? '').trim();
    if (!token || !phoneId || !to) return { ok: false, detail: 'WhatsApp is not configured (token, phone number ID, recipient phone required).' };
    const ok = await whatsappSend({ token, phoneNumberId: phoneId, to }, msg, fetchImpl);
    return ok ? { ok: true, detail: 'Test message sent to WhatsApp.' } : { ok: false, detail: 'WhatsApp did not accept the message.' };
  }
  return { ok: false, detail: `Unknown channel: ${channel}` };
}

export function saveChannelV2(
  envFile: string,
  channel: string,
  input: Record<string, string | undefined>,
  options: { commands?: boolean } = {}
): { ok: boolean; detail: string } {
  const updates: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined) {
      updates[k] = v.trim();
    }
  }
  if (options.commands !== undefined) {
    updates.CHANNEL_COMMANDS = options.commands ? 'on' : 'off';
  }

  let text = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
  for (const [k, v] of Object.entries(updates)) {
    process.env[k] = v;
    const regex = new RegExp(`^${k}=.*$`, 'm');
    if (regex.test(text)) {
      text = text.replace(regex, `${k}=${v}`);
    } else {
      text += `\n${k}=${v}`;
    }
  }
  writeFileSync(envFile, text, 'utf8');
  return { ok: true, detail: `${channel} saved to .env.` };
}

export function resetChannelV2(envFile: string, channel: string): { ok: boolean; detail: string } {
  const prefixes: Record<string, string[]> = {
    telegram: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_ALLOWED_USER_IDS'],
    discord: ['DISCORD_BOT_TOKEN', 'DISCORD_CHANNEL_ID', 'DISCORD_GUILD_ID', 'DISCORD_APPLICATION_ID', 'DISCORD_DELIVERY', 'DISCORD_WEBHOOK_URL', 'DISCORD_PUBLIC_KEY', 'DISCORD_ALLOWED_USER_IDS'],
    slack: ['SLACK_WEBHOOK_URL', 'SLACK_SIGNING_SECRET', 'SLACK_ALLOWED_USER_IDS'],
    whatsapp: ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_TO', 'WHATSAPP_TEMPLATE_NAME', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_ALLOWED_NUMBERS']
  };

  const keys = prefixes[channel] ?? [];
  let text = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
  for (const k of keys) {
    delete process.env[k];
    const regex = new RegExp(`^${k}=.*$`, 'm');
    if (regex.test(text)) {
      text = text.replace(regex, `${k}=`);
    }
  }
  writeFileSync(envFile, text, 'utf8');
  return { ok: true, detail: `${channel} configuration has been reset.` };
}

export async function telegramChatsV2(
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; detail: string; chats: Array<{ chatId: string; chat: string; userId: string; user: string }> }> {
  if (!token) return { ok: false, detail: 'Bot token required.', chats: [] };
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/getUpdates?allowed_updates=["message"]`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { ok: false, detail: `Telegram HTTP ${res.status}`, chats: [] };
    const data = (await res.json()) as any;
    if (!data?.ok) return { ok: false, detail: data?.description ?? 'Telegram error', chats: [] };
    const chats = (data.result ?? [])
      .map((u: any) => ({
        chatId: String(u.message?.chat?.id ?? ''),
        chat: String(u.message?.chat?.title ?? u.message?.chat?.username ?? u.message?.chat?.first_name ?? ''),
        userId: String(u.message?.from?.id ?? ''),
        user: String(u.message?.from?.username ?? u.message?.from?.first_name ?? '')
      }))
      .filter((c: any) => c.chatId);
    return { ok: true, detail: chats.length ? 'Chats found.' : 'No messages yet.', chats };
  } catch (err) {
    return { ok: false, detail: (err as Error).message, chats: [] };
  }
}

export async function syncDiscordCommandsV2(
  token: string,
  appId: string,
  guildId?: string,
  fetchImpl: typeof fetch = fetch
) {
  if (!token || !appId) throw new Error('Bot token and application ID required.');
  const url = guildId
    ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
    : `https://discord.com/api/v10/applications/${appId}/commands`;
  const res = await fetchImpl(url, {
    method: 'PUT',
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(DISCORD_COMMANDS)
  });
  if (!res.ok) throw new Error(`Discord error: HTTP ${res.status}`);
  return (await res.json()) as unknown[];
}

export async function inspectDiscordBotV2(
  token: string,
  guildId?: string,
  fetchImpl: typeof fetch = fetch
) {
  if (!token) throw new Error('Bot token required.');
  const headers = { Authorization: `Bot ${token}` };
  const appRes = await fetchImpl('https://discord.com/api/v10/oauth2/applications/@me', { headers });
  if (!appRes.ok) throw new Error(`Invalid bot token: HTTP ${appRes.status}`);
  const app = (await appRes.json()) as { id: string; verify_key?: string };

  const guildsRes = await fetchImpl('https://discord.com/api/v10/users/@me/guilds', { headers });
  const guilds = guildsRes.ok ? ((await guildsRes.json()) as Array<{ id: string; name: string }>) : [];

  let channels: Array<{ id: string; name: string }> = [];
  if (guildId) {
    const chRes = await fetchImpl(`https://discord.com/api/v10/guilds/${guildId}/channels`, { headers });
    if (chRes.ok) {
      const list = (await chRes.json()) as Array<{ id: string; name: string; type: number }>;
      channels = list.filter((c) => c.type === 0).map((c) => ({ id: c.id, name: c.name }));
    }
  }

  return {
    application: app,
    guilds,
    channels,
    delivery: 'gateway',
    installUrl: `https://discord.com/oauth2/authorize?client_id=${app.id}&scope=bot%20applications.commands&permissions=2048`
  };
}

export class ChannelSupervisor {
  constructor(
    private config: ChannelConfig,
    private options: ChannelSupervisorOptions = {}
  ) {}

  public async handleInbound(message: InboundChannelMessage): Promise<InboundReply> {
    const isOwner = this.isAllowlisted(message.channel, message.senderId);

    if (!isOwner) {
      return {
        authorized: false,
        reason: `Sender ${message.senderId} is not in the Owner allowlist for ${message.channel}.`
      };
    }

    let replyText = `Command received: "${safe(message.text)}"`;
    if (this.options.executeCommand) {
      replyText = await this.options.executeCommand(message.text);
    }

    return {
      authorized: true,
      replyText
    };
  }

  private isAllowlisted(channel: string, senderId: string): boolean {
    if (channel === 'telegram') {
      const allowed = this.config.telegram?.ownerUserIds ?? [];
      return allowed.includes(senderId);
    }
    if (channel === 'discord') {
      const allowed = this.config.discord?.ownerUserIds ?? [];
      return allowed.includes(senderId);
    }
    if (channel === 'slack') {
      const allowed = this.config.slack?.ownerUserIds ?? [];
      return allowed.includes(senderId);
    }
    if (channel === 'whatsapp') {
      const allowed = this.config.whatsapp?.ownerPhoneNumbers ?? [];
      return allowed.includes(senderId);
    }
    return false;
  }

  public async sendAlert(text: string): Promise<boolean> {
    if (this.options.transport) {
      const enabledChannels = Object.keys(this.config) as Array<keyof ChannelConfig>;
      for (const ch of enabledChannels) {
        if (this.config[ch]?.enabled) {
          await this.options.transport(ch, text);
        }
      }
      return true;
    }
    return true;
  }

  public getStatus(): Record<string, { configured: boolean; maskedToken?: string }> {
    const mask = (token?: string) => {
      if (!token || token.length < 6) return '****';
      return `${token.slice(0, 6)}****`;
    };

    return {
      telegram: {
        configured: Boolean(this.config.telegram?.enabled && this.config.telegram.botToken),
        maskedToken: mask(this.config.telegram?.botToken)
      },
      discord: {
        configured: Boolean(this.config.discord?.enabled && (this.config.discord.webhookUrl || this.config.discord.botToken))
      },
      slack: {
        configured: Boolean(this.config.slack?.enabled && this.config.slack.webhookUrl)
      },
      whatsapp: {
        configured: Boolean(this.config.whatsapp?.enabled && this.config.whatsapp.verifyToken)
      }
    };
  }

  public verifyWhatsAppChallenge(mode?: string, token?: string, challenge?: string): string | null {
    if (mode === 'subscribe' && token === this.config.whatsapp?.verifyToken && challenge) {
      return challenge;
    }
    return null;
  }
}

export const HELP_TEXT = [
  'Trading Agent Mpu Gandring Commands:',
  '• /status: Balance, equity, venue, guards status',
  '• /positions: Active positions and resting exchange stops',
  '• /report: Latest performance and execution report',
  '• /scan: Instant proactive scan for desk alerts',
  '• /analyze <symbol>: Direct agents to debate & auto-trade (e.g. /analyze BTCUSDT)',
  '• /ask <question>: Chat with Desk Lead (or /ask <agent> <question>)',
  '• /set profile <default|balance|profit|aggressive>, /set size <1.5..100>%, /set leverage <1..20>',
  '• /open long|short <symbol> [size%] [leverage]',
  '• /close <symbol> or /close all: Execute directly using the active settings',
  '• /watchlist: Active auto-trading symbols',
  '• /scorecard: Agent performance & win rate',
  '• /lessons: Recent self-improving lessons',
  '• /cautious or /aggressive: Adjust agent risk appetite',
  '• /kill: Emergency stop (send "kill confirm" to flatten all positions)'
].join('\n');

const DISCORD_API = 'https://discord.com/api/v10';
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function verifyDiscord(
  publicKeyHex: string,
  raw: Buffer | string,
  ts: string | undefined,
  sigHex: string | undefined,
  nowS = Math.floor(Date.now() / 1000)
): boolean {
  try {
    if (!/^[0-9a-f]{64}$/i.test(publicKeyHex) || !ts || !sigHex || !/^[0-9a-f]{128}$/i.test(sigHex)) return false;
    if (!/^\d{1,12}$/.test(ts) || Math.abs(nowS - Number(ts)) > 300) return false;
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]),
      format: 'der',
      type: 'spki'
    });
    return edVerify(
      null,
      Buffer.concat([Buffer.from(ts, 'utf8'), Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8')]),
      key,
      Buffer.from(sigHex, 'hex')
    );
  } catch {
    return false;
  }
}

export interface DiscordOption {
  name?: string;
  type?: number;
  value?: unknown;
  options?: DiscordOption[];
}

export interface DiscordInteraction {
  id?: string;
  token?: string;
  application_id?: string;
  type?: number;
  guild_id?: string;
  channel_id?: string;
  member?: { user?: { id?: string } };
  user?: { id?: string };
  data?: { name?: string; options?: DiscordOption[] };
}

export function discordCommandText(data: DiscordInteraction['data']): string {
  if (!data?.name) return 'help';
  const cmd = data.name.toLowerCase();
  const group = (data.options ?? []).find((o) => o.options && o.options.length > 0);
  if (group && group.name) {
    return discordCommandText({ name: group.name, options: group.options });
  }
  return [
    cmd,
    ...(data.options ?? []).flatMap((o) =>
      o.options
        ? [discordCommandText({ name: o.name, options: o.options })]
        : o.value !== undefined
        ? [String(o.value)]
        : []
    )
  ]
    .join(' ')
    .trim();
}

export class DiscordGateway {
  private socket: WebSocket | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private stopped = true;
  private sequence: number | null = null;
  private session: string | null = null;
  private resumeUrl = 'wss://gateway.discord.gg';
  private acknowledged = true;
  private seen = new Map<string, number>();
  status = 'disconnected';

  constructor(
    private config: () => {
      commands?: boolean;
      discord?: {
        botToken?: string;
        channelId?: string;
        guildId?: string;
        applicationId?: string;
        allowed?: string[];
        ownerUserIds?: string[];
      };
    },
    private fetchImpl: typeof fetch = fetch,
    private executeCommand?: (cmdText: string, actor: string) => Promise<string>,
    private onKill?: () => void
  ) {}

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.retry) clearTimeout(this.retry);
    this.socket?.close();
    this.socket = null;
    this.status = 'disconnected';
  }

  private connect() {
    if (this.stopped) return;
    this.status = 'connecting';
    const socket = new WebSocket(`${this.resumeUrl}/?v=10&encoding=json`);
    this.socket = socket;
    const send = (value: unknown) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
    };

    socket.on('message', (raw) => {
      try {
        const packet = JSON.parse(raw.toString()) as {
          op: number;
          s?: number;
          t?: string;
          d: Record<string, unknown>;
        };
        if (typeof packet.s === 'number') this.sequence = packet.s;
        if (packet.op === 10) {
          const interval = Number(packet.d.heartbeat_interval);
          if (!Number.isFinite(interval) || interval < 1000) {
            socket.close();
            return;
          }
          if (this.heartbeat) clearInterval(this.heartbeat);
          this.acknowledged = true;
          this.heartbeat = setInterval(() => {
            if (!this.acknowledged) {
              socket.terminate();
              return;
            }
            this.acknowledged = false;
            send({ op: 1, d: this.sequence });
          }, interval);
          this.heartbeat.unref();

          const token = this.config().discord?.botToken;
          if (this.session) {
            send({ op: 6, d: { token, session_id: this.session, seq: this.sequence } });
          } else {
            send({
              op: 2,
              d: {
                token,
                intents: 1,
                properties: {
                  os: process.platform,
                  browser: 'Trading Agent Mpu Gandring',
                  device: 'Trading Agent Mpu Gandring'
                }
              }
            });
          }
        } else if (packet.op === 11) {
          this.acknowledged = true;
        } else if (packet.op === 1) {
          send({ op: 1, d: this.sequence });
        } else if (packet.op === 7) {
          socket.close();
        } else if (packet.op === 9) {
          this.session = null;
          this.sequence = null;
          socket.close();
        } else if (packet.t === 'READY') {
          this.session = String(packet.d.session_id);
          if (
            typeof packet.d.resume_gateway_url === 'string' &&
            /^wss:\/\/[^/]+\.discord\.gg\/?$/.test(packet.d.resume_gateway_url)
          ) {
            this.resumeUrl = packet.d.resume_gateway_url.replace(/\/$/, '');
          }
          this.status = 'connected';
        } else if (packet.t === 'RESUMED') {
          this.status = 'connected';
        } else if (packet.t === 'INTERACTION_CREATE') {
          void this.handle(packet.d as DiscordInteraction);
        }
      } catch {
        this.status = 'invalid_packet';
      }
    });

    socket.on('error', () => {
      this.status = 'connection_failed';
      socket.close();
    });

    socket.on('close', (code) => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.status = 'disconnected';
      if (!this.stopped && ![4004, 4010, 4011, 4013, 4014].includes(code)) {
        this.retry = setTimeout(() => this.connect(), 5000);
        this.retry.unref();
      }
    });
  }

  async handle(interaction: DiscordInteraction) {
    if (interaction.type !== 2 || !interaction.id || !interaction.token || this.seen.has(interaction.id)) return;
    const now = Date.now();
    for (const [id, at] of this.seen) if (now - at > 900_000) this.seen.delete(id);
    this.seen.set(interaction.id, now);

    const c = this.config();
    const userId = interaction.member?.user?.id ?? interaction.user?.id;
    const allowed = c.discord?.allowed ?? c.discord?.ownerUserIds ?? [];
    const commandsOn = c.commands !== false;

    let refusal: string | null = null;
    if (!commandsOn) {
      refusal = 'Chat commands are off on this desk (CHANNEL_COMMANDS=off).';
    } else if (!userId || !allowed.includes(userId)) {
      refusal = 'You are not on this desk\'s allowlist.';
    } else if (
      interaction.guild_id &&
      ((c.discord?.guildId && interaction.guild_id !== c.discord.guildId) ||
        (c.discord?.channelId && interaction.channel_id !== c.discord.channelId))
    ) {
      refusal = 'Use the configured server and channel.';
    }

    const appId =
      interaction.application_id ||
      c.discord?.applicationId ||
      (typeof process !== 'undefined' ? process.env?.DISCORD_APPLICATION_ID : undefined);

    try {
      const response = await this.fetchImpl(
        `${DISCORD_API}/interactions/${interaction.id}/${interaction.token}/callback`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            refusal
              ? { type: 4, data: { content: refusal, flags: 64, allowed_mentions: { parse: [] } } }
              : { type: 5, data: { flags: 64 } }
          ),
          signal: AbortSignal.timeout(2500)
        }
      );
      if (!response.ok || refusal) return;

      let content: string;
      const cmdText = discordCommandText(interaction.data);
      const actor = `discord:${userId ?? 'unknown'}`;
      try {
        if (this.executeCommand) {
          content = await this.executeCommand(cmdText, actor);
        } else {
          content = `Executed: ${cmdText}`;
        }
      } catch {
        content = 'The desk could not complete this command.';
      }

      if (appId) {
        await this.fetchImpl(
          `${DISCORD_API}/webhooks/${appId}/${interaction.token}/messages/@original`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: safe(content).slice(0, 1990),
              allowed_mentions: { parse: [] }
            }),
            signal: AbortSignal.timeout(8000)
          }
        );
      }
    } catch {
      this.status = 'interaction_failed';
    }
  }
}
