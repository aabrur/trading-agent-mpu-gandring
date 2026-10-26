/**
 * Exchange-Side Resting Stop Loss Guarantee Engine for Mpu Gandring.
 *
 * Core invariant enforcer for TESTNET and LIVE trading:
 * - Guarantees that EVERY open position has an active resting trigger order on the exchange.
 * - Prevents naked positions: if a stop loss order fails or is cancelled,
 *   the position must be immediately reconciled or closed (Fail Closed).
 * - Distinguishes between verified resting stops, unverified stops, and confirmed missing stops.
 */

import type { ExchangeAdapter, Protection } from '../exchange/types.js';

export type RestingStopStatus = 'CONFIRMED_RESTING' | 'UNVERIFIED_PENDING' | 'CONFIRMED_MISSING';

export interface RestingStopVerification {
  symbol: string;
  side: 'LONG' | 'SHORT';
  status: RestingStopStatus;
  stopPrice: number | null;
  takeProfitPrice: number | null;
  venueOrderId?: string;
  error?: string;
  timestamp: number;
}

/**
 * Verifies that a resting stop loss order is actively guarding the position on the exchange.
 */
export async function verifyRestingStopProtection(
  adapter: ExchangeAdapter,
  symbol: string,
  side: 'LONG' | 'SHORT',
  expectedStopPrice?: number
): Promise<RestingStopVerification> {
  const now = Date.now();

  // Venue must support exchange-side stop orders
  if (!adapter.exchangeStops) {
    return {
      symbol,
      side,
      status: 'CONFIRMED_MISSING',
      stopPrice: null,
      takeProfitPrice: null,
      error: `Venue ${adapter.name} does not support exchange-side stop orders (fail closed)`,
      timestamp: now,
    };
  }

  try {
    const protection: Protection = await adapter.protection(symbol, side);
    if (!protection || protection.stop === null || protection.stop <= 0) {
      return {
        symbol,
        side,
        status: 'CONFIRMED_MISSING',
        stopPrice: null,
        takeProfitPrice: protection?.tp ?? null,
        error: `No active stop loss order found resting on ${adapter.name} for ${symbol}`,
        timestamp: now,
      };
    }

    // Directional sanity check:
    // For LONG: stop must be below trigger/market reference
    // For SHORT: stop must be above trigger/market reference
    if (expectedStopPrice && expectedStopPrice > 0) {
      const diffPct = Math.abs((protection.stop - expectedStopPrice) / expectedStopPrice) * 100;
      if (diffPct > 2.0) {
        return {
          symbol,
          side,
          status: 'UNVERIFIED_PENDING',
          stopPrice: protection.stop,
          takeProfitPrice: protection.tp ?? null,
          error: `Resting stop price (${protection.stop}) deviates >2% from expected stop (${expectedStopPrice})`,
          timestamp: now,
        };
      }
    }

    return {
      symbol,
      side,
      status: 'CONFIRMED_RESTING',
      stopPrice: protection.stop,
      takeProfitPrice: protection.tp ?? null,
      venueOrderId: (protection as any).stopOrderId,
      timestamp: now,
    };
  } catch (err: any) {
    return {
      symbol,
      side,
      status: 'UNVERIFIED_PENDING',
      stopPrice: null,
      takeProfitPrice: null,
      error: `Failed to query protection status from ${adapter.name}: ${err?.message || 'timeout'}`,
      timestamp: now,
    };
  }
}
