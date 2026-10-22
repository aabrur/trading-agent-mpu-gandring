import { describe, it, expect } from 'vitest';
import { moneySplit, planOrder, calculateSafetyNetHedge, evaluateAutoHedge } from '../server/money.js';

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
  it('uses the allocation without a separate account-equity loss cap', () => {
    const p = planOrder({ ...base, n: 1, leverage: 3, stopPct: 1.5 });
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.margin).toBe(800);
      expect(p.stop).toBe(99.5); // 1.5% of margin at 3x = 0.5% of price.
      expect(p.lossAtStop).toBeGreaterThan(10);
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

describe('Safety Net and Auto-Hedge formula specification', () => {
  it('calculates capital partitioning and margin allocation per N accurately for $20 balance', () => {
    const spec1 = calculateSafetyNetHedge(20, 1);
    expect(spec1.activeCapital).toBe(12.00);
    expect(spec1.safetyNet).toBe(8.00);
    expect(spec1.perOrder).toBe(12.00);
    expect(spec1.triggerLoss).toBe(-5.00);
    expect(spec1.triggerEquity).toBe(15.00);
    expect(spec1.marginBuffer).toBe(3.00);

    const spec2 = calculateSafetyNetHedge(20, 2);
    expect(spec2.perOrder).toBe(6.00);

    const spec3 = calculateSafetyNetHedge(20, 3);
    expect(spec3.perOrder).toBe(4.00);

    const spec4 = calculateSafetyNetHedge(20, 4);
    expect(spec4.perOrder).toBe(3.00);
  });

  it('triggers auto-hedge only when loss reaches L_trigger and calculates hedge direction and volume', () => {
    const positions = [
      { side: 'LONG' as const, qty: 1.5 },
      { side: 'SHORT' as const, qty: 0.5 }
    ];

    const safe = evaluateAutoHedge(20, 8, -4.50, positions);
    expect(safe.triggered).toBe(false);
    expect(safe.direction).toBeNull();

    const hitLoss = evaluateAutoHedge(20, 8, -5.00, positions);
    expect(hitLoss.triggered).toBe(true);
    expect(hitLoss.triggerLoss).toBe(-5.00);
    expect(hitLoss.marginBuffer).toBe(3.00);
    expect(hitLoss.buyVolume).toBe(1.5);
    expect(hitLoss.sellVolume).toBe(0.5);
    expect(hitLoss.vHedge).toBe(1.0);
    expect(hitLoss.direction).toBe('SELL');

    const shortHeavy = [
      { side: 'LONG' as const, qty: 0.2 },
      { side: 'SHORT' as const, qty: 0.8 }
    ];
    const hitShort = evaluateAutoHedge(20, 8, -5.20, shortHeavy);
    expect(hitShort.triggered).toBe(true);
    expect(hitShort.vHedge).toBe(0.6);
    expect(hitShort.direction).toBe('BUY');
  });
});
