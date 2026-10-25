// CoinMarketCap API client for Free (Basic) Plan.
// Endpoints used: /v1/key/info, /v1/cryptocurrency/quotes/latest, /v1/global-metrics/quotes/latest
// Rate limits on Basic Plan: 333 credits/day, 10,000 credits/month, 30 req/min.
// In-memory caching protects the free tier allowance.

export interface CoinMarketCapQuote {
  symbol: string;
  price: number;
  volume24h: number;
  volumeChange24hPct: number | null;
  percentChange1h: number | null;
  percentChange24h: number | null;
  percentChange7d: number | null;
  marketCap: number;
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
}

const QUOTE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache for individual quotes
const GLOBAL_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes cache for global market metrics

const quoteCache = new Map<string, { data: CoinMarketCapQuote; at: number }>();
let globalCache: { data: CoinMarketCapGlobal; at: number } | null = null;

export function resetCoinMarketCapCache(): void {
  quoteCache.clear();
  globalCache = null;
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
        usage?: { current_day?: { credits_used?: number; credits_left?: number } };
      };
    } | null;

    if (!res.ok || (json?.status?.error_code && json.status.error_code !== 0)) {
      const msg = json?.status?.error_message || `HTTP ${res.status}`;
      return { ok: false, error: msg };
    }

    const plan = json?.data?.plan?.name || 'Basic';
    const creditsLeft = json?.data?.usage?.current_day?.credits_left ?? undefined;
    return { ok: true, plan, creditsLeft };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function fetchCoinMarketCapQuotes(
  symbols: string[],
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<Record<string, CoinMarketCapQuote>> {
  const key = apiKey.trim();
  if (!key || !symbols.length) return {};

  const now = Date.now();
  const cleanedList = [...new Set(symbols.map(cleanSymbol).filter(Boolean))];
  const out: Record<string, CoinMarketCapQuote> = {};
  const needed: string[] = [];

  for (const sym of cleanedList) {
    const cached = quoteCache.get(sym);
    if (cached && now - cached.at < QUOTE_CACHE_TTL_MS) {
      out[sym] = cached.data;
    } else {
      needed.push(sym);
    }
  }

  if (!needed.length) return out;

  try {
    const url = `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=${encodeURIComponent(needed.join(','))}`;
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'X-CMC_PRO_API_KEY': key
      },
      signal: AbortSignal.timeout(7000)
    });

    if (!res.ok) return out;

    const json = await res.json().catch(() => null) as {
      status?: { error_code?: number };
      data?: Record<string, {
        id?: number;
        name?: string;
        symbol?: string;
        cmc_rank?: number;
        quote?: {
          USD?: {
            price?: number;
            volume_24h?: number;
            volume_change_24h?: number;
            percent_change_1h?: number;
            percent_change_24h?: number;
            percent_change_7d?: number;
            market_cap?: number;
            market_cap_dominance?: number;
          };
        };
      }>;
    } | null;

    if (json?.status?.error_code === 0 && json.data) {
      for (const [sym, item] of Object.entries(json.data)) {
        const usd = item.quote?.USD;
        if (!usd || typeof usd.price !== 'number') continue;

        const quoteObj: CoinMarketCapQuote = {
          symbol: sym,
          price: usd.price,
          volume24h: usd.volume_24h ?? 0,
          volumeChange24hPct: usd.volume_change_24h ?? null,
          percentChange1h: usd.percent_change_1h ?? null,
          percentChange24h: usd.percent_change_24h ?? null,
          percentChange7d: usd.percent_change_7d ?? null,
          marketCap: usd.market_cap ?? 0,
          marketCapDominance: usd.market_cap_dominance ?? null,
          cmcRank: item.cmc_rank ?? null,
          updatedAt: now
        };

        quoteCache.set(sym, { data: quoteObj, at: now });
        out[sym] = quoteObj;
      }
    }
  } catch {
    // Fail closed quietly without burning retries or throwing
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
  if (globalCache && now - globalCache.at < GLOBAL_CACHE_TTL_MS) {
    return globalCache.data;
  }

  try {
    const res = await fetchImpl('https://pro-api.coinmarketcap.com/v1/global-metrics/quotes/latest', {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'X-CMC_PRO_API_KEY': key
      },
      signal: AbortSignal.timeout(7000)
    });

    if (!res.ok) return globalCache?.data ?? null;

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
      globalCache = { data: globalObj, at: now };
      return globalObj;
    }
  } catch {
    // Fail closed to protect caller
  }

  return globalCache?.data ?? null;
}

export async function fetchCoinMarketCapSummary(
  symbol: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<CoinMarketCapSummary> {
  const base = cleanSymbol(symbol);
  const now = Date.now();
  const cachedQuote = quoteCache.get(base);
  const isQuoteCached = !!(cachedQuote && now - cachedQuote.at < QUOTE_CACHE_TTL_MS);

  const [quotes, global] = await Promise.all([
    fetchCoinMarketCapQuotes([symbol], apiKey, fetchImpl),
    fetchCoinMarketCapGlobal(apiKey, fetchImpl)
  ]);

  return {
    source: 'coinmarketcap',
    symbol,
    quote: quotes[base] ?? null,
    global,
    cached: isQuoteCached,
    fetchedAt: now
  };
}

export async function getCoinMarketCapSummary(
  symbol: string,
  fetchImpl: typeof fetch = fetch
): Promise<CoinMarketCapSummary | null> {
  const key = (process.env.COINMARKETCAP_API_KEY || process.env.CMC_API_KEY || '').trim();
  if (!key) return null;
  return fetchCoinMarketCapSummary(symbol, key, fetchImpl);
}

