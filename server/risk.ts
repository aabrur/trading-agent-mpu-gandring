import type { AppConfig } from './config.js';
import type { Out } from './agents/run.js';

export interface GateResult {
  decision: 'APPROVE' | 'REDUCE' | 'REJECT';
  sizeFactor: number;
  leverage: number;
  stopPct: number;
  notes: string[];
}

// The Risk Manager's opinion goes through hard code caps. It can only make a trade
// smaller or safer than the configured limits. It can never loosen them.
export function applyRiskGate(op: Out<'risk'>, limits: AppConfig['risk'], temperament = 0): GateResult {
  const notes: string[] = [];
  let { decision, sizeFactor, leverage, stopPct } = op;
  if (leverage > limits.maxLeverage) { notes.push(`Leverage ${leverage}x capped to ${limits.maxLeverage}x.`); leverage = limits.maxLeverage; }
  leverage = Math.max(1, Math.floor(leverage));
  if (sizeFactor > 1) sizeFactor = 1;
  if (decision === 'REDUCE' && sizeFactor >= 1) { sizeFactor = 0.5; notes.push('REDUCE with full size makes no sense, using 0.5.'); }
  if (decision === 'REJECT') sizeFactor = 0;
  if (stopPct > limits.defaultStopPct) { notes.push(`Stop ${stopPct}% is wider than the ${limits.defaultStopPct}% limit, tightened.`); stopPct = limits.defaultStopPct; }
  if (stopPct < limits.minStopPct) { notes.push(`Stop ${stopPct}% is tighter than the ${limits.minStopPct}% floor, set to the floor.`); stopPct = limits.minStopPct; }
  if (temperament < 0 && sizeFactor > 0) { sizeFactor = sizeFactor * Math.max(0.4, 1 + temperament * 0.2); notes.push('Owner asked Risk to be more cautious, size trimmed.'); }
  if (decision === 'APPROVE' && sizeFactor < 1) decision = 'REDUCE';
  return { decision, sizeFactor: Math.round(sizeFactor * 100) / 100, leverage, stopPct: Math.round(stopPct * 100) / 100, notes };
}
