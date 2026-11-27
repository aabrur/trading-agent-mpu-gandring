import { describe, expect, it } from 'vitest';
import {
  adaptivePriceDecimals,
  formatAdaptivePrice,
  sizeSovereignOrderQuantity
} from '../../server/v2/execution/decimal.js';

describe('Sovereign direct-price SL/TP precision & quantity sizing', () => {
  it('preserves exact direct entry-price SL/TP without leverage division on micro-cap tokens', () => {
    const entry = 0.0000085;
    const stopPct = 30;
    const tpPct = 60;
    // Direct entry-price percentage: NEVER divided by leverage (e.g. 20x)
    expect(adaptivePriceDecimals(entry)).toBe(8);
    const stop = formatAdaptivePrice(entry * (1 - stopPct / 100), entry);
    const tp = formatAdaptivePrice(entry * (1 + tpPct / 100), entry);
    expect(stop).toBe('0.00000595');
    expect(tp).toBe('0.00001360');
    expect(Number(stop)).toBeGreaterThan(0);
    expect(formatAdaptivePrice(0.1234567, 0.12)).toBe('0.123457');
    expect(formatAdaptivePrice(12.34567, 12)).toBe('12.3457');
    expect(formatAdaptivePrice(68500.129, 68500)).toBe('68500.13');
  });

  it('floors quantity strictly to venue qtyStep without rounding up and refuses invalid entryPrice', () => {
    // 50 USDT margin * 1x on 70000 BTC = 0.00071428 BTC; step 0.001 -> must floor to 0 (not round up to 0.001!)
    const smallBtc = sizeSovereignOrderQuantity({
      marginUsdt: 50,
      leverage: 1,
      entryPrice: 70000,
      qtyStep: '0.001',
      minQty: '0.001'
    });
    expect(smallBtc.ok).toBe(false);

    // 100 USDT margin * 10x on 70000 BTC = 0.0142857 BTC; step 0.001 -> floors to 0.014
    const validBtc = sizeSovereignOrderQuantity({
      marginUsdt: 100,
      leverage: 10,
      entryPrice: 70000,
      qtyStep: '0.001',
      minQty: '0.001'
    });
    expect(validBtc).toEqual({ ok: true, qty: '0.014' });

    // Integer-step meme coin: 50 * 10 / 0.0000085 = 58823529.41; step 100 -> floors to 58823500
    const meme = sizeSovereignOrderQuantity({
      marginUsdt: 50,
      leverage: 10,
      entryPrice: 0.0000085,
      qtyStep: '100',
      minQty: '100'
    });
    expect(meme).toEqual({ ok: true, qty: '58823500' });

    // Invalid zero price never defaults to qty = 1
    const zeroPx = sizeSovereignOrderQuantity({
      marginUsdt: 50,
      leverage: 10,
      entryPrice: 0,
      qtyStep: '0.001'
    });
    expect(zeroPx.ok).toBe(false);

    // OKX ctVal contractMultiplier sizing: 100 USDT * 5x = 500 USDT on 68500 BTC, ctVal=0.01 -> 500 / (68500 * 0.01) = 0.7299 contracts, floor step 1 -> fails below minQty 1; 200 USDT * 5x -> 1.459 -> floors to 1 contract
    const okxSmall = sizeSovereignOrderQuantity({
      marginUsdt: 100,
      leverage: 5,
      entryPrice: 68500,
      qtyStep: '1',
      minQty: '1',
      contractMultiplier: '0.01'
    });
    expect(okxSmall.ok).toBe(false);

    const okxValid = sizeSovereignOrderQuantity({
      marginUsdt: 200,
      leverage: 5,
      entryPrice: 68500,
      qtyStep: '1',
      minQty: '1',
      contractMultiplier: '0.01'
    });
    expect(okxValid).toEqual({ ok: true, qty: '1' });
  });

  it('accounts for Bybit V5 Order Cost (IM + open/close taker fees) without altering Owner safetyNet=0 or N=1', () => {
    const avail = 33.206;
    const marginFloored = Math.floor(avail * 100) / 100; // 33.20 (never rounded up to 33.21)
    const fee = 0.00075;

    for (const [entryPrice, expectedQty] of [
      [1729.8, '0.18'],
      [748.0, '0.43']
    ] as const) {
      for (const side of ['LONG', 'SHORT'] as const) {
        const res = sizeSovereignOrderQuantity({
          marginUsdt: marginFloored,
          leverage: 10,
          entryPrice,
          qtyStep: '0.01',
          minQty: '0.01',
          takerFeeRate: fee,
          side,
          orderType: 'MARKET'
        });
        expect(res).toEqual({ ok: true, qty: expectedQty });
        if (res.ok) {
          const notional = Number(res.qty) * entryPrice;
          const closeFactor = side === 'SHORT' ? 1 + 1 / 10 : 1 - 1 / 10;
          const bybitOrderCost = notional / 10 + notional * fee * (1 + closeFactor);
          expect(bybitOrderCost).toBeLessThanOrEqual(avail);
        }
      }
    }
  });
});
