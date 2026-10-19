import { describe, it, expect } from 'vitest';
import { categorizeNews, assessImpact, deduplicateEvents, titleSlug, normalizeLegacyItem, buildNewsBriefing, type NormalizedNewsEvent } from '../server/market/news.js';
import { classifyTransfer, getWhaleBriefing } from '../server/market/whale.js';
import { atr } from '../server/strategy.js';
import { Scorecard } from '../server/scorecard.js';
import { Desk } from '../server/desk.js';
import { loadConfig } from '../server/config.js';
import { makeCaller } from '../server/providers/index.js';


describe('News intelligence and normalization', () => {
  it('categorizes news headlines accurately', () => {
    expect(categorizeNews('Major bridge exploit results in $10M stolen funds')).toBe('exploit_hack');
    expect(categorizeNews('Solana network outage halts block production')).toBe('blockchain_outage');
    expect(categorizeNews('SEC files enforcement action against crypto platform')).toBe('regulation');
    expect(categorizeNews('Exchange announces delisting of token pair')).toBe('listing_delisting');
    expect(categorizeNews('USDT stablecoin experiences depeg pressure')).toBe('stablecoin');
    expect(categorizeNews('Spot Bitcoin ETF records $250M net inflows')).toBe('etf');
    expect(categorizeNews('Federal Reserve signals potential interest rate pause')).toBe('fed');
    expect(categorizeNews('CPI inflation data prints below economist expectations')).toBe('cpi');
  });

  it('triggers a critical VETO only on severe events', () => {
    const hack = assessImpact('exploit_hack', 'severe', 'Smart contract exploit detected');
    expect(hack.isVeto).toBe(true);
    expect(hack.vetoReason).toContain('Security exploit');

    const outage = assessImpact('blockchain_outage', 'severe', 'Chain halt in progress');
    expect(outage.isVeto).toBe(true);

    const normal = assessImpact('general_market', 'neutral', 'Market consolidates in tight range');
    expect(normal.isVeto).toBe(false);
    expect(normal.vetoReason).toBeNull();
  });

  it('deduplicates repetitive headlines using slugs', () => {
    const ev1: NormalizedNewsEvent = {
      id: '1', title: 'Bitcoin surges past 70k resistance', source: 'CoinDesk', sourceUrl: null,
      publishedAt: 1000, observedAt: 1000, affectedAssets: ['BTC'], category: 'general_market',
      evidenceStatus: 'REPORTED', impactAssessment: '', sentiment: 'bullish', freshness: 'fresh',
      duplicateGroup: null, provider: 'cryptopanic', example: false
    };
    const ev2: NormalizedNewsEvent = {
      ...ev1, id: '2', title: 'Bitcoin Surges Past 70k Resistance!', source: 'Decrypt'
    };
    const deduped = deduplicateEvents([ev1, ev2]);
    expect(deduped.length).toBe(1);
    expect(deduped[0].duplicateGroup).toBe(titleSlug('Bitcoin surges past 70k resistance'));
  });

  it('builds a structured briefing and detects critical vetos', () => {
    const item = {
      id: 'test-1', symbol: 'BTC', headline: 'Critical zero-day exploit drains protocol',
      body: 'Funds compromised', source: 'SecurityFeed', sentiment: 'severe' as const, example: false
    };
    const norm = normalizeLegacyItem(item, 'BTCUSDT');
    const briefing = buildNewsBriefing('BTCUSDT', [norm], 'CONFIGURED_LIVE');
    expect(briefing.criticalVetoFound).toBe(true);
    expect(briefing.vetoReason).toContain('Security exploit');
  });
});

describe('On-chain whale intelligence', () => {
  it('correctly classifies exchange inflows and outflows with non-fictional interpretations', () => {
    const inflow = classifyTransfer('private_wallet', 'binance', 1500, 'BTC', 105000000);
    expect(inflow.classification).toBe('EXCHANGE_INFLOW');
    expect(inflow.interpretation).toContain('potential spot/derivative supply or selling pressure');
    expect(inflow.interpretation).toContain('Not confirmed proof of a completed market sale');

    const outflow = classifyTransfer('coinbase', 'cold_storage', 2000, 'ETH', 6000000);
    expect(outflow.classification).toBe('EXCHANGE_OUTFLOW');
    expect(outflow.interpretation).toContain('potential supply withdrawal');
    expect(outflow.interpretation).toContain('Not confirmed proof of continuous accumulation');
  });

  it('reports unconfigured status when WHALE_ALERT_API_KEY is not present', async () => {
    const briefing = await getWhaleBriefing('BTC', {});
    expect(briefing.providerStatus).toBe('UNCONFIGURED');
    expect(briefing.summary).toContain('On-chain whale provider unconfigured');
    expect(briefing.summary).toContain('Candle volume proxies must never be confused');
  });
});

describe('Quantitative indicators', () => {
  it('computes deterministic ATR on closed candles', () => {
    const candles = [
      { t: 1000, o: 100, h: 105, l: 98, c: 102, v: 10 },
      { t: 2000, o: 102, h: 108, l: 101, c: 107, v: 15 },
      { t: 3000, o: 107, h: 110, l: 104, c: 106, v: 20 },
      { t: 4000, o: 106, h: 107, l: 100, c: 101, v: 25 },
      { t: 5000, o: 101, h: 105, l: 99, c: 104, v: 18 }
    ];
    const val = atr(candles, 3);
    expect(val).toBeGreaterThan(0);
    expect(Number.isFinite(val)).toBe(true);
  });
});

describe('Scorecard improvements', () => {
  it('tracks realized net PnL and per-role calls accurately', () => {
    const sc = new Scorecard();
    sc.opened('BTCUSDT', { side: 'LONG', stances: { market: 'LONG', research: 'SHORT' }, riskDecision: 'APPROVE' }, 'pos-1');
    sc.closed('BTCUSDT', 'LONG', 45.5, 0, 'pos-1');

    const rows = sc.rows();
    const lead = rows.find((r) => r.role === 'lead')!;
    expect(lead.note).toContain('net PnL +45.5 USDT');
    expect(sc.lead.wins).toBe(1);
    expect(lead.right).toBe(1);

    const market = rows.find((r) => r.role === 'market')!;
    expect(market.right).toBe(1);

    const research = rows.find((r) => r.role === 'research')!;
    expect(research.wrong).toBe(1);
  });
});

describe('Context-aware agent chat and analytical queries', () => {
  it('handles role-addressed questions in Indonesian and English', async () => {
    const config = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEBATE_PACE_MS: '0' });
    const desk = new Desk(config, makeCaller(config));

    const r1 = await desk.command('Market, analisis BTC sekarang');
    expect(r1.ok).toBe(true);
    expect(desk.chats.market.length).toBeGreaterThan(0);

    const r2 = await desk.command('Research, berita penting apa dalam 24 jam terakhir?');
    expect(r2.ok).toBe(true);
    expect(desk.chats.research.length).toBeGreaterThan(0);

    const r3 = await desk.command('Kenapa tidak LONG BTC tadi?');
    expect(r3.ok).toBe(true);
  });
});
