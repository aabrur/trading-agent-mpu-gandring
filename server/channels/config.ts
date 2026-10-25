// Chat channel settings, read from the environment (.env only). No imports from the rest of the app, so config.ts can use it.
export const CHANNELS = ['telegram', 'discord', 'slack', 'whatsapp'] as const;
export type ChannelName = (typeof CHANNELS)[number];
/** Channels we looked at and do not ship code for (see docs/channels.md for the reason). */
export const DOC_ONLY_CHANNELS = ['email', 'michat'] as const;

export interface ChannelConfig {
  /** CHANNEL_COMMANDS=on lets allowlisted users send the safe commands (status, report, positions, kill). Off by default. */
  commands: boolean;
  /** Port and bind address of the separate inbound webhook server (only /api/channels/*). */
  inbound: { port: number; host: string };
  supervisor: { on: boolean; intervalMin: number; cooldownMin: number };
  telegram: { enabled: boolean; token: string; chatId: string; allowed: string[] };
  discord: { botToken?: string; channelId?: string; guildId?: string; applicationId?: string; delivery?: 'gateway' | 'http'; enabled: boolean; webhookUrl: string; publicKey: string; allowed: string[]; inbound: boolean };
  slack: { enabled: boolean; webhookUrl: string; signingSecret: string; allowed: string[]; inbound: boolean };
  whatsapp: { enabled: boolean; token: string; phoneNumberId: string; to: string; appSecret: string; verifyToken: string; allowed: string[]; graphVersion: string; template: string; templateLang: string; inbound: boolean };
}

/** Env vars that hold secrets (redacted everywhere, masked in setup status, never echoed). */
export const CHANNEL_SECRET_ENV = ['DISCORD_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN', 'DISCORD_WEBHOOK_URL', 'SLACK_WEBHOOK_URL', 'SLACK_SIGNING_SECRET', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN'] as const;

const s = (env: NodeJS.ProcessEnv, k: string) => (env[k] ?? '').trim();
const list = (env: NodeJS.ProcessEnv, k: string) => s(env, k).split(/[\s,]+/).map((x) => x.replace(/^\+/, '')).filter(Boolean);
const n = (env: NodeJS.ProcessEnv, k: string, d: number) => { const v = Number(s(env, k)); return Number.isFinite(v) && s(env, k) !== '' ? v : d; };
export const DISCORD_WEBHOOK_RE = /^https:\/\/(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\/\d+\/[\w-]+$/;
export const SLACK_WEBHOOK_RE = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+$/;

export function channelConfig(env: NodeJS.ProcessEnv): ChannelConfig {
  const tg = { token: s(env, 'TELEGRAM_BOT_TOKEN'), chatId: s(env, 'TELEGRAM_CHAT_ID'), allowed: list(env, 'TELEGRAM_ALLOWED_USER_IDS') };
  const dc = { botToken: s(env, 'DISCORD_BOT_TOKEN'), channelId: s(env, 'DISCORD_CHANNEL_ID'), guildId: s(env, 'DISCORD_GUILD_ID'), applicationId: s(env, 'DISCORD_APPLICATION_ID'), delivery: (s(env, 'DISCORD_DELIVERY') === 'http' || !s(env, 'DISCORD_BOT_TOKEN') ? 'http' : 'gateway') as 'http' | 'gateway', webhookUrl: s(env, 'DISCORD_WEBHOOK_URL'), publicKey: s(env, 'DISCORD_PUBLIC_KEY').toLowerCase(), allowed: list(env, 'DISCORD_ALLOWED_USER_IDS') };
  const sl = { webhookUrl: s(env, 'SLACK_WEBHOOK_URL'), signingSecret: s(env, 'SLACK_SIGNING_SECRET'), allowed: list(env, 'SLACK_ALLOWED_USER_IDS') };
  const wa = { token: s(env, 'WHATSAPP_ACCESS_TOKEN'), phoneNumberId: s(env, 'WHATSAPP_PHONE_NUMBER_ID'), to: s(env, 'WHATSAPP_TO').replace(/^\+/, ''), appSecret: s(env, 'WHATSAPP_APP_SECRET'), verifyToken: s(env, 'WHATSAPP_VERIFY_TOKEN'), allowed: list(env, 'WHATSAPP_ALLOWED_NUMBERS'),
    graphVersion: /^v\d+\.\d+$/.test(s(env, 'WHATSAPP_GRAPH_VERSION')) ? s(env, 'WHATSAPP_GRAPH_VERSION') : 'v26.0', template: s(env, 'WHATSAPP_TEMPLATE_NAME'), templateLang: s(env, 'WHATSAPP_TEMPLATE_LANG') || 'en_US' };
  const any = !!(tg.token && tg.chatId) || !!(dc.botToken && (dc.channelId || dc.allowed.length > 0)) || DISCORD_WEBHOOK_RE.test(dc.webhookUrl) || SLACK_WEBHOOK_RE.test(sl.webhookUrl) || !!(wa.token && wa.phoneNumberId && wa.to);
  return {
    commands: /^on$/i.test(s(env, 'CHANNEL_COMMANDS')),
    inbound: { port: Math.max(1, Math.min(65535, n(env, 'CHANNEL_WEBHOOK_PORT', 8788))), host: s(env, 'CHANNEL_WEBHOOK_HOST') || '127.0.0.1' },
    supervisor: { on: any && !/^off$/i.test(s(env, 'SUPERVISOR')), intervalMin: Math.max(1, n(env, 'SUPERVISOR_INTERVAL_MIN', 5)), cooldownMin: Math.max(1, n(env, 'ALERT_COOLDOWN_MIN', 30)) },
    telegram: { ...tg, enabled: !!(tg.token && tg.chatId) },
    discord: { ...dc, enabled: !!(dc.botToken && (dc.channelId || dc.allowed.length > 0)) || DISCORD_WEBHOOK_RE.test(dc.webhookUrl), inbound: dc.delivery === 'http' && /^[0-9a-f]{64}$/.test(dc.publicKey) },
    slack: { ...sl, enabled: SLACK_WEBHOOK_RE.test(sl.webhookUrl), inbound: !!sl.signingSecret },
    whatsapp: { ...wa, enabled: !!(wa.token && wa.phoneNumberId && wa.to), inbound: !!(wa.appSecret && wa.verifyToken && wa.token && wa.phoneNumberId) }
  };
}
