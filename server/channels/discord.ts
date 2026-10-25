import WebSocket from 'ws';
import { z } from 'zod';
import type { Desk } from '../desk.js';
import type { ChannelConfig } from './config.js';
import { allowed, parseCommand, runCommand } from './commands.js';
import { safe } from '../redact.js';

const API = 'https://discord.com/api/v10';
const snowflake = z.string().regex(/^\d{3,25}$/);
export const DiscordBotBody = z.object({ token: z.string().min(1).max(400).optional(), guildId: snowflake.optional(), channelId: snowflake.optional() }).strict();
export async function discordApi(token: string, route: string, fetchImpl: typeof fetch = fetch, method = 'GET', body?: unknown): Promise<unknown> {
  const response = await fetchImpl(`${API}${route}`, { method, headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Discord HTTP ${response.status}${response.status === 429 ? ': rate limited; try again later' : ': check bot permissions and installation'}`);
  return response.status === 204 ? null : response.json();
}
const Application = z.object({ id: snowflake, verify_key: z.string().regex(/^[a-f0-9]{64}$/i).optional(), interactions_endpoint_url: z.string().nullable().optional() });
const Guilds = z.array(z.object({ id: snowflake, name: z.string() }));
const Channels = z.array(z.object({ id: snowflake, name: z.string(), type: z.number(), guild_id: snowflake.optional() }));
export async function inspectDiscordBot(token: string, guildId?: string, fetchImpl: typeof fetch = fetch) {
  const application = Application.parse(await discordApi(token, '/applications/@me', fetchImpl));
  const guilds: z.infer<typeof Guilds> = [];
  let after = '';
  for (;;) {
    const page = Guilds.parse(await discordApi(token, `/users/@me/guilds?limit=200${after ? `&after=${after}` : ''}`, fetchImpl));
    guilds.push(...page);
    if (page.length < 200) break;
    const last = page.at(-1)!.id;
    if (last === after) throw new Error('Discord guild pagination did not advance');
    after = last;
  }
  if (guildId && !guilds.some(g => g.id === guildId)) throw new Error('Install the bot in the selected server first.');
  const channels = guildId ? Channels.parse(await discordApi(token, `/guilds/${guildId}/channels`, fetchImpl)).filter(c => c.type === 0 || c.type === 5) : [];
  return { application, guilds, channels, delivery: application.interactions_endpoint_url ? 'http' as const : 'gateway' as const,
    installUrl: `https://discord.com/oauth2/authorize?client_id=${application.id}&scope=bot%20applications.commands&permissions=3072` };
}

const option = (name: string, description: string, required = false, type = 3) => ({ name, description, type, required });
export const MPU_DISCORD_COMMAND = { name: 'mpu', description: 'Trading Agent Mpu Gandring', type: 1, options: [
  ...['status', 'report', 'positions', 'scan', 'watchlist', 'scorecard', 'lessons', 'help'].map(name => ({ name, description: `${name} from the desk`, type: 1 })),
  { name: 'analyze', description: 'Analyze a configured symbol', type: 1, options: [option('symbol', 'Symbol', true)] },
  { name: 'ask', description: 'Ask an agent', type: 1, options: [option('text', 'Question', true), option('agent', 'lead, market, research, strategist, risk, execution')] },
  { name: 'open', description: 'Existing Owner open command', type: 1, options: [option('side', 'long or short', true), option('symbol', 'Symbol', true), option('size', 'Order size percentage', false, 10), option('leverage', 'Leverage', false, 10)] },
  { name: 'close', description: 'Existing Owner close command', type: 1, options: [option('symbol', 'Symbol or all', true)] },
  { name: 'set', description: 'Existing Owner settings command', type: 1, options: [option('setting', 'profile, size, leverage, n, safety', true), option('value', 'Setting value', true)] },
  { name: 'kill', description: 'Existing kill confirmation flow', type: 1, options: [option('confirm', 'Type confirm to execute')] }
] };
export async function syncDiscordCommands(token: string, appId: string, guildId?: string, fetchImpl: typeof fetch = fetch) {
  snowflake.parse(appId);
  if (guildId) snowflake.parse(guildId);
  const route = guildId ? `/applications/${appId}/guilds/${guildId}/commands` : `/applications/${appId}/commands`;
  // POST upserts this name only. Never bulk-overwrite unrelated application commands.
  await discordApi(token, route, fetchImpl, 'POST', MPU_DISCORD_COMMAND);
  const registered = z.array(z.object({ id: snowflake, name: z.string(), options: z.array(z.object({ name: z.string() })).optional() })).parse(await discordApi(token, route, fetchImpl));
  const command = registered.find(c => c.name === 'mpu');
  if (!command || !MPU_DISCORD_COMMAND.options.every(option => command.options?.some(o => o.name === option.name))) throw new Error('Discord command read-back did not confirm all /mpu subcommands.');
  return { registered: true, count: 1, commandId: command.id };
}

const dmChannelCache = new Map<string, string>();
export function recordDiscordDmChannel(token: string, userId: string, channelId: string) {
  if (token && userId && channelId) dmChannelCache.set(`${token}:${userId}`, channelId);
}
export async function resolveDiscordDmChannel(token: string, userId: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const key = `${token}:${userId}`;
  const cached = dmChannelCache.get(key);
  if (cached) return cached;
  const res = (await discordApi(token, '/users/@me/channels', fetchImpl, 'POST', { recipient_id: userId })) as { id?: string } | null;
  if (!res?.id) throw new Error('Could not open DM channel with Discord user.');
  dmChannelCache.set(key, res.id);
  return res.id;
}

export interface DiscordOption { name?: string; type?: number; value?: unknown; options?: DiscordOption[] }
export interface DiscordInteraction { id?: string; token?: string; application_id?: string; type?: number; guild_id?: string; channel_id?: string;
  member?: { user?: { id?: string } }; user?: { id?: string }; data?: { name?: string; options?: DiscordOption[] } }
export function discordCommandText(data: DiscordInteraction['data']): string {
  if (data?.name !== 'mpu') return [data?.name || '', ...(data?.options ?? []).flatMap(o => o.options ? [discordCommandText({name: o.name, options: o.options})] : [String(o.value ?? '')])].join(' ');
  const group = data.options?.[0];
  if (!group?.name) return 'help';
  const values = Object.fromEntries((group.options ?? []).map(o => [o.name, o.value]));
  if (group.name === 'open') return ['open', values.side, values.symbol, ...(values.size === undefined ? [] : [`${values.size}%`]), ...(values.leverage === undefined ? [] : [`${values.leverage}x`])].filter(value => value !== undefined).join(' ');
  if (group.name === 'set' && values.setting === 'size' && values.value !== undefined && !String(values.value).endsWith('%')) values.value = `${values.value}%`;
  const names: Record<string, string[]> = { analyze: ['symbol'], ask: ['agent', 'text'], open: ['side', 'symbol', 'size', 'leverage'], close: ['symbol'], set: ['setting', 'value'], kill: ['confirm'] };
  return [group.name, ...(names[group.name] ?? []).flatMap(name => values[name] === undefined ? [] : [String(values[name])])].join(' ');
}
export function discordRefusal(c: ChannelConfig, interaction: DiscordInteraction): string | null {
  if (!c.commands) return 'Chat commands are off on this desk (CHANNEL_COMMANDS=off).';
  const userId = interaction.member?.user?.id ?? interaction.user?.id;
  if (!allowed(c.discord.allowed, userId)) return 'You are not on this desk\'s allowlist.';
  if (!interaction.guild_id) return null;
  if (c.discord.guildId && interaction.guild_id !== c.discord.guildId || c.discord.channelId && interaction.channel_id !== c.discord.channelId) return 'Use the configured server and channel.';
  return null;
}

/** Gateway uses the same parser and Owner command pathway as signed HTTP interactions. */
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
  constructor(private desk: Desk, private config: () => ChannelConfig, private fetchImpl: typeof fetch = fetch, private onKill?: () => void) {}
  start() { this.stopped = false; this.connect(); }
  stop() { this.stopped = true; if (this.heartbeat) clearInterval(this.heartbeat); if (this.retry) clearTimeout(this.retry); this.socket?.close(); this.socket = null; this.status = 'disconnected'; }
  private connect() {
    if (this.stopped) return;
    this.status = 'connecting';
    const socket = new WebSocket(`${this.resumeUrl}/?v=10&encoding=json`); this.socket = socket;
    const send = (value: unknown) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
    socket.on('message', raw => {
      try {
        const packet = JSON.parse(raw.toString()) as { op: number; s?: number; t?: string; d: Record<string, unknown> };
        if (typeof packet.s === 'number') this.sequence = packet.s;
        if (packet.op === 10) {
          const interval = Number(packet.d.heartbeat_interval);
          if (!Number.isFinite(interval) || interval < 1000) { socket.close(); return; }
          if (this.heartbeat) clearInterval(this.heartbeat);
          this.acknowledged = true;
          this.heartbeat = setInterval(() => { if (!this.acknowledged) { socket.terminate(); return; } this.acknowledged = false; send({op: 1, d: this.sequence}); }, interval);
          this.heartbeat.unref();
          if (this.session) send({ op: 6, d: {token: this.config().discord.botToken, session_id: this.session, seq: this.sequence} });
          else send({op: 2, d: {token: this.config().discord.botToken, intents: 1, properties: {os: process.platform, browser: 'Trading Agent Mpu Gandring', device: 'Trading Agent Mpu Gandring'}}});
        } else if (packet.op === 11) this.acknowledged = true;
        else if (packet.op === 1) send({op: 1, d: this.sequence});
        else if (packet.op === 7) socket.close();
        else if (packet.op === 9) { this.session = null; this.sequence = null; socket.close(); }
        else if (packet.t === 'READY') { this.session = String(packet.d.session_id); if (typeof packet.d.resume_gateway_url === 'string' && /^wss:\/\/[^/]+\.discord\.gg\/?$/.test(packet.d.resume_gateway_url)) this.resumeUrl = packet.d.resume_gateway_url.replace(/\/$/, ''); this.status = 'connected'; }
        else if (packet.t === 'RESUMED') this.status = 'connected';
        else if (packet.t === 'INTERACTION_CREATE') void this.handle(packet.d as DiscordInteraction);
      } catch { this.status = 'invalid_packet'; }
    });
    socket.on('error', () => { this.status = 'connection_failed'; socket.close(); });
    socket.on('close', code => { if (this.heartbeat) clearInterval(this.heartbeat); this.status = 'disconnected'; if (!this.stopped && ![4004, 4010, 4011, 4013, 4014].includes(code)) { this.retry = setTimeout(() => this.connect(), 5000); this.retry.unref(); } });
  }
  async handle(interaction: DiscordInteraction) {
    if (interaction.type !== 2 || !interaction.id || !interaction.token || !interaction.application_id || this.seen.has(interaction.id)) return;
    const now = Date.now(); for (const [id, at] of this.seen) if (now - at > 900_000) this.seen.delete(id);
    this.seen.set(interaction.id, now);
    const c = this.config();
    const userId = interaction.member?.user?.id ?? interaction.user?.id;
    if (userId && interaction.channel_id && !interaction.guild_id && c.discord.botToken) {
      recordDiscordDmChannel(c.discord.botToken, userId, interaction.channel_id);
    }
    const refusal = discordRefusal(c, interaction);
    try {
      const response = await this.fetchImpl(`${API}/interactions/${interaction.id}/${interaction.token}/callback`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(refusal ? {type: 4, data: {content: refusal, flags: 64, allowed_mentions: {parse: []}}} : {type: 5, data: {flags: 64}}), signal: AbortSignal.timeout(2500)});
      if (!response.ok || refusal) return;
      let content: string;
      try { content = await runCommand(this.desk, parseCommand(discordCommandText(interaction.data)), this.onKill, `discord:${interaction.member?.user?.id ?? interaction.user?.id}`); }
      catch { content = 'The desk could not complete this command.'; }
      await this.fetchImpl(`${API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({content: safe(content).slice(0,1990), allowed_mentions: {parse: []}}), signal: AbortSignal.timeout(8000)});
    } catch { this.status = 'interaction_failed'; }
  }
}
