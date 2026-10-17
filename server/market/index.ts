import type { Candle, MarketSnapshot, NewsItem } from '../types.js';
import { sampleSnapshot } from './sample.js';
import { closedOnly } from '../strategy.js';
import { sanitizeUntrusted } from '../untrusted.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

type Source = MarketSnapshot['source'];
const ORDER: Source[] = ['bybit', 'binance', 'hyperliquid'];

async function getJson(url: string, init?: RequestInit, timeoutMs = 6000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

async function fromBybit(symbol: string): Promise<MarketSnapshot> {
  const tk = await getJson(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`);
  const row = tk?.result?.list?.[0];
  if (!row) throw new Error('bybit: no ticker');
  const kl = await getJson(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=15&limit=301`);
  const candles: Candle[] = (kl?.result?.list ?? []).map((r: string[]) => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] })).reverse();
  return {
    symbol, source: 'bybit', example: false, last: +row.lastPrice, change24hPct: +row.price24hPcnt * 100,
    fundingRate: row.fundingRate ? +row.fundingRate : null, bid: +row.bid1Price || null, ask: +row.ask1Price || null,
    candles: closedOnly(candles), fetchedAt: Date.now()
  };
}

async function fromBinance(symbol: string): Promise<MarketSnapshot> {
  const tk = await getJson(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`);
  const kl = await getJson(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=301`);
  const candles: Candle[] = kl.map((r: any[]) => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
  return {
    symbol, source: 'binance', example: false, last: +tk.lastPrice, change24hPct: +tk.priceChangePercent,
    fundingRate: null, bid: +tk.bidPrice || null, ask: +tk.askPrice || null, candles: closedOnly(candles), fetchedAt: Date.now()
  };
}

async function fromHyperliquid(symbol: string): Promise<MarketSnapshot> {
  const coin = symbol.replace(/USDT?$/, '');
  const [meta, ctxs] = await getJson('https://api.hyperliquid.xyz/info', { method: 'POST', body: JSON.stringify({ type: 'metaAndAssetCtxs' }) });
  const idx = meta.universe.findIndex((u: any) => u.name === coin);
  if (idx < 0) throw new Error('hyperliquid: unknown coin');
  const c = ctxs[idx];
  const end = Date.now();
  const kl = await getJson('https://api.hyperliquid.xyz/info', { method: 'POST', body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval: '15m', startTime: end - 301 * 15 * 60_000, endTime: end } }) });
  const candles: Candle[] = kl.map((r: any) => ({ t: +r.t, o: +r.o, h: +r.h, l: +r.l, c: +r.c, v: +r.v }));
  const last = +c.markPx;
  const prev = +c.prevDayPx;
  return {
    symbol, source: 'hyperliquid', example: false, last, change24hPct: prev ? ((last - prev) / prev) * 100 : 0,
    fundingRate: c.funding ? +c.funding : null, bid: null, ask: null, candles: closedOnly(candles), fetchedAt: Date.now()
  };
}

const FETCHERS: Record<Exclude<Source, 'sample'>, (s: string) => Promise<MarketSnapshot>> = { bybit: fromBybit, binance: fromBinance, hyperliquid: fromHyperliquid };

export async function getSnapshot(symbol: string, preferred: Source): Promise<MarketSnapshot & { errors: string[] }> {
  const errors: string[] = [];
  if (preferred !== 'sample') {
    const chain = [preferred, ...ORDER.filter((s) => s !== preferred)] as Exclude<Source, 'sample'>[];
    for (const src of chain) {
      try {
        const snap = await FETCHERS[src](symbol);
        if (snap.last > 0 && snap.candles.length >= 55) return { ...snap, errors };
        errors.push(`${src}: not enough data`);
      } catch (e) { errors.push(`${src}: ${(e as Error).message}`); }
    }
  }
  return { ...sampleSnapshot(symbol), errors };
}

const here = path.dirname(fileURLToPath(import.meta.url));
function findSample(file: string): string {
  for (const p of [path.resolve(here, '../../data/sample', file), path.resolve(here, '../../../data/sample', file), path.resolve(here, '../../../../data/sample', file), path.resolve(process.cwd(), 'data/sample', file)]) {
    try { readFileSync(p); return p; } catch { /* next */ }
  }
  throw new Error(`sample file ${file} not found`);
}

// News: this version ships sample catalysts (labeled EXAMPLE). Swap in your own
// feed in getNews(). Whatever the source, text goes through sanitizeUntrusted.
export function getNews(symbol: string): NewsItem[] {
  const raw = JSON.parse(readFileSync(findSample('news.json'), 'utf8')) as NewsItem[];
  const coin = symbol.replace(/USDT?$/, '');
  return raw
    .filter((n) => n.symbol === symbol || n.symbol === coin || n.symbol === '*')
    .map((n) => {
      const h = sanitizeUntrusted(n.headline, 200);
      const b = sanitizeUntrusted(n.body, 600);
      return { ...n, headline: h.text, body: b.text, flagged: h.flagged || b.flagged, example: true };
    });
}

export function getRawNewsForTest(): NewsItem[] {
  return JSON.parse(readFileSync(findSample('news.json'), 'utf8'));
}

// Optional news plugin (EXPERIMENTAL). CryptoPanic posts, cached 5 minutes per coin.
// Headlines are untrusted text: sanitized like the sample feed, and falls back to samples on any error.
const newsCache = new Map<string, { at: number; items: NewsItem[] }>();
export async function getNewsFor(symbol: string, cfg: { news: { provider: 'sample' | 'cryptopanic'; key: string; baseUrl: string } }, fetchImpl: typeof fetch = fetch): Promise<NewsItem[]> {
  if (cfg.news.provider !== 'cryptopanic' || !cfg.news.key) return getNews(symbol);
  const coin = symbol.replace(/USDT?$/, '');
  const hit = newsCache.get(coin);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.items;
  const url = `${cfg.news.baseUrl}?auth_token=${encodeURIComponent(cfg.news.key)}&currencies=${encodeURIComponent(coin)}&public=true`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`news HTTP ${res.status}`);
    const body: any = await res.json();
    const items: NewsItem[] = (body?.results ?? []).slice(0, 8).map((p: any, i: number) => {
      const h = sanitizeUntrusted(String(p.title ?? ''), 200);
      const b = sanitizeUntrusted(String(p.description ?? p.title ?? ''), 400);
      const votes = p.votes ?? {};
      const sentiment = (votes.positive ?? 0) > (votes.negative ?? 0) ? 'bullish' : (votes.negative ?? 0) > (votes.positive ?? 0) ? 'bearish' : 'neutral';
      return { id: `cp-${p.id ?? i}`, symbol: coin, headline: h.text, body: b.text, source: String(p.source?.title ?? p.domain ?? 'cryptopanic').slice(0, 60), sentiment, flagged: h.flagged || b.flagged, example: false } as NewsItem;
    });
    if (!items.length) return getNews(symbol);
    newsCache.set(coin, { at: Date.now(), items });
    return items;
  } catch {
    return getNews(symbol);
  } finally { clearTimeout(t); }
}

// ---------- candles on other timeframes (npm run gb -- candles) ----------
export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type Timeframe = typeof TIMEFRAMES[number];
const TF_MS: Record<Timeframe, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
const BYBIT_TF: Record<Timeframe, string> = { '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D' };

/** Closed candles for one timeframe. Public data only. Falls back to sample data (15m sample bars are aggregated). */
export async function getCandles(symbol: string, tf: Timeframe, preferred: Source, limit = 100): Promise<{ symbol: string; tf: Timeframe; source: Source; example: boolean; candles: Candle[]; errors: string[] }> {
  const n = Math.min(500, Math.max(10, limit));
  const errors: string[] = [];
  if (preferred !== 'sample') {
    const chain = [preferred, ...ORDER.filter((s) => s !== preferred)] as Exclude<Source, 'sample'>[];
    for (const src of chain) {
      try {
        let candles: Candle[] = [];
        if (src === 'bybit') {
          const kl = await getJson(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${BYBIT_TF[tf]}&limit=${n + 1}`);
          candles = (kl?.result?.list ?? []).map((r: string[]) => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] })).reverse();
        } else if (src === 'binance') {
          const kl = await getJson(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=${n + 1}`);
          candles = kl.map((r: any[]) => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
        } else {
          const coin = symbol.replace(/USDT?$/, ''), end = Date.now();
          const kl = await getJson('https://api.hyperliquid.xyz/info', { method: 'POST', body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval: tf, startTime: end - (n + 1) * TF_MS[tf], endTime: end } }) });
          candles = kl.map((r: any) => ({ t: +r.t, o: +r.o, h: +r.h, l: +r.l, c: +r.c, v: +r.v }));
        }
        const closed = candles.filter((c) => c.t + TF_MS[tf] <= Date.now()).slice(-n);
        if (closed.length >= 10) return { symbol, tf, source: src, example: false, candles: closed, errors };
        errors.push(`${src}: not enough data`);
      } catch (e) { errors.push(`${src}: ${(e as Error).message}`); }
    }
  }
  const base = sampleSnapshot(symbol).candles;
  const step = Math.max(1, Math.round(TF_MS[tf] / TF_MS['15m']));
  const out: Candle[] = [];
  for (let i = base.length % step; i + step <= base.length; i += step) {
    const g = base.slice(i, i + step);
    out.push({ t: g[0].t, o: g[0].o, h: Math.max(...g.map((x) => x.h)), l: Math.min(...g.map((x) => x.l)), c: g[g.length - 1].c, v: g.reduce((s, x) => s + x.v, 0) });
  }
  return { symbol, tf: step === 1 && TF_MS[tf] < TF_MS['15m'] ? '15m' : tf, source: 'sample', example: true, candles: out.slice(-n), errors };
}
