import type { Candle, MeasurementEvidence, WhaleOnChainSummary } from '../types.js';

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
export const measuredNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};
const round = (value: number) => Math.round(value * 10000) / 10000;
export function closedLiveCandles(candles: Candle[], intervalMs: number, now = Date.now()): Candle[] {
  const valid = candles.filter(candle => [candle.t, candle.o, candle.h, candle.l, candle.c, candle.v].every(Number.isFinite)
    && candle.t > 0 && candle.t + intervalMs <= now && Math.min(candle.o, candle.h, candle.l, candle.c) > 0
    && candle.v >= 0 && candle.h >= Math.max(candle.o, candle.c) && candle.l <= Math.min(candle.o, candle.c))
    .sort((a, b) => a.t - b.t);
  const last = valid.at(-1);
  if (!last || now - (last.t + intervalMs) > 2 * intervalMs) return [];
  let start = valid.length - 1;
  while (start > 0 && valid[start].t - valid[start - 1].t === intervalMs) start--;
  return valid.slice(start);
}
export async function publicJson(url: string, fetchImpl: typeof fetch = fetch): Promise<JsonObject> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw new Error(`Public feed HTTP ${response.status}`);
  const data = object(await response.json());
  if (data.error || (data.retCode !== undefined && data.retCode !== 0)) throw new Error('Public feed rejected the request');
  return data;
}

export function openInterestChanges(rows: unknown[], now = Date.now()) {
  const source = 'bybit /v5/market/open-interest; linear; 5min';
  const points = rows.map(object).map(row => ({ at: measuredNumber(row.timestamp), value: measuredNumber(row.openInterest) }))
    .filter((row): row is { at: number; value: number } => row.at !== null && row.value !== null && row.value >= 0 && row.at <= now && row.at > 0)
    .sort((a, b) => b.at - a.at);
  const latest = points[0];
  const evidence: Record<string, MeasurementEvidence> = {};
  const values = [15, 60, 240].map(minutes => {
    const name = minutes === 15 ? 'oiDelta15mPct' : minutes === 60 ? 'oiDelta1hPct' : 'oiDelta4hPct';
    const baseline = latest && points.find(point => point.at === latest.at - minutes * 60_000);
    const available = !!latest && now - latest.at <= 10 * 60_000 && !!baseline && baseline.value > 0;
    evidence[name] = { source, observedAt: now, status: available ? 'live' : 'unavailable', sampleAt: latest?.at, baselineAt: baseline?.at,
      basis: `Percentage change between recorded OI observations exactly ${minutes} minutes apart`,
      ...(!available ? { reason: 'Fresh observations covering the exact requested horizon are unavailable' } : {}) };
    return available ? round((latest.value / baseline!.value - 1) * 100) : null;
  });
  return { oiDelta15mPct: values[0], oiDelta1hPct: values[1], oiDelta4hPct: values[2], evidence };
}

export async function fetchOpenInterestChanges(symbol: string, fetchImpl: typeof fetch = fetch) {
  const now = Date.now();
  try {
    const data = await publicJson(`https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${encodeURIComponent(symbol)}&intervalTime=5min&limit=50`, fetchImpl);
    const rows = object(data.result).list;
    return openInterestChanges(Array.isArray(rows) ? rows : [], now);
  } catch { return openInterestChanges([], now); }
}

export async function fetchDeribitMeasurements(currency: string, fetchImpl: typeof fetch = fetch): Promise<NonNullable<WhaleOnChainSummary['deribitMacro']>> {
  const now = Date.now();
  const result: NonNullable<WhaleOnChainSummary['deribitMacro']> = { currency, putCallRatioBasis: 'open_interest', dvol: null, putCallRatio: null, indexPrice: null, evidence: {} };
  const request = (method: string, query: string) => publicJson(`https://www.deribit.com/api/v2/public/${method}?${query}`, fetchImpl);
  const tasks = await Promise.allSettled([
    request('get_book_summary_by_currency', `currency=${currency}&kind=option`),
    request('get_volatility_index_data', `currency=${currency}&start_timestamp=${now - 10 * 60_000}&end_timestamp=${now}&resolution=60`),
    request('get_index_price', `index_name=${currency.toLowerCase()}_usd`)
  ]);
  const evidence = result.evidence!;
  for (const [index, name] of ['putCallRatio', 'dvol', 'indexPrice'].entries()) {
    const method = ['get_book_summary_by_currency', 'get_volatility_index_data', 'get_index_price'][index];
    evidence[name] = { source: `deribit public/${method}; ${currency}`, observedAt: now, status: 'unavailable', reason: 'A valid observation was not returned' };
  }
  if (tasks[0].status === 'fulfilled' && Array.isArray(tasks[0].value.result)) {
    let puts = 0, calls = 0, count = 0, valid = true;
    for (const raw of tasks[0].value.result) {
      const row = object(raw);
      const instrument = String(row.instrument_name ?? '');
      if (!instrument.startsWith(`${currency}-`) || !/-[PC]$/.test(instrument)) continue;
      const oi = measuredNumber(row.open_interest);
      if (oi === null || oi < 0) { valid = false; break; }
      if (instrument.endsWith('-P')) puts += oi; else calls += oi;
      count++;
    }
    if (valid && count > 0 && calls > 0) result.putCallRatio = round(puts / calls);
    evidence.putCallRatio.basis = 'Sum of put open interest divided by sum of call open interest across returned options';
  }
  if (tasks[1].status === 'fulfilled') {
    const rows = object(tasks[1].value.result).data;
    const points = Array.isArray(rows) ? rows.filter(Array.isArray).map(row => ({ at: measuredNumber(row[0]), close: measuredNumber(row[4]) }))
      .filter(row => row.at !== null && row.at <= now && now - row.at <= 3 * 60_000 && row.close !== null && row.close >= 0)
      .sort((a, b) => b.at! - a.at!) : [];
    if (points[0]) { result.dvol = points[0].close; evidence.dvol.sampleAt = points[0].at!; }
  }
  if (tasks[2].status === 'fulfilled') {
    const price = measuredNumber(object(tasks[2].value.result).index_price);
    if (price !== null && price > 0) result.indexPrice = price;
  }
  for (const key of ['putCallRatio', 'dvol', 'indexPrice'] as const) {
    if (result[key] !== null) { evidence[key].status = 'live'; delete evidence[key].reason; }
  }
  return result;
}
