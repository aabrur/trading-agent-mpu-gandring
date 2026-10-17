import { describe, it, expect } from 'vitest';
import { applyRiskGate } from '../server/risk.js';
import { loadConfig } from '../server/config.js';

const limits = loadConfig({ TRADING_MODE: 'PAPER' }).risk;

describe('risk gate can tighten, never loosen', () => {
  it('caps leverage and widened stops', () => {
    const g = applyRiskGate({ decision: 'APPROVE', sizeFactor: 1, leverage: 100, stopPct: 20, reason: 'yolo' }, limits);
    expect(g.leverage).toBe(limits.maxLeverage);
    expect(g.stopPct).toBe(limits.defaultStopPct);
  });
  it('keeps a tighter choice from the agent', () => {
    const g = applyRiskGate({ decision: 'REDUCE', sizeFactor: 0.3, leverage: 1, stopPct: 0.8, reason: 'careful' }, limits);
    expect(g).toMatchObject({ decision: 'REDUCE', sizeFactor: 0.3, leverage: 1, stopPct: 0.8 });
  });
  it('REJECT means zero size', () => {
    expect(applyRiskGate({ decision: 'REJECT', sizeFactor: 1, leverage: 3, stopPct: 1, reason: 'no' }, limits).sizeFactor).toBe(0);
  });
  it('a cautious owner mood trims size further', () => {
    const g = applyRiskGate({ decision: 'APPROVE', sizeFactor: 1, leverage: 3, stopPct: 1, reason: 'ok' }, limits, -2);
    expect(g.sizeFactor).toBeLessThan(1);
    expect(g.decision).toBe('REDUCE');
  });
});
