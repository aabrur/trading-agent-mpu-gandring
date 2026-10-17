import { describe, it, expect } from 'vitest';
import { planOrder, tickToward } from '../server/money.js';
import { rulesFromExchangeInfo, asterRules, clearRulesCache, adapterRules } from '../server/exchange/rules.js';
import { AsterAdapter } from '../server/exchange/aster.js';

// Live desk numbers from 2026-10-17: equity 14.44, safety net 3, N 2 -> 5.72 per order, 3x, max loss 10% of equity.
const desk = { balance: 14.44, equity: 14.44, safetyNet: 3, n: 2, openPositions: 0, usedMargin: 0, sizeFactor: 1, leverage: 3, minStopPct: 0.3, minOrderUsdt: 5, maxLossPerTradePct: 10, takerFee: 0.00055, takeProfitR: 2 };
const zecRules = { qtyStep: 0.001, minQty: 0.001, tickSize: 0.01, minNotional: 5, takerFee: 0.0004, source: 'test' };
const ethRules = { qtyStep: 0.001, minQty: 0.001, tickSize: 0.01, minNotional: 5, takerFee: 0.0004, source: 'test' };

describe('sizing with exchange rules (Aster)', () => {
  it('ZEC LONG entry 1167.02 stop 1161.0: qty 0.014, stop unchanged, margin inside 5.72, fees in the loss', () => {
    const p = planOrder({ ...desk, price: 1167.02, side: 'LONG', stop: 1161.0, rules: zecRules });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.split.perOrder).toBe(5.72);
    expect(p.qty).toBe(0.014);
    expect(p.stop).toBe(1161.0);
    expect(p.margin).toBeLessThanOrEqual(5.72);
    expect(p.notional).toBeCloseTo(16.34, 2);
    expect(p.notional).toBeGreaterThanOrEqual(5); // min notional is checked on notional, not margin
    const expectedLoss = 0.014 * (1167.02 - 1161.0) + 0.00055 * 0.014 * (1167.02 + 1161.0);
    expect(p.lossAtStop).toBeCloseTo(expectedLoss, 4);
    expect(p.lossAtStop).toBeLessThanOrEqual(1.444);
    expect(p.takerFee).toBe(0.00055); // the larger of TAKER_FEE and the venue fee
  });
  it('ETH step 0.001 fits the allocation', () => {
    const p = planOrder({ ...desk, price: 2430, side: 'LONG', stop: 2400, rules: ethRules });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.qty).toBe(0.007); // 5.72 * 3 / 2430 = 0.00706 -> floor 0.007
    expect(p.margin).toBeLessThanOrEqual(5.72);
    expect(p.notional).toBeGreaterThanOrEqual(5);
    expect(p.stop).toBe(2400);
  });
  it('refuses when the order value is below the minimum notional', () => {
    const p = planOrder({ ...desk, safetyNet: 12, price: 2430, side: 'LONG', stop: 2400, rules: ethRules }); // 1.22 per order x3 -> 0.001 ETH = 2.43 USDT
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toMatch(/minimum notional 5/);
  });
  it('refuses instead of rounding up to the minimum quantity', () => {
    const p = planOrder({ ...desk, price: 2430, side: 'LONG', stop: 2400, rules: { ...ethRules, qtyStep: 0.01, minQty: 0.01 } });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toMatch(/Not rounding up/);
  });
  it('a wide stop shrinks qty instead of moving the stop; a loss cap that leaves less than the minimum refuses', () => {
    const wide = planOrder({ ...desk, maxLossPerTradePct: 1, price: 1167.02, side: 'LONG', stop: 1100, rules: zecRules }); // 5.7% stop, 0.144 USDT cap
    expect(wide.ok).toBe(false); // 0.144 / 68.3 = 0.002 ZEC = 2.3 USDT < 5 min notional
    const ok = planOrder({ ...desk, balance: 100, equity: 100, safetyNet: 20, n: 1, maxLossPerTradePct: 1, price: 1167.02, side: 'LONG', stop: 1100, rules: zecRules });
    expect(ok.ok).toBe(true);
    if (ok.ok) { expect(ok.stop).toBe(1100); expect(ok.lossAtStop).toBeLessThanOrEqual(1); expect(ok.qty).toBe(0.014); }
  });
  it('never moves the stop: only tick rounding toward the entry, both sides', () => {
    const l = planOrder({ ...desk, price: 1167.02, side: 'LONG', stop: 1161.004, rules: zecRules });
    const s = planOrder({ ...desk, price: 1167.02, side: 'SHORT', stop: 1172.996, rules: zecRules });
    expect(l.ok && l.stop).toBe(1161.01);
    expect(s.ok && s.stop).toBe(1172.99);
    expect(tickToward(1161.0, 0.01, 'LONG')).toBe(1161.0);
    expect(tickToward(0.022645, 0.00001, 'SHORT')).toBe(0.02264);
    for (const stop of [1150, 1160, 1163.5]) {
      const p = planOrder({ ...desk, price: 1167.02, side: 'LONG', stop, rules: zecRules });
      if (p.ok) expect(p.stop).toBe(stop);
    }
  });
  it('refuses wrong-side stops and stops closer than MIN_STOP_PCT', () => {
    expect(planOrder({ ...desk, price: 1167.02, side: 'LONG', stop: 1170, rules: zecRules }).ok).toBe(false);
    expect(planOrder({ ...desk, price: 1167.02, side: 'SHORT', stop: 1160, rules: zecRules }).ok).toBe(false);
    const tight = planOrder({ ...desk, price: 1167.02, side: 'LONG', stop: 1165, rules: zecRules }); // 0.17%
    expect(tight.ok).toBe(false);
    if (!tight.ok) expect(tight.reason).toMatch(/0.3% floor/);
  });
  it('keeps the guards: safety net, N, Money Trade headroom', () => {
    expect(planOrder({ ...desk, balance: 3, equity: 3, price: 1167.02, side: 'LONG', stop: 1161, rules: zecRules }).ok).toBe(false);
    expect(planOrder({ ...desk, openPositions: 2, price: 1167.02, side: 'LONG', stop: 1161, rules: zecRules }).ok).toBe(false);
    expect(planOrder({ ...desk, usedMargin: 10, price: 1167.02, side: 'LONG', stop: 1161, rules: zecRules }).ok).toBe(false);
  });
});

const info = { symbols: [
  { symbol: 'ZECUSDT', status: 'TRADING', filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.0100' }, { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '6000' }, { filterType: 'MARKET_LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '2000' }, { filterType: 'MIN_NOTIONAL', notional: '5' }] },
  { symbol: 'ETHUSDT', status: 'TRADING', filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.01' }, { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '10000' }, { filterType: 'MARKET_LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '2000' }, { filterType: 'MIN_NOTIONAL', notional: '5' }] }
] };

describe('instrument rules from Aster exchangeInfo', () => {
  it('reads LOT_SIZE/MARKET_LOT_SIZE, PRICE_FILTER and MIN_NOTIONAL', () => {
    const r = rulesFromExchangeInfo(info, 'ETHUSDT', 'test', 0.0004);
    expect(r).toMatchObject({ qtyStep: 0.001, minQty: 0.001, maxQty: 2000, tickSize: 0.01, minNotional: 5, takerFee: 0.0004, status: 'TRADING' });
  });
  it('caches for 5 minutes (one exchangeInfo call for many tickets) and the adapter exposes it', async () => {
    clearRulesCache();
    let calls = 0;
    const f = (async () => { calls++; return new Response(JSON.stringify(info), { status: 200 }); }) as typeof fetch;
    await asterRules('ZECUSDT', 'mainnet', f, 'https://aster.test');
    await asterRules('ZECUSDT', 'mainnet', f, 'https://aster.test');
    expect(calls).toBe(1);
    const a = new AsterAdapter('mainnet', '0x' + '1'.repeat(40), '0x' + '2'.repeat(64), f, 'https://aster.test2');
    const r = await adapterRules(a, 'ZECUSDT');
    expect(r).toMatchObject({ qtyStep: 0.001, tickSize: 0.01, minNotional: 5 });
    await a.instrument('ZECUSDT');
    expect(calls).toBe(2);
  });
});
