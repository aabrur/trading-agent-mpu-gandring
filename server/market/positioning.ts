import type { MeasurementEvidence } from '../types.js';
import { measuredNumber } from './observations.js';

export interface PositioningSummary {
  symbol: string;
  period: string;
  category: string;
  status: 'live' | 'unavailable';
  topTraderStatus: 'live' | 'unavailable' | 'UNCONFIGURED' | 'error';
  longShortRatio: number | null;
  longAccountRatio: number | null;
  shortAccountRatio: number | null;
  topAccountLongShortRatio: number | null;
  topPositionLongShortRatio: number | null;
  openInterestValue: number | null;
  takerBuySellRatio: number | null;
  takerBuyVolume: number | null;
  takerSellVolume: number | null;
  venue: string;
  observedAt: number;
  evidence: Record<string, MeasurementEvidence>;
  venues: Record<string, PositioningVenueSummary>;
}

export interface PositioningVenueSummary {
  symbol: string;
  period: string;
  category: string;
  status: 'live' | 'unavailable' | 'UNCONFIGURED' | 'error';
  longShortRatio: number | null;
  longAccountRatio: number | null;
  shortAccountRatio: number | null;
  topAccountLongShortRatio: number | null;
  topPositionLongShortRatio: number | null;
  openInterestValue: number | null;
  takerBuySellRatio: number | null;
  takerBuyVolume: number | null;
  takerSellVolume: number | null;
  observedAt: number;
  evidence: Record<string, MeasurementEvidence>;
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};

export function summarizeBybitPositioning(payload: unknown, symbol: string, now = Date.now()): PositioningSummary {
  const body = obj(payload), result = obj(body.result);
  const rows = Array.isArray(result.list) ? result.list : [];
  const candidates = rows.map(obj);
  const row = candidates.find(item => item.symbol === symbol) ?? (candidates.length === 1 ? candidates[0] : undefined);
  const longAccountRatio = measuredNumber(row?.buyRatio);
  const shortAccountRatio = measuredNumber(row?.sellRatio);
  const sampleAt = measuredNumber(row?.timestamp);
  const valid = longAccountRatio !== null && shortAccountRatio !== null && longAccountRatio >= 0 && shortAccountRatio > 0
    && longAccountRatio <= 1 && shortAccountRatio <= 1 && sampleAt !== null && sampleAt <= now && now - sampleAt <= 10 * 60_000;
  const ratio = valid ? Number((longAccountRatio! / shortAccountRatio!).toFixed(4)) : null;
  const status = ratio === null ? 'unavailable' : 'live';
  const evidence: Record<string, MeasurementEvidence> = {
    longShortRatio: { source: 'Bybit GET /v5/market/account-ratio; category=linear; period=5min', observedAt: now, status, ...(ratio === null ? { reason: 'No valid fresh account-ratio observation was returned' } : {}), ...(sampleAt !== null ? { sampleAt } : {}) },
    openInterestValue: { source: 'Bybit GET /v5/market/tickers; category=linear', observedAt: now, status: 'unavailable', reason: 'Open interest value is supplied by the derivatives ticker collector' },
    topAccountLongShortRatio: { source: 'Bybit public market data', observedAt: now, status: 'unavailable', reason: 'The Bybit account-ratio endpoint reports global account positioning, not top-trader positioning' },
    topPositionLongShortRatio: { source: 'Bybit public market data', observedAt: now, status: 'unavailable', reason: 'The Bybit account-ratio endpoint reports global account positioning, not top-trader positioning' }
  };
  const venue: PositioningVenueSummary = {
    symbol, period: '5min', category: 'linear', status,
    longShortRatio: ratio,
    longAccountRatio: valid ? longAccountRatio : null,
    shortAccountRatio: valid ? shortAccountRatio : null,
    topAccountLongShortRatio: null,
    topPositionLongShortRatio: null,
    openInterestValue: null,
    takerBuySellRatio: null, takerBuyVolume: null, takerSellVolume: null,
    observedAt: now, evidence
  };
  return { ...venue, status: venue.status === 'live' ? 'live' : 'unavailable', venue: 'bybit', category: 'linear + USD-M Futures', takerBuySellRatio: null, takerBuyVolume: null, takerSellVolume: null, topTraderStatus: 'UNCONFIGURED', venues: { bybit: venue } };
}

export function summarizeBinancePositioning(payload: unknown, symbol: string, now = Date.now()): PositioningVenueSummary {
  const rows = Array.isArray(payload) ? payload.map(obj) : [];
  const row = rows.find(item => item.symbol === symbol) ?? (rows.length === 1 ? rows[0] : undefined);
  const timestamp = measuredNumber(row?.timestamp);
  const longShortRatio = measuredNumber(row?.longShortRatio);
  const longAccountRatio = measuredNumber(row?.longAccount);
  const shortAccountRatio = measuredNumber(row?.shortAccount);
  const valid = timestamp !== null && timestamp <= now && now - timestamp <= 10 * 60_000
    && longShortRatio !== null && longShortRatio > 0 && longAccountRatio !== null && longAccountRatio >= 0 && shortAccountRatio !== null && shortAccountRatio > 0;
  const status = valid ? 'live' : 'unavailable';
  return {
    symbol, period: '5m', category: 'USD-M Futures', status,
    longShortRatio: valid ? longShortRatio : null,
    longAccountRatio: valid ? longAccountRatio : null,
    shortAccountRatio: valid ? shortAccountRatio : null,
    topAccountLongShortRatio: null,
    topPositionLongShortRatio: null,
    openInterestValue: null,
    takerBuySellRatio: null, takerBuyVolume: null, takerSellVolume: null,
    observedAt: now,
    evidence: {
      longShortRatio: { source: 'Binance GET /futures/data/globalLongShortAccountRatio; period=5m', observedAt: now, status, ...(timestamp !== null ? { sampleAt: timestamp } : {}), ...(!valid ? { reason: 'No valid fresh Binance global long/short observation was returned' } : {}) },
      topAccountLongShortRatio: { source: 'Binance GET /futures/data/topLongShortAccountRatio', observedAt: now, status: 'unavailable', reason: 'UNCONFIGURED: not enabled or market-data key not configured; endpoint requires X-MBX-APIKEY' },
      topPositionLongShortRatio: { source: 'Binance GET /futures/data/topLongShortPositionRatio', observedAt: now, status: 'unavailable', reason: 'UNCONFIGURED: not enabled or market-data key not configured; endpoint requires X-MBX-APIKEY' }
    }
  };
}

export async function fetchBybitPositioning(symbol: string, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<PositioningSummary> {
  try {
    const url = `https://api.bybit.com/v5/market/account-ratio?category=linear&symbol=${encodeURIComponent(symbol)}&period=5min&limit=1`;
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (obj(payload).retCode !== 0) throw new Error('Bybit rejected the request');
    return summarizeBybitPositioning(payload, symbol, now);
  } catch {
    return summarizeBybitPositioning({ retCode: -1, result: { list: [] } }, symbol, now);
  }
}

interface EndpointResult { payload: unknown; status: 'live' | 'error'; }

async function fetchBinanceEndpoint(path: string, symbol: string, period: string, fetchImpl: typeof fetch, key?: string): Promise<EndpointResult> {
  const url = `https://fapi.binance.com/futures/data/${path}?symbol=${encodeURIComponent(symbol)}&period=${period}&limit=1`;
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(3000),
      redirect: 'error',
      ...(key ? { headers: { 'X-MBX-APIKEY': key } } : {})
    });
    if (!response.ok) return { payload: null, status: 'error' };
    return { payload: await response.json(), status: 'live' };
  } catch {
    return { payload: null, status: 'error' };
  }
}

function latestRow(payload: unknown, symbol: string): Json | undefined {
  const rows = Array.isArray(payload) ? payload.map(obj) : [];
  return rows.find(row => row.symbol === symbol) ?? (rows.length === 1 ? rows[0] : undefined);
}

function freshTimestamp(row: Json | undefined, now: number): number | null {
  const sampleAt = measuredNumber(row?.timestamp);
  return sampleAt !== null && sampleAt <= now && now - sampleAt <= 10 * 60_000 ? sampleAt : null;
}

export async function fetchPositioning(symbol: string, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<PositioningSummary> {
  const bybitPromise = fetchBybitPositioning(symbol, fetchImpl, now);
  const binanceGlobalPromise = fetchBinanceEndpoint('globalLongShortAccountRatio', symbol, '5m', fetchImpl);
  const takerPromise = fetchBinanceEndpoint('takerlongshortRatio', symbol, '5m', fetchImpl);
  const topEnabled = process.env.BINANCE_TOP_TRADER_ENABLED === 'on';
  const topKey = process.env.BINANCE_MARKET_DATA_API_KEY?.trim() ?? '';
  const topConfigured = topEnabled && topKey.length > 0;
  const [bybit, globalResult, takerResult, accountTopResult, positionTopResult] = await Promise.all([
    bybitPromise,
    binanceGlobalPromise,
    takerPromise,
    topConfigured ? fetchBinanceEndpoint('topLongShortAccountRatio', symbol, '5m', fetchImpl, topKey) : Promise.resolve(null),
    topConfigured ? fetchBinanceEndpoint('topLongShortPositionRatio', symbol, '5m', fetchImpl, topKey) : Promise.resolve(null)
  ]);

  const binance = summarizeBinancePositioning(globalResult.status === 'live' ? globalResult.payload : [], symbol, now);
  const takerRow = latestRow(takerResult.payload, symbol);
  const takerAt = freshTimestamp(takerRow, now);
  const takerBuyVolume = measuredNumber(takerRow?.buyVol);
  const takerSellVolume = measuredNumber(takerRow?.sellVol);
  const reportedTakerRatio = measuredNumber(takerRow?.buySellRatio);
  const validTaker = takerResult.status === 'live' && takerAt !== null && takerBuyVolume !== null && takerBuyVolume >= 0
    && takerSellVolume !== null && takerSellVolume > 0 && reportedTakerRatio !== null && reportedTakerRatio > 0;
  binance.takerBuySellRatio = validTaker ? reportedTakerRatio : null;
  binance.takerBuyVolume = validTaker ? takerBuyVolume : null;
  binance.takerSellVolume = validTaker ? takerSellVolume : null;
  binance.evidence.takerBuySellRatio = {
    source: 'Binance GET /futures/data/takerlongshortRatio; USD-M; period=5m; volumes in provider units',
    observedAt: now, status: validTaker ? 'live' : 'unavailable',
    ...(takerAt !== null ? { sampleAt: takerAt } : {}), ...(!validTaker ? { reason: 'No valid fresh Binance taker volume sample was returned' } : {})
  };

  const topObservations = [
    { name: 'topAccountLongShortRatio', result: accountTopResult, field: 'topAccountLongShortRatio', path: 'topLongShortAccountRatio' },
    { name: 'topPositionLongShortRatio', result: positionTopResult, field: 'topPositionLongShortRatio', path: 'topLongShortPositionRatio' }
  ] as const;
  let topStatus: PositioningSummary['topTraderStatus'] = topConfigured ? 'unavailable' : 'UNCONFIGURED';
  for (const item of topObservations) {
    const row = item.result?.status === 'live' ? latestRow(item.result.payload, symbol) : undefined;
    const sampleAt = freshTimestamp(row, now);
    const value = measuredNumber(row?.longShortRatio);
    const valid = sampleAt !== null && value !== null && value > 0;
    const status = valid ? 'live' : topConfigured ? item.result?.status === 'error' ? 'error' : 'unavailable' : 'unavailable';
    if (status === 'error') topStatus = 'error';
    else if (valid && topStatus !== 'error') topStatus = 'live';
    if (item.field === 'topAccountLongShortRatio') binance.topAccountLongShortRatio = valid ? value : null;
    else binance.topPositionLongShortRatio = valid ? value : null;
    binance.evidence[item.field] = {
      source: `Binance GET /futures/data/${item.path}; USD-M; period=5m`, observedAt: now, status: status === 'error' ? 'unavailable' : status,
      ...(sampleAt !== null ? { sampleAt } : {}),
      ...(!valid ? { reason: !topConfigured
        ? 'UNCONFIGURED: not enabled or market-data key not configured; endpoint requires X-MBX-APIKEY'
        : item.result?.status === 'error' ? 'Top-trader request failed with an HTTP or network error'
          : 'No valid fresh top-trader observation was returned' } : {})
    };
  }
  binance.status = binance.longShortRatio !== null || binance.takerBuySellRatio !== null
    || binance.topAccountLongShortRatio !== null || binance.topPositionLongShortRatio !== null ? 'live' : 'unavailable';
  const evidence = { ...bybit.evidence, ...binance.evidence };
  const anyLive = bybit.status === 'live' || binance.status === 'live';
  return {
    ...bybit,
    status: anyLive ? 'live' : 'unavailable',
    topTraderStatus: topStatus,
    topAccountLongShortRatio: binance.topAccountLongShortRatio,
    topPositionLongShortRatio: binance.topPositionLongShortRatio,
    takerBuySellRatio: binance.takerBuySellRatio,
    takerBuyVolume: binance.takerBuyVolume,
    takerSellVolume: binance.takerSellVolume,
    evidence,
    venues: { ...bybit.venues, binance }
  };
}
