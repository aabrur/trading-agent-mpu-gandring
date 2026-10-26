import { describe, expect, it } from 'vitest';
import { verifyRestingStopProtection } from '../server/live/resting-stop.js';
import type { ExchangeAdapter } from '../server/exchange/types.js';

describe('Exchange-Side Resting Stop Loss Guarantee', () => {
  it('confirms resting stop protection when adapter reports active stop loss', async () => {
    const mockAdapter: Partial<ExchangeAdapter> = {
      name: 'bybit' as any,
      network: 'mainnet',
      exchangeStops: true,
      protection: async (sym: string, side: any) => ({
        stop: 95.0,
        tp: 110.0,
        stopOrderId: 'stop-order-123',
      } as any),
    };

    const res = await verifyRestingStopProtection(mockAdapter as ExchangeAdapter, 'BTCUSDT', 'LONG', 95.0);
    expect(res.status).toBe('CONFIRMED_RESTING');
    expect(res.stopPrice).toBe(95.0);
    expect(res.venueOrderId).toBe('stop-order-123');
    expect(res.error).toBeUndefined();
  });

  it('fails closed when venue does not support exchange stops', async () => {
    const mockAdapter: Partial<ExchangeAdapter> = {
      name: 'mock' as any,
      network: 'mainnet',
      exchangeStops: false,
    };

    const res = await verifyRestingStopProtection(mockAdapter as ExchangeAdapter, 'ETHUSDT', 'LONG');
    expect(res.status).toBe('CONFIRMED_MISSING');
    expect(res.error).toContain('does not support exchange-side stop orders');
  });

  it('fails closed when no resting stop order is found on the exchange', async () => {
    const mockAdapter: Partial<ExchangeAdapter> = {
      name: 'bybit' as any,
      network: 'mainnet',
      exchangeStops: true,
      protection: async () => ({ stop: null, tp: null }),
    };

    const res = await verifyRestingStopProtection(mockAdapter as ExchangeAdapter, 'SOLUSDT', 'LONG');
    expect(res.status).toBe('CONFIRMED_MISSING');
    expect(res.error).toContain('No active stop loss order found resting');
  });

  it('flags UNVERIFIED_PENDING when protection query fails due to network error', async () => {
    const mockAdapter: Partial<ExchangeAdapter> = {
      name: 'bybit' as any,
      network: 'mainnet',
      exchangeStops: true,
      protection: async () => {
        throw new Error('504 Gateway Timeout');
      },
    };

    const res = await verifyRestingStopProtection(mockAdapter as ExchangeAdapter, 'ADAUSDT', 'SHORT');
    expect(res.status).toBe('UNVERIFIED_PENDING');
    expect(res.error).toContain('504 Gateway Timeout');
  });
});
