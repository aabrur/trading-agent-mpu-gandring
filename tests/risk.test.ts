import { describe, it, expect } from 'vitest';
import { applyRiskGate } from '../server/risk.js';
import { loadConfig } from '../server/config.js';

const limits = loadConfig({ TRADING_MODE: 'PAPER' }).risk;

describe('Owner profile order parameters', () => {
  it('caps leverage at the selected profile and uses its margin stop', () => {
    const g = applyRiskGate({ leverage: 100 }, limits);
    expect(g.leverage).toBe(limits.maxLeverage);
    expect(g.stopPct).toBe(limits.defaultStopPct);
  });
  it('keeps requested leverage below the cap without reducing allocation', () => {
    const g = applyRiskGate({ leverage: 1 }, limits);
    expect(g).toMatchObject({ decision: 'APPROVE', sizeFactor: 1, leverage: 1, stopPct: limits.defaultStopPct });
  });
  it('does not use legacy model rejection, size factor or stop choices', () => {
    const proposal = { decision: 'REJECT', sizeFactor: 0, leverage: 3, stopPct: 0.1 };
    expect(applyRiskGate(proposal, limits)).toMatchObject({ decision: 'APPROVE', sizeFactor: 1, stopPct: limits.defaultStopPct });
  });
  it('has no independent minimum stop floor', () => {
    expect(applyRiskGate({ leverage: 3 }, { ...limits, minStopPct: 1.2, defaultStopPct: 0.1 }).stopPct).toBe(0.1);
  });
});
