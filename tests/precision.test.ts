import { describe, expect, it } from 'vitest';
import {
  precisionFromStep,
  formatDecimal,
  quantizePrice,
  quantizeAmount,
  validateNotional,
} from '../server/exchange/precision.js';

describe('Safe Decimal Precision & Order Arithmetic Engine', () => {
  it('derives correct decimal precision from tick or step sizes', () => {
    expect(precisionFromStep(1)).toBe(0);
    expect(precisionFromStep(0.1)).toBe(1);
    expect(precisionFromStep(0.01)).toBe(2);
    expect(precisionFromStep(0.001)).toBe(3);
    expect(precisionFromStep(0.00001)).toBe(5);
    expect(precisionFromStep(0.05)).toBe(2);
  });

  it('formats decimals without exponential scientific notation', () => {
    expect(formatDecimal(0.00000123, 6)).toBe('0.000001');
    expect(formatDecimal(1250.555, 2)).toBe('1250.56');
    expect(formatDecimal(100, 4)).toBe('100.0000');
  });

  it('quantizes price accurately to tick size without float leaks', () => {
    expect(quantizePrice(100.12345, 0.01)).toBe(100.12);
    expect(quantizePrice(100.128, 0.01)).toBe(100.13);
    expect(quantizePrice(100.12345, 0.05, 'ROUND')).toBe(100.10);
    expect(quantizePrice(100.14, 0.05, 'ROUND')).toBe(100.15);
  });

  it('quantizes amount to lot size enforcing minQty and maxQty', () => {
    // Normal truncation
    const res1 = quantizeAmount(1.23456, 0.01);
    expect(res1.valid).toBe(true);
    expect(res1.amount).toBe(1.23);

    // Below minQty
    const res2 = quantizeAmount(0.005, 0.01, 0.1);
    expect(res2.valid).toBe(false);
    expect(res2.error).toContain('below minimum allowed lot size');

    // Above maxQty
    const res3 = quantizeAmount(500, 1, 1, 200);
    expect(res3.valid).toBe(false);
    expect(res3.error).toContain('exceeds maximum allowed lot size');
  });

  it('validates minNotional bounds correctly', () => {
    const valid = validateNotional(100, 2, 5); // 200 >= 5
    expect(valid.valid).toBe(true);
    expect(valid.notional).toBe(200);

    const invalid = validateNotional(1, 2, 5); // 2 < 5
    expect(invalid.valid).toBe(false);
    expect(invalid.error).toContain('below exchange minimum');
  });
});
