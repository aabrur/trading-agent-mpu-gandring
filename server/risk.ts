import type { AppConfig } from './config.js';
import type { Out } from './agents/run.js';

export interface GateResult {
  decision: 'APPROVE' | 'REDUCE' | 'REJECT';
  sizeFactor: number;
  leverage: number;
  stopPct: number;
  notes: string[];
}

// High-conviction risk gate: protects against catastrophic ruin and noise-wick stop-outs
// while allowing aggressive sizing and structural breathing room when momentum aligns.
export function applyRiskGate(op: Out<'risk'>, limits: AppConfig['risk'], temperament = 0): GateResult {
  const notes: string[] = [];
  let { decision, sizeFactor, leverage, stopPct } = op;

  // 1. Leverage cap based on active profile
  if (leverage > limits.maxLeverage) {
    notes.push(`Leverage ${leverage}x capped to ${limits.maxLeverage}x.`);
    leverage = limits.maxLeverage;
  }
  leverage = Math.max(1, Math.floor(leverage));

  // 2. Stop-loss breathing room: enforce minimum floor so wicks don't eat fees,
  // The active owner's stop limit is also the execution planner's stop limit.
  const effectiveMaxStop = limits.defaultStopPct;

  if (stopPct < limits.minStopPct) {
    notes.push(`Stop ${stopPct}% is tighter than the ${limits.minStopPct}% anti-whipsaw floor, widened to floor.`);
    stopPct = limits.minStopPct;
  }
  if (stopPct > effectiveMaxStop) {
    notes.push(`Stop ${stopPct}% capped to ${effectiveMaxStop}% maximum structural distance.`);
    stopPct = effectiveMaxStop;
  }

  // 3. Conviction sizing & temperament scaling
  if (decision === 'REJECT') {
    sizeFactor = 0;
  } else {
    if (decision === 'REDUCE' && sizeFactor >= 1) {
      // Do not blindly slash to 0.5; use a measured 0.75 reduction so winners still pay for fees
      sizeFactor = temperament > 0 ? 0.85 : 0.75;
      notes.push(`REDUCE adjusted to ${sizeFactor}x conviction size.`);
    }

    if (temperament > 0 && sizeFactor > 0) {
      const boost = Math.min(1.5, 1 + temperament * 0.25);
      sizeFactor = Math.min(1.0, sizeFactor * boost);
      notes.push(`Aggressive temperament active: sizeFactor boosted (${boost.toFixed(2)}x multiplier).`);
    } else if (temperament < 0 && sizeFactor > 0) {
      sizeFactor = sizeFactor * Math.max(0.4, 1 + temperament * 0.2);
      notes.push('Cautious temperament active: size trimmed.');
    }

    if (sizeFactor > 1) sizeFactor = 1;
  }

  if (decision === 'APPROVE' && sizeFactor < 0.85) decision = 'REDUCE';

  return {
    decision,
    sizeFactor: Math.round(sizeFactor * 100) / 100,
    leverage,
    stopPct: Math.round(stopPct * 100) / 100,
    notes
  };
}
