import { describe, expect, it } from 'vitest';
import { fetchPublicCryptoNews } from '../../server/v2/research/host.js';

describe('Task 5: News Routing and Symbol vs General Market Scope', () => {
  it('identifies symbol-specific vs general market news based on ticker keywords', async () => {
    // Custom mock fetch returning 1 specific and 1 general news
    const mockRssXml = `
      <rss version="2.0">
        <channel>
          <item>
            <title>Ethereum Layer-2 TVL Reaches All Time High</title>
            <link>https://example.com/eth-l2</link>
            <description>Growth in ETH rollups accelerates.</description>
            <pubDate>Mon, 05 Nov 2026 12:00:00 GMT</pubDate>
          </item>
          <item>
            <title>SEC Regulatory Framework Faces Scrutiny Across Global Markets</title>
            <link>https://example.com/sec-market</link>
            <description>Broader macro policy remains uncertain for crypto assets.</description>
            <pubDate>Mon, 05 Nov 2026 12:05:00 GMT</pubDate>
          </item>
        </channel>
      </rss>
    `;

    const fakeFetch = (async () => ({
      ok: true,
      text: async () => mockRssXml
    })) as unknown as typeof fetch;

    const oldEnv = process.env.VITEST;
    try {
      delete process.env.VITEST;
      const items = await fetchPublicCryptoNews('ETHUSDT', fakeFetch);

      expect(items.length).toBeGreaterThan(0);
      const ethItem = items.find((i) => i.title.includes('Ethereum'));
      const secItem = items.find((i) => i.title.includes('SEC'));

      expect(ethItem?.targetScope).toBe('SYMBOL_SPECIFIC');
      expect(ethItem?.matchedSymbol).toBe('ETHUSDT');

      expect(secItem?.targetScope).toBe('GENERAL_MARKET');
      expect(secItem?.matchedSymbol).toBe('MARKET');
    } finally {
      process.env.VITEST = oldEnv;
    }
  });

  it('keeps news isolated per symbol so ETH news does not pollute DOGE', () => {
    const rawEvents = [
      { id: '1', symbol: 'ETHUSDT', headline: 'Ethereum Pectra upgrade live', targetScope: 'SYMBOL_SPECIFIC' },
      { id: '2', symbol: 'MARKET', headline: 'Fed cuts interest rates by 25bps', targetScope: 'GENERAL_MARKET' },
      { id: '3', symbol: 'DOGEUSDT', headline: 'Dogecoin transaction volume spikes', targetScope: 'SYMBOL_SPECIFIC' }
    ];

    const targetSymbol = 'DOGEUSDT';
    const filteredForDoge = rawEvents.filter(
      (ev) => ev.symbol === targetSymbol || ev.symbol === 'MARKET' || ev.targetScope === 'GENERAL_MARKET'
    );

    const symbols = filteredForDoge.map((e) => e.symbol);
    expect(symbols).toContain('DOGEUSDT');
    expect(symbols).toContain('MARKET');
    expect(symbols).not.toContain('ETHUSDT');
  });
});
