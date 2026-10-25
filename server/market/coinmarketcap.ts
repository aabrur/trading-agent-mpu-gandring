// Optional CoinMarketCap enrichment. Account quotas are read from /v1/key/info.
import { createHash } from 'node:crypto';
import { z } from 'zod';

export interface CoinMarketCapQuote {
  cmcId: number;
  symbol: string;
  price: number;
  volume24h: number | null;
  volumeChange24hPct: number | null;
  percentChange1h: number | null;
  percentChange24h: number | null;
  percentChange7d: number | null;
  marketCap: number | null;
  marketCapDominance: number | null;
  cmcRank: number | null;
  updatedAt: number;
}

export interface CoinMarketCapGlobal {
  totalMarketCapUsd: number;
  total24hVolumeUsd: number;
  btcDominance: number;
  ethDominance: number;
  defiMarketCapUsd: number | null;
  updatedAt: number;
}

export interface CoinMarketCapSummary {
  source: 'coinmarketcap';
  symbol: string;
  quote: CoinMarketCapQuote | null;
  global: CoinMarketCapGlobal | null;
  cached: boolean;
  fetchedAt: number;
  momentum: CmcMomentum;
  quota: { creditsLeft?: number; plan?: string; checkedAt: number; error?: string } | null;
}

export interface CmcMomentum {
  symbol: string;
  cmcId: number | null;
  source: 'coinmarketcap';
  sourceStatus: 'live' | 'stale' | 'unavailable';
  observedAt: number | null;
  measurementBasis: 'rolling 24h aggregate; activity, not net capital inflow';
  volume24h: number | null;
  volumeChange24hPct: number | null;
  volumeToMarketCapRatio: number | null;
  priceChange1hPct: number | null;
  priceChange24hPct: number | null;
  marketCapDominancePct: number | null;
  classification: 'ROTATION_SURGE' | 'MOMENTUM_BUILDING' | 'NORMAL' | 'INSUFFICIENT_DATA';
  evidence: string[];
}

// Descriptive thresholds only, never execution requirements.
// Surge: volume growth >=50%, turnover >=0.1, positive 1h and 24h price change.
// Building: volume growth >=20%, turnover >=0.03, positive 1h and 24h change.
export function cmcMomentum(symbol: string, q: CoinMarketCapQuote | null, now = Date.now()): CmcMomentum {
  const ratio = q?.volume24h != null && q.marketCap != null && q.marketCap > 0 ? q.volume24h / q.marketCap : null;
  const status = !q ? 'unavailable' : now - q.updatedAt > QUOTE_CACHE_TTL_MS ? 'stale' : 'live';
  const complete = status === 'live' && ratio !== null && q?.volumeChange24hPct != null && q.percentChange1h != null && q.percentChange24h != null;
  let classification: CmcMomentum['classification'] = 'INSUFFICIENT_DATA';
  if (complete && q) {
    classification = q.volumeChange24hPct! >= 50 && ratio! >= 0.1 && q.percentChange1h! > 0 && q.percentChange24h! > 0 ? 'ROTATION_SURGE'
      : q.volumeChange24hPct! >= 20 && ratio! >= 0.03 && q.percentChange1h! > 0 && q.percentChange24h! > 0 ? 'MOMENTUM_BUILDING' : 'NORMAL';
  }
  return { symbol, cmcId: q?.cmcId ?? null, source: 'coinmarketcap', sourceStatus: status, observedAt: q?.updatedAt ?? null,
    measurementBasis: 'rolling 24h aggregate; activity, not net capital inflow', volume24h: q?.volume24h ?? null,
    volumeChange24hPct: q?.volumeChange24hPct ?? null, volumeToMarketCapRatio: ratio, priceChange1hPct: q?.percentChange1h ?? null,
    priceChange24hPct: q?.percentChange24h ?? null, marketCapDominancePct: q?.marketCapDominance ?? null, classification,
    evidence: complete ? [`24h volume change ${q!.volumeChange24hPct}%; volume/market cap ${ratio}; 1h price ${q!.percentChange1h}%; 24h price ${q!.percentChange24h}%.`]
      : ['Fresh, complete CMC observations unavailable; missing evidence is not verified absence.'] };
}

const QUOTE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache for individual quotes
const GLOBAL_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes cache for global market metrics

const quoteCache = new Map<string, { data: CoinMarketCapQuote; at: number }>();
const globalCache = new Map<string, { data: CoinMarketCapGlobal; at: number }>();
const pending = new Map<string, Promise<unknown>>();
const blockedUntil = new Map<string, number>();
const quotaCache = new Map<string, CoinMarketCapSummary['quota']>();
const credentialId = (key: string) => createHash('sha256').update(key).digest('hex');
async function once<T>(id: string, work: () => Promise<T>): Promise<T> {
  const existing = pending.get(id);
  if (existing) return existing as Promise<T>;
  const promise = work(); pending.set(id, promise);
  try { return await promise; } finally { pending.delete(id); }
}
function backoff(key: string, res: Response, code?: number) {
  if (res.status !== 429 && ![1008, 1009, 1010, 1011].includes(code ?? 0)) return;
  const retry = res.headers?.get('retry-after');
  const delay = retry && Number.isFinite(Number(retry)) ? Number(retry) * 1000 : retry ? Date.parse(retry) - Date.now() : 60_000;
  blockedUntil.set(credentialId(key), Date.now() + Math.max(60_000, Number.isFinite(delay) ? delay : 60_000));
}

export function resetCoinMarketCapCache(): void {
  quoteCache.clear();
  globalCache.clear(); pending.clear(); blockedUntil.clear(); quotaCache.clear();
}

function cleanSymbol(sym: string): string {
  return sym.toUpperCase().replace(/(USDT|USDC|USD|BUSD|PERP)$/i, '').trim();
}

export async function checkCoinMarketCapKey(
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; plan?: string; creditsLeft?: number; error?: string }> {
  const key = apiKey.trim();
  if (!key) return { ok: false, error: 'Empty CoinMarketCap API key' };

  try {
    const res = await fetchImpl('https://pro-api.coinmarketcap.com/v1/key/info', {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'X-CMC_PRO_API_KEY': key
      },
      signal: AbortSignal.timeout(6000)
    });

    const json = await res.json().catch(() => null) as {
      status?: { error_code?: number; error_message?: string | null };
      data?: {
        plan?: { name?: string; credit_limit_daily?: number };
        usage?: { current_day?: { credits_used?: number; credits_left?: number }; current_month?: { credits_left?: number } };
      };
    } | null;

    if (!res.ok || (json?.status?.error_code && json.status.error_code !== 0)) {
      backoff(key, res, json?.status?.error_code);
      const msg = json?.status?.error_message || `HTTP ${res.status}`;
      return { ok: false, error: msg };
    }

    const plan = json?.data?.plan?.name;
    const remaining = [json?.data?.usage?.current_day?.credits_left, json?.data?.usage?.current_month?.credits_left].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    const creditsLeft = remaining.length ? Math.min(...remaining) : undefined;
    if (creditsLeft === 0) blockedUntil.set(credentialId(key), Date.now() + GLOBAL_CACHE_TTL_MS);
    return { ok: true, plan, creditsLeft };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

const optionalNumber = z.number().finite().nullish();
const v3Quotes = z.object({
  status: z.object({ error_code: z.number() }),
  data: z.array(z.object({
    id: z.number().int().positive(), symbol: z.string().min(1), cmc_rank: optionalNumber,
    quote: z.array(z.object({ id: optionalNumber, symbol: z.string().optional(), price: z.number().finite().positive(),
      volume_24h: optionalNumber, volume_change_24h: optionalNumber, percent_change_1h: optionalNumber,
      percent_change_24h: optionalNumber, percent_change_7d: optionalNumber, market_cap: optionalNumber,
      market_cap_dominance: optionalNumber, last_updated: z.string().datetime() }))
  }))
});

export async function fetchCoinMarketCapQuotes(
  symbols: string[], apiKey: string, fetchImpl: typeof fetch = fetch,
  ids: Record<string, number> = {}
): Promise<Record<string, CoinMarketCapQuote>> {
  const key = apiKey.trim(), credential = credentialId(key);
  if (!key || !symbols.length) return {};
  const wanted = [...new Set(symbols.map(cleanSymbol).filter(Boolean))].sort();
  const cacheKey = (sym: string) => `${credential}:${sym}:${ids[sym] ?? ''}`;
  const out: Record<string, CoinMarketCapQuote> = {};
  const needed = wanted.filter(sym => {
    const hit = quoteCache.get(cacheKey(sym));
    if (hit && Date.now() - hit.at < QUOTE_CACHE_TTL_MS) { out[sym] = hit.data; return false; }
    return true;
  });
  if (!needed.length || (blockedUntil.get(credential) ?? 0) > Date.now()) return out;
  // ID lookups and symbol lookups cannot be mixed in the same CMC request.
  for (const group of [needed.filter(s => ids[s]), needed.filter(s => !ids[s])]) {
    if (!group.length || (blockedUntil.get(credential) ?? 0) > Date.now()) continue;
    const query = ids[group[0]] ? `id=${group.map(s => ids[s]).join(',')}` : `symbol=${encodeURIComponent(group.join(','))}`;
    const results = await once(`${credential}:quotes:${query}`, async () => {
      const result: Record<string, CoinMarketCapQuote> = {};
      try {
        const res = await fetchImpl(`https://pro-api.coinmarketcap.com/v3/cryptocurrency/quotes/latest?${query}&convert=USD&skip_invalid=true`, {
          headers: { Accept: 'application/json', 'X-CMC_PRO_API_KEY': key }, signal: AbortSignal.timeout(7000)
        });
        const body: unknown = await res.json().catch(() => null);
        const status = z.object({ status: z.object({ error_code: z.number() }) }).safeParse(body);
        backoff(key, res, status.success ? status.data.status.error_code : undefined);
        const parsed = v3Quotes.safeParse(body);
        if (!res.ok || !parsed.success || parsed.data.status.error_code !== 0) return result;
        for (const sym of group) {
          const matches = parsed.data.data.filter(item => item.symbol.toUpperCase() === sym && (!ids[sym] || item.id === ids[sym]));
          // Ambiguous symbols require an explicit CMC ID, never an arbitrary first record.
          if (matches.length !== 1) continue;
          const item = matches[0], usd = item.quote.find(q => q.symbol === 'USD' || q.id === 2781);
          if (!usd) continue;
          const q: CoinMarketCapQuote = { cmcId: item.id, symbol: sym, price: usd.price, volume24h: usd.volume_24h ?? null,
            volumeChange24hPct: usd.volume_change_24h ?? null, percentChange1h: usd.percent_change_1h ?? null,
            percentChange24h: usd.percent_change_24h ?? null, percentChange7d: usd.percent_change_7d ?? null,
            marketCap: usd.market_cap ?? null, marketCapDominance: usd.market_cap_dominance ?? null,
            cmcRank: item.cmc_rank ?? null, updatedAt: Date.parse(usd.last_updated) };
          quoteCache.set(cacheKey(sym), { data: q, at: Date.now() }); result[sym] = q;
        }
      } catch { /* Optional enrichment must not break exchange observations. */ }
      return result;
    });
    Object.assign(out, results);
  }
  return out;
}

export async function fetchCoinMarketCapGlobal(
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<CoinMarketCapGlobal | null> {
  const key = apiKey.trim();
  if (!key) return null;

  const now = Date.now();
  const credential = credentialId(key), cached = globalCache.get(credential);
  if (cached && now - cached.at < GLOBAL_CACHE_TTL_MS) return cached.data;
  if ((blockedUntil.get(credential) ?? 0) > now) return null;
  return once(`${credential}:global`, async () => {

  try {
    const res = await fetchImpl('https://pro-api.coinmarketcap.com/v1/global-metrics/quotes/latest', {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'X-CMC_PRO_API_KEY': key
      },
      signal: AbortSignal.timeout(7000)
    });

    backoff(key, res);
    if (!res.ok) return null;

    const json = await res.json().catch(() => null) as {
      status?: { error_code?: number };
      data?: {
        btc_dominance?: number;
        eth_dominance?: number;
        quote?: {
          USD?: {
            total_market_cap?: number;
            total_volume_24h?: number;
            defi_market_cap?: number;
          };
        };
      };
    } | null;

    if (json?.status?.error_code === 0 && json.data?.quote?.USD) {
      const usd = json.data.quote.USD;
      const globalObj: CoinMarketCapGlobal = {
        totalMarketCapUsd: usd.total_market_cap ?? 0,
        total24hVolumeUsd: usd.total_volume_24h ?? 0,
        btcDominance: json.data.btc_dominance ?? 0,
        ethDominance: json.data.eth_dominance ?? 0,
        defiMarketCapUsd: usd.defi_market_cap ?? null,
        updatedAt: now
      };
      globalCache.set(credential, { data: globalObj, at: now });
      return globalObj;
    }
  } catch {
    // Fail closed to protect caller
  }

  return null;
  });
}

export async function fetchCoinMarketCapSummary(
  symbol: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<CoinMarketCapSummary> {
  const base = cleanSymbol(symbol);
  const now = Date.now();
  const cachedQuote = quoteCache.get(`${credentialId(apiKey.trim())}:${base}:`);
  const isQuoteCached = !!(cachedQuote && now - cachedQuote.at < QUOTE_CACHE_TTL_MS);

  const [quotes, global] = await Promise.all([
    fetchCoinMarketCapQuotes([symbol], apiKey, fetchImpl),
    fetchCoinMarketCapGlobal(apiKey, fetchImpl)
  ]);

  const credential = credentialId(apiKey.trim());
  let quota = quotaCache.get(credential) ?? null;
  if (!quota || now - quota.checkedAt > GLOBAL_CACHE_TTL_MS) {
    quota = await once(`${credential}:quota`, async () => {
      const info = await checkCoinMarketCapKey(apiKey, fetchImpl);
      const value = { creditsLeft: info.creditsLeft, plan: info.plan, error: info.error, checkedAt: Date.now() };
      quotaCache.set(credential, value); return value;
    });
  }
  return {
    source: 'coinmarketcap',
    symbol,
    quote: quotes[base] ?? null,
    global,
    cached: isQuoteCached,
    fetchedAt: now, momentum: cmcMomentum(symbol, quotes[base] ?? null), quota
  };
}

export function coinMarketCapStatus(apiKey: string) {
  const credential = credentialId(apiKey.trim());
  const quotes = [...quoteCache.entries()].filter(([key]) => key.startsWith(credential + ':')).map(([, entry]) => entry.data);
  const observedAt = quotes.length ? Math.max(...quotes.map(q => q.updatedAt)) : null;
  const quota = quotaCache.get(credential) ?? null;
  return { connected: !!observedAt && Date.now() - observedAt < QUOTE_CACHE_TTL_MS, observedAt,
    freshness: observedAt ? Date.now() - observedAt < QUOTE_CACHE_TTL_MS ? 'fresh' : 'stale' : 'unverified', quota,
    retryAt: blockedUntil.get(credential) ?? null };
}

export async function getCoinMarketCapSummary(
  symbol: string,
  fetchImpl: typeof fetch = fetch
): Promise<CoinMarketCapSummary | null> {
  const key = (process.env.COINMARKETCAP_API_KEY || process.env.CMC_API_KEY || '').trim();
  if (!key) return null;
  return fetchCoinMarketCapSummary(symbol, key, fetchImpl);
}

