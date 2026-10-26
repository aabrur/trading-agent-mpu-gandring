import { describe, expect, it } from 'vitest';
import { MultichannelSupervisorSync, type SupervisorDeskState } from '../server/channels/supervisor-sync.js';

describe('Multichannel Supervisor Synchronization', () => {
  const sync = new MultichannelSupervisorSync();

  const baseState: SupervisorDeskState = {
    mode: 'LIVE',
    venue: 'bybit',
    killSwitchActive: false,
    officeUp: true,
    balance: 1000,
    equity: 1050,
    safetyNet: 200,
    dailyLossCapPct: 3.0,
    dailyLossUsedPct: 0.5,
    dailyLossHit: false,
    positions: [
      {
        symbol: 'BTCUSDT',
        side: 'LONG',
        qty: 0.05,
        entry: 60000,
        stop: 58500,
        tp: 64000,
        pnl: 50,
        stopRestingOnExchange: true,
      },
    ],
    recentErrorsCount: 0,
    findings: [],
  };

  it('triggers immediate ALERT when a position has NO resting stop loss on the exchange', () => {
    const dangerousState: SupervisorDeskState = {
      ...baseState,
      positions: [
        {
          symbol: 'ETHUSDT',
          side: 'LONG',
          qty: 1,
          entry: 3000,
          stop: 2900,
          tp: 3200,
          pnl: -10,
          stopRestingOnExchange: false, // Critical failure
        },
      ],
    };

    const alerts = sync.evaluateEscalations(dangerousState);
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    const stopAlert = alerts.find(a => a.reason === 'POSITION_STOP_MISSING');
    expect(stopAlert).toBeDefined();
    expect(stopAlert?.level).toBe('ALERT');
    expect(stopAlert?.requiresImmediateAttention).toBe(true);
  });

  it('triggers immediate ALERT when kill switch is active or daily loss limit is reached', () => {
    const killedState: SupervisorDeskState = {
      ...baseState,
      killSwitchActive: true,
      dailyLossHit: true,
      dailyLossUsedPct: 100,
    };

    const alerts = sync.evaluateEscalations(killedState);
    expect(alerts.some(a => a.reason === 'KILL_SWITCH_ACTIVE')).toBe(true);
    expect(alerts.some(a => a.reason === 'DAILY_LOSS_LIMIT_REACHED')).toBe(true);
  });

  it('formats standardized AGENTS.md supervisor report with resting stop status', () => {
    const reportText = sync.formatReport(baseState, '2026-10-26T09:00:00Z');
    expect(reportText).toContain('Desk report 2026-10-26T09:00:00Z');
    expect(reportText).toContain('Mode: LIVE on bybit. Kill switch: off. Office: up.');
    expect(reportText).toContain('Equity 1050.00 USDT (balance 1000.00, safety net 200.00, Money Trade 800.00)');
    expect(reportText).toContain('BTCUSDT LONG 0.05 entry 60000 stop 58500 tp 64000 PnL +50.00');
    expect(reportText).toContain('Every position has a stop on the exchange: yes.');
    expect(reportText).toContain('Needs you: nothing.');
  });
});
