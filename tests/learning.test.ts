import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server/config.js';
import { Desk } from '../server/desk.js';
import { AutoTrader } from '../server/auto.js';
import { buildReport } from '../server/reports.js';
import { makeCaller, type ModelCaller } from '../server/providers/index.js';
import { Learnings, loosensGuard } from '../server/learnings.js';
import { proactiveScan } from '../server/scan.js';

const base = { TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEBATE_PACE_MS: '0', AUTO_TRADING: 'on', AUTO_SYMBOLS: 'ETHUSDT' };
const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), 'mg-learn-')), 'learnings.json');
const mk = (extra: Record<string, string> = {}, caller?: ModelCaller, file: string | null = null) => {
  const c = loadConfig({ ...base, ...extra });
  return new Desk(c, caller ?? makeCaller(c), { reportsDir: null, learningsPath: file });
};
const L = (lesson: string, role: 'market' | 'risk' | 'desk' = 'market') => ({ role, kind: 'loss' as const, happened: 'ETH short stopped out', rootCause: 'entered against the 1h trend', lesson });

describe('lesson advice and Owner settings', () => {
  it('allows discussion of risk parameters without treating lesson text as settings', () => {
    for (const t of ['Use 10x leverage on strong setups', 'Skip the stop loss when confident', 'remove stops on winners', 'increase position size after a loss', 'trade the safety net when the setup is great', 'disable the daily loss stop', 'widen the stop to avoid noise', 'average down on losers', 'set N to 8', 'retry the order until it fills'])
      expect(loosensGuard(t), t).toBe(false);
    for (const t of ['Wait for a closed 15m bar above EMA21 before going long', 'REDUCE size when the room is split', 'HOLD on stale data', 'Every position needs a stop on the exchange; close any position found without one.'])
      expect(loosensGuard(t), t).toBe(false);
  });
  it('every lesson the desk writes by itself passes the block', () => {
    const src = readFileSync('server/desk.ts', 'utf8');
    const built = [...src.matchAll(/lesson: '([^']+)'/g)].map((m) => m[1]);
    expect(built.length).toBeGreaterThan(5);
    for (const t of built) expect(loosensGuard(t), t).toBe(false);
  });
  it('stores and promotes advice without changing execution settings', () => {
    const file = tmp();
    const l = new Learnings(file, 3);
    for (let i = 0; i < 4; i++) expect(l.add(L('Use 20x leverage when everyone agrees'))).not.toBeNull();
    expect(l.items).toHaveLength(1);
    expect(l.refused).toBe(0);
    writeFileSync(file, JSON.stringify({ lessons: [{ id: 'x', key: 'k', role: 'risk', kind: 'note', happened: '', rootCause: '', lesson: 'skip the risk gate on strong signals', status: 'promoted', count: 9, firstAt: 1, lastAt: 1, source: 'desk' }] }));
    const again = new Learnings(file, 3);
    expect(again.items).toHaveLength(1);
    expect(again.standingRules()).toHaveLength(1);
    const desk = mk({}, undefined, file);
    expect(desk.cfg.risk.maxLeverage).toBe(5);
  });
});

describe('self-improving: reflect and promote', () => {
  it('new, confirmed, promoted after 3 sightings; standing rules persist across restarts', () => {
    const file = tmp();
    const l = new Learnings(file, 3);
    expect(l.add(L('Wait for a closed bar above EMA21 before longs'))!.event).toBe('new');
    expect(l.add(L('Wait for a closed bar above EMA21 before longs'))!.event).toBe('confirmed');
    expect(l.add(L('Wait for a closed bar above EMA21 before longs'))!.event).toBe('promoted');
    expect(l.items).toHaveLength(1);
    expect(l.standingRules('market').map((x) => x.lesson)).toEqual(['Wait for a closed bar above EMA21 before longs']);
    expect(l.standingRules('risk')).toHaveLength(0); // role scoped
    const reloaded = new Learnings(file, 3);
    expect(reloaded.standingRules('market')).toHaveLength(1);
  });
  it('standing rules and recent lessons are fed into the agents prompts before each debate', async () => {
    const seen: { agent: string; system: string; user: string }[] = [];
    const c = loadConfig(base);
    const inner = makeCaller(c);
    const spy: ModelCaller = async (req) => { seen.push({ agent: req.agent, system: req.system, user: req.user }); return inner(req); };
    const desk = mk({}, spy);
    for (let i = 0; i < 3; i++) desk.learn(L('Wait for a closed bar above EMA21 before longs'));
    desk.learn({ ...L('Funding above 0.03% means crowded longs, be careful'), kind: 'stop' });
    await desk.runDebate('ETHUSDT');
    const market = seen.find((s) => s.agent === 'market')!;
    expect(market.system).toMatch(/Standing rules/);
    expect(market.system).toContain('Wait for a closed bar above EMA21 before longs');
    expect(market.system).toMatch(/advice only/);
    expect(market.user).toContain('Funding above');
  });
  it('a closed losing trade writes lessons and updates the scorecard', async () => {
    const desk = mk();
    await desk.runDebate('ETHUSDT'); // opens a SHORT on sample data
    const p = desk.book.positions[0];
    expect(p).toBeTruthy();
    await desk.executeClose('ETHUSDT', p.entry * 1.01, 'stop loss hit');
    for (let i = 0; i < 40 && !desk.learnings.items.some((x) => x.kind === 'stop'); i++) await new Promise((r) => setTimeout(r, 25));
    expect(desk.learnings.items.some((x) => x.role === 'lead' && x.kind === 'stop')).toBe(true);
    const lead = desk.scorecard.rows().find((r) => r.role === 'lead')!;
    expect(lead.wrong).toBe(1);
  });
  it('records Owner corrections without silently changing active risk settings', async () => {
    const desk = mk();
    await desk.command('that was wrong, do not short into support', 'market');
    expect(desk.learnings.items.some((x) => x.kind === 'correction' && x.role === 'market')).toBe(true);
    await desk.command('you were wrong, use 10x leverage next time', 'risk');
    expect(desk.learnings.items.some((x) => x.role === 'risk')).toBe(true);
    expect(desk.cfg.risk.maxLeverage).toBe(5);
  });
});

describe('proaktif-agent: scan before every cycle', () => {
  it('flags loss cap usage, missing stops, errors, stale data and the safety net', () => {
    const desk = mk({ LOSS_WARN_PCT: '70', STALE_FEED_MIN: '5' });
    desk.checkDay();
    desk.day.startEquity = desk.book.balance / (1 - 0.0225); // 2.25% down of a 3% cap = 75% used
    desk.book.positions.push({ id: 'p1', symbol: 'ETHUSDT', side: 'LONG', qty: 1, entry: 3000, stop: 0, tp: null, margin: 100, leverage: 1, openedAt: Date.now(), mark: 3000, unrealizedPnl: 0 } as never);
    desk.recordError('exchange', 'HTTP 503 from exchange');
    desk.tickers.ETHUSDT = { symbol: 'ETHUSDT', last: 3000, change24hPct: 0, source: 'sample', example: true, at: Date.now() - 20 * 60_000 };
    desk.book.balance = 215; // Money Trade 15 above the 200 safety net
    const codes = proactiveScan(desk).map((f) => `${f.level}:${f.code}`);
    expect(codes).toContain('alert:no_stop');
    expect(codes.some((c) => c.endsWith(':daily_loss_usage') || c.endsWith(':daily_loss_hit'))).toBe(true);
    expect(codes).toContain('warn:errors');
    expect(codes).toContain('warn:stale_feed');
    expect(codes).toContain('warn:safety_net');
  });
  it('a clean desk scans ok', () => {
    const desk = mk();
    desk.tickers.ETHUSDT = { symbol: 'ETHUSDT', last: 3000, change24hPct: 0, source: 'sample', example: true, at: Date.now() };
    expect(proactiveScan(desk).map((f) => f.level)).toEqual(['ok']);
  });
  it('the auto cycle scans first, reflects after, and the report lists lessons this period', async () => {
    const desk = mk({ STALE_FEED_MIN: '1' });
    const auto = new AutoTrader(desk, 0);
    const since = Date.now() - 1;
    desk.tickers.ETHUSDT = { symbol: 'ETHUSDT', last: 3000, change24hPct: 0, source: 'sample', example: true, at: Date.now() - 5 * 60_000 };
    desk.book.positions.push({ id: 'p1', symbol: 'SOLUSDT', side: 'LONG', qty: 1, entry: 150, stop: 0, tp: null, margin: 50, leverage: 1, openedAt: Date.now(), mark: 150, unrealizedPnl: 0 } as never);
    await auto.cycle();
    expect(desk.lastScan).not.toBeNull();
    const scanLog = desk.logs.findIndex((l) => /^Scan/.test(l.text));
    const firstSpeech = desk.logs.findIndex((l) => l.kind === 'speech');
    expect(scanLog).toBeGreaterThanOrEqual(0);
    expect(scanLog).toBeLessThan(firstSpeech); // scan BEFORE the debate
    expect(desk.learnings.items.some((x) => x.kind === 'scan' && x.role === 'execution')).toBe(true); // reflect AFTER
    const rep = buildReport(desk, since);
    expect(rep.text).toMatch(/Lessons this period \([1-9]/);
    expect(rep.text).toMatch(/Scorecard \(Desk Lead\)/);
    expect(rep.scorecard).toHaveLength(6);
  });
  it('LEARNING=off writes nothing', async () => {
    const desk = mk({ LEARNING: 'off' });
    desk.learn(L('Wait for a closed bar above EMA21 before longs'));
    expect(desk.learnings.items).toHaveLength(0);
  });
});
