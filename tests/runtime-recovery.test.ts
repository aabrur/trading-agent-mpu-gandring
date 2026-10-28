import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { AGENT_IDS, loadConfig } from '../server/config.js';
import { runAgent } from '../server/agents/run.js';
import { systemPrompt } from '../server/agents/roles.js';
import { ChatSchema, OpinionSchema, ResearchSchema, RebuttalSchema, LeadSchema, extractJson } from '../server/schemas.js';
import { asterFills, asterIncome, historyScope, historyText, parseHistoryJson } from '../server/exchange/financial-history.js';
import { AsterAdapter } from '../server/exchange/aster.js';
import { makeCaller } from '../server/providers/index.js';
import { Desk } from '../server/desk.js';
import { DeskLead } from '../server/channels/supervisor.js';

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => undefined) }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.mocked(delay).mockClear(); });
const cfg = () => loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEBATE_PACE_MS: '0' });
const input = { instruction: 'Reply.', data: {}, context: {} };

describe('model response recovery', () => {
  it('accepts plain chat and clips text before validation without inventing actions', async () => {
    const result = await runAgent(cfg(), async () => 'x'.repeat(70000), 'lead', 'chat', input);
    expect(result.fallback).toBe(false);
    expect(result.data.reply).toHaveLength(64000);
    expect(result.data.commandToExecute).toBeUndefined();
    expect(OpinionSchema.parse({ stance: 'LONG', argument: 'x'.repeat(3000) }).argument).toHaveLength(1500);
    expect(ChatSchema.parse({ reply: 'Paragraph one.\n\nParagraph two.' }).reply).toContain('\n\n');
    expect(extractJson('Hello {Boss}, how is your day?', 'chat')).toEqual({ reply: 'Hello {Boss}, how is your day?' });
    expect(extractJson('"Hello Boss"', 'chat')).toEqual({ reply: 'Hello Boss' });
  });
  it('repairs truncated strings, nested arrays and braces while preserving escaped quotes', () => {
    expect(extractJson('{"reply":"Hi \\"Boss\\"', 'chat')).toEqual({ reply: 'Hi "Boss"' });
    expect(extractJson('{"reply":"Hi', 'chat')).toEqual({ reply: 'Hi' });
    expect(extractJson('{"reply":"Hi", "notes":[{"text":"x"}')).toEqual({ reply: 'Hi', notes: [{ text: 'x' }] });
    expect(() => extractJson('{"decision":"APPROVE","stopPct":')).toThrow();
  });
  it('defaults missing confidence, while rejecting invalid confidence and decision fields', () => {
    expect(OpinionSchema.parse({ stance: 'LONG', argument: 'Trend' }).confidence).toBe(0.65);
    expect(ResearchSchema.parse({ vote: 'ABSTAIN', argument: 'No sources' }).confidence).toBe(0.65);
    expect(RebuttalSchema.parse({ stance: 'SHORT', rebuttal: 'Structure' }).confidence).toBe(0.65);
    expect(LeadSchema.parse({ action: 'HOLD', reason: 'Waiting' }).confidence).toBe(0.65);
    expect(LeadSchema.safeParse({ action: 'OPEN_LONG', confidence: 3, reason: 'bad' }).success).toBe(false);
  });
  it('requires a completed Risk judgment while preserving Owner sizing and ignoring the legacy equity loss cap', async () => {
    const config = cfg(), base = makeCaller(config);
    let mode: 'format' | 'reject' | 'approve' = 'format';
    const caller = vi.fn(async (request: Parameters<typeof base>[0]) => request.task === 'risk_assessment' ? mode === 'format' ? 'no JSON object' : mode === 'reject' ? '{"decision":"REJECT","reason":"Verified veto"}' : '{"decision":"APPROVE","reason":"Evidence and Owner exposure reviewed"}' : base(request));
    const desk = new Desk(config, caller, { reportsDir: null, learningsPath: null, killFile: null });
    const recovered = await desk.runDebate('ETHUSDT');
    expect(recovered.executed).toBe(false);
    expect(recovered.riskDecision).toBe('REJECT');
    await desk.command('close all');
    mode = 'reject';
    expect((await desk.runDebate('ETHUSDT')).riskDecision).toBe('REJECT');
    expect(desk.book.positions).toHaveLength(0);
    await desk.command('close all');
    mode = 'approve'; config.risk.maxLossPerTradePct = 0.000001;
    expect((await desk.runDebate('ETHUSDT')).executed).toBe(true);
    expect(desk.book.positions).toHaveLength(1);
    expect(caller.mock.calls.some(([request]) => request.task === 'risk')).toBe(false);
    desk.stop();
  });
  it('allocates sufficient output tokens to OpenRouter chat', async () => {
    const captured: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      captured.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"reply":"Hi"}' } }] }));
    });
    const config = loadConfig({ DEFAULT_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'fixture-key', MARKET_SOURCE: 'sample' });
    await runAgent(config, makeCaller(config), 'lead', 'chat', input);
    expect(Number(captured[0].max_tokens)).toBeGreaterThanOrEqual(1024);
  });
});

describe('financial history identifiers', () => {
  it('keeps large IDs exact, and missing-ID fallbacks stable across re-reads', () => {
    const parsed = parseHistoryJson('[{"id":9007199254740993,"orderId":9007199254740995,"symbol":"BTCUSDT","qty":"1","price":"100","time":1500}]') as Record<string, unknown>[];
    expect(asterFills(parsed, [])[0]).toMatchObject({ id: '9007199254740993', orderId: '9007199254740995' });
    expect(historyText(null)).toBe('unknown');
    expect(historyText(Number.MAX_SAFE_INTEGER + 1)).toBe(String(Number.MAX_SAFE_INTEGER + 1));
    const row = { symbol: 'BTCUSDT', qty: '1', price: '100', time: 1500 };
    expect(asterFills([row], [])[0].id).toBe(asterFills([{ time: 1500, price: '100', qty: '1', symbol: 'BTCUSDT' }], [])[0].id);
    expect(asterFills([{ ...row, time: 1600 }], [])[0].id).not.toBe(asterFills([row], [])[0].id);
    const income = { incomeType: 'FUNDING_FEE', symbol: 'BTCUSDT', income: '1', asset: 'USDT', time: 1500 };
    expect(asterIncome([income])[0].id).toBe(asterIncome([income])[0].id);
    expect(() => asterFills([{ symbol: 'BTCUSDT', price: '100', time: 1500 }], [])).toThrow();
    expect(() => historyScope('aster', 'mainnet', undefined)).toThrow();
  });
  it('preserves unquoted large IDs through the actual Aster HTTP reader', async () => {
    const fetcher = (async (url: string) => new Response(url.includes('/income?') ? '[]' : '[{"id":9007199254740993,"orderId":9007199254740995,"symbol":"BTCUSDT","qty":"1","price":"100","time":1500}]')) as typeof fetch;
    const adapter = new AsterAdapter('testnet', '0x1111111111111111111111111111111111111111', '0x' + '11'.repeat(32), fetcher);
    const page = await adapter.financialHistory({ since: 1000, until: 2000, symbols: ['BTCUSDT'] });
    expect(page.records.find((row) => row.kind === 'fill')).toMatchObject({ id: '9007199254740993', orderId: '9007199254740995' });
  });
});

describe('modular personas', () => {
  it.each(AGENT_IDS)('loads all four %s files in order, before extra context', (agent) => {
    const prompt = systemPrompt(agent, 'EXTRA_CONTEXT');
    let previous = -1;
    for (const name of ['identity', 'soul', 'role', 'agent']) {
      const body = readFileSync(new URL(`../server/agents/personas/${agent}/${name}.md`, import.meta.url), 'utf8').trim();
      const at = prompt.indexOf(body);
      expect(at).toBeGreaterThan(previous); previous = at;
    }
    expect(prompt.endsWith('EXTRA_CONTEXT')).toBe(true);
  });
});

describe('Telegram polling lifecycle', () => {
  function fixture(fetcher: typeof fetch) {
    const config = loadConfig({ MARKET_SOURCE: 'sample', CHANNEL_COMMANDS: 'on', TELEGRAM_BOT_TOKEN: '123456:fixture-token', TELEGRAM_CHAT_ID: '111', TELEGRAM_ALLOWED_USER_IDS: '222' });
    const desk = new Desk(config, makeCaller(config), { reportsDir: null, learningsPath: null, killFile: null });
    return { config, desk, lead: new DeskLead(desk, config.channels, fetcher) };
  }
  const hold = (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true });
  });
  it('has one poller per token and aborts the old request on stop/start', async () => {
    const fetcher = vi.fn(hold) as typeof fetch;
    const { config, desk, lead } = fixture(fetcher);
    const duplicate = new DeskLead(desk, config.channels, fetcher);
    try {
      lead.start(); lead.start(); duplicate.start();
      expect(fetcher).toHaveBeenCalledTimes(1);
      lead.stop(); lead.start();
      expect(fetcher).toHaveBeenCalledTimes(2);
      await Promise.resolve();
      lead.start(); expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { lead.stop(); duplicate.stop(); }
  });
  it('probes the connection before retrying and ignores repeated update IDs', async () => {
    const calls: string[] = [];
    const fetcher = (async (url, init) => {
      calls.push(String(url));
      if (calls.length === 1) throw new TypeError('fetch failed');
      if (String(url).includes('/getMe')) return new Response('{"ok":true}');
      return hold(url, init);
    }) as typeof fetch;
    const { lead, desk } = fixture(fetcher);
    try {
      lead.start();
      await vi.waitFor(() => expect(calls).toHaveLength(3));
      expect(calls[1]).toContain('/getMe');
      expect(vi.mocked(delay).mock.calls[0][0]).toBe(15000);
    } finally { lead.stop(); }
    const send = vi.spyOn(lead.hub, 'send').mockResolvedValue('sent');
    const update = { update_id: 42, message: { chat: { id: 111 }, from: { id: 222 }, text: 'set size 5%' } };
    expect(await lead.handleTelegramUpdate(update)).toContain('5%');
    expect(await lead.handleTelegramUpdate(update)).toBeNull();
    expect(desk.cfg.risk.orderSizePct).toBe(5);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
