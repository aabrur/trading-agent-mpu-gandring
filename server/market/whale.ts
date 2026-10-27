import { sanitizeUntrusted } from '../untrusted.js';
import { safe } from '../redact.js';
import type { WhaleOnChainSummary } from '../types.js';
import { fetchDeribitMeasurements } from './observations.js';

/** Existing provider query coverage, shared with evidence classification. */
export const WHALE_OBSERVATION_POLICY = { minUsd: 500_000, maxAgeMs: 24 * 3600 * 1000 } as const;

export interface NormalizedWhaleEvent {
  chainId: string | number;
  txHash: string;
  blockNumber: number | null;
  timestamp: number | null;
  tokenAddress: string | null;
  tokenSymbol: string;
  rawAmount: string;
  normalizedAmount: number | null;
  usdValueOrNull: number | null;
  fromAddress: string;
  toAddress: string;
  fromEntityOrNull: string | null;
  toEntityOrNull: string | null;
  attributionConfidence: 'high' | 'medium' | 'low' | 'unknown';
  confirmationStatus: 'confirmed' | 'pending' | 'unverified';
  source: string;
  classification: 'EXCHANGE_INFLOW' | 'EXCHANGE_OUTFLOW' | 'INTERNAL_TRANSFER' | 'MINT_BURN' | 'UNKNOWN';
  interpretation: string;
}

export interface WhaleBriefing {
  symbol: string;
  providerStatus: 'CONFIGURED_LIVE' | 'UNCONFIGURED' | 'UNAVAILABLE';
  dataStatus?: 'DATA_AVAILABLE' | 'NO_RELEVANT_EVENTS' | 'UNCONFIGURED' | 'UNAVAILABLE';
  providerName: string;
  source?: string;
  events: NormalizedWhaleEvent[];
  summary: string;
  observedAt: number;
  disclaimer: string;
}

// Known labeled entities for exchange and treasury wallets
export const KNOWN_ENTITIES: Record<string, string> = {
  'binance': 'Binance',
  'bybit': 'Bybit',
  'coinbase': 'Coinbase',
  'okx': 'OKX',
  'kraken': 'Kraken',
  'tether_treasury': 'Tether Treasury',
  'circle': 'Circle',
  'bitfinex': 'Bitfinex'
};

// Classify transfer direction and provide analytical interpretation
export function classifyTransfer(
  fromEntity: string | null,
  toEntity: string | null,
  amount: number,
  symbol: string,
  usdValue: number | null
): { classification: NormalizedWhaleEvent['classification']; interpretation: string } {
  const fromEx = fromEntity && /binance|bybit|coinbase|okx|kraken|bitfinex/i.test(fromEntity);
  const toEx = toEntity && /binance|bybit|coinbase|okx|kraken|bitfinex/i.test(toEntity);

  const valStr = usdValue != null && Number.isFinite(usdValue) ? ` ($${(usdValue / 1e6).toFixed(1)}M)` : '';

  if (toEx && !fromEx) {
    return {
      classification: 'EXCHANGE_INFLOW',
      interpretation: `Transfer of ${amount.toLocaleString()} ${symbol}${valStr} to ${toEntity}. Implies potential spot/derivative supply or selling pressure. Not confirmed proof of a completed market sale.`
    };
  }
  if (fromEx && !toEx) {
    return {
      classification: 'EXCHANGE_OUTFLOW',
      interpretation: `Transfer of ${amount.toLocaleString()} ${symbol}${valStr} out of ${fromEntity} to private custody or smart contract. Implies potential supply withdrawal. Not confirmed proof of continuous accumulation.`
    };
  }
  if (fromEx && toEx) {
    return {
      classification: 'INTERNAL_TRANSFER',
      interpretation: `Inter-exchange transfer of ${amount.toLocaleString()} ${symbol}${valStr} between ${fromEntity} and ${toEntity}. Typically rebalancing or cold storage management.`
    };
  }
  if (/tether|circle/i.test(fromEntity ?? '') || /tether|circle/i.test(toEntity ?? '')) {
    return {
      classification: 'MINT_BURN',
      interpretation: `Stablecoin issuance/redemption activity of ${amount.toLocaleString()} ${symbol}${valStr} involving ${fromEntity ?? 'Treasury'} and ${toEntity ?? 'recipient'}.`
    };
  }
  return {
    classification: 'UNKNOWN',
    interpretation: `Transfer of ${amount.toLocaleString()} ${symbol}${valStr} between unverified entities. Counterparty motives remain unverified.`
  };
}

export function optionalNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function attributionConfidence(fromEntity: string | null, toEntity: string | null): NormalizedWhaleEvent['attributionConfidence'] {
  if (!fromEntity && !toEntity) return 'unknown';
  return 'medium';
}

function confirmationStatus(tx: { hash?: unknown; block_number?: unknown }): NormalizedWhaleEvent['confirmationStatus'] {
  const hash = tx.hash != null && String(tx.hash).trim() !== '';
  const block = optionalNumber(tx.block_number);
  if (hash && block != null) return 'confirmed';
  if (hash) return 'unverified';
  return 'unverified';
}

const whaleCache = new Map<string, { at: number; briefing: WhaleBriefing }>();
export function resetWhaleCache() { whaleCache.clear(); }

export async function getEnterpriseWhaleBriefing(
  symbol: string,
  blockchain: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<WhaleBriefing> {
  const coin = symbol.replace(/USDT?$|USDC$/, '').toUpperCase();
  const startSec = Math.floor((Date.now() - WHALE_OBSERVATION_POLICY.maxAgeMs) / 1000);
  const host = 'https://leviathan.whale-alert.io';
  const heightUrl = `${host}/${encodeURIComponent(blockchain)}/height_at_time/${startSec}?api_key=${encodeURIComponent(apiKey)}`;
  const heightRes = await fetchImpl(heightUrl);
  if (!heightRes.ok) throw new Error(`Whale Alert Enterprise height_at_time HTTP ${heightRes.status}`);
  const heightData: any = await heightRes.json();
  const startHeight = heightData?.height;
  if (startHeight == null) throw new Error('Whale Alert Enterprise height_at_time response omitted height');

  const txUrl = `${host}/${encodeURIComponent(blockchain)}/transactions?api_key=${encodeURIComponent(apiKey)}&start_height=${startHeight}&symbol=${encodeURIComponent(coin.toLowerCase())}`;
  const txRes = await fetchImpl(txUrl);
  if (!txRes.ok) throw new Error(`Whale Alert Enterprise transactions HTTP ${txRes.status}`);
  const txData: any = await txRes.json();
  const rawTxs: any[] = Array.isArray(txData?.transactions) ? txData.transactions : [];

  const events: NormalizedWhaleEvent[] = [];
  for (const tx of rawTxs) {
    const hash = tx.hash != null && String(tx.hash).trim() !== '' ? String(tx.hash) : '';
    const blockNumber = optionalNumber(tx.height);
    const tsSec = optionalNumber(tx.timestamp);
    const timestamp = tsSec == null ? null : (tsSec < 1e12 ? tsSec * 1000 : tsSec);
    const subTxs: any[] = Array.isArray(tx.sub_transactions) ? tx.sub_transactions : [];
    for (const sub of subTxs) {
      const fromInput = sub.inputs?.[0];
      const toOutput = sub.outputs?.[0];
      const fromEntity = fromInput?.owner ? String(fromInput.owner) : null;
      const toEntity = toOutput?.owner ? String(toOutput.owner) : null;
      const amt = optionalNumber(fromInput?.amount ?? toOutput?.amount);
      const unitPrice = optionalNumber(sub.unit_price_usd);
      const usd = unitPrice != null && amt != null ? unitPrice * amt : null;
      const { classification, interpretation } = classifyTransfer(fromEntity, toEntity, amt ?? 0, coin, usd);

      events.push({
        chainId: blockchain,
        txHash: hash,
        blockNumber,
        timestamp,
        tokenAddress: null,
        tokenSymbol: sub.symbol ? String(sub.symbol).toUpperCase() : coin,
        rawAmount: String(amt ?? ''),
        normalizedAmount: amt,
        usdValueOrNull: usd,
        fromAddress: String(fromInput?.address ?? 'unknown'),
        toAddress: String(toOutput?.address ?? 'unknown'),
        fromEntityOrNull: fromEntity,
        toEntityOrNull: toEntity,
        attributionConfidence: attributionConfidence(fromEntity, toEntity),
        confirmationStatus: hash && blockNumber != null ? 'confirmed' : 'unverified',
        source: 'whale-alert-enterprise',
        classification,
        interpretation
      });
    }
  }

  return {
    symbol: coin,
    providerStatus: 'CONFIGURED_LIVE',
    dataStatus: events.length ? 'DATA_AVAILABLE' : 'NO_RELEVANT_EVENTS',
    providerName: 'Whale Alert Enterprise API',
    source: 'Whale Alert Enterprise API',
    events,
    summary: events.length === 0
      ? `No large on-chain transactions recorded for ${coin} in the last 24h via Enterprise API.`
      : `${events.length} transfer(s) observed via Enterprise API. Top event: ${events[0].interpretation}`,
    observedAt: Date.now(),
    disclaimer: 'Enterprise feed data maps sub-transactions to direction classifications.'
  };
}

export async function getWhaleBriefing(
  symbol: string,
  env: { WHALE_ALERT_API_KEY?: string; WHALE_ALERT_ENTERPRISE_API?: string; WHALE_ALERT_CHAIN?: string; WHALE_ALERT_BLOCKCHAIN?: string } = process.env,
  fetchImpl: typeof fetch = fetch
): Promise<WhaleBriefing> {
  const coin = symbol.replace(/USDT?$|USDC$/, '').toUpperCase();
  const cached = whaleCache.get(coin);
  if (cached && Date.now() - cached.at < 3 * 60_000) {
    return cached.briefing;
  }

  const apiKey = env.WHALE_ALERT_API_KEY;
  if (!apiKey) {
    const briefing: WhaleBriefing = {
      symbol: coin,
      providerStatus: 'UNCONFIGURED',
      dataStatus: 'UNCONFIGURED',
      providerName: 'Whale Alert / Explorer API',
      source: 'Whale Alert Transactions API',
      events: [],
      summary: `On-chain whale provider unconfigured for ${coin}. To enable real on-chain transaction monitoring, set WHALE_ALERT_API_KEY in environment. Candle volume proxies must never be confused with on-chain wallet tracking.`,
      observedAt: Date.now(),
      disclaimer: 'Whale tracking requires verified blockchain explorer or indexer feeds. Transfers to exchanges reflect potential supply, not guaranteed market execution.'
    };
    whaleCache.set(coin, { at: Date.now(), briefing });
    return briefing;
  }

  if (env.WHALE_ALERT_ENTERPRISE_API === 'yes' || env.WHALE_ALERT_ENTERPRISE_API === 'true') {
    const chain = env.WHALE_ALERT_CHAIN || env.WHALE_ALERT_BLOCKCHAIN;
    if (!chain) {
      const briefing: WhaleBriefing = {
        symbol: coin,
        providerStatus: 'UNCONFIGURED',
        dataStatus: 'UNCONFIGURED',
        providerName: 'Whale Alert Enterprise API',
        source: 'Whale Alert Enterprise API',
        events: [],
        summary: 'Whale Alert Enterprise API is enabled but WHALE_ALERT_CHAIN is unconfigured.',
        observedAt: Date.now(),
        disclaimer: 'Whale Alert Enterprise API requires a chain mapping.'
      };
      whaleCache.set(coin, { at: Date.now(), briefing });
      return briefing;
    }
    try {
      const res = await getEnterpriseWhaleBriefing(coin, chain, apiKey, fetchImpl);
      whaleCache.set(coin, { at: Date.now(), briefing: res });
      return res;
    } catch (e) {
      const briefing: WhaleBriefing = {
        symbol: coin,
        providerStatus: 'UNAVAILABLE',
        dataStatus: 'UNAVAILABLE',
        providerName: 'Whale Alert Enterprise API',
        source: 'Whale Alert Enterprise API',
        events: [],
        summary: `Whale Alert Enterprise API query failed: ${safe((e as Error).message)}.`,
        observedAt: Date.now(),
        disclaimer: 'Whale Alert Enterprise API unavailable.'
      };
      return briefing;
    }
  }

  // Live Whale Alert provider
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const minVal = WHALE_OBSERVATION_POLICY.minUsd;
    const startSec = Math.floor((Date.now() - WHALE_OBSERVATION_POLICY.maxAgeMs) / 1000);
    const url = `https://api.whale-alert.io/v1/transactions?api_key=${encodeURIComponent(apiKey)}&min_value=${minVal}&start=${startSec}&currency=${encodeURIComponent(coin.toLowerCase())}`;
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`Whale Alert HTTP ${res.status}`);
    const data: any = await res.json();
    if (!Array.isArray(data?.transactions)) throw new Error('Whale Alert response omitted transactions');
    const rawTxs: any[] = data.transactions;
    const seen = new Set<string>();

    const events: NormalizedWhaleEvent[] = rawTxs.filter((tx: any) => {
      const key = tx?.hash == null ? '' : String(tx.hash);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 10).map((tx: any) => {
      const fromEntity = tx.from?.owner ? String(tx.from.owner) : null;
      const toEntity = tx.to?.owner ? String(tx.to.owner) : null;
      const amt = optionalNumber(tx.amount);
      const usd = optionalNumber(tx.amount_usd);
      const tsSec = optionalNumber(tx.timestamp);
      const { classification, interpretation } = classifyTransfer(fromEntity, toEntity, amt ?? 0, coin, usd);
      const blockNumber = optionalNumber(tx.block_number);

      return {
        chainId: tx.blockchain ?? 'unknown',
        txHash: tx.hash != null && String(tx.hash).trim() !== '' ? String(tx.hash) : '',
        blockNumber,
        timestamp: tsSec == null ? null : (tsSec < 1e12 ? tsSec * 1000 : tsSec),
        tokenAddress: tx.token?.address ? String(tx.token.address) : null,
        tokenSymbol: tx.symbol ? String(tx.symbol).toUpperCase() : coin,
        rawAmount: tx.amount == null ? '' : String(tx.amount),
        normalizedAmount: amt,
        usdValueOrNull: usd,
        fromAddress: String(tx.from?.address ?? 'unknown'),
        toAddress: String(tx.to?.address ?? 'unknown'),
        fromEntityOrNull: fromEntity,
        toEntityOrNull: toEntity,
        attributionConfidence: attributionConfidence(fromEntity, toEntity),
        confirmationStatus: confirmationStatus(tx),
        source: 'whale-alert',
        classification,
        interpretation
      };
    });

    const summary = events.length === 0
      ? `No large on-chain transactions (> $500k) recorded for ${coin} in the last 24h.`
      : `${events.length} large transfer(s) observed. Top event: ${events[0].interpretation}`;

    const briefing: WhaleBriefing = {
      symbol: coin,
      providerStatus: 'CONFIGURED_LIVE',
      dataStatus: events.length ? 'DATA_AVAILABLE' : 'NO_RELEVANT_EVENTS',
      providerName: 'Whale Alert API',
      source: 'Whale Alert Transactions API',
      events,
      summary,
      observedAt: Date.now(),
      disclaimer: 'Transfers to exchanges reflect potential supply, not guaranteed market execution.'
    };
    whaleCache.set(coin, { at: Date.now(), briefing });
    return briefing;
  } catch (e) {
    const briefing: WhaleBriefing = {
      symbol: coin,
      providerStatus: 'UNAVAILABLE',
      dataStatus: 'UNAVAILABLE',
      providerName: 'Whale Alert API',
      source: 'Whale Alert Transactions API',
      events: [],
      summary: `Whale Alert API query failed: ${safe((e as Error).message)}. Real on-chain data temporarily unavailable.`,
      observedAt: Date.now(),
      disclaimer: 'Do not substitute candle volume proxies for whale tracking.'
    };
    return briefing;
  } finally {
    clearTimeout(t);
  }
}

const DEFAULT_HYPERLIQUID_WHALES = [
  '0xdfc24b077bc1425ad1dea75bcb6f8158e10df303',
  '0x5b3256965e7c3cf26e11fcaf296dfc8807c01073',
  '0x010461c14e146acc353886173f13590d2717c563'
];

export type HyperliquidWatchlistResult = NonNullable<WhaleOnChainSummary['hyperliquidWhales']> & {
  coverageStatus: 'DATA_AVAILABLE' | 'NO_RELEVANT_EVENTS' | 'PARTIAL' | 'UNAVAILABLE';
  coverageNote: string;
  watchlistSource: 'configured' | 'built_in_sample';
};

export async function getHyperliquidWhales(
  coin: string,
  addresses?: string[],
  fetchImpl: typeof fetch = fetch
): Promise<HyperliquidWatchlistResult | undefined> {
  const envValue = process.env.HYPERLIQUID_WHALE_ADDRESSES;
  const envAddresses = envValue?.split(',').map((a) => a.trim()).filter((a) => /^0x[a-f\d]{40}$/i.test(a));
  const configuredByCaller = addresses !== undefined;
  const watchlistSource = configuredByCaller || envValue !== undefined ? 'configured' : 'built_in_sample';
  const configured = configuredByCaller ? addresses : envValue !== undefined ? envAddresses ?? [] : DEFAULT_HYPERLIQUID_WHALES;
  const addrs = [...new Set(configured.filter((a) => /^0x[a-f\d]{40}$/i.test(a)))];
  if (!addrs.length) return undefined;
  const targetCoin = coin.replace(/USDT?$|USDC$/, '').toUpperCase();

  let longCount = 0, shortCount = 0;
  let totalLongNotional = 0, totalShortNotional = 0;
  let totalUnrealizedPnl = 0;
  let walletsChecked = 0;
  const topPositions: Array<{ address: string; side: 'LONG' | 'SHORT'; notional: number; pnl: number }> = [];

  await Promise.all(
    addrs.map(async (addr) => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 4000);
        const res = await fetchImpl('https://api.hyperliquid.xyz/info', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'clearinghouseState', user: addr }),
          signal: ctrl.signal
        }).finally(() => clearTimeout(t));

        if (!res.ok) return;
        const data: any = await res.json();
        if (!Array.isArray(data?.assetPositions)) return;
        walletsChecked++;
        const positions: any[] = data.assetPositions;
        for (const p of positions) {
          const pos = p.position;
          if (pos && String(pos.coin).toUpperCase() === targetCoin) {
            const sz = Number(pos.szi ?? 0);
            const ntl = Math.abs(Number(pos.positionValue ?? 0));
            const pnl = Number(pos.unrealizedPnl ?? 0);
            totalUnrealizedPnl += pnl;
            if (sz > 0) {
              longCount++;
              totalLongNotional += ntl;
              topPositions.push({ address: `${addr.slice(0, 6)}...${addr.slice(-4)}`, side: 'LONG', notional: Math.round(ntl), pnl: Math.round(pnl) });
            } else if (sz < 0) {
              shortCount++;
              totalShortNotional += ntl;
              topPositions.push({ address: `${addr.slice(0, 6)}...${addr.slice(-4)}`, side: 'SHORT', notional: Math.round(ntl), pnl: Math.round(pnl) });
            }
          }
        }
      } catch { /* ignore individual address errors */ }
    })
  );

  topPositions.sort((a, b) => b.notional - a.notional);

  if (!walletsChecked) return undefined;

  return {
    coverageStatus: walletsChecked !== addrs.length ? 'PARTIAL' : longCount + shortCount ? 'DATA_AVAILABLE' : 'NO_RELEVANT_EVENTS',
    coverageNote: `Queried ${walletsChecked} of ${addrs.length} ${watchlistSource === 'configured' ? 'configured' : 'built-in sample'} watchlist addresses. This is not market-wide positioning coverage.`,
    watchlistSource,
    walletsChecked, walletsRequested: addrs.length,
    evidence: { source: 'hyperliquid clearinghouseState; configured wallet watchlist', observedAt: Date.now(), status: 'live', basis: 'Positions in the queried wallets only; not all market participants' },
    longCount,
    shortCount,
    avgLongNotional: longCount > 0 ? Math.round(totalLongNotional / longCount) : 0,
    avgShortNotional: shortCount > 0 ? Math.round(totalShortNotional / shortCount) : 0,
    totalUnrealizedPnl: Math.round(totalUnrealizedPnl),
    topPositions: topPositions.slice(0, 5)
  };
}

export async function getDeribitMacro(currency = 'BTC', fetchImpl: typeof fetch = fetch): Promise<WhaleOnChainSummary['deribitMacro']> {
  const curr = currency.replace(/USDT?$|USDC$/, '').toUpperCase();
  return fetchDeribitMeasurements(curr, fetchImpl);
}

export async function getWhaleOnChainSummary(symbol: string, fetchImpl: typeof fetch = fetch): Promise<WhaleOnChainSummary> {
  const coin = symbol.replace(/USDT?$|USDC$/, '').toUpperCase();
  const [hlWhales, deribit] = await Promise.all([
    getHyperliquidWhales(coin, undefined, fetchImpl).catch(() => undefined),
    getDeribitMacro(coin === 'ETH' ? 'ETH' : 'BTC', fetchImpl).catch(() => undefined)
  ]);

  return {
    hyperliquidWhales: hlWhales,
    deribitMacro: deribit
  };
}
export const WHALE_UTILS_READY = true;
