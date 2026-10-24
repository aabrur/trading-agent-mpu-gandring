import { describe, expect, it, vi } from 'vitest';
import { getLiveAnnouncementsResult, liveAnnouncementObservation, resetLiveNewsCache } from '../server/market/live-news.js';
import { getEnterpriseWhaleBriefing, getHyperliquidWhales, getWhaleBriefing, resetWhaleCache } from '../server/market/whale.js';
import { getSuiTransferBriefing } from '../server/market/sui.js';

describe('news and optional on-chain evidence status', () => {
  it('distinguishes a successful zero-relevant-news response from a failure', async () => {
    resetLiveNewsCache();
    const ok = await getLiveAnnouncementsResult('BTCUSDT', async () => new Response(JSON.stringify({
      retCode: 0, result: { list: [{ title: 'ETH product update', description: '', publishTime: 1_800_000_000_000, url: 'https://announcements.bybit.com/en/article/eth' }] }
    }), { status: 200 }));
    expect(ok.status).toBe('NO_RELEVANT_EVENTS');
    expect(ok.observedAt).toBeTypeOf('number');
    resetLiveNewsCache();
    const failed = await getLiveAnnouncementsResult('BTCUSDT', async () => new Response('down', { status: 503 }));
    expect(failed.status).toBe('UNAVAILABLE');
  });

  it('exposes only cached announcement observations and caches provider failures', async () => {
    resetLiveNewsCache();
    expect(liveAnnouncementObservation('BTCUSDT')).toBeUndefined();
    let calls = 0;
    const fetcher = async () => { calls++; return new Response('down', { status: 503 }); };
    const first = await getLiveAnnouncementsResult('BTCUSDT', fetcher);
    expect(first.status).toBe('UNAVAILABLE');
    expect(liveAnnouncementObservation('BTCUSDT')).toEqual(first);
    await getLiveAnnouncementsResult('BTCUSDT', fetcher);
    expect(calls).toBe(1);
  });

  it('uses real publication times and deduplicates Bybit announcement IDs', async () => {
    resetLiveNewsCache();
    const publishedAt = Date.now() - 60_000;
    const result = await getLiveAnnouncementsResult('BTCUSDT', async () => new Response(JSON.stringify({ retCode: 0, result: { list: [
      { title: 'Bitcoin product update', description: 'BTC', publishTime: publishedAt, url: 'https://announcements.bybit.com/en/article/x', id: 'same' },
      { title: 'Bitcoin product update', description: 'BTC', publishTime: publishedAt, url: 'https://announcements.bybit.com/en/article/x', id: 'same' }
    ] } }), { status: 200 }));
    expect(result.items).toHaveLength(1);
    expect(result.items[0].publishedAt).toBe(publishedAt);
    expect(result.items[0].id).toContain('same');
    expect(result.items[0].observedAt).toBeTypeOf('number');
    expect(result.items[0].affectedAssets).toEqual(['BTC']);
    expect(result.items[0].evidenceStatus).toBe('REPORTED');
  });

  it('retains relevant announcements with an unknown publication time without inventing one', async () => {
    resetLiveNewsCache();
    const result = await getLiveAnnouncementsResult('BTCUSDT', async () => new Response(JSON.stringify({ retCode: 0, result: { list: [
      { title: 'Bitcoin product update', description: '', url: 'https://announcements.bybit.com/en/article/unknown-time' }
    ] } }), { status: 200 }));
    expect(result.status).toBe('DATA_AVAILABLE');
    expect(result.items[0].publishedAt).toBeNull();
  });

  it('distinguishes Whale Alert no-events, unconfigured and provider failure', async () => {
    resetWhaleCache();
    const absent = await getWhaleBriefing('BTC', {});
    expect(absent.dataStatus).toBe('UNCONFIGURED');
    resetWhaleCache();
    const zero = await getWhaleBriefing('BTC', { WHALE_ALERT_API_KEY: 'fixture' }, async () => new Response(JSON.stringify({ transactions: [] }), { status: 200 }));
    expect(zero.dataStatus).toBe('NO_RELEVANT_EVENTS');
    resetWhaleCache();
    const failed = await getWhaleBriefing('BTC', { WHALE_ALERT_API_KEY: 'fixture' }, async () => new Response('bad', { status: 502 }));
    expect(failed.dataStatus).toBe('UNAVAILABLE');
  });

  it('uses only the documented opt-in Enterprise routes and maps their transaction schema', async () => {
    const calls: string[] = [];
    const result = await getEnterpriseWhaleBriefing('BTC', 'bitcoin', 'fixture-key', async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('height_at_time')) return new Response(JSON.stringify({ height: 12345, timestamp: 1_800_000_000 }), { status: 200 });
      return new Response(JSON.stringify({ transactions: [{
        height: 12346, timestamp: 1_800_000_001, hash: '0xtx',
        sub_transactions: [{ symbol: 'BTC', transaction_type: 'transfer', unit_price_usd: 10, inputs: [{ address: 'from', amount: '2', owner: 'binance' }], outputs: [{ address: 'to', amount: '2' }] }]
      }] }), { status: 200 });
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('/bitcoin/height_at_time/');
    expect(calls[1]).toContain('/bitcoin/transactions?');
    expect(calls[1]).toContain('start_height=12345');
    expect(calls[1]).toContain('symbol=btc');
    expect(result.dataStatus).toBe('DATA_AVAILABLE');
    expect(result.events[0].txHash).toBe('0xtx');
    expect(result.events[0].normalizedAmount).toBe(2);
    expect(result.events[0].timestamp).toBe(1_800_000_001_000);
  });

  it('does not call the undocumented legacy API for opt-in Enterprise configuration errors', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 200 }));
    const result = await getWhaleBriefing('BTC', {
      WHALE_ALERT_API_KEY: 'fixture-key', WHALE_ALERT_ENTERPRISE_API: 'yes'
    }, fetcher);
    expect(result.providerStatus).toBe('UNCONFIGURED');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('deduplicates Whale Alert hashes and preserves missing transaction timestamps', async () => {
    resetWhaleCache();
    const tx = { blockchain: 'ethereum', hash: '0xsame', amount: 12, from: { address: 'a' }, to: { address: 'b' } };
    const result = await getWhaleBriefing('ETH', { WHALE_ALERT_API_KEY: 'fixture' }, async () => new Response(JSON.stringify({ transactions: [tx, tx] }), { status: 200 }));
    expect(result.events).toHaveLength(1);
    expect(result.events[0].timestamp).toBeNull();
  });

  it('reports the exact configured Hyperliquid watchlist coverage', async () => {
    vi.stubEnv('HYPERLIQUID_WHALE_ADDRESSES', `0x${'a'.repeat(40)},0x${'a'.repeat(40)},invalid`);
    try {
      const result = await getHyperliquidWhales('BTC', undefined, async () => new Response(JSON.stringify({ assetPositions: [] }), { status: 200 }));
      expect(result?.watchlistSource).toBe('configured');
      expect(result?.walletsRequested).toBe(1);
      expect(result?.walletsChecked).toBe(1);
      expect(result?.coverageStatus).toBe('NO_RELEVANT_EVENTS');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reports optional Sui absence without inventing transfers', async () => {
    const result = await getSuiTransferBriefing('SUI', {});
    expect(result.status).toBe('UNCONFIGURED');
    expect(result.events).toEqual([]);
    expect(result.observedAt).toBeTypeOf('number');
  });

  it('labels successful Sui GraphQL empty results distinctly from request failure', async () => {
    const empty = await getSuiTransferBriefing('SUI', { SUI_GRAPHQL_URL: 'https://sui.example/graphql' }, async () => new Response(JSON.stringify({ data: { events: { nodes: [] } } }), { status: 200 }));
    expect(empty.status).toBe('NO_RELEVANT_EVENTS');
    const failure = await getSuiTransferBriefing('SUI', { SUI_GRAPHQL_URL: 'https://sui.example/graphql' }, async () => new Response('no', { status: 503 }));
    expect(failure.status).toBe('UNAVAILABLE');
  });

  it('uses documented Sui event fields, keeps multiple events per transaction, and redacts endpoint credentials', async () => {
    let requestBody = '';
    const result = await getSuiTransferBriefing('SUI', { SUI_GRAPHQL_URL: 'https://sui.example/graphql?token=private' }, async (_input, init) => {
      requestBody = String(init?.body ?? '');
      return new Response(JSON.stringify({ data: { events: { nodes: [
        { transaction: { digest: 'digest-1' }, sequenceNumber: '0', timestamp: '2026-10-24T00:00:00Z', contents: { type: { repr: '0x2::coin::CoinEvent' }, json: { amount: '5' } } },
        { transaction: { digest: 'digest-1' }, sequenceNumber: '1', timestamp: null, contents: { type: { repr: '0x2::coin::CoinEvent' }, json: { amount: '8' } } },
        { transaction: { digest: 'digest-1' }, sequenceNumber: '1', timestamp: null, contents: { type: { repr: '0x2::coin::CoinEvent' }, json: { amount: '8' } } }
      ] } } }), { status: 200 });
    });
    expect(result.events).toHaveLength(2);
    expect(result.events[1].timestamp).toBeNull();
    expect(result.source).toBe('https://sui.example');
    expect(JSON.stringify(result)).not.toContain('private');
    expect(JSON.parse(requestBody).query).toContain('events(first: 50');
    expect(JSON.parse(requestBody).query).toContain('sequenceNumber');
  });

  it('applies the Sui sender filter only when the address is well formed', async () => {
    let body = '';
    const endpoint = { SUI_GRAPHQL_URL: 'https://sui.example/graphql', SUI_SENDER_ADDRESS: `0x${'a'.repeat(64)}` };
    await getSuiTransferBriefing('SUI', endpoint, async (_input, init) => {
      body = String(init?.body ?? '');
      return new Response(JSON.stringify({ data: { events: { nodes: [] } } }), { status: 200 });
    });
    expect(JSON.parse(body).query).toContain('filter: { sender: $sender }');
    expect(JSON.parse(body).variables.sender).toBe(endpoint.SUI_SENDER_ADDRESS);
    await getSuiTransferBriefing('SUI', { ...endpoint, SUI_SENDER_ADDRESS: '0xnot-an-address' }, async (_input, init) => {
      body = String(init?.body ?? '');
      return new Response(JSON.stringify({ data: { events: { nodes: [] } } }), { status: 200 });
    });
    expect(JSON.parse(body).query).not.toContain('filter: { sender: $sender }');
  });

  it('rejects userinfo in configured Sui endpoints without returning it', async () => {
    const result = await getSuiTransferBriefing('SUI', { SUI_GRAPHQL_URL: 'https://secret:password@sui.example/graphql?key=hidden' });
    expect(result.status).toBe('UNAVAILABLE');
    expect(JSON.stringify(result)).not.toMatch(/secret|password|hidden/);
  });
});
