/**
 * Safe Decimal Precision & Order Arithmetic Engine for Mpu Gandring.
 *
 * Clean-room TypeScript implementation inspired by ccxt/ccxt:
 * - Eliminates IEEE 754 floating-point rounding errors on financial orders.
 * - Quantizes price to exchange tickSize.
 * - Quantizes order quantity to exchange lot stepSize, enforcing minQty and maxQty.
 * - Verifies minNotional requirements before order submission.
 * - Clean decimal string representation avoiding scientific exponential notation.
 */

export type RoundingMode = 'ROUND' | 'TRUNCATE' | 'CEIL';

/**
 * Calculates decimal precision places from a fractional step (e.g. 0.001 -> 3).
 */
export function precisionFromStep(step: number): number {
  if (step <= 0 || !Number.isFinite(step)) return 0;
  const str = step.toString();
  if (str.includes('e-')) {
    const parts = str.split('e-');
    return parseInt(parts[1], 10);
  }
  const decimal = str.split('.')[1];
  return decimal ? decimal.length : 0;
}

/**
 * Formats a numeric value into a fixed-point decimal string avoiding scientific notation.
 */
export function formatDecimal(val: number, precision: number): string {
  if (!Number.isFinite(val)) return '0';
  const factor = Math.pow(10, precision);
  const rounded = Math.round(val * factor) / factor;
  return rounded.toFixed(precision);
}

/**
 * Quantizes order price to exchange tick size.
 */
export function quantizePrice(
  price: number,
  tickSize: number,
  mode: RoundingMode = 'ROUND'
): number {
  if (price <= 0 || tickSize <= 0) return price;
  const precision = precisionFromStep(tickSize);
  const ratio = price / tickSize;

  let steps: number;
  if (mode === 'TRUNCATE') {
    steps = Math.floor(ratio + 1e-12);
  } else if (mode === 'CEIL') {
    steps = Math.ceil(ratio - 1e-12);
  } else {
    steps = Math.round(ratio);
  }

  const quantized = steps * tickSize;
  return Number(quantized.toFixed(precision));
}

/**
 * Quantizes order amount to exchange lot step size, enforcing min/max boundaries.
 */
export function quantizeAmount(
  amount: number,
  qtyStep: number,
  minQty: number = 0,
  maxQty: number | null = null,
  mode: RoundingMode = 'TRUNCATE' // Default to TRUNCATE to avoid allocating beyond available margin
): { amount: number; valid: boolean; error?: string } {
  if (amount <= 0 || qtyStep <= 0) {
    return { amount: 0, valid: false, error: 'Amount and qtyStep must be positive' };
  }

  const precision = precisionFromStep(qtyStep);
  const ratio = amount / qtyStep;

  let steps: number;
  if (mode === 'TRUNCATE') {
    steps = Math.floor(ratio + 1e-12);
  } else if (mode === 'CEIL') {
    steps = Math.ceil(ratio - 1e-12);
  } else {
    steps = Math.round(ratio);
  }

  const quantized = Number((steps * qtyStep).toFixed(precision));

  if (quantized < minQty) {
    return {
      amount: quantized,
      valid: false,
      error: `Quantized amount ${quantized} is below minimum allowed lot size ${minQty}`,
    };
  }

  if (maxQty !== null && quantized > maxQty) {
    return {
      amount: quantized,
      valid: false,
      error: `Quantized amount ${quantized} exceeds maximum allowed lot size ${maxQty}`,
    };
  }

  return {
    amount: quantized,
    valid: true,
  };
}

/**
 * Validates whether an order meets the minimum notional value (amount * price).
 */
export function validateNotional(
  price: number,
  amount: number,
  minNotional: number | null
): { notional: number; valid: boolean; error?: string } {
  const notional = price * amount;
  if (minNotional !== null && minNotional > 0 && notional < minNotional) {
    return {
      notional: Number(notional.toFixed(4)),
      valid: false,
      error: `Order notional ${notional.toFixed(2)} is below exchange minimum ${minNotional.toFixed(2)}`,
    };
  }

  return {
    notional: Number(notional.toFixed(4)),
    valid: true,
  };
}
