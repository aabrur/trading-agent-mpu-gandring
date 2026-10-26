import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setEnv, readEnv } from '../cli/envfile.js';
import { loadConfig } from '../server/config.js';
import { modelUpdates } from '../server/setup/models.js';
import { reasoningStatus, requireReasoning, registerReasoning } from '../server/providers/reasoning.js';
import { makeCaller } from '../server/providers/index.js';
import { saveTradingLimits, saveTradingProfile, tradingSetupInfo } from '../server/setup/trading.js';
import { DEFAULT_TRADING_SETTINGS } from '../server/trading-settings.js';
import { planOrder } from '../server/money.js';
import { channelConfig } from '../server/channels/config.js';
import { discordSend } from '../server/channels/adapters.js';
import { discordCommandText, discordRefusal, inspectDiscordBot, MPU_DISCORD_COMMAND, syncDiscordCommands } from '../server/channels/discord.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('Owner reasoning configuration', () => {
  it('persists all six independent levels and preserves omitted settings', () => {
    const updates = modelUpdates({}, {defaultProvider: 'local', defaultModel: 'codex:default', defaultReasoning: 'high', reasoning: {lead: 'max', market: 'med', research: 'low', strategist: 'xhigh', risk: 'high', execution: 'med'}});
    const cfg = loadConfig(Object.fromEntries(Object.entries(updates).filter(([, value]) => value !== null)));
    expect(cfg.defaultReasoning).toBe('high');
    expect(cfg.reasoning).toEqual({lead: 'max', market: 'med', research: 'low', strategist: 'xhigh', risk: 'high', execution: 'med'});
    expect(modelUpdates({DEFAULT_REASONING_EFFORT: 'max'}, {defaultProvider: 'mock', defaultModel: 'mock-desk-v1'})).not.toHaveProperty('DEFAULT_REASONING_EFFORT');
  });
  it('never silently downgrades or fabricates support', () => {
    expect(() => requireReasoning('deepseek', 'deepseek-flash', 'xhigh')).toThrow();
    expect(requireReasoning('groq', 'openai/gpt-oss-120b', 'med')).toBe('medium');
    expect(reasoningStatus('local', 'pi:default', 'max').effective).toBeNull();
  });
  it.each([
    ['openai', 'gpt-5', 'reasoning_effort'], ['openrouter', 'vendor/fixture', 'reasoning'],
    ['anthropic', 'claude-opus-4-6', 'output_config'], ['deepseek', 'deepseek-flash', 'reasoning_effort']
  ] as const)('encodes native effort for %s', async (provider, model, field) => {
    const requests: Record<string, unknown>[] = [];
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/models')) return new Response(JSON.stringify({data: [{id: model, reasoning: {supported_efforts: ['high']}}]}));
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({choices: [{message: {content: '{"reply":"ok"}'}}], content: [{text: '{"reply":"ok"}'}]}));
    });
    vi.stubGlobal('fetch', request);
    registerReasoning('openrouter', model, ['high']);
    const cfg = loadConfig({DEFAULT_REASONING_EFFORT: 'high'});
    await makeCaller(cfg)({agent: 'lead', task: 'chat', provider, model, system: '', user: '', context: {}, attempt: 1});
    expect(requests[0]).toHaveProperty(field);
    if (provider === 'openrouter') expect(requests[0]).not.toHaveProperty('reasoning_effort');
    if (provider === 'anthropic') expect(requests[0].output_config).toEqual({effort: 'high'});
  });
});

describe('Owner trade limits', () => {
  it('saves only two fields and isolates network profiles', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'mpu-limits-')), '.env');
    setEnv(file, {TRADING_MODE: 'LIVE', SAFETY_NET: '37', MAX_LEVERAGE: '9'});
    saveTradingProfile(file, {network: 'testnet', profile: 'balance', values: {...DEFAULT_TRADING_SETTINGS, safetyNet: 37}});
    const before = readEnv(file);
    saveTradingLimits(file, {network: 'testnet', minOrderUsdt: 0, maxOrderUsdt: 42});
    const after = readEnv(file);
    for (const [key, value] of Object.entries(before)) if (!/MIN_ORDER_USDT|MAX_ORDER_USDT/.test(key)) expect(after[key]).toBe(value);
    expect(tradingSetupInfo(after).networks.testnet.values.maxOrderUsdt).toBe(42);
    expect(tradingSetupInfo(after).networks.mainnet.values.maxOrderUsdt).toBe(0);
    saveTradingLimits(file, {network: 'testnet', minOrderUsdt: 12, maxOrderUsdt: 0});
    expect(tradingSetupInfo(readEnv(file)).networks.testnet.values).toMatchObject({minOrderUsdt: 12, maxOrderUsdt: 0, safetyNet: 37});
  });
  it('caps positive maxima, leaves zero unlimited and preserves exchange constraints', () => {
    const input = {balance: 1000, safetyNet: 200, n: 4, openPositions: 0, usedMargin: 0, price: 100, side: 'LONG' as const, sizeFactor: 1, leverage: 2, stopPct: 2, minOrderUsdt: 0, rules: {qtyStep: 0.01, minQty: 0.01, minNotional: 5, tickSize: 0.01, source: 'fixture'}};
    const unlimited = planOrder({...input, maxOrderUsdt: 0});
    const capped = planOrder({...input, maxOrderUsdt: 50});
    expect(unlimited.ok && unlimited.notional).toBe(400);
    expect(capped.ok && capped.notional).toBe(50);
    expect(planOrder({...input, maxOrderUsdt: 1, adjustToVenueMinimum: true}).ok).toBe(false);
    expect(planOrder({...input, minOrderUsdt: 500}).ok).toBe(false);
  });
});

describe('Discord bot integration', () => {
  const token = 'fixture-bot-token';
  it('validates bot identity, discovers servers and eligible channels', async () => {
    const request = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(String(url).includes('/applications/@me') ? {id: '123', verify_key: 'a'.repeat(64), interactions_endpoint_url: null} : String(url).includes('/channels') ? [{id: '789', name: 'desk', type: 0}, {id: '999', name: 'voice', type: 2}] : [{id: '456', name: 'Owner server'}])));
    const info = await inspectDiscordBot(token, '456', request);
    expect(info.delivery).toBe('gateway');
    expect(info.channels.map(c => c.id)).toEqual(['789']);
    expect(info.installUrl).toContain('applications.commands');
    await expect(inspectDiscordBot(token, '999', request)).rejects.toThrow('Install');
  });
  it('synchronizes direct channel commands and verifies registration', async () => {
    const directRes = [{ id: '101', name: 'status' }, { id: '102', name: 'positions' }];
    const request = vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify(directRes)));
    expect((await syncDiscordCommands(token, '123', '456', request)).registered).toBe(true);
    expect(request.mock.calls.map(([, init]) => init?.method)).toEqual(['PUT']);
    expect(String(request.mock.calls[0][0])).toContain('/guilds/456/commands');

    const globalReq = vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify(directRes)));
    expect((await syncDiscordCommands(token, '123', undefined, globalReq)).registered).toBe(true);
    expect(String(globalReq.mock.calls[0][0])).toBe('https://discord.com/api/v10/applications/123/commands');
  });
  it('uses Bot API outbound delivery without a webhook and resolves DMs', async () => {
    const request = vi.fn(async () => new Response('{}'));
    const cfg = channelConfig({DISCORD_BOT_TOKEN: token, DISCORD_CHANNEL_ID: '789'});
    expect(await discordSend(cfg.discord, 'fixture', request)).toBe('sent');
    expect(request.mock.calls[0][0]).toBe('https://discord.com/api/v10/channels/789/messages');

    const dmReq = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('/users/@me/channels')) {
        const parsed = JSON.parse(String(init?.body ?? '{}'));
        return new Response(JSON.stringify({id: `dm_${parsed.recipient_id}`}));
      }
      return new Response('{}');
    });
    const dmCfg = channelConfig({DISCORD_BOT_TOKEN: token, DISCORD_ALLOWED_USER_IDS: 'user_boss, user_copilot'});
    expect(await discordSend(dmCfg.discord, 'dm alert', dmReq)).toBe('sent');
    expect(String(dmReq.mock.calls[0][0])).toBe('https://discord.com/api/v10/users/@me/channels');
    expect(String(dmReq.mock.calls[1][0])).toBe('https://discord.com/api/v10/users/@me/channels');
    expect(String(dmReq.mock.calls[2][0])).toBe('https://discord.com/api/v10/channels/dm_user_boss/messages');
    expect(String(dmReq.mock.calls[3][0])).toBe('https://discord.com/api/v10/channels/dm_user_copilot/messages');
  });
  it('parses named nested values in command order and preserves Owner authorization', () => {
    expect(discordCommandText({name: 'mpu', options: [{name: 'open', options: [{name: 'symbol', value: 'BTCUSDT'}, {name: 'leverage', value: 3}, {name: 'side', value: 'long'}, {name: 'size', value: 10}]}]})).toBe('open long BTCUSDT 10% 3x');
    expect(discordCommandText({name: 'mpu', options: [{name: 'kill', options: []}]})).toBe('kill');
    const cfg = channelConfig({CHANNEL_COMMANDS: 'on', DISCORD_ALLOWED_USER_IDS: '123', DISCORD_CHANNEL_ID: '789', DISCORD_GUILD_ID: '456'});
    expect(discordRefusal(cfg, {user: {id: '999'}, channel_id: '789', guild_id: '456'})).toContain('allowlist');
    expect(discordRefusal(cfg, {user: {id: '123'}, channel_id: '789', guild_id: '456'})).toBeNull();
    // Direct Message (DM) has no guild_id: allowlist user is authorized in DM
    expect(discordRefusal(cfg, {user: {id: '123'}, channel_id: 'dm_123'})).toBeNull();
  });
});
