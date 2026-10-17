import { describe, it, expect } from 'vitest';
import { loadConfig } from '../server/config.js';
import { Desk } from '../server/desk.js';
import { makeCaller } from '../server/providers/index.js';
import { strategyVote, ema } from '../server/strategy.js';
import { sampleCandles } from '../server/market/sample.js';
import { parseCommand } from '../server/commands.js';

const cfg = () => loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEBATE_PACE_MS: '0' });

describe('strategy rule', () => {
  it('EMA seeds with the simple average', () => {
    expect(ema([1, 2, 3, 4], 3)[2]).toBe(2);
  });
  it('abstains with too few bars', () => {
    expect(strategyVote(sampleCandles('BTCUSDT', 30)).side).toBe('ABSTAIN');
  });
  it('produces a side and invalidation on enough bars', () => {
    const v = strategyVote(sampleCandles('ETHUSDT'));
    expect(['LONG', 'SHORT', 'ABSTAIN']).toContain(v.side);
    if (v.side !== 'ABSTAIN') expect(v.invalidation).toBeGreaterThan(0);
  });
});

describe('full mock debate, zero keys, zero network', () => {
  it('runs end to end and emits speech, meter and a verdict', async () => {
    const c = cfg();
    const desk = new Desk(c, makeCaller(c), { reportsDir: null });
    const events: Record<string, number> = {};
    for (const e of ['speech', 'meter', 'verdict', 'fight']) desk.on(e, () => { events[e] = (events[e] ?? 0) + 1; });
    const v = await desk.runDebate('ETHUSDT');
    expect(['OPEN_LONG', 'OPEN_SHORT', 'CLOSE', 'HOLD']).toContain(v.action);
    expect(v.example).toBe(true);
    expect(events.speech).toBeGreaterThan(8);
    expect(events.verdict).toBe(1);
    expect(desk.debate).toBeNull();
  });
  it('is deterministic', async () => {
    const run = async () => { const c = cfg(); const d = new Desk(c, makeCaller(c), { reportsDir: null }); const v = await d.runDebate('SOLUSDT'); return [v.action, v.riskDecision, v.disagreement]; };
    expect(await run()).toEqual(await run());
  });
  it('every paper position has a stop and respects N', async () => {
    const c = cfg();
    const desk = new Desk(c, makeCaller(c), { reportsDir: null });
    await desk.command('set n 1');
    for (const s of ['ETHUSDT', 'BTCUSDT', 'SOLUSDT', 'ETHUSDT']) await desk.runDebate(s);
    expect(desk.book.positions.length).toBeLessThanOrEqual(1);
    for (const p of desk.book.positions) expect(p.stop).toBeGreaterThan(0);
  });
  it('commands work: pause blocks debates, close all empties the book', async () => {
    const c = cfg();
    const desk = new Desk(c, makeCaller(c), { reportsDir: null });
    await desk.runDebate('ETHUSDT');
    await desk.command('pause');
    await expect(desk.runDebate('BTCUSDT')).rejects.toThrow(/paused/);
    await desk.command('resume');
    const r = await desk.command('close all');
    expect(r.ok).toBe(true);
    expect(desk.book.positions.length).toBe(0);
    expect((await desk.command('set n 9')).ok).toBe(false);
    expect((await desk.command('set safety 300')).reply).toMatch(/Safety net set to 300 USDT\. Money Trade \d/);
  });
  it('chat with an agent returns an in-character reply', async () => {
    const c = cfg();
    const desk = new Desk(c, makeCaller(c), { reportsDir: null });
    const r = await desk.command('what do you think about funding?', 'risk');
    expect(r.command).toBe('chat');
    expect(r.reply).toMatch(/leverage|stop|cap/i);
    expect(desk.chats.risk.length).toBe(2);
  });
});

describe('command parser', () => {
  it('understands the main commands', () => {
    expect(parseCommand('analyze eth')).toEqual({ type: 'debate', symbol: 'ETHUSDT' });
    expect(parseCommand('set n 3')).toEqual({ type: 'set_n', n: 3 });
    expect(parseCommand('safety net 25')).toEqual({ type: 'set_safety', value: 25 });
    expect(parseCommand('close all')).toEqual({ type: 'close_all' });
    expect(parseCommand('be more cautious')).toEqual({ type: 'mood', delta: -1 });
    expect(parseCommand('tahan')).toEqual({ type: 'pause' });
  });
});
