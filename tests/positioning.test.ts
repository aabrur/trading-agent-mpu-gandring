import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBybitPositioning, fetchPositioning, summarizeBybitPositioning } from '../server/market/positioning.js';

afterEach(() => vi.unstubAllEnvs());

describe('derivatives positioning evidence', () => {
  it('derives account long/short ratio from the documented Bybit response', () => {
    const summary = summarizeBybitPositioning({ result: { list: [{ symbol: 'BTCUSDT', buyRatio: '0.6', sellRatio: '0.4', timestamp: '1000' }] } }, 'BTCUSDT', 2000);
    expect(summary.longShortRatio).toBe(1.5);
    expect(summary.longAccountRatio).toBe(0.6);
    expect(summary.topAccountLongShortRatio).toBeNull();
    expect(summary.evidence.longShortRatio.status).toBe('live');
  });

  it('returns unavailable rather than inventing values for missing or malformed rows', () => {
    const summary = summarizeBybitPositioning({ result: { list: [{ symbol: 'BTCUSDT', buyRatio: 'bad', sellRatio: '0.4' }] } }, 'BTCUSDT', 2000);
    expect(summary.longShortRatio).toBeNull();
    expect(summary.evidence.longShortRatio.status).toBe('unavailable');
  });

  it('rejects account-ratio rows without a valid fresh timestamp', () => {
    const missingTime = summarizeBybitPositioning({ result: { list: [{ symbol: 'BTCUSDT', buyRatio: '0.6', sellRatio: '0.4' }] } }, 'BTCUSDT', 2_000);
    const stale = summarizeBybitPositioning({ result: { list: [{ symbol: 'BTCUSDT', buyRatio: '0.6', sellRatio: '0.4', timestamp: '1' }] } }, 'BTCUSDT', 2_000_000);
    expect(missingTime.longShortRatio).toBeNull();
    expect(stale.longShortRatio).toBeNull();
  });

  it('requests the documented public account-ratio endpoint and labels the source', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ retCode: 0, result: { list: [{ symbol: 'ETHUSDT', buyRatio: '0.5', sellRatio: '0.5', timestamp: '15000' }] } }), { status: 200 });
    };
    const result = await fetchBybitPositioning('ETHUSDT', fetchImpl, 20_000);
    expect(calls[0]).toContain('/v5/market/account-ratio?category=linear&symbol=ETHUSDT&period=5min&limit=1');
    expect(result.evidence.longShortRatio.source).toContain('GET /v5/market/account-ratio');
    expect(result.longShortRatio).toBe(1);
  });

  it('collects public Binance global positioning and leaves key-required top trader data unavailable', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('api.bybit.com')) return new Response(JSON.stringify({ retCode: 0, result: { list: [{ symbol: 'BTCUSDT', buyRatio: '0.5', sellRatio: '0.5', timestamp: '15000' }] } }), { status: 200 });
      return new Response(JSON.stringify([{ symbol: 'BTCUSDT', longShortRatio: '1.2', longAccount: '0.545', shortAccount: '0.455', timestamp: 15_000 }]), { status: 200 });
    };
    const result = await fetchPositioning('BTCUSDT', fetchImpl, 20_000);
    expect(calls).toContain('https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=5m&limit=1');
    expect(result.venues.binance.longShortRatio).toBe(1.2);
    expect(result.venues.binance.topAccountLongShortRatio).toBeNull();
    expect(result.venues.binance.evidence.topAccountLongShortRatio.reason).toContain('requires X-MBX-APIKEY');
    expect(calls.every(url => !url.includes('topLongShort'))).toBe(true);
  });

  it('keeps key-required Binance requests disabled and unconfigured by default', async () => {
    vi.stubEnv('BINANCE_TOP_TRADER_ENABLED', 'on');
    vi.stubEnv('BINANCE_MARKET_DATA_API_KEY', '');
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      if (String(input).includes('api.bybit.com')) return new Response(JSON.stringify({ retCode: 0, result: { list: [] } }), { status: 200 });
      return new Response(JSON.stringify([{ symbol: 'BTCUSDT', longShortRatio: '1', longAccount: '0.5', shortAccount: '0.5', timestamp: 20_000 }]), { status: 200 });
    };
    const result = await fetchPositioning('BTCUSDT', fetchImpl, 20_000);
    expect(calls.some(call => call.url.includes('topLongShort'))).toBe(false);
    expect(calls.every(call => !new Headers(call.init?.headers).has('X-MBX-APIKEY'))).toBe(true);
    expect(result.status).toBe('live');
    expect(result.topTraderStatus).toBe('UNCONFIGURED');
    expect(result.evidence.topAccountLongShortRatio.reason).toContain('not enabled or market-data key not configured');
  });

  it('does not call top-trader endpoints when disabled even if the dedicated key exists', async () => {
    vi.stubEnv('BINANCE_TOP_TRADER_ENABLED', 'off');
    vi.stubEnv('BINANCE_MARKET_DATA_API_KEY', 'fixture-market-data-key');
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input); calls.push({ url, init });
      if (url.includes('api.bybit.com')) return new Response(JSON.stringify({ retCode: 0, result: { list: [] } }), { status: 200 });
      return new Response(JSON.stringify([{ symbol: 'BTCUSDT', longShortRatio: '1', longAccount: '0.5', shortAccount: '0.5', timestamp: 20_000 }]), { status: 200 });
    };
    const result = await fetchPositioning('BTCUSDT', fetchImpl, 20_000);
    expect(calls.some(call => call.url.includes('topLongShort'))).toBe(false);
    expect(calls.every(call => !new Headers(call.init?.headers).has('X-MBX-APIKEY'))).toBe(true);
    expect(result.topTraderStatus).toBe('UNCONFIGURED');
  });

  it('sends only the dedicated key to both official Binance top-trader endpoints when enabled', async () => {
    const key = 'fixture-market-data-key';
    vi.stubEnv('BINANCE_TOP_TRADER_ENABLED', 'on');
    vi.stubEnv('BINANCE_MARKET_DATA_API_KEY', key);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes('api.bybit.com')) return new Response(JSON.stringify({ retCode: 0, result: { list: [] } }), { status: 200 });
      if (url.includes('topLongShortAccountRatio')) return new Response(JSON.stringify([{ symbol: 'BTCUSDT', longShortRatio: '1.2', longAccount: '0.545', shortAccount: '0.455', timestamp: 20_000 }]), { status: 200 });
      if (url.includes('topLongShortPositionRatio')) return new Response(JSON.stringify([{ symbol: 'BTCUSDT', longShortRatio: '1.4', longAccount: '0.58', shortAccount: '0.42', timestamp: 20_000 }]), { status: 200 });
      return new Response(JSON.stringify([{ symbol: 'BTCUSDT', longShortRatio: '1', longAccount: '0.5', shortAccount: '0.5', timestamp: 20_000 }]), { status: 200 });
    };
    const result = await fetchPositioning('BTCUSDT', fetchImpl, 20_000);
    const topCalls = calls.filter(call => call.url.includes('topLongShort'));
    expect(topCalls).toHaveLength(2);
    for (const call of topCalls) {
      expect(call.url.startsWith('https://fapi.binance.com/futures/data/')).toBe(true);
      expect(call.url).toContain('symbol=BTCUSDT&period=5m&limit=1');
      expect(new Headers(call.init?.headers).get('X-MBX-APIKEY')).toBe(key);
      expect(call.init?.redirect).toBe('error');
    }
    expect(result.topAccountLongShortRatio).toBe(1.2);
    expect(result.topPositionLongShortRatio).toBe(1.4);
    expect(result.topTraderStatus).toBe('live');
    expect(JSON.stringify(result)).not.toContain(key);
  });

  it('captures Binance taker ratio and base volumes from a fresh public sample', async () => {
    vi.stubEnv('BINANCE_TOP_TRADER_ENABLED', 'off');
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input); calls.push(url);
      if (url.includes('api.bybit.com')) return new Response(JSON.stringify({ retCode: 0, result: { list: [] } }), { status: 200 });
      if (url.includes('takerlongshortRatio')) return new Response(JSON.stringify([{ buySellRatio: '1.5', buyVol: '3', sellVol: '2', timestamp: 20_000 }]), { status: 200 });
      return new Response(JSON.stringify([{ symbol: 'BTCUSDT', longShortRatio: '1', longAccount: '0.5', shortAccount: '0.5', timestamp: 20_000 }]), { status: 200 });
    };
    const result = await fetchPositioning('BTCUSDT', fetchImpl, 20_000);
    expect(calls.some(url => url.includes('/futures/data/takerlongshortRatio?symbol=BTCUSDT&period=5m&limit=1'))).toBe(true);
    expect(result.takerBuySellRatio).toBe(1.5);
    expect(result.takerBuyVolume).toBe(3);
    expect(result.takerSellVolume).toBe(2);
    expect(result.evidence.takerBuySellRatio.status).toBe('live');
  });

  it('does not treat stale Binance taker volume as current positioning', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('api.bybit.com')) return new Response(JSON.stringify({ retCode: 0, result: { list: [] } }), { status: 200 });
      if (url.includes('takerlongshortRatio')) return new Response(JSON.stringify([{ buySellRatio: '1.5', buyVol: '3', sellVol: '2', timestamp: 1 }]), { status: 200 });
      return new Response(JSON.stringify([{ symbol: 'BTCUSDT', longShortRatio: '1', longAccount: '0.5', shortAccount: '0.5', timestamp: 20_000 }]), { status: 200 });
    };
    const result = await fetchPositioning('BTCUSDT', fetchImpl, 1_000_000);
    expect(result.takerBuySellRatio).toBeNull();
    expect(result.takerBuyVolume).toBeNull();
    expect(result.evidence.takerBuySellRatio.status).toBe('unavailable');
  });

  it('reports top-trader auth errors without exposing the key', async () => {
    const key = 'fixture-secret-never-return';
    vi.stubEnv('BINANCE_TOP_TRADER_ENABLED', 'on');
    vi.stubEnv('BINANCE_MARKET_DATA_API_KEY', key);
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('api.bybit.com')) return new Response(JSON.stringify({ retCode: 0, result: { list: [] } }), { status: 200 });
      if (url.includes('topLongShort')) return new Response('Unauthorized', { status: 401 });
      if (url.includes('takerlongshortRatio')) return new Response(JSON.stringify([{ buySellRatio: '1', buyVol: '1', sellVol: '1', timestamp: 20_000 }]), { status: 200 });
      return new Response(JSON.stringify([{ symbol: 'BTCUSDT', longShortRatio: '1', longAccount: '0.5', shortAccount: '0.5', timestamp: 20_000 }]), { status: 200 });
    };
    const result = await fetchPositioning('BTCUSDT', fetchImpl, 20_000);
    expect(result.topAccountLongShortRatio).toBeNull();
    expect(result.topTraderStatus).toBe('error');
    expect(result.evidence.topAccountLongShortRatio.status).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain(key);
  });
});
