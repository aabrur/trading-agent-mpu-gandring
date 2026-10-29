import type { NewsItem } from '../types.js';
import { sanitizeUntrusted } from '../untrusted.js';
import { publicJson, measuredNumber } from './observations.js';
import { coinOf, categorizeNews, metricProvenance } from './news.js';

export type LiveNewsStatus = 'DATA_AVAILABLE' | 'NO_RELEVANT_EVENTS' | 'UNAVAILABLE';
export type LiveNewsItem = NewsItem & {
  observedAt: number;
  affectedAssets: string[];
  eventCategory: ReturnType<typeof categorizeNews>;
  evidenceStatus: 'REPORTED';
};
export interface LiveAnnouncementsResult {
  status: LiveNewsStatus;
  source: 'Bybit announcements';
  observedAt: number;
  items: LiveNewsItem[];
  error?: string;
}

const cache = new Map<string, { at: number; result: LiveAnnouncementsResult }>();
const names: Record<string, string[]> = { BTC: ['BITCOIN'], ETH: ['ETHEREUM'], SOL: ['SOLANA'], DOGE: ['DOGECOIN'], BNB: ['BINANCE COIN'], ADA: ['CARDANO'], AVAX: ['AVALANCHE'], XRP: ['RIPPLE'] };
export function resetLiveNewsCache() { cache.clear(); }
/** Last completed announcement request for a symbol, including failures. Never triggers a request. */
export function liveAnnouncementObservation(symbol: string): LiveAnnouncementsResult | undefined {
  return cache.get(symbol.replace(/USDT?$|USDC$/, '').toUpperCase())?.result;
}

/** Public announcements are reported news, not independent verification of an event. */
export async function getLiveAnnouncementsResult(symbol: string, fetchImpl: typeof fetch = fetch): Promise<LiveAnnouncementsResult> {
  const coin = symbol.replace(/USDT?$|USDC$/, '').toUpperCase();
  const observedAt = Date.now();
  if (!/^[A-Z0-9]{1,20}$/.test(coin)) return { status: 'UNAVAILABLE', source: 'Bybit announcements', observedAt, items: [], error: 'Invalid symbol' };
  const cached = cache.get(coin);
  if (cached && observedAt - cached.at < 60_000) return cached.result;
  try {
    const data = await publicJson('https://api.bybit.com/v5/announcements/index?locale=en-US&limit=50', fetchImpl);
    if (data.retCode !== 0) throw new Error('Bybit announcement response returned a non-zero retCode');
    const result = data.result as { list?: unknown[] } | undefined;
    if (!Array.isArray(result?.list)) throw new Error('Bybit announcement response omitted result.list');
    const terms = [coin, `${coin}USDT`, ...(names[coin] ?? [])];
    const relevant = new RegExp(`(^|[^A-Z0-9])(${terms.join('|')})(?=$|[^A-Z0-9])`, 'i');
    const items: LiveNewsItem[] = [];
    const seen = new Set<string>();
    for (const raw of result.list) {
      if (!raw || typeof raw !== 'object') continue;
      const row = raw as Record<string, unknown>;
      const headline = sanitizeUntrusted(String(row.title ?? ''), 200);
      const body = sanitizeUntrusted(String(row.description ?? ''), 400);
      const publishedAt = measuredNumber(row.publishTime ?? row.dateTimestamp);
      if (!relevant.test(`${headline.text} ${body.text}`)) continue;
      if (publishedAt != null && (publishedAt > observedAt || observedAt - publishedAt > 72 * 60 * 60_000)) continue;
      let sourceUrl: string;
      try { const url = new URL(String(row.url)); if (url.protocol !== 'https:' || !(url.hostname === 'bybit.com' || url.hostname.endsWith('.bybit.com'))) continue; sourceUrl = url.href; } catch { continue; }
      const identity = String(row.id ?? row.articleId ?? `${sourceUrl}|${publishedAt}|${headline.text}`);
      if (seen.has(identity)) continue;
      seen.add(identity);
      const item: LiveNewsItem = { id: `bybit-${identity}`, symbol: coin, headline: headline.text, body: body.text,
        source: 'Bybit announcements', sourceUrl, publishedAt, observedAt, affectedAssets: [coinOf(coin)],
        eventCategory: categorizeNews(`${headline.text} ${body.text}`), evidenceStatus: 'REPORTED',
        provider: 'bybit', sentiment: 'neutral', example: false, flagged: headline.flagged || body.flagged };
      items.push({ ...item, metricProvenance: metricProvenance(item) });
      if (items.length >= 8) break;
    }
    const response: LiveAnnouncementsResult = { status: items.length ? 'DATA_AVAILABLE' : 'NO_RELEVANT_EVENTS', source: 'Bybit announcements', observedAt, items };
    cache.set(coin, { at: observedAt, result: response });
    return response;
  } catch (error) {
    // Failures are cached for the same window so a down provider is not hammered by every agent call.
    const failed: LiveAnnouncementsResult = { status: 'UNAVAILABLE', source: 'Bybit announcements', observedAt, items: [], error: error instanceof Error ? error.message : 'Provider request failed' };
    cache.set(coin, { at: observedAt, result: failed });
    return failed;
  }
}

export async function getLiveAnnouncements(symbol: string, fetchImpl: typeof fetch = fetch): Promise<NewsItem[]> {
  return (await getLiveAnnouncementsResult(symbol, fetchImpl)).items;
}

export function liveNewsStatus(items: NewsItem[]): 'CONFIGURED_LIVE' | 'SAMPLE_FALLBACK' | 'UNAVAILABLE' {
  return items.some(item => item.example) ? 'SAMPLE_FALLBACK' : items.length ? 'CONFIGURED_LIVE' : 'UNAVAILABLE';
}
