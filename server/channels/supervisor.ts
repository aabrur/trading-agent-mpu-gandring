import { DiscordGateway } from './discord.js';
// Desk Lead: the one supervisor that watches the desk and talks to you on your chat channel.
// - every SUPERVISOR_INTERVAL_MIN: health, positions without stops, daily loss cap, safety net, API errors, stale feeds, kill switch
// - alerts (warn/alert findings) go to every enabled channel, once per ALERT_COOLDOWN_MIN per finding, louder when it escalates
// - scheduled reports (REPORT_INTERVAL_MIN) go to every enabled channel (Telegram already gets them from the Reporter)
// - with CHANNEL_COMMANDS=on, allowlisted users may send the safe commands only (see commands.ts). Telegram uses long polling,
//   so no public URL is needed; Discord, Slack and WhatsApp call signed webhooks (see routes.ts).
import type { Desk } from '../desk.js';
import { proactiveScan, type Finding } from '../scan.js';
import { safe, log } from '../redact.js';
import type { Report } from '../reports.js';
import { ChannelHub } from './adapters.js';
import { allowed, parseCommand, runCommand } from './commands.js';
import type { ChannelConfig } from './config.js';
import { setTimeout as delay } from 'node:timers/promises';

const RANK: Record<Finding['level'], number> = { ok: 0, info: 1, warn: 2, alert: 3 };
const keyOf = (f: Finding) => (['no_stop', 'stale_feed', 'sample_fallback'].includes(f.code) ? `${f.code}:${f.text.split(' ')[0]}` : f.code);

export class DeskLead {
  readonly hub: ChannelHub;
  private discordGateway: DiscordGateway | null = null;
  get discordStatus() { return this.discordGateway?.status ?? (this.cfg.discord.delivery === 'http' ? 'http' : 'disconnected'); }
  reload(cfg: ChannelConfig) { this.stop(); this.cfg = cfg; this.hub.cfg = cfg; this.desk.cfg.channels = cfg; this.start(); }
  private timer: NodeJS.Timeout | null = null;
  private sent = new Map<string, { at: number; rank: number }>();
  private wasKilled: boolean;
  private static telegramPollers = new Map<string, DeskLead>();
  private pollAbort: AbortController | null = null;
  private offset = 0;
  private onReport = (r: Report) => { void this.hub.broadcast(r.text, { except: ['telegram'] }); };

  constructor(private desk: Desk, public cfg: ChannelConfig, private fetchImpl: typeof fetch = fetch, private onKill?: () => void) {
    this.hub = new ChannelHub(cfg, fetchImpl);
    this.wasKilled = desk.killed;
  }

  start() {
    if (!this.cfg.supervisor.on || this.timer) return;
    if (this.cfg.discord.botToken && this.cfg.discord.delivery === 'gateway') { this.discordGateway = new DiscordGateway(this.desk, () => this.cfg, this.fetchImpl, this.onKill); this.discordGateway.start(); }
    this.desk.on('report', this.onReport);
    this.timer = setInterval(() => void this.tick(), this.cfg.supervisor.intervalMin * 60_000);
    this.timer.unref?.();
    log(`[desk lead] watching the desk every ${this.cfg.supervisor.intervalMin} min; channels: ${this.hub.enabled().join(', ') || 'none'}; chat commands ${this.cfg.commands ? 'on (allowlisted only)' : 'off'}`);
    if (this.cfg.commands && this.cfg.telegram.enabled && this.cfg.telegram.allowed.length) void this.pollTelegram();
  }
  stop() {
    this.discordGateway?.stop(); this.discordGateway = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null; this.pollAbort?.abort(); this.pollAbort = null;
    if (DeskLead.telegramPollers.get(this.cfg.telegram.token) === this) DeskLead.telegramPollers.delete(this.cfg.telegram.token);
    this.desk.off('report', this.onReport);
  }

  /** One supervision pass. Returns the alert texts it sent (for tests and the office). */
  async tick(now = Date.now()): Promise<string[]> {
    this.desk.diagnostic({ source: 'supervisor', category: 'SUPERVISOR', eventName: 'supervisor.check', status: 'started', message: 'Supervisor check started' });
    const out: string[] = [];
    if (this.desk.killed && !this.wasKilled) out.push('KILL SWITCH IS ON. Emergency stop latched. Check the actual exchange cancel and flatten acknowledgements. Release only on the desk computer: the local Office OFF button or npm run unkill -- --yes.');
    this.wasKilled = this.desk.killed;
    const cool = this.cfg.supervisor.cooldownMin * 60_000;
    for (const f of proactiveScan(this.desk, now)) {
      if (RANK[f.level] < RANK.warn) continue;
      const k = keyOf(f); const prev = this.sent.get(k);
      if (prev && now - prev.at < cool && RANK[f.level] <= prev.rank) continue;
      this.sent.set(k, { at: now, rank: RANK[f.level] });
      out.push(`${f.level === 'alert' ? 'ALERT' : 'Warning'}: ${f.text}`);
    }
    if (out.length) await this.hub.broadcast(safe(`Desk Lead (${this.desk.cfg.tradingMode})\n${out.join('\n')}`));
    this.desk.diagnostic({ source: 'supervisor', category: 'SUPERVISOR', eventName: 'supervisor.checked', status: 'completed', level: out.length ? 'WARN' : 'INFO', message: 'Supervisor check completed', details: { findings: out.length } });
    return out;
  }

  /** Telegram long polling (getUpdates). Only messages from TELEGRAM_CHAT_ID sent by a user in TELEGRAM_ALLOWED_USER_IDS are obeyed. */
  async handleTelegramUpdate(u: { update_id?: number; message?: { chat?: { id?: number | string }; from?: { id?: number | string }; text?: string } }): Promise<string | null> {
    if (typeof u.update_id === 'number' && u.update_id < this.offset) return null;
    if (typeof u.update_id === 'number') this.offset = Math.max(this.offset, u.update_id + 1);
    const m = u.message; if (!m || typeof m.text !== 'string') return null;
    const tg = this.cfg.telegram;
    if (String(m.chat?.id ?? '') !== tg.chatId || !allowed(tg.allowed, m.from?.id)) { log('[desk lead] ignored a Telegram message from a chat or user not on the allowlist'); return null; }
    const reply = await runCommand(this.desk, parseCommand(m.text), this.onKill, `telegram:${m.chat?.id}:${m.from?.id}`);
    await this.hub.send('telegram', reply);
    return reply;
  }

  private async pollTelegram() {
    const tg = this.cfg.telegram;
    if (this.pollAbort || DeskLead.telegramPollers.has(tg.token)) return;
    const control = new AbortController();
    this.pollAbort = control;
    DeskLead.telegramPollers.set(tg.token, this);
    let failures = 0;
    let warned = false;
    try { while (!control.signal.aborted) {
      try {
        if (failures) {
          const probe = await this.fetchImpl(`https://api.telegram.org/bot${tg.token}/getMe`, { signal: AbortSignal.any([control.signal, AbortSignal.timeout(8000)]) });
          if (!probe.ok) throw new Error(`Connection check HTTP ${probe.status}`);
        }
        const r = await this.fetchImpl(`https://api.telegram.org/bot${tg.token}/getUpdates?timeout=25&offset=${this.offset}&allowed_updates=${encodeURIComponent('["message"]')}`, { signal: AbortSignal.any([control.signal, AbortSignal.timeout(35_000)]) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { ok?: boolean; result?: unknown[] };
        if (j.ok === false || !Array.isArray(j.result)) throw new Error('Invalid getUpdates response');
        if (control.signal.aborted) break;
        if (warned) log('[desk lead] Telegram connection restored');
        warned = false;
        failures = 0;
        for (const u of j.result) { if (control.signal.aborted) break; await this.handleTelegramUpdate(u as never); }
        if (!j.result.length) await delay(1000, undefined, { signal: control.signal });
      } catch (e) {
        if (control.signal.aborted) break;
        failures++;
        const name = (e as Error).name;
        if (!warned && name !== 'AbortError' && name !== 'TimeoutError') {
          log(`[desk lead] Telegram unavailable: ${safe((e as Error).message).slice(0, 120)}. Retrying with backoff.`);
          warned = true;
        }
        try { await delay(Math.min(120_000, 15_000 * 2 ** Math.min(failures - 1, 3)), undefined, { signal: control.signal }); }
        catch { break; }
      }
    } } finally {
      if (this.pollAbort === control) {
        this.pollAbort = null;
        if (DeskLead.telegramPollers.get(tg.token) === this) DeskLead.telegramPollers.delete(tg.token);
      }
    }
  }
}
