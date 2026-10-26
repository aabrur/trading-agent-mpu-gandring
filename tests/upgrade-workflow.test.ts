import { describe, it, expect, vi } from 'vitest';
import { Desk } from '../server/desk.js';
import { AutoTrader } from '../server/auto.js';
import { loadConfig } from '../server/config.js';
import { previewTicket } from '../server/sizing.js';
import { makeCaller, type ModelRequest } from '../server/providers/index.js';
import { buildReport } from '../server/reports.js';

const config = () => loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEBATE_PACE_MS: '0', AUTO_SYMBOLS: 'BTCUSDT,ETHUSDT', AUTO_TRADING: 'off' });
describe('scheduler and decision payload', () => {
  it('records VETO and execution failure while ignoring a second Risk model rejection', async () => {
    for (const kind of ['veto', 'risk-reject', 'execution-failed'] as const) {
      const cfg = config(), caller = makeCaller(cfg);
      const d = new Desk(cfg, (r) => r.task === 'lead' ? Promise.resolve(JSON.stringify({ action: 'OPEN_LONG', confidence: 0.8, reason: 'Supported setup' })) :
        r.task === 'research' ? Promise.resolve(JSON.stringify({ vote: kind === 'veto' ? 'VETO' : 'ABSTAIN', confidence: 0.8, argument: 'Sourced event concern', sources: [] })) :
        r.task === 'risk' ? Promise.resolve(JSON.stringify({ decision: kind === 'risk-reject' ? 'REJECT' : 'APPROVE', sizeFactor: 1, leverage: 1, stopPct: 1.5, reason: 'Existing calculation' })) : caller(r));
      vi.spyOn(d, 'executeOpen').mockResolvedValue({ ok: false, line: 'Venue timeout', reason: 'Venue timeout' });
      await d.runDebate('BTCUSDT');
      expect(d.opportunityReviews.since(-1)[0].reasonKind).toBe(kind === 'risk-reject' ? 'execution-failed' : kind);
      expect(d.book.positions).toHaveLength(0);
      const before = { risk: structuredClone(cfg.risk), lessons: structuredClone(d.learnings.items), scores: d.scorecard.rows() };
      buildReport(d, -1);
      expect({ risk: cfg.risk, lessons: d.learnings.items, scores: d.scorecard.rows() }).toEqual(before);
    }
  });
  it('allows explicitly unpaced headless debates without speech timers', async () => {
    vi.useFakeTimers();
    const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEFAULT_PROVIDER: 'mock', DEBATE_PACE_MS: '0' });
    const caller = makeCaller(cfg);
    const desk = new Desk(cfg, (r) => r.task === 'lead' ? Promise.resolve(JSON.stringify({ action: 'HOLD', confidence: 0.7, reason: 'No setup' })) : caller(r), { jevEnv: { JEV_ENABLED: 'false' } });
    let completed = false;
    const work = desk.runDebate('BTCUSDT').then(() => { completed = true; });
    try {
      for (let i = 0; i < 500; i++) await Promise.resolve();
      expect(completed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { await vi.runAllTimersAsync(); await work; vi.useRealTimers(); }
  });
  it('Auto OFF allows the current symbol to finish but stops queued work', async () => {
    const cfg = config(); const d = new Desk(cfg, makeCaller(cfg)); const auto = new AutoTrader(d);
    vi.spyOn(d, 'closeStale').mockResolvedValue(0);
    const debate = vi.spyOn(d, 'runDebate').mockImplementation(async () => { auto.stop(); return {} as Awaited<ReturnType<Desk['runDebate']>>; });
    await auto.cycle();
    expect(debate).toHaveBeenCalledTimes(1);
    expect(d.autoState.on).toBe(false);
    expect(d.autoState.running).toBe(false);
  });
  it('HOLD skips the Risk model and includes strategy invalidation in the real payload', async () => {
    const cfg = config(); const calls: ModelRequest[] = []; const caller = makeCaller(cfg);
    const d = new Desk(cfg, async (r) => { calls.push(r); return r.task === 'lead' ? JSON.stringify({ action: 'HOLD', confidence: 0.7, reason: 'No setup' }) : caller(r); });
    await d.runDebate('BTCUSDT');
    expect(calls.some((r) => r.task === 'risk')).toBe(false);
    expect(calls.find((r) => r.task === 'lead')?.user).toContain('strategyInvalidated');
    const research = calls.find((r) => r.task === 'research')!.user;
    expect(research).not.toContain('largeWalletNetflow');
    expect(research).toContain('INFERRED');
    expect(d.opportunityReviews.since(-1)[0].reasonKind).toBe('hold');
  });
});

describe('active configuration ticket preview', () => {
  it('uses custom stop/TP parameters on both sides without changing the config', () => {
    const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEFAULT_STOP_PCT: '2', TAKE_PROFIT_PCT: '6', TAKE_PROFIT_R: '999' });
    const before = structuredClone(cfg.risk);
    const book = { balance: 1000, equity: 1000, safetyNet: 200, n: 4, open: 0, used: 0, mode: 'PAPER' };
    expect(previewTicket(cfg, book, { symbol: 'BTCUSDT', side: 'LONG', entry: 100 }, null).data).toMatchObject({ stop: 99.6, tp: 101.2 });
    expect(previewTicket(cfg, book, { symbol: 'BTCUSDT', side: 'SHORT', entry: 100 }, null).data).toMatchObject({ stop: 100.4, tp: 98.8 });
    expect(cfg.risk).toEqual(before);
  });
});
