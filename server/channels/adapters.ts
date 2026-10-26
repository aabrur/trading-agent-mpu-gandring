// Outbound adapters for the official APIs only: Telegram Bot API, Discord webhooks, Slack incoming webhooks, WhatsApp Business Cloud API (Meta Graph).
// Everything sent passes the secret redactor first. Failures are logged without the URL or token.
import { safe, log } from '../redact.js';
import { CHANNELS, type ChannelConfig, type ChannelName } from './config.js';
import { resolveDiscordDmChannel } from './discord.js';
import { recordDiagnostic } from '../session-log.js';

export type SendResult = 'sent' | 'failed' | 'off';
const T = 8000;
const post = (fetchImpl: typeof fetch, url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(T) });

async function attempt(name: ChannelName, fn: () => Promise<Response>): Promise<SendResult> {
  const started = Date.now();
  try { const r = await fn(); if (!r.ok) throw new Error(`HTTP ${r.status}`); recordDiagnostic({ source: `channel:${name}`, category: 'INTEGRATION', eventName: 'channel.delivered', status: 'delivered', durationMs: Date.now() - started, message: 'Channel message delivered', details: { httpStatus: r.status } }); return 'sent'; }
  catch (e) { recordDiagnostic({ source: `channel:${name}`, category: 'INTEGRATION', eventName: 'channel.failed', status: 'failed', level: 'WARN', durationMs: Date.now() - started, message: 'Channel delivery failed', details: { error: e } }); log(`[channel] ${name} not delivered: ${safe((e as Error).message).slice(0, 160)}`); return 'failed'; }
}

export function telegramSend(c: ChannelConfig['telegram'], text: string, fetchImpl: typeof fetch = fetch, chatId = c.chatId): Promise<SendResult> {
  if (!c.token || !chatId) return Promise.resolve('off');
  return attempt('telegram', () => post(fetchImpl, `https://api.telegram.org/bot${c.token}/sendMessage`, { chat_id: chatId, text: safe(text).slice(0, 4000), disable_web_page_preview: true }));
}
export async function discordSend(c: ChannelConfig['discord'], text: string, fetchImpl: typeof fetch = fetch): Promise<SendResult> {
  if (!c.enabled) return 'off';
  const targets: string[] = [];
  const botToken = c.botToken;
  if (botToken && c.allowed.length > 0) {
    const dms = await Promise.all(
      c.allowed.map(async (uid) => {
        try {
          return await resolveDiscordDmChannel(botToken, uid, fetchImpl);
        } catch (e) {
          log(`[channel] discord DM channel resolve failed for ${uid}: ${safe((e as Error).message).slice(0, 160)}`);
          return null;
        }
      })
    );
    for (const dm of dms) {
      if (dm && !targets.includes(dm)) targets.push(dm);
    }
  }
  // Guild/server channel is optional: send to it only when configured
  if (botToken && c.channelId && !targets.includes(c.channelId)) {
    targets.push(c.channelId);
  }
  if (botToken && targets.length > 0) {
    const headers: Record<string, string> = { Authorization: `Bot ${botToken}` };
    const body = { content: safe(text).slice(0, 1990), allowed_mentions: { parse: [] } };
    const results = await Promise.all(
      targets.map(targetChannel =>
        attempt('discord', () => post(fetchImpl, `https://discord.com/api/v10/channels/${targetChannel}/messages`, body, headers))
      )
    );
    return results.includes('sent') ? 'sent' : 'failed';
  }
  if (c.webhookUrl) {
    return attempt('discord', () => post(fetchImpl, c.webhookUrl, { content: safe(text).slice(0, 1990), allowed_mentions: { parse: [] } }));
  }
  return 'off';
}
export function slackSend(c: ChannelConfig['slack'], text: string, fetchImpl: typeof fetch = fetch): Promise<SendResult> {
  if (!c.enabled) return Promise.resolve('off');
  return attempt('slack', () => post(fetchImpl, c.webhookUrl, { text: safe(text).slice(0, 3900) }));
}
/** Free-form text only reaches a user inside the 24-hour window after they last messaged the number. Outside it Meta requires an
 *  approved template: set WHATSAPP_TEMPLATE_NAME (one body parameter, {{1}}) and alerts use it. */
export function whatsappSend(c: ChannelConfig['whatsapp'], text: string, fetchImpl: typeof fetch = fetch, to = c.to, freeForm = false): Promise<SendResult> {
  if (!c.token || !c.phoneNumberId || !to) return Promise.resolve('off');
  const body = safe(text);
  const msg = c.template && !freeForm
    ? { messaging_product: 'whatsapp', to, type: 'template', template: { name: c.template, language: { code: c.templateLang }, components: [{ type: 'body', parameters: [{ type: 'text', text: body.replace(/\s*\n\s*/g, ' | ').slice(0, 1000) }] }] } }
    : { messaging_product: 'whatsapp', to, type: 'text', text: { body: body.slice(0, 4000), preview_url: false } };
  return attempt('whatsapp', () => post(fetchImpl, `https://graph.facebook.com/${c.graphVersion}/${encodeURIComponent(c.phoneNumberId)}/messages`, msg, { Authorization: `Bearer ${c.token}` }));
}

export class ChannelHub {
  constructor(public cfg: ChannelConfig, private fetchImpl: typeof fetch = fetch) {}
  enabled(): ChannelName[] { return CHANNELS.filter((n) => this.cfg[n].enabled); }
  send(name: ChannelName, text: string): Promise<SendResult> {
    switch (name) {
      case 'telegram': return telegramSend(this.cfg.telegram, text, this.fetchImpl);
      case 'discord': return discordSend(this.cfg.discord, text, this.fetchImpl);
      case 'slack': return slackSend(this.cfg.slack, text, this.fetchImpl);
      case 'whatsapp': return whatsappSend(this.cfg.whatsapp, text, this.fetchImpl);
    }
  }
  async broadcast(text: string, o: { except?: ChannelName[] } = {}): Promise<Partial<Record<ChannelName, SendResult>>> {
    const out: Partial<Record<ChannelName, SendResult>> = {};
    await Promise.all(this.enabled().filter((n) => !o.except?.includes(n)).map(async (n) => { out[n] = await this.send(n, text); }));
    return out;
  }
}
