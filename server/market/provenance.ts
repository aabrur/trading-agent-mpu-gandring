import { asterBase } from '../exchange/rules.js';
import type { Network } from '../exchange/types.js';
import type { MarketSnapshot } from '../types.js';

type Source = MarketSnapshot['source'];
export interface FeedProvenance {
  requestedVenue: string;
  actualVenue: string | null;
  requestedNetwork: Network;
  network: Network | null;
  endpoint: string | null;
  observedAt: number;
  sourceType: 'native' | 'reference' | 'sample' | 'unavailable';
  availability: 'AVAILABLE' | 'UNAVAILABLE';
  symbol: string;
  instrument: 'perpetual' | 'spot' | 'sample' | 'unknown';
  volumeUnit: 'base_asset' | 'unknown';
}

export function feedProvenance(symbol: string, requested: Source, actual: Source | null, feed: 'candles' | 'ticker' | 'orderbook' | 'trades', network: Network, observedAt: number): FeedProvenance {
  const endpoints: Record<Exclude<Source, 'sample'>, Record<typeof feed, string>> = {
    bybit: { candles: 'https://api.bybit.com/v5/market/kline', ticker: 'https://api.bybit.com/v5/market/tickers', orderbook: 'https://api.bybit.com/v5/market/orderbook', trades: 'https://api.bybit.com/v5/market/recent-trade' },
    binance: { candles: 'https://api.binance.com/api/v3/klines', ticker: 'https://api.binance.com/api/v3/ticker/24hr', orderbook: 'https://fapi.binance.com/fapi/v1/depth', trades: 'https://fapi.binance.com/fapi/v1/aggTrades' },
    aster: { candles: `${asterBase(network)}/fapi/v3/klines`, ticker: `${asterBase(network)}/fapi/v3/ticker/24hr`, orderbook: `${asterBase(network)}/fapi/v3/depth`, trades: `${asterBase(network)}/fapi/v3/aggTrades` },
    hyperliquid: { candles: 'https://api.hyperliquid.xyz/info#candleSnapshot', ticker: 'https://api.hyperliquid.xyz/info#metaAndAssetCtxs', orderbook: 'https://api.hyperliquid.xyz/info#l2Book', trades: '' },
    dydx: { candles: 'https://indexer.dydx.trade/v4/candles/perpetualMarkets', ticker: 'https://indexer.dydx.trade/v4/perpetualMarkets', orderbook: '', trades: '' },
    paradex: { candles: 'https://api.prod.paradex.trade/v1/markets/klines', ticker: 'https://api.prod.paradex.trade/v1/markets/summary', orderbook: '', trades: '' },
    orderly: { candles: 'https://api.orderly.org/v1/tv/history', ticker: 'https://api.orderly.org/v1/public/futures', orderbook: '', trades: '' }
  };
  const available = actual !== null;
  return {
    requestedVenue: requested, actualVenue: actual, requestedNetwork: network,
    network: actual === null || actual === 'sample' ? null : actual === 'aster' ? network : 'mainnet',
    endpoint: actual && actual !== 'sample' ? endpoints[actual][feed] || null : null, observedAt,
    sourceType: actual === null ? 'unavailable' : actual === 'sample' ? 'sample' : actual === requested ? 'native' : 'reference',
    availability: available ? 'AVAILABLE' : 'UNAVAILABLE', symbol,
    instrument: actual === null ? 'unknown' : actual === 'sample' ? 'sample' : actual === 'binance' && (feed === 'candles' || feed === 'ticker') ? 'spot' : 'perpetual',
    volumeUnit: actual && !['sample', 'paradex', 'orderly'].includes(actual) ? 'base_asset' : 'unknown'
  };
}
