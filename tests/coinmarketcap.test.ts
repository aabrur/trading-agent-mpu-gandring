import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  checkCoinMarketCapKey,
  fetchCoinMarketCapQuotes,
  fetchCoinMarketCapGlobal,
  fetchCoinMarketCapSummary,
  getCoinMarketCapSummary,
  resetCoinMarketCapCache
} from '../server/market/coinmarketcap.js';

describe('CoinMarketCap API client (Free / Basic Plan)', () => {
  beforeEach(() => {
    resetCoinMarketCapCache();
  });

  it('validates key info successfully', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: { error_code: 0, error_message: null },
        data: {
          plan: { name: 'Basic', credit_limit_daily: 333 },
          usage: { current_day: { credits_used: 10, credits_left: 323 } }
        }
      })
    });

    const result = await checkCoinMarketCapKey('test-cmc-key', fakeFetch as unknown as typeof fetch);
    expect(result.ok).toBe(true);
    expect(result.plan).toBe('Basic');
    expect(result.creditsLeft).toBe(323);
    expect(fakeFetch).toHaveBeenCalledWith(
      'https://pro-api.coinmarketcap.com/v1/key/info',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-CMC_PRO_API_KEY': 'test-cmc-key'
        })
      })
    );
  });

  it('handles invalid key or 401 error gracefully', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({
        status: { error_code: 10001, error_message: 'This API Key is invalid.' }
      })
    });

    const result = await checkCoinMarketCapKey('bad-key', fakeFetch as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('This API Key is invalid.');
  });

  it('fetches quotes and caches within TTL to conserve free credits', async () => {
    let callCount = 0;
    const fakeFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      return {
        ok: true,
        json: async () => ({
          status: { error_code: 0, error_message: null },
          data: {
            BTC: {
              id: 1,
              name: 'Bitcoin',
              symbol: 'BTC',
              cmc_rank: 1,
              quote: {
                USD: {
                  price: 68500,
                  volume_24h: 35000000000,
                  volume_change_24h: 4.5,
                  percent_change_1h: 0.2,
                  percent_change_24h: 2.1,
                  percent_change_7d: 5.8,
                  market_cap: 1350000000000,
                  market_cap_dominance: 57.2
                }
              }
            }
          }
        })
      };
    });

    const q1 = await fetchCoinMarketCapQuotes(['BTCUSDT'], 'test-key', fakeFetch as unknown as typeof fetch);
    expect(q1.BTC).toBeDefined();
    expect(q1.BTC?.cmcRank).toBe(1);
    expect(q1.BTC?.marketCapDominance).toBe(57.2);
    expect(callCount).toBe(1);

    // Second call within TTL should use in-memory cache
    const q2 = await fetchCoinMarketCapQuotes(['BTCUSDT'], 'test-key', fakeFetch as unknown as typeof fetch);
    expect(q2.BTC?.price).toBe(68500);
    expect(callCount).toBe(1); // No new network call
  });

  it('fetches global metrics and caches results', async () => {
    let callCount = 0;
    const fakeFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      return {
        ok: true,
        json: async () => ({
          status: { error_code: 0, error_message: null },
          data: {
            btc_dominance: 57.5,
            eth_dominance: 13.8,
            quote: {
              USD: {
                total_market_cap: 2450000000000,
                total_volume_24h: 88000000000,
                defi_market_cap: 92000000000
              }
            }
          }
        })
      };
    });

    const g1 = await fetchCoinMarketCapGlobal('test-key', fakeFetch as unknown as typeof fetch);
    expect(g1).toBeDefined();
    expect(g1?.btcDominance).toBe(57.5);
    expect(g1?.ethDominance).toBe(13.8);
    expect(callCount).toBe(1);

    const g2 = await fetchCoinMarketCapGlobal('test-key', fakeFetch as unknown as typeof fetch);
    expect(g2?.btcDominance).toBe(57.5);
    expect(callCount).toBe(1);
  });

  it('combines quotes and global metrics into summary without throwing on error', async () => {
    const fakeFetch = vi.fn().mockRejectedValue(new Error('Network error'));
    const summary = await fetchCoinMarketCapSummary('SOLUSDT', 'test-key', fakeFetch as unknown as typeof fetch);
    expect(summary).toBeDefined();
    expect(summary.quote).toBeNull();
    expect(summary.global).toBeNull();
  });

  it('getCoinMarketCapSummary returns null when no key is configured in env', async () => {
    const origKey = process.env.COINMARKETCAP_API_KEY;
    const origCmc = process.env.CMC_API_KEY;
    delete process.env.COINMARKETCAP_API_KEY;
    delete process.env.CMC_API_KEY;

    try {
      const fakeFetch = vi.fn();
      const res = await getCoinMarketCapSummary('BTCUSDT', fakeFetch as unknown as typeof fetch);
      expect(res).toBeNull();
      expect(fakeFetch).not.toHaveBeenCalled();
    } finally {
      if (origKey !== undefined) process.env.COINMARKETCAP_API_KEY = origKey;
      if (origCmc !== undefined) process.env.CMC_API_KEY = origCmc;
    }
  });
});
