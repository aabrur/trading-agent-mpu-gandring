// Chat channels and the Desk Lead: mocked adapters, allowlists, webhook signatures, and the safe command set.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { loadConfig } from '../server/config.js';
import { createApp } from '../server/app.js';
import { channelConfig, CHANNELS } from '../server/channels/config.js';
import { parseCommand, allowed, SAFE_COMMANDS } from '../server/channels/commands.js';
import { verifySlack, verifyMeta, verifyDiscord } from '../server/channels/verify.js';
import { ChannelHub } from '../server/channels/adapters.js';
import { CHANNEL_GUIDES, allChannelLinks, NOT_SHIPPED } from '../server/channels/guide.js';
import { checkChannelInput, saveChannel, testChannel, telegramChats, channelStatus } from '../server/channels/setup.js';

const TG_TOKEN = '123456789:' + 'A'.repeat(35);
const SLACK_SECRET = 'f'.repeat(32);
const WA_SECRET = 'e'.repeat(32);
const WA_TOKEN = 'EAA' + 'x'.repeat(60);
const VERIFY = 'verify-token-0123456789';
const DISCORD_HOOK = 'https://discord.com/api/webhooks/123456789012345678/' + 'h'.repeat(60);
const SLACK_HOOK = 'https://hooks.slack.com/services/T000/B000/' + 's'.repeat(24);
const kp = generateKeyPairSync('ed25519');
const DISCORD_PUB = (kp.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('hex');
const now = () => String(Math.floor(Date.now() / 1000));

type Sent = { url: string; body: string; headers: Record<string, string> };
const recorder = () => {
  const sent: Sent[] = [];
  const f = (async (u: string, init?: RequestInit) => { sent.push({ url: String(u), body: String(init?.body ?? ''), headers: (init?.headers ?? {}) as Record<string, string> }); return new Response('{"ok":true,"result":[]}'); }) as unknown as typeof fetch;
  return { sent, f };
};
const allEnv = {
  TELEGRAM_BOT_TOKEN: TG_TOKEN, TELEGRAM_CHAT_ID: '1111', TELEGRAM_ALLOWED_USER_IDS: '2222',
  DISCORD_WEBHOOK_URL: DISCORD_HOOK, DISCORD_PUBLIC_KEY: DISCORD_PUB, DISCORD_ALLOWED_USER_IDS: '3333',
  SLACK_WEBHOOK_URL: SLACK_HOOK, SLACK_SIGNING_SECRET: SLACK_SECRET, SLACK_ALLOWED_USER_IDS: 'U0ALLOWED1',
  WHATSAPP_ACCESS_TOKEN: WA_TOKEN, WHATSAPP_PHONE_NUMBER_ID: '1234567890', WHATSAPP_TO: '6281200000000', WHATSAPP_APP_SECRET: WA_SECRET, WHATSAPP_VERIFY_TOKEN: VERIFY, WHATSAPP_ALLOWED_NUMBERS: '6281200000000',
  CHANNEL_COMMANDS: 'on'
};

describe('safe command set', () => {
  it('accepts only status, report, positions, kill, help', () => {
    expect(SAFE_COMMANDS).toEqual(['status', 'report', 'positions', 'kill', 'help']);
    for (const t of ['status', '/status', '/status@MyDeskBot', 'desk positions', 'REPORT']) expect(parseCommand(t).ok).toBe(true);
    expect(parseCommand('kill')).toMatchObject({ ok: true, cmd: 'kill', confirm: false });
    expect(parseCommand('kill confirm')).toMatchObject({ ok: true, cmd: 'kill', confirm: true });
    expect(parseCommand('kill confirm:confirm')).toMatchObject({ ok: true, cmd: 'kill', confirm: true });
  });
  it('accepts supported Owner orders while rejecting malformed orders, mode changes, un-kill and keys', () => {
    const refused = (t: string, re: RegExp) => { const p = parseCommand(t); expect(p.ok).toBe(false); if (!p.ok) expect(p.reply).toMatch(re); };
    for (const t of ['open BTCUSDT long', 'short SOL 5x', 'size BTC']) refused(t, /Usage/);
    for (const t of ['/buy ETH', 'close all', 'set size 5%', 'set leverage 10']) expect(parseCommand(t)).toMatchObject({ ok: true, cmd: 'owner' });
    for (const t of ['live', '/mode LIVE', 'go-live', 'testnet']) refused(t, /mode cannot/);
    for (const t of ['unkill', 'un-kill --yes', 'resume']) refused(t, /desk computer/);
    for (const t of ['key set BYBIT_API_KEY=x', 'set TRADING_MODE=LIVE', 'withdraw 100', 'env']) refused(t, /Keys and wallet/);
    expect(parseCommand('rm -rf /')).toMatchObject({ ok: true, cmd: 'chat' });
  });
  it('accepts interactive commands: analyze, scan, ask, watchlist, scorecard, lessons, cautious', () => {
    expect(parseCommand('/analyze BTCUSDT')).toMatchObject({ ok: true, cmd: 'analyze', symbol: 'BTCUSDT' });
    expect(parseCommand('debate SOL')).toMatchObject({ ok: true, cmd: 'analyze', symbol: 'SOLUSDT' });
    expect(parseCommand('/scan')).toMatchObject({ ok: true, cmd: 'scan' });
    expect(parseCommand('/ask what is the trend?')).toMatchObject({ ok: true, cmd: 'ask', agent: 'lead', text: 'what is the trend?' });
    expect(parseCommand('/ask market how are candles looking?')).toMatchObject({ ok: true, cmd: 'ask', agent: 'market', text: 'how are candles looking?' });
    expect(parseCommand('/watchlist')).toMatchObject({ ok: true, cmd: 'watchlist' });
    expect(parseCommand('/scorecard')).toMatchObject({ ok: true, cmd: 'scorecard' });
    expect(parseCommand('/lessons')).toMatchObject({ ok: true, cmd: 'lessons' });
    expect(parseCommand('/cautious')).toMatchObject({ ok: true, cmd: 'cautious' });
  });
  it('allowlist: empty means nobody; ids compare exactly', () => {
    expect(allowed([], '1')).toBe(false);
    expect(allowed(['2222'], 2222)).toBe(true);
    expect(allowed(['2222'], '22223')).toBe(false);
    expect(allowed(['6281200000000'], '+6281200000000')).toBe(true);
    expect(allowed(['2222'], undefined)).toBe(false);
  });
});

describe('webhook signatures', () => {
  const body = 'token=x&user_id=U0ALLOWED1&text=status';
  it('Slack HMAC v0 with a 5 minute window', () => {
    const ts = now();
    const sig = 'v0=' + createHmac('sha256', SLACK_SECRET).update(`v0:${ts}:${body}`).digest('hex');
    expect(verifySlack(SLACK_SECRET, body, ts, sig)).toBe(true);
    expect(verifySlack(SLACK_SECRET, body + 'x', ts, sig)).toBe(false);
    expect(verifySlack('0'.repeat(32), body, ts, sig)).toBe(false);
    const old = String(Number(ts) - 600);
    expect(verifySlack(SLACK_SECRET, body, old, 'v0=' + createHmac('sha256', SLACK_SECRET).update(`v0:${old}:${body}`).digest('hex'))).toBe(false);
    expect(verifySlack('', body, ts, sig)).toBe(false);
  });
  it('Meta X-Hub-Signature-256', () => {
    const sig = 'sha256=' + createHmac('sha256', WA_SECRET).update('{"a":1}').digest('hex');
    expect(verifyMeta(WA_SECRET, '{"a":1}', sig)).toBe(true);
    expect(verifyMeta(WA_SECRET, '{"a":2}', sig)).toBe(false);
    expect(verifyMeta(WA_SECRET, '{"a":1}', undefined)).toBe(false);
  });
  it('Discord Ed25519', () => {
    const ts = now(); const b = '{"type":1}';
    const sig = sign(null, Buffer.from(ts + b), kp.privateKey).toString('hex');
    expect(verifyDiscord(DISCORD_PUB, b, ts, sig)).toBe(true);
    expect(verifyDiscord(DISCORD_PUB, '{"type":2}', ts, sig)).toBe(false);
    expect(verifyDiscord('ab'.repeat(32), b, ts, sig)).toBe(false);
    expect(verifyDiscord(DISCORD_PUB, b, ts, 'zz')).toBe(false);
  });
});

describe('adapters (mocked, official endpoints only)', () => {
  it('each channel posts to its official API and redacts secrets', async () => {
    loadConfig({ TRADING_MODE: 'PAPER', ...allEnv }); // the app registers channel secrets with the redactor here
    const { sent, f } = recorder();
    const hub = new ChannelHub(channelConfig(allEnv), f);
    expect(hub.enabled()).toEqual([...CHANNELS]);
    const r = await hub.broadcast(`hello ${WA_TOKEN}`);
    expect(Object.values(r)).toEqual(['sent', 'sent', 'sent', 'sent']);
    const hosts = sent.map((s) => new URL(s.url).host).sort();
    expect(hosts).toEqual(['api.telegram.org', 'discord.com', 'graph.facebook.com', 'hooks.slack.com']);
    expect(sent.find((s) => s.url.includes('graph.facebook.com'))!.url).toMatch(/\/v\d+\.\d+\/1234567890\/messages$/);
    for (const s of sent) expect(s.body).not.toContain(WA_TOKEN);
    expect(JSON.parse(sent.find((s) => s.url.includes('discord'))!.body).allowed_mentions).toEqual({ parse: [] });
  });
  it('WhatsApp uses the approved template when one is set; bad webhook URLs are not used', async () => {
    const { sent, f } = recorder();
    await new ChannelHub(channelConfig({ ...allEnv, WHATSAPP_TEMPLATE_NAME: 'desk_alert' }), f).send('whatsapp', 'line1\nline2');
    expect(JSON.parse(sent[0].body)).toMatchObject({ type: 'template', template: { name: 'desk_alert' } });
    const c = channelConfig({ DISCORD_WEBHOOK_URL: 'https://evil.example/api/webhooks/1/x', SLACK_WEBHOOK_URL: 'http://hooks.slack.com/services/x' });
    expect(c.discord.enabled || c.slack.enabled).toBe(false);
  });
  it('commands are off by default; secrets are redacted by config', () => {
    expect(channelConfig({}).commands).toBe(false);
    expect(channelConfig({}).supervisor.on).toBe(false);
    expect(channelConfig({ TELEGRAM_BOT_TOKEN: TG_TOKEN, TELEGRAM_CHAT_ID: '1' }).supervisor.on).toBe(true);
  });
});

describe('channel setup (shared by CLI and office)', () => {
  it('guides use https links and the env names the code reads; MiChat and email are documented, not shipped', () => {
    for (const l of allChannelLinks()) expect(l.url).toMatch(/^https:\/\//);
    const names = Object.values(CHANNEL_GUIDES).flatMap((g) => g.fields.map((f) => f.env));
    for (const n of names) expect(Object.keys(allEnv).concat(['WHATSAPP_TEMPLATE_NAME'])).toContain(n);
    expect(NOT_SHIPPED.michat).toMatch(/no bot or developer API/);
    expect(JSON.stringify(CHANNEL_GUIDES.whatsapp)).toMatch(/business/i);
    expect(JSON.stringify(CHANNEL_GUIDES.whatsapp)).not.toMatch(/whatsapp-web|baileys|venom/i);
  });
  it('validates input, saves with chmod 600, never echoes secrets', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'mg-ch-')); const env = path.join(d, '.env');
    expect(checkChannelInput('telegram', { TELEGRAM_BOT_TOKEN: 'nope', TELEGRAM_CHAT_ID: '1' })).toMatch(/does not look right/);
    expect(checkChannelInput('telegram', { TELEGRAM_CHAT_ID: '1' })).toMatch(/required/);
    expect(checkChannelInput('telegram', { BYBIT_API_KEY: 'x' } as never)).toMatch(/not a Telegram setting/);
    expect(checkChannelInput('discord', { DISCORD_WEBHOOK_URL: 'https://example.com/hook' })).toMatch(/does not look right/);
    const r = saveChannel(env, 'telegram', { TELEGRAM_BOT_TOKEN: TG_TOKEN, TELEGRAM_CHAT_ID: '1111', TELEGRAM_ALLOWED_USER_IDS: '2222' }, { commands: true });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain(TG_TOKEN);
    if (process.platform !== 'win32') expect(statSync(env).mode & 0o777).toBe(0o600);
    expect(readFileSync(env, 'utf8')).toContain('CHANNEL_COMMANDS=on');
    const st = channelStatus({ ...allEnv });
    expect(JSON.stringify(st)).not.toContain(TG_TOKEN);
    expect(JSON.stringify(st)).not.toContain(SLACK_SECRET);
    expect(JSON.stringify(st)).not.toContain(DISCORD_HOOK);
  });
  it('test message and Telegram chat lookup (mocked)', async () => {
    const { sent, f } = recorder();
    expect((await testChannel(allEnv, 'slack', f)).ok).toBe(true);
    expect(sent[0].body).toMatch(/Test message/);
    expect((await testChannel({}, 'discord', f)).ok).toBe(false);
    const tg = (async () => new Response(JSON.stringify({ ok: true, result: [{ update_id: 1, message: { chat: { id: 1111, type: 'private', first_name: 'Me' }, from: { id: 2222, first_name: 'Me' }, text: 'hi' } }] }))) as unknown as typeof fetch;
    const r = await telegramChats(TG_TOKEN, tg);
    expect(r.chats).toEqual([{ chatId: '1111', chat: 'Me', userId: '2222', user: 'Me' }]);
  });
});

describe('Desk Lead and inbound routes', () => {
  const servers: Server[] = [];
  afterEach(() => { for (const s of servers.splice(0)) s.close(); });
  async function boot(env: Record<string, string> = allEnv) {
    const d = mkdtempSync(path.join(tmpdir(), 'mg-ch-'));
    const { sent, f } = recorder();
    const built = createApp(loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', HOST: '127.0.0.1', DEBATE_PACE_MS: '0', ...env }), { reportsDir: null, learningsPath: null, envFile: path.join(d, '.env'), channelFetch: f });
    const inb = built.inbound.listen(0, '127.0.0.1'); servers.push(inb);
    await new Promise<void>((r) => built.server.listen(0, '127.0.0.1', () => r())); servers.push(built.server);
    await new Promise((r) => setTimeout(r, 10));
    return { ...built, sent, base: `http://127.0.0.1:${(built.server.address() as AddressInfo).port}`, inBase: `http://127.0.0.1:${(inb.address() as AddressInfo).port}` };
  }
  const slackReq = (inBase: string, fields: Record<string, string>, secret = SLACK_SECRET) => {
    const body = new URLSearchParams(fields).toString(); const ts = now();
    return fetch(`${inBase}/api/channels/slack`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': ts, 'x-slack-signature': 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex') }, body });
  };
  const discordReq = (inBase: string, obj: unknown, good = true) => {
    const body = JSON.stringify(obj); const ts = now();
    const sig = sign(null, Buffer.from(ts + body), good ? kp.privateKey : generateKeyPairSync('ed25519').privateKey).toString('hex');
    return fetch(`${inBase}/api/channels/discord`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature-ed25519': sig, 'x-signature-timestamp': ts }, body });
  };

  it('the inbound server has only the chat routes (no office, no kill route, no setup)', async () => {
    const { inBase } = await boot();
    for (const p of ['/api/health', '/api/state', '/api/kill', '/api/setup', '/api/gb/open', '/api/ops/open']) expect((await fetch(`${inBase}${p}`, { method: p === '/api/kill' ? 'POST' : 'GET' })).status).toBe(404);
  });
  it('Slack: bad signature 401, non-allowlisted refused, safe command works, open refused', async () => {
    const { inBase } = await boot();
    expect((await slackReq(inBase, { user_id: 'U0ALLOWED1', text: 'status' }, '0'.repeat(32))).status).toBe(401);
    expect((await (await slackReq(inBase, { user_id: 'U0STRANGER', text: 'status' })).json()).text).toMatch(/not on this desk's allowlist/);
    expect((await (await slackReq(inBase, { user_id: 'U0ALLOWED1', text: 'status' })).json()).text).toMatch(/Desk Lead status: PAPER/);
    expect((await (await slackReq(inBase, { user_id: 'U0ALLOWED1', text: 'open BTCUSDT long' })).json()).text).toMatch(/Usage/);
    expect((await (await slackReq(inBase, { user_id: 'U0ALLOWED1', text: 'unkill' })).json()).text).toMatch(/Refused/);
  });
  it('Discord: PING, signature, allowlist, kill needs confirm and then trips the kill switch', async () => {
    const { inBase, desk } = await boot();
    expect(await (await discordReq(inBase, { type: 1 })).json()).toEqual({ type: 1 });
    expect((await discordReq(inBase, { type: 1 }, false)).status).toBe(401);
    expect((await (await discordReq(inBase, { type: 2, data: { name: 'positions' }, member: { user: { id: '9999' } } })).json()).data.content).toMatch(/allowlist/);
    expect((await (await discordReq(inBase, { type: 2, data: { name: 'kill' }, member: { user: { id: '3333' } } })).json()).data.content).toMatch(/kill confirm/);
    expect(desk.killed).toBe(false);
    await discordReq(inBase, { type: 2, data: { name: 'kill', options: [{ name: 'confirm', value: 'confirm' }] }, member: { user: { id: '3333' } } });
    await new Promise((r) => setTimeout(r, 30));
    expect(desk.killed).toBe(true);
  });
  it('commands off: even allowlisted users get a refusal', async () => {
    const { inBase } = await boot({ ...allEnv, CHANNEL_COMMANDS: 'off' });
    expect((await (await slackReq(inBase, { user_id: 'U0ALLOWED1', text: 'status' })).json()).text).toMatch(/commands are off/);
  });
  it('WhatsApp: verify handshake, signature, allowlist, reply to the sender', async () => {
    const { inBase, sent } = await boot();
    expect(await (await fetch(`${inBase}/api/channels/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=12345`)).text()).toBe('12345');
    expect((await fetch(`${inBase}/api/channels/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`)).status).toBe(403);
    const msg = (from: string, text: string) => JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from, type: 'text', text: { body: text } }] } }] }] });
    const send = (b: string, secret = WA_SECRET) => fetch(`${inBase}/api/channels/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(b).digest('hex') }, body: b });
    expect((await send(msg('6281200000000', 'status'), 'bad')).status).toBe(401);
    await send(msg('6289999999999', 'status'));
    await send(msg('6281200000000', 'positions'));
    await new Promise((r) => setTimeout(r, 30));
    const wa = sent.filter((s) => s.url.includes('graph.facebook.com')).map((s) => JSON.parse(s.body));
    expect(wa).toHaveLength(1);
    expect(wa[0]).toMatchObject({ to: '6281200000000', type: 'text' });
    expect(wa[0].text.body).toMatch(/No open positions/);
  });
  it('Telegram: only the configured chat and allowlisted user are obeyed', async () => {
    const { lead, desk } = await boot();
    expect(await lead.handleTelegramUpdate({ update_id: 1, message: { chat: { id: 1111 }, from: { id: 9999 }, text: '/kill confirm' } })).toBeNull();
    expect(await lead.handleTelegramUpdate({ update_id: 2, message: { chat: { id: 5555 }, from: { id: 2222 }, text: '/status' } })).toBeNull();
    expect(await lead.handleTelegramUpdate({ update_id: 3, message: { chat: { id: 1111 }, from: { id: 2222 }, text: '/open BTCUSDT' } })).toMatch(/Usage/);
    expect(await lead.handleTelegramUpdate({ update_id: 4, message: { chat: { id: 1111 }, from: { id: 2222 }, text: '/status' } })).toMatch(/Desk Lead status/);
    expect(desk.killed).toBe(false);
  });
  it('Desk Lead alerts once per cooldown, and on kill', async () => {
    const { lead, desk, sent } = await boot();
    desk.recordError('exchange', 'HTTP 500 a'); desk.recordError('exchange', 'HTTP 500 b'); desk.recordError('exchange', 'HTTP 500 c');
    const a = await lead.tick();
    expect(a.some((t) => /ALERT: 3 API or exchange errors/.test(t))).toBe(true);
    const n = sent.length;
    expect((await lead.tick()).some((t) => /errors/.test(t))).toBe(false);
    expect(sent.length).toBe(n);
    await desk.kill();
    expect((await lead.tick()).some((t) => /KILL SWITCH IS ON/.test(t))).toBe(true);
  });
  it('office channel setup routes are localhost only and saving needs local mode', async () => {
    const { base } = await boot();
    const info = await (await fetch(`${base}/api/setup/channels`)).json();
    expect(info.ok).toBe(true);
    expect(JSON.stringify(info)).not.toContain(TG_TOKEN);
    expect((await fetch(`${base}/api/setup/channels`, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    const g = await boot({ ...allEnv, APP_MODE: 'grokbot' });
    const r = await fetch(`${g.base}/api/setup/channels/save`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'telegram', values: { TELEGRAM_BOT_TOKEN: TG_TOKEN, TELEGRAM_CHAT_ID: '1' } }) });
    expect(r.status).toBe(403);
  });
});
