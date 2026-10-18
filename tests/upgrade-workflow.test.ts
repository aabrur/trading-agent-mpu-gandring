import { describe, it, expect, vi } from 'vitest';
import { Desk } from '../server/desk.js';
import { AutoTrader } from '../server/auto.js';
import { loadConfig } from '../server/config.js';
import { previewTicket } from '../server/sizing.js';
import { makeCaller, type ModelRequest } from '../server/providers/index.js';

const config = () => loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEBATE_PACE_MS: '0', AUTO_SYMBOLS: 'BTCUSDT,ETHUSDT', AUTO_TRADING: 'off' });
describe('scheduler and decision payload', () => {
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
  });
});

describe('active configuration ticket preview', () => {
  it('uses custom stop/TP parameters on both sides without changing the config', () => {
    const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEFAULT_STOP_PCT: '2', TAKE_PROFIT_R: '3' });
    const before = structuredClone(cfg.risk);
    const book = { balance: 1000, equity: 1000, safetyNet: 200, n: 4, open: 0, used: 0, mode: 'PAPER' };
    expect(previewTicket(cfg, book, { symbol: 'BTCUSDT', side: 'LONG', entry: 100 }, null).data).toMatchObject({ stop: 98, tp: 106 });
    expect(previewTicket(cfg, book, { symbol: 'BTCUSDT', side: 'SHORT', entry: 100 }, null).data).toMatchObject({ stop: 102, tp: 94 });
    expect(cfg.risk).toEqual(before);
  });
});
