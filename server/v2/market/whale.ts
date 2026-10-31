import { safe } from '../../redact.js';
import type { BybitMarketHub } from './bybit.js';

export const KNOWN_ENTITIES: Record<string, string> = {
  binance: 'Binance',
  bybit: 'Bybit',
  coinbase: 'Coinbase',
  okx: 'OKX',
  kraken: 'Kraken',
  tether_treasury: 'Tether Treasury',
  circle: 'Circle',
  bitfinex: 'Bitfinex'
};

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
      interpretation: `Transfer of ${amount.toLocaleString()} ${symbol}${valStr} to ${toEntity}. Implies potential supply or selling pressure.`
    };
  }
  if (fromEx && !toEx) {
    return {
      classification: 'EXCHANGE_OUTFLOW',
      interpretation: `Transfer of ${amount.toLocaleString()} ${symbol}${valStr} out of ${fromEntity} to custody or contract. Implies potential supply withdrawal.`
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
    interpretation: `Transfer of ${amount.toLocaleString()} ${symbol}${valStr} between unverified entities.`
  };
}

export interface ExchangeWhaleTrade {
  venue: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  usdValue: number;
  timestamp: number;
  isLiquidation?: boolean;
}

export interface WhaleIntelligenceReport {
  symbol: string;
  observedAt: number;
  onchain: {
    status: 'DATA_AVAILABLE' | 'NO_RELEVANT_EVENTS' | 'UNCONFIGURED' | 'UNAVAILABLE';
    providerName: string;
    events: NormalizedWhaleEvent[];
    inflowUsdTotal: number;
    outflowUsdTotal: number;
    summary: string;
  };
  exchange: {
    status: 'AVAILABLE' | 'UNAVAILABLE';
    largeTrades: ExchangeWhaleTrade[];
    largeBuyVolumeUsd: number;
    largeSellVolumeUsd: number;
    netWhaleDeltaUsd: number;
    orderbookImbalanceRatio: number | null;
  };
  synthesis: string;
  disclaimer: string;
}

const LARGE_TRADE_USD_THRESHOLD = 50_000;

export async function computeWhaleIntelligence(params: {
  symbol: string;
  apiKey?: string | null;
  fetchImpl?: typeof fetch;
  marketHub?: BybitMarketHub;
}): Promise<WhaleIntelligenceReport> {
  const { symbol, apiKey, fetchImpl = fetch, marketHub } = params;
  const now = Date.now();
  const coin = symbol.replace(/USDT?$|USDC$/, '').toUpperCase();

  let onchainReport: WhaleIntelligenceReport['onchain'] = {
    status: 'UNCONFIGURED',
    providerName: 'Whale Alert API',
    events: [],
    inflowUsdTotal: 0,
    outflowUsdTotal: 0,
    summary: 'Whale Alert key is not configured.'
  };

  if (apiKey && apiKey.trim()) {
    try {
      const minVal = 500_000;
      const startSec = Math.floor((now - 24 * 3600 * 1000) / 1000);
      const url = `https://api.whale-alert.io/v1/transactions?api_key=${encodeURIComponent(apiKey.trim())}&min_value=${minVal}&start=${startSec}&currency=${encodeURIComponent(coin.toLowerCase())}`;
      const res = await fetchImpl(url);
      if (!res.ok) {
        throw new Error(`Whale Alert HTTP ${res.status}`);
      }
      const data = (await res.json()) as { transactions?: any[] };
      const rawTxs: any[] = Array.isArray(data?.transactions) ? data.transactions : [];
      const seen = new Set<string>();

      const events: NormalizedWhaleEvent[] = rawTxs
        .filter((tx: any) => {
          const key = tx?.hash ? String(tx.hash) : '';
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, 10)
        .map((tx: any) => {
          const fromEntity = tx.from?.owner ? String(tx.from.owner) : null;
          const toEntity = tx.to?.owner ? String(tx.to.owner) : null;
          const amt = Number(tx.amount) || null;
          const usd = Number(tx.amount_usd) || null;
          const tsSec = Number(tx.timestamp) || null;
          const { classification, interpretation } = classifyTransfer(fromEntity, toEntity, amt ?? 0, coin, usd);
          const blockNumber = Number(tx.block_number) || null;

          return {
            chainId: String(tx.blockchain ?? 'unknown'),
            txHash: String(tx.hash ?? ''),
            blockNumber,
            timestamp: tsSec ? (tsSec < 1e12 ? tsSec * 1000 : tsSec) : null,
            tokenAddress: tx.token?.address ? String(tx.token.address) : null,
            tokenSymbol: tx.symbol ? String(tx.symbol).toUpperCase() : coin,
            rawAmount: String(tx.amount ?? ''),
            normalizedAmount: amt,
            usdValueOrNull: usd,
            fromAddress: String(tx.from?.address ?? 'unknown'),
            toAddress: String(tx.to?.address ?? 'unknown'),
            fromEntityOrNull: fromEntity,
            toEntityOrNull: toEntity,
            attributionConfidence: fromEntity || toEntity ? 'medium' : 'unknown',
            confirmationStatus: tx.hash && blockNumber != null ? 'confirmed' : 'unverified',
            source: 'whale-alert',
            classification,
            interpretation
          };
        });

      let inflow = 0;
      let outflow = 0;
      for (const ev of events) {
        const usd = ev.usdValueOrNull ?? 0;
        if (ev.classification === 'EXCHANGE_INFLOW') inflow += usd;
        else if (ev.classification === 'EXCHANGE_OUTFLOW') outflow += usd;
      }

      onchainReport = {
        status: events.length > 0 ? 'DATA_AVAILABLE' : 'NO_RELEVANT_EVENTS',
        providerName: 'Whale Alert API',
        events,
        inflowUsdTotal: inflow,
        outflowUsdTotal: outflow,
        summary: events.length > 0
          ? `${events.length} large transfer(s) observed. Top: ${events[0].interpretation}`
          : `No whale-tier transactions (> $500k) observed for ${coin} in the last 24h.`
      };
    } catch (err) {
      onchainReport = {
        status: 'UNAVAILABLE',
        providerName: 'Whale Alert API',
        events: [],
        inflowUsdTotal: 0,
        outflowUsdTotal: 0,
        summary: `Whale Alert query error: ${safe((err as Error).message)}`
      };
    }
  }

  const exchangeTrades: ExchangeWhaleTrade[] = [];
  let largeBuyVol = 0;
  let largeSellVol = 0;
  let imbalance: number | null = null;

  if (marketHub) {
    try {
      const trades = marketHub.recentTrades(symbol) ?? [];
      for (const t of trades) {
        const pNum = Number(t.price);
        const sNum = Number(t.size);
        const usdVal = pNum * sNum;
        if (usdVal >= LARGE_TRADE_USD_THRESHOLD) {
          const side = t.side === 'Buy' ? 'BUY' : 'SELL';
          if (side === 'BUY') largeBuyVol += usdVal;
          else largeSellVol += usdVal;

          exchangeTrades.push({
            venue: 'bybit',
            symbol,
            side,
            price: pNum,
            quantity: sNum,
            usdValue: usdVal,
            timestamp: t.sourceAt || t.observedAt || Date.now()
          });
        }
      }

      const ob = marketHub.orderbook(symbol);
      if (ob && ob.bids.length && ob.asks.length) {
        const topBids = ob.bids.slice(0, 20).reduce((acc: number, b) => acc + (Number(b.price) * Number(b.size)), 0);
        const topAsks = ob.asks.slice(0, 20).reduce((acc: number, a) => acc + (Number(a.price) * Number(a.size)), 0);
        const total = topBids + topAsks;
        imbalance = total > 0 ? (topBids - topAsks) / total : 0;
      }
    } catch {
      // Stream read failure does not break the report
    }
  }

  const netDelta = largeBuyVol - largeSellVol;
  const exchangeReport: WhaleIntelligenceReport['exchange'] = {
    status: marketHub ? 'AVAILABLE' : 'UNAVAILABLE',
    largeTrades: exchangeTrades,
    largeBuyVolumeUsd: largeBuyVol,
    largeSellVolumeUsd: largeSellVol,
    netWhaleDeltaUsd: netDelta,
    orderbookImbalanceRatio: imbalance
  };

  const synthesisParts: string[] = [];
  if (onchainReport.status === 'DATA_AVAILABLE') {
    synthesisParts.push(`On-chain: Inflow $${(onchainReport.inflowUsdTotal / 1e6).toFixed(2)}M, Outflow $${(onchainReport.outflowUsdTotal / 1e6).toFixed(2)}M.`);
  } else {
    synthesisParts.push(`On-chain: ${onchainReport.summary}`);
  }

  if (exchangeReport.status === 'AVAILABLE' && exchangeTrades.length > 0) {
    synthesisParts.push(`Exchange tape: ${exchangeTrades.length} large trade(s) (>= $50k). Net delta: $${(netDelta / 1e3).toFixed(1)}k.`);
  }

  return {
    symbol,
    observedAt: now,
    onchain: onchainReport,
    exchange: exchangeReport,
    synthesis: synthesisParts.join(' '),
    disclaimer: 'Whale transfers and tape blocks represent liquidity shifts and are not proof of execution motive.'
  };
}
