import { describe, expect, it } from 'vitest';
import {
  addDecimals,
  assertCompatibleInstrumentUnits,
  compareDecimals,
  mulDecimals,
  quantize,
  subDecimals
} from '../../server/v2/execution/decimal.js';

describe('T05 exact BigInt decimal quantization and unit boundaries', () => {
  it('quantizes_sub_satoshi_and_step_sizes_without_float_drift', () => {
    expect(quantize('0.000000019', '0.00000001', 'floor')).toBe('0.00000001');
    expect(quantize('0.000000011', '0.00000001', 'ceil')).toBe('0.00000002');
    expect(quantize('0.000000010', '0.00000001', 'ceil')).toBe('0.00000001');

    // Floor quantity never rounds up
    expect(quantize('0.099999999', '0.01', 'floor')).toBe('0.09');
    expect(quantize('1.999', '0.001', 'floor')).toBe('1.999');
    expect(quantize('1.9999', '0.001', 'floor')).toBe('1.999');

    // Non-power-of-10 tick sizes and integer lot steps
    expect(quantize('100.149', '0.05', 'floor')).toBe('100.10');
    expect(quantize('100.101', '0.05', 'ceil')).toBe('100.15');
    expect(quantize('295', '100', 'floor')).toBe('200');
    expect(quantize('205', '100', 'ceil')).toBe('300');
  });

  it('performs_exact_decimal_addition_subtraction_multiplication_and_comparison', () => {
    expect(addDecimals('0.1', '0.2')).toBe('0.3');
    expect(subDecimals('1.00000003', '0.00000001')).toBe('1.00000002');
    expect(mulDecimals('95050.10', '0.003')).toBe('285.1503');
    expect(compareDecimals('10.00', '10')).toBe(0);
    expect(compareDecimals('10.00000001', '10')).toBe(1);
    expect(compareDecimals('9.99999999', '10')).toBe(-1);

    expect(() => quantize('10', '0', 'floor')).toThrow(/positive/i);
    expect(() => quantize('NaN', '0.01', 'floor')).toThrow();
  });

  it('rejects_unit_or_contract_multiplier_mismatch_before_cross_venue_comparison', () => {
    expect(() =>
      assertCompatibleInstrumentUnits(
        { baseCoin: 'PEPE', quoteCoin: 'USDT', contractMultiplier: 1000 },
        { baseCoin: 'PEPE', quoteCoin: 'USDT', contractMultiplier: 1 }
      )
    ).toThrow(/multiplier/i);

    expect(() =>
      assertCompatibleInstrumentUnits(
        { baseCoin: 'BTC', quoteCoin: 'USDT', contractMultiplier: 1 },
        { baseCoin: 'ETH', quoteCoin: 'USDT', contractMultiplier: 1 }
      )
    ).toThrow(/base/i);
  });
});
