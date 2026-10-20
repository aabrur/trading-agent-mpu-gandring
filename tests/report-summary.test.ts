import { describe, expect, it } from 'vitest';
import { Desk } from '../server/desk.js';
import { loadConfig } from '../server/config.js';
import { makeCaller } from '../server/providers/index.js';
import { buildReport, renderText } from '../server/reports.js';

function desk() {
  const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', AUTO_SYMBOLS: 'ETHUSDT,BTCUSDT', AUTO_TRADING: 'off' });
  return new Desk(cfg, makeCaller(cfg), { reportsDir: null, learningsPath: null });
}

describe('compact report summary', () => {
  it('captures current and previous monitoring without modifying desk state', () => {
    const d = desk();
    d.lastCycle = { symbol: 'ETHUSDT', durationMs: 100, stage: 'done', verdict: 'HOLD', outcome: 'HOLD', executionStatus: null, noTradeReason: 'No setup', reasonCode: 'NO_SETUP', timing: null };
    d.killed = true;
    const r = buildReport(d, 0);
    expect(r.monitoring).toMatchObject({ killed: true, running: false, symbols: d.cfg.watchlist, previous: 'ETHUSDT · HOLD · HOLD' });
    expect(r.text).toContain('Kill ON');
    expect(r.text).toContain('Previous: ETHUSDT');
    expect(r.text).toContain('managed net unknown');
    expect(d.book.positions).toHaveLength(0);
  });

  it('keeps long period history in structured data while bounding channel text', () => {
    const d = desk();
    for (let i = 0; i < 200; i++) d.activity.push({ at: i + 1, kind: 'skipped', symbol: 'ETHUSDT', detail: 'Waiting for a closed candle. '.repeat(40) });
    const r = buildReport(d, 0, 1000);
    expect(r.skipped).toHaveLength(200);
    expect(r.text).toContain('Skipped 200');
    expect(r.text.length).toBeLessThan(3000);
    expect(r.text.match(/Latest skip:/g)).toHaveLength(1);
  });

  it('puts missing exchange protection and scan alerts before routine activity', () => {
    const r = buildReport(desk(), 0);
    r.mode = 'LIVE';
    r.positions = [{ symbol: 'BTCUSDT', side: 'LONG', qty: 1, entry: 100, stop: 90, tp: null, mark: 100, pnl: 0, openedAt: 1, protectionStatus: 'unknown' }];
    r.scan = [{ code: 'stale', level: 'alert', text: 'Prices are stale.' }];
    const text = renderText(r);
    expect(text).toContain('Protection 1 UNVERIFIED');
    expect(text.indexOf('Prices are stale')).toBeLessThan(text.indexOf('Equity'));
    expect(text).toContain('SL 90 (unknown)');
  });
});
