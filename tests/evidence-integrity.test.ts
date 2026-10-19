import { describe, it, expect, vi } from 'vitest';
import {
  assessImpact,
  buildNewsBriefing,
  newsFreshness,
  normalizeLegacyItem,
  parsePublishedAt,
  type NormalizedNewsEvent
} from '../server/market/news.js';
import { classifyTransfer, getWhaleBriefing, optionalNumber, resetWhaleCache } from '../server/market/whale.js';
import { getNewsFor } from '../server/market/index.js';

const event = (over: Partial<NormalizedNewsEvent> = {}): NormalizedNewsEvent => ({
  id: '1',
  title: 'Bitcoin consolidates',
  source: 'CoinDesk',
  sourceUrl: 'https://example.com/a',
  publishedAt: 1_700_000_000_000,
  observedAt: 1_700_000_000_000,
  affectedAssets: ['BTC'],
  category: 'general_market',
  evidenceStatus: 'REPORTED',
  impactAssessment: '',
  sentiment: 'neutral',
  freshness: 'fresh',
  duplicateGroup: null,
  provider: 'cryptopanic',
  example: false,
  ...over
});

describe('news publication timestamps', () => {
  it('parses ISO and unix publication times and leaves unknowns as null', () => {
    expect(parsePublishedAt('2024-01-15T12:00:00Z')).toBe(Date.parse('2024-01-15T12:00:00Z'));
    expect(parsePublishedAt(1_704_000_000)).toBe(1_704_000_000_000);
    expect(parsePublishedAt(1_704_000_000_000)).toBe(1_704_000_000_000);
    expect(parsePublishedAt(null)).toBeNull();
    expect(parsePublishedAt(undefined)).toBeNull();
    expect(parsePublishedAt('')).toBeNull();
    expect(parsePublishedAt('not-a-date')).toBeNull();
  });

  it('does not invent a publication time when the source omitted one', () => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const norm = normalizeLegacyItem({
        id: 'x', symbol: 'BTC', headline: 'ETF inflows continue', body: 'Reported inflows',
        source: 'Wire', sentiment: 'bullish', example: false
      }, 'BTCUSDT');
      expect(norm.publishedAt).toBeNull();
      expect(norm.observedAt).toBe(now);
      expect(norm.freshness).toBe('unknown');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('preserves a known publication timestamp instead of replacing it with ingest time', () => {
    const published = Date.parse('2024-06-01T08:00:00Z');
    const observed = Date.parse('2024-06-03T08:00:00Z');
    vi.spyOn(Date, 'now').mockReturnValue(observed);
    try {
      const norm = normalizeLegacyItem({
        id: 'x', symbol: 'BTC', headline: 'ETF inflows continue', body: 'Reported inflows',
        source: 'Wire', sentiment: 'bullish', example: false, publishedAt: published, sourceUrl: 'https://example.com/etf'
      }, 'BTCUSDT');
      expect(norm.publishedAt).toBe(published);
      expect(norm.observedAt).toBe(observed);
      expect(norm.sourceUrl).toBe('https://example.com/etf');
      expect(norm.freshness).toBe('stale');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('does not treat an article as fresh just because it was fetched recently', () => {
    const now = Date.parse('2024-06-03T08:00:00Z');
    expect(newsFreshness(null, now)).toBe('unknown');
    expect(newsFreshness(now - 30 * 60_000, now)).toBe('fresh');
    expect(newsFreshness(now - 12 * 3600_000, now)).toBe('stale');
    expect(newsFreshness(now - 5 * 86400_000, now)).toBe('archived');
  });

  it('keeps CryptoPanic published_at and url on live items', async () => {
    const published = '2024-06-01T10:00:00Z';
    const fetchImpl = async () => new Response(JSON.stringify({
      results: [{
        id: 99,
        title: 'Exchange reports outage on matching engine',
        description: 'Status page update',
        published_at: published,
        url: 'https://news.example/outage',
        source: { title: 'StatusPage' },
        votes: { positive: 0, negative: 0 }
      }]
    }), { status: 200 });
    const items = await getNewsFor('BTCUSDT', {
      news: { provider: 'cryptopanic', key: 'test-key', baseUrl: 'https://cryptopanic.example/posts/' }
    }, fetchImpl as unknown as typeof fetch);
    expect(items[0].example).toBe(false);
    expect(items[0].publishedAt).toBe(Date.parse(published));
    expect(items[0].sourceUrl).toBe('https://news.example/outage');
    expect(items[0].headline).toContain('outage');
  });
});

describe('critical-event classification', () => {
  it('treats keyword-only matches as reported claims, not independently verified events', () => {
    const hack = assessImpact('exploit_hack', 'severe', 'Smart contract exploit detected');
    expect(hack.isVetoCandidate).toBe(true);
    expect(hack.verification).toBe('reported_claim');

    const item = {
      id: 'test-1', symbol: 'BTC', headline: 'Critical zero-day exploit drains protocol',
      body: 'Funds compromised', source: 'SecurityFeed', sentiment: 'severe' as const, example: false
    };
    const briefing = buildNewsBriefing('BTCUSDT', [normalizeLegacyItem(item, 'BTCUSDT')], 'CONFIGURED_LIVE');
    expect(briefing.criticalClaimFound).toBe(true);
    expect(briefing.criticalVetoFound).toBe(false);
    expect(briefing.events[0].evidenceStatus).toBe('REPORTED');
  });

  it('never auto-vetoes sample or unknown-time keyword matches', () => {
    const sample = normalizeLegacyItem({
      id: 's', symbol: 'BTC', headline: 'EXAMPLE: exploit drains bridge', body: 'demo',
      source: 'sample', sentiment: 'severe', example: true
    }, 'BTCUSDT');
    const sampleBrief = buildNewsBriefing('BTCUSDT', [sample], 'SAMPLE_FALLBACK');
    expect(sampleBrief.criticalVetoFound).toBe(false);
    expect(sample.evidenceStatus).toBe('UNAVAILABLE');

    const staleClaim = event({
      title: 'Exchange hack reported last week',
      category: 'exploit_hack',
      evidenceStatus: 'REPORTED',
      freshness: 'archived',
      publishedAt: 1,
      affectedAssets: ['BTC']
    });
    expect(buildNewsBriefing('BTCUSDT', [staleClaim], 'CONFIGURED_LIVE').criticalVetoFound).toBe(false);
  });

  it('auto-vetoes only verified, relevant, fresh critical events', () => {
    const verified = event({
      title: 'Confirmed chain halt on Bitcoin',
      category: 'blockchain_outage',
      evidenceStatus: 'VERIFIED',
      freshness: 'fresh',
      sentiment: 'severe',
      affectedAssets: ['BTC']
    });
    const briefing = buildNewsBriefing('BTCUSDT', [verified], 'CONFIGURED_LIVE');
    expect(briefing.criticalVetoFound).toBe(true);
    expect(briefing.vetoReason).toMatch(/outage|halt/i);

    const otherAsset = event({
      ...verified,
      id: '2',
      affectedAssets: ['SOL'],
      title: 'Confirmed Solana halt'
    });
    expect(buildNewsBriefing('BTCUSDT', [otherAsset], 'CONFIGURED_LIVE').criticalVetoFound).toBe(false);
  });
});

describe('whale unknown values and attribution', () => {
  it('keeps missing USD amounts unknown instead of coercing them to zero', () => {
    expect(optionalNumber(null)).toBeNull();
    expect(optionalNumber(undefined)).toBeNull();
    expect(optionalNumber('')).toBeNull();
    expect(optionalNumber('abc')).toBeNull();
    expect(optionalNumber(0)).toBe(0);
    expect(optionalNumber('1500.5')).toBe(1500.5);
    expect(Number(null)).toBe(0);
  });

  it('does not label unlabeled wallets as high-confidence entities or invent confirmation', async () => {
    resetWhaleCache();
    const fetchImpl = async () => new Response(JSON.stringify({
      transactions: [{
        blockchain: 'bitcoin',
        hash: 'abc123',
        timestamp: 1_704_000_000,
        amount: 12.5,
        amount_usd: null,
        from: { address: '1from' },
        to: { address: '1to' }
      }]
    }), { status: 200 });
    const briefing = await getWhaleBriefing('BTCUSDT', { WHALE_ALERT_API_KEY: 'k' }, fetchImpl as unknown as typeof fetch);
    expect(briefing.providerStatus).toBe('CONFIGURED_LIVE');
    expect(briefing.events[0].usdValueOrNull).toBeNull();
    expect(briefing.events[0].normalizedAmount).toBe(12.5);
    expect(briefing.events[0].txHash).toBe('abc123');
    expect(briefing.events[0].confirmationStatus).toBe('unverified');
    expect(briefing.events[0].attributionConfidence).toBe('unknown');
    expect(briefing.events[0].fromEntityOrNull).toBeNull();
    expect(briefing.events[0].interpretation).not.toMatch(/confirmed (sale|buying|selling)/i);
  });

  it('uses medium attribution only when the provider supplied an owner label', async () => {
    resetWhaleCache();
    const fetchImpl = async () => new Response(JSON.stringify({
      transactions: [{
        blockchain: 'ethereum',
        hash: '0xdead',
        block_number: 123,
        timestamp: 1_704_000_000,
        amount: 1000,
        amount_usd: 2_000_000,
        from: { address: '0xfrom', owner: 'coinbase' },
        to: { address: '0xto' }
      }]
    }), { status: 200 });
    const briefing = await getWhaleBriefing('ETHUSDT', { WHALE_ALERT_API_KEY: 'k' }, fetchImpl as unknown as typeof fetch);
    expect(briefing.events[0].usdValueOrNull).toBe(2_000_000);
    expect(briefing.events[0].confirmationStatus).toBe('confirmed');
    expect(briefing.events[0].attributionConfidence).toBe('medium');
    expect(briefing.events[0].fromEntityOrNull).toBe('coinbase');
    expect(briefing.events[0].classification).toBe('EXCHANGE_OUTFLOW');
    expect(briefing.events[0].interpretation).toContain('Not confirmed proof of continuous accumulation');
  });

  it('keeps missing provider responses unavailable without fabricating events', async () => {
    resetWhaleCache();
    const fetchImpl = async () => new Response('nope', { status: 503 });
    const briefing = await getWhaleBriefing('BTCUSDT', { WHALE_ALERT_API_KEY: 'k' }, fetchImpl as unknown as typeof fetch);
    expect(briefing.providerStatus).toBe('UNAVAILABLE');
    expect(briefing.events).toEqual([]);
  });

  it('does not describe exchange inflows as confirmed selling', () => {
    const inflow = classifyTransfer(null, 'binance', 10, 'BTC', null);
    expect(inflow.classification).toBe('EXCHANGE_INFLOW');
    expect(inflow.interpretation).toContain('Not confirmed proof of a completed market sale');
    expect(inflow.interpretation).not.toContain('$0.0M');
  });
});
