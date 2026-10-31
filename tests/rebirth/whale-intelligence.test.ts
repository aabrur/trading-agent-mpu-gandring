import { describe, expect, it } from 'vitest';
import {
  computeWhaleIntelligence,
  classifyTransfer
} from '../../server/v2/market/whale.js';

describe('Whale Intelligence Pipeline', () => {
  it('correctly classifies exchange inflow and outflow', () => {
    const inflow = classifyTransfer(
      '0x1234567890abcdef',
      'Binance',
      1000,
      'BTC',
      90_000_000
    );
    expect(inflow.classification).toBe('EXCHANGE_INFLOW');
    expect(inflow.interpretation).toContain('supply or selling pressure');

    const outflow = classifyTransfer(
      'Bybit',
      '0x1234567890abcdef',
      500,
      'BTC',
      45_000_000
    );
    expect(outflow.classification).toBe('EXCHANGE_OUTFLOW');
    expect(outflow.interpretation).toContain('supply withdrawal');
  });

  it('computes on-chain and exchange whale intelligence report', async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        transactions: [
          {
            blockchain: 'bitcoin',
            hash: '0xabc123',
            amount: 1500,
            amount_usd: 135_000_000,
            from: { owner: 'unknown' },
            to: { owner: 'binance' },
            symbol: 'BTC',
            timestamp: Math.floor(Date.now() / 1000)
          }
        ]
      })
    }) as any;

    const report = await computeWhaleIntelligence({
      symbol: 'BTCUSDT',
      apiKey: 'test-whale-key',
      fetchImpl: mockFetch
    });

    expect(report.symbol).toBe('BTCUSDT');
    expect(report.onchain.status).toBe('DATA_AVAILABLE');
    expect(report.onchain.events.length).toBe(1);
    expect(report.onchain.events[0].classification).toBe('EXCHANGE_INFLOW');
    expect(report.onchain.inflowUsdTotal).toBe(135_000_000);
    expect(report.disclaimer).toBeDefined();
  });

  it('handles unconfigured whale alert key gracefully', async () => {
    const report = await computeWhaleIntelligence({
      symbol: 'ETHUSDT',
      apiKey: null
    });

    expect(report.symbol).toBe('ETHUSDT');
    expect(report.onchain.status).toBe('UNCONFIGURED');
    expect(report.onchain.events).toEqual([]);
    expect(report.synthesis).toContain('Whale Alert key is not configured');
  });
});
