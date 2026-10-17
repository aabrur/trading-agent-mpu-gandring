import { describe, it, expect } from 'vitest';
import { moneySplit, planOrder } from '../server/money.js';

const base = { balance: 1000, safetyNet: 200, n: 4, openPositions: 0, usedMargin: 0, price: 100, side: 'LONG' as const, sizeFactor: 1, leverage: 2, stopPct: 1.5, minOrderUsdt: 5, maxLossPerTradePct: 1 };

describe('money split (Boss rule)', () => {
  it('matches the written example: 100 balance, 20 safety net, N=4 gives 20 per order', () => {
    const s = moneySplit({ balance: 100, safetyNet: 20, n: 4 });
    expect(s.moneyTrade).toBe(80);
    expect(s.perOrder).toBe(20);
    expect(s.canOpen).toBe(true);
  });
  it.each([1, 2, 3, 4])('splits Money Trade evenly for N=%i', (n) => {
    expect(moneySplit({ balance: 500, safetyNet: 100, n }).perOrder).toBeCloseTo(400 / n, 2);
  });
  it('rejects N outside 1 to 4', () => {
    expect(() => moneySplit({ balance: 100, safetyNet: 10, n: 5 })).toThrow();
    expect(() => moneySplit({ balance: 100, safetyNet: 10, n: 0 })).toThrow();
  });
  it('stops opening when balance is at or below the safety net', () => {
    expect(moneySplit({ balance: 20, safetyNet: 20, n: 2 }).canOpen).toBe(false);
    const p = planOrder({ ...base, balance: 150, safetyNet: 200 });
    expect(p.ok).toBe(false);
  });
});

describe('order planning', () => {
  it('never exceeds N positions', () => {
    const p = planOrder({ ...base, openPositions: 4 });
    expect(p.ok).toBe(false);
  });
  it('never touches the safety net', () => {
    const trimmed = planOrder({ ...base, n: 1, usedMargin: 790 });
    expect(trimmed.ok).toBe(true);
    if (trimmed.ok) expect(trimmed.margin + 790).toBeLessThanOrEqual(800);
    expect(planOrder({ ...base, n: 1, usedMargin: 798 }).ok).toBe(false);
  });
  it('refuses an order without a stop', () => {
    expect(planOrder({ ...base, stopPct: 0 }).ok).toBe(false);
  });
  it('does not round up below the minimum and suggests a smaller N', () => {
    const p = planOrder({ ...base, balance: 30, safetyNet: 20, n: 4, leverage: 1 }); // 2.5 per order, notional 2.5 < 5
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.suggestion).toMatch(/smaller N/);
  });
  it('caps size so a stop hit loses at most the per trade limit', () => {
    const p = planOrder({ ...base, n: 1, leverage: 3, stopPct: 1.5 });
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.notional * 0.015).toBeLessThanOrEqual(10 + 1e-6);
      expect(p.margin).toBeLessThanOrEqual(800);
    }
  });
  it('puts the stop on the right side', () => {
    const l = planOrder({ ...base, side: 'LONG' });
    const s = planOrder({ ...base, side: 'SHORT' });
    expect(l.ok && l.stop < 100).toBe(true);
    expect(s.ok && s.stop > 100).toBe(true);
    expect(l.ok && l.tp! > 100).toBe(true);
    expect(s.ok && s.tp! < 100).toBe(true);
  });
});

import { PaperBook } from '../server/paper.js';
describe('paper book exits', () => {
  it('closes at the stop or the take profit', () => {
    const b = new PaperBook(1000, 200, 4, 0);
    b.open({ symbol: 'X', side: 'LONG', qty: 1, entry: 100, stop: 98, tp: 104, margin: 50, leverage: 2 });
    b.open({ symbol: 'Y', side: 'SHORT', qty: 1, entry: 100, stop: 102, tp: 96, margin: 50, leverage: 2 });
    expect(b.mark('X', 104.5)[0].reason).toMatch(/take profit/);
    expect(b.mark('Y', 102.5)[0].reason).toMatch(/stop/);
    expect(b.balance).toBe(1000 + 4 - 2);
  });
});
