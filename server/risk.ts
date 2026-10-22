import type { AppConfig } from './config.js';

export interface GateResult {
  decision: 'APPROVE';
  sizeFactor: number;
  leverage: number;
  stopPct: number;
  notes: string[];
}

// Order parameters come from the Owner's profile, never model conviction or mood.
export function applyRiskGate(op: { leverage: number }, limits: AppConfig['risk']): GateResult {
  const notes: string[] = [];
  let { leverage } = op;

  // Leverage cap based on active profile.
  if (leverage > limits.maxLeverage) {
    notes.push(`Leverage ${leverage}x capped to ${limits.maxLeverage}x.`);
    leverage = limits.maxLeverage;
  }
  leverage = Math.max(1, Math.floor(leverage));

  return {
    decision: 'APPROVE',
    sizeFactor: 1,
    leverage,
    stopPct: limits.defaultStopPct,
    notes
  };
}
