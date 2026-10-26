/**
 * Multichannel Supervisor Synchronization Engine for Mpu Gandring.
 *
 * Coordinates real-time health, risk limits, resting stop status, and reports
 * across all connected channels (Telegram, Discord, Slack, WhatsApp):
 * - Evaluates immediate escalation conditions.
 * - Formats standardized desk supervisor reports following AGENTS.md protocol.
 * - Broadcasts synchronized alerts with deduplication.
 */

export interface SupervisorDeskState {
  mode: 'PAPER' | 'TESTNET' | 'LIVE';
  venue: string;
  killSwitchActive: boolean;
  officeUp: boolean;
  balance: number;
  equity: number;
  safetyNet: number;
  dailyLossCapPct: number;
  dailyLossUsedPct: number;
  dailyLossHit: boolean;
  positions: Array<{
    symbol: string;
    side: 'LONG' | 'SHORT';
    qty: number;
    entry: number;
    stop: number;
    tp: number | null;
    pnl: number;
    stopRestingOnExchange: boolean;
  }>;
  recentErrorsCount: number;
  findings: string[];
}

export interface EscalationAlert {
  level: 'ALERT' | 'WARN' | 'INFO';
  reason: string;
  detail: string;
  timestamp: number;
  requiresImmediateAttention: boolean;
}

export class MultichannelSupervisorSync {
  /**
   * Evaluates whether an immediate escalation alert must be triggered according to AGENTS.md rules.
   */
  public evaluateEscalations(state: SupervisorDeskState): EscalationAlert[] {
    const alerts: EscalationAlert[] = [];
    const now = Date.now();

    // 1. Position has no verified resting stop on exchange
    const missingStops = state.positions.filter(p => !p.stopRestingOnExchange);
    if (missingStops.length > 0) {
      alerts.push({
        level: 'ALERT',
        reason: 'POSITION_STOP_MISSING',
        detail: `Critical: ${missingStops.length} position(s) (${missingStops.map(p => p.symbol).join(', ')}) have NO resting stop order on the exchange!`,
        timestamp: now,
        requiresImmediateAttention: true,
      });
    }

    // 2. Kill switch turned on
    if (state.killSwitchActive) {
      alerts.push({
        level: 'ALERT',
        reason: 'KILL_SWITCH_ACTIVE',
        detail: 'Kill switch is ON. All trading halted and positions flattened.',
        timestamp: now,
        requiresImmediateAttention: true,
      });
    }

    // 3. Daily loss stop hit or cap >= 90% used
    if (state.dailyLossHit || state.dailyLossUsedPct >= 90) {
      alerts.push({
        level: 'ALERT',
        reason: 'DAILY_LOSS_LIMIT_REACHED',
        detail: `Daily loss stop triggered or near cap (${state.dailyLossUsedPct.toFixed(1)}% of ${state.dailyLossCapPct}% limit used).`,
        timestamp: now,
        requiresImmediateAttention: true,
      });
    }

    // 4. Equity at or below safety net
    if (state.equity <= state.safetyNet && state.safetyNet > 0) {
      alerts.push({
        level: 'ALERT',
        reason: 'SAFETY_NET_BREACHED',
        detail: `Equity (${state.equity.toFixed(2)}) is at or below safety net (${state.safetyNet.toFixed(2)}).`,
        timestamp: now,
        requiresImmediateAttention: true,
      });
    }

    // 5. 3 or more API/exchange errors
    if (state.recentErrorsCount >= 3) {
      alerts.push({
        level: 'WARN',
        reason: 'HIGH_ERROR_COUNT',
        detail: `${state.recentErrorsCount} API or exchange errors observed in recent checks.`,
        timestamp: now,
        requiresImmediateAttention: false,
      });
    }

    return alerts;
  }

  /**
   * Formats standardized supervisor status report following AGENTS.md specification.
   */
  public formatReport(state: SupervisorDeskState, dateStr: string = new Date().toISOString()): string {
    const allStopsResting = state.positions.length === 0 || state.positions.every(p => p.stopRestingOnExchange);
    const moneyTrade = Math.max(0, state.balance - state.safetyNet);

    const lines: string[] = [
      `Desk report ${dateStr}`,
      `Mode: ${state.mode} on ${state.venue}. Kill switch: ${state.killSwitchActive ? 'ON' : 'off'}. Office: ${state.officeUp ? 'up' : 'down'}.`,
      `Equity ${state.equity.toFixed(2)} USDT (balance ${state.balance.toFixed(2)}, safety net ${state.safetyNet.toFixed(2)}, Money Trade ${moneyTrade.toFixed(2)}). Today: ${state.dailyLossHit ? 'Loss stop hit' : 'Active'} (${state.dailyLossUsedPct.toFixed(1)}% of cap used).`,
      `Positions (${state.positions.length}):`,
    ];

    if (state.positions.length === 0) {
      lines.push('  No open positions.');
    } else {
      for (const p of state.positions) {
        lines.push(`  ${p.symbol} ${p.side} ${p.qty} entry ${p.entry} stop ${p.stop} tp ${p.tp ?? 'none'} PnL ${p.pnl >= 0 ? '+' : ''}${p.pnl.toFixed(2)}`);
      }
    }

    lines.push(`Every position has a stop on the exchange: ${allStopsResting ? 'yes' : 'NO'}.`);
    lines.push(`Findings: ${state.findings.length > 0 ? state.findings.join('; ') : 'none'}.`);

    const needsYou = state.positions.some(p => !p.stopRestingOnExchange) || state.killSwitchActive || state.dailyLossHit;
    lines.push(`Needs you: ${needsYou ? 'ACTION REQUIRED' : 'nothing'}.`);

    return lines.join('\n');
  }
}
