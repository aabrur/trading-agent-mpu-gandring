export const HOLD_REASON = {
  NO_STRATEGY_SIGNAL: 'NO_STRATEGY_SIGNAL',
  LOW_CONFIDENCE: 'LOW_CONFIDENCE',
  CRITICAL_EVENT_VETO: 'CRITICAL_EVENT_VETO',
  STALE_MARKET_DATA: 'STALE_MARKET_DATA',
  EXISTING_POSITION: 'EXISTING_POSITION',
  INSUFFICIENT_CAPITAL: 'INSUFFICIENT_CAPITAL',
  DAILY_LOSS_CAP: 'DAILY_LOSS_CAP',
  RISK_REJECT: 'RISK_REJECT',
  EXCHANGE_CONSTRAINT: 'EXCHANGE_CONSTRAINT',
  PROVIDER_FAILURE: 'PROVIDER_FAILURE',
  EXECUTION_FAILURE: 'EXECUTION_FAILURE',
  UNRESOLVED_ORDER: 'UNRESOLVED_ORDER',
  STALE_SIGNAL: 'STALE_SIGNAL',
  EXTERNAL_POSITION: 'EXTERNAL_POSITION',
  NO_POSITION_TO_CLOSE: 'NO_POSITION_TO_CLOSE',
  KILL_SWITCH: 'KILL_SWITCH',
  DESK_PAUSED: 'DESK_PAUSED'
} as const;

export type HoldReasonCode = typeof HOLD_REASON[keyof typeof HOLD_REASON];

export type DecisionOutcome = 'HOLD' | 'BLOCKED' | 'FAILED' | 'SUBMITTED' | 'PARTIAL' | 'FILLED' | 'CLOSED';

export function classifyHoldReason(reason: string): HoldReasonCode | null {
  const t = reason.toLowerCase();
  if (/kill switch/.test(t)) return HOLD_REASON.KILL_SWITCH;
  if (/paused/.test(t)) return HOLD_REASON.DESK_PAUSED;
  if (/daily loss/.test(t)) return HOLD_REASON.DAILY_LOSS_CAP;
  if (/confidence/.test(t)) return HOLD_REASON.LOW_CONFIDENCE;
  if (/veto|critical event/.test(t)) return HOLD_REASON.CRITICAL_EVENT_VETO;
  if (/stale signal|thesis (is |was )?invalid/.test(t)) return HOLD_REASON.STALE_SIGNAL;
  if (/stale|unavailable market|sample data/.test(t)) return HOLD_REASON.STALE_MARKET_DATA;
  if (/already has an open position|existing position/.test(t)) return HOLD_REASON.EXISTING_POSITION;
  if (/external/.test(t)) return HOLD_REASON.EXTERNAL_POSITION;
  if (/nothing left|too small|minimum|insufficient|safety net/.test(t)) return HOLD_REASON.INSUFFICIENT_CAPITAL;
  if (/risk rejected|rejected:/.test(t)) return HOLD_REASON.RISK_REJECT;
  if (/instrument|not trading|\blot\b|notional|exchange/.test(t)) return HOLD_REASON.EXCHANGE_CONSTRAINT;
  if (/not filled|execution venue|no fill/.test(t)) return HOLD_REASON.EXECUTION_FAILURE;
  if (/reconcil|pending|unresolved/.test(t)) return HOLD_REASON.UNRESOLVED_ORDER;
  if (/no strategy|abstain|undecided|no valid setup/.test(t)) return HOLD_REASON.NO_STRATEGY_SIGNAL;
  if (/nothing to close|no position/.test(t)) return HOLD_REASON.NO_POSITION_TO_CLOSE;
  return null;
}

export function outcomeFor(input: {
  action: 'OPEN_LONG' | 'OPEN_SHORT' | 'CLOSE' | 'HOLD';
  executed: boolean;
  executionStatus?: string;
  reasonCode?: string | null;
  blocked?: boolean;
  failed?: boolean;
}): DecisionOutcome {
  if (input.executionStatus === 'partial') return 'PARTIAL';
  if (input.executionStatus === 'filled') return 'FILLED';
  if (input.executionStatus === 'closed') return 'CLOSED';
  if (input.executionStatus === 'submitted') return 'SUBMITTED';
  if (input.reasonCode === HOLD_REASON.RISK_REJECT) return 'BLOCKED';
  if (input.action === 'HOLD') return input.blocked ? 'BLOCKED' : 'HOLD';
  if (input.blocked) return 'BLOCKED';
  if (input.action === 'CLOSE') return input.executed ? 'CLOSED' : 'FAILED';
  if (input.executed) return 'FILLED';
  return 'FAILED';
}
