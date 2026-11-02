import { describe, expect, it } from 'vitest';
import { formatDeskReportText } from '../../server/v2/reports.js';
import { deskOpenPnl, formatReportCard, formatStatusCard } from '../../server/v2/channel-text.js';

describe('channel command cards', () => {
  it('uses the same Open PnL as the office badge', () => {
    const live = deskOpenPnl({
      mode: 'LIVE',
      paperUnrealized: 1,
      venueUnrealized: 50,
      venueStatus: 'confirmed'
    });
    expect(live).toEqual({ value: 50, source: 'Exchange' });

    const report = formatDeskReportText({
      at: Date.parse('2026-11-02T16:11:00Z'),
      mode: 'LIVE',
      venue: 'bybit',
      killed: false,
      equity: 1050,
      balance: 1000,
      safetyNet: 200,
      moneyTrade: 800,
      dailyLossHit: false,
      dailyLossLimitPct: 10,
      positions: [{ symbol: 'BTCUSDT', side: 'LONG', qty: 0.05, entry: 60000, stop: 58500, unrealizedPnl: 50 }],
      openPnl: live.value,
      pnlSource: live.source,
      realized: 12.4,
      autoOn: true,
      autoIntervalMin: 15
    });
    const status = formatStatusCard({
      mode: 'LIVE',
      venue: 'bybit',
      killed: false,
      autoOn: true,
      autoIntervalMin: 15,
      equity: 1050,
      balance: 1000,
      safetyNet: 200,
      moneyTrade: 800,
      perOrder: 266.66,
      openPnl: live.value,
      pnlSource: live.source,
      realized: 12.4,
      positions: 1,
      slots: 3,
      freeSlots: 2,
      dailyLossHit: false,
      dailyLossLimitPct: 10
    });
    expect(report).toContain('Open PnL +50.00 USDT · Exchange');
    expect(status).toContain('Open PnL +50.00 USDT · Exchange');
    expect(report).toContain('PnL +50.00');
    expect(report).not.toContain('pnl 0');
    expect(report).toContain('🟢 ▲');
    expect(report).toContain('📋 REPORT');
  });

  it('does not invent a zero when Open PnL is unavailable', () => {
    const text = formatReportCard({
      at: Date.parse('2026-11-02T16:11:00Z'),
      mode: 'LIVE',
      venue: 'aster',
      killed: false,
      autoOn: false,
      autoIntervalMin: 15,
      equity: null,
      balance: null,
      safetyNet: 200,
      moneyTrade: null,
      openPnl: null,
      pnlSource: 'Local estimate',
      realized: null,
      dailyLossHit: false,
      dailyLossLimitPct: 10,
      positions: []
    });
    expect(text).toContain('Open PnL unavailable');
    expect(text).not.toContain('Open PnL +0.00');
  });
});
