import type { NewsItem } from '../types.js';
import { sanitizeUntrusted } from '../untrusted.js';
import { publicJson, measuredNumber } from './observations.js';

const cache = new Map<string, { at: number; items: NewsItem[] }>();
const names: Record<string, string[]> = { BTC: ['BITCOIN'], ETH: ['ETHEREUM'], SOL: ['SOLANA'], DOGE: ['DOGECOIN'], BNB: ['BINANCE COIN'], ADA: ['CARDANO'], AVAX: ['AVALANCHE'], XRP: ['RIPPLE'] };

/** Public announcements are reported news, not independent verification of an event. */
export async function getLiveAnnouncements(symbol: string, fetchImpl: typeof fetch = fetch): Promise<NewsItem[]> {
  const coin = symbol.replace(/USDT?$|USDC$/, '').toUpperCase();
  if (!/^[A-Z0-9]{1,20}$/.test(coin)) return [];
  const cached = cache.get(coin);
  if (cached && Date.now() - cached.at < 60_000) return cached.items;
  try {
    const data = await publicJson('https://api.bybit.com/v5/announcements/index?locale=en-US&limit=50', fetchImpl);
    const result = data.result as { list?: unknown[] } | undefined;
    if (!Array.isArray(result?.list)) return [];
    const terms = [coin, `${coin}USDT`, ...(names[coin] ?? [])];
    const relevant = new RegExp(`(^|[^A-Z0-9])(${terms.join('|')})(?=$|[^A-Z0-9])`, 'i');
    const items: NewsItem[] = [];
    for (const raw of result.list) {
      if (!raw || typeof raw !== 'object') continue;
      const row = raw as Record<string, unknown>;
      const headline = sanitizeUntrusted(String(row.title ?? ''), 200);
      const body = sanitizeUntrusted(String(row.description ?? ''), 400);
      const publishedAt = measuredNumber(row.publishTime ?? row.dateTimestamp);
      if (!relevant.test(`${headline.text} ${body.text}`) || !publishedAt || publishedAt > Date.now() || Date.now() - publishedAt > 72 * 60 * 60_000) continue;
      let sourceUrl: string;
      try { const url = new URL(String(row.url)); if (url.protocol !== 'https:' || !url.hostname.endsWith('.bybit.com')) continue; sourceUrl = url.href; } catch { continue; }
      items.push({ id: `bybit-${publishedAt}-${items.length}`, symbol: coin, headline: headline.text, body: body.text,
        source: 'Bybit announcements', sourceUrl, publishedAt, provider: 'bybit', sentiment: 'neutral', example: false, flagged: headline.flagged || body.flagged });
      if (items.length >= 8) break;
    }
    cache.set(coin, { at: Date.now(), items });
    return items;
  } catch { return []; }
}

export function liveNewsStatus(items: NewsItem[]): 'CONFIGURED_LIVE' | 'SAMPLE_FALLBACK' | 'UNAVAILABLE' {
  return items.some(item => item.example) ? 'SAMPLE_FALLBACK' : items.length ? 'CONFIGURED_LIVE' : 'UNAVAILABLE';
}
