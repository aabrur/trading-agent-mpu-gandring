import { httpJson, type FetchLike, type Network } from './types.js';

/**
 * Instrument rules as the exchange publishes them. The sizer uses these numbers and nothing guessed:
 * lot step and minimum quantity, price tick, minimum notional (qty * price) and the venue's taker fee.
 */
export interface InstrumentRules {
  symbol: string;
  qtyStep: number;
  minQty: number;
  maxQty: number | null;
  tickSize: number;
  /** Minimum order value in quote (qty * price). null when the venue publishes none. */
  minNotional: number | null;
  /** Venue base taker fee as a fraction (0.0004 = 0.04%). null when unknown. */
  takerFee: number | null;
  status: string | null;
  source: string;
  fetchedAt: number;
}

export const RULES_TTL_MS = 5 * 60_000;
export type RulesCache = Map<string, { at: number; rules: InstrumentRules }>;
const shared: RulesCache = new Map();
const inflight = new Map<string, Promise<InstrumentRules>>();

/** Caches rules briefly (default 5 min) so a burst of tickets does not hammer exchangeInfo. */
export async function cachedRules(key: string, load: () => Promise<InstrumentRules>, store: RulesCache = shared, ttlMs = RULES_TTL_MS): Promise<InstrumentRules> {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.rules;
  const pending = store === shared ? inflight.get(key) : undefined;
  if (pending) return pending;
  const p = load().then((rules) => { store.set(key, { at: Date.now(), rules }); return rules; });
  if (store === shared) { inflight.set(key, p); void p.catch(() => {}).finally(() => inflight.delete(key)); }
  return p;
}
export function clearRulesCache() { shared.clear(); inflight.clear(); }

// Aster docs (Fees page, checked 2026-10-17): Crypto General perps 0.04% taker, Group B 0.1% taker. VIP tiers only lower these.
export const ASTER_TAKER_FEE = 0.0004;
export const ASTER_GROUP_B_TAKER_FEE = 0.001;
const ASTER_GROUP_B = new Set(['1000NEXUSDT', 'AEONUSDT', 'ASTEROIDUSDT', 'AVLUSDT', 'BAYUSDT', 'BASECATUSDT', 'BLENDUSDT', 'B3USDT', 'CARDSUSDT', 'CATEUSDT', 'DELTAUSDT', 'FONEUSDT', 'MEMEUSDT', 'MARSCOINUSDT', 'NESUSDT', 'OUSDT', 'OKBUSDT', 'PENGUINUSDT', 'PUNDIAIUSDT', 'RTXUSDT', 'SKHYNIXUSDT']);
export const asterTakerFee = (symbol: string) => (ASTER_GROUP_B.has(symbol) ? ASTER_GROUP_B_TAKER_FEE : ASTER_TAKER_FEE);

/**
 * Reads Binance-style exchangeInfo filters (Aster and Binance futures use the same shape).
 * Market entries must satisfy both LOT_SIZE and MARKET_LOT_SIZE, so the stricter of the two wins.
 */
export function rulesFromExchangeInfo(info: any, symbol: string, source: string, takerFee: number | null): InstrumentRules {
  const s = info?.symbols?.find((x: any) => x.symbol === symbol);
  if (!s) throw new Error(`${source}: unknown symbol ${symbol}`);
  const f = (t: string) => (s.filters ?? []).find((x: any) => x.filterType === t);
  const lots = [f('LOT_SIZE'), f('MARKET_LOT_SIZE')].filter(Boolean);
  if (!lots.length) throw new Error(`${source}: ${symbol} has no LOT_SIZE filter`);
  const px = f('PRICE_FILTER');
  const mn = f('MIN_NOTIONAL');
  const steps = lots.map((l: any) => Number(l.stepSize)).filter((v) => v > 0);
  const mins = lots.map((l: any) => Number(l.minQty)).filter((v) => v >= 0);
  const maxs = lots.map((l: any) => Number(l.maxQty)).filter((v) => v > 0);
  const qtyStep = Math.max(...steps);
  const tickSize = Number(px?.tickSize);
  if (!(qtyStep > 0) || !(tickSize > 0)) throw new Error(`${source}: ${symbol} lot step or tick size missing`);
  const minNotionalRaw = Number(mn?.notional ?? mn?.minNotional);
  return {
    symbol, qtyStep, minQty: Math.max(qtyStep, ...mins), maxQty: maxs.length ? Math.min(...maxs) : null, tickSize,
    minNotional: minNotionalRaw > 0 ? minNotionalRaw : null, takerFee, status: s.status ?? null, source, fetchedAt: Date.now()
  };
}

const ASTER_BASE: Record<Network, string> = { mainnet: 'https://fapi.asterdex.com', testnet: 'https://fapi.asterdex-testnet.com' };
export function asterBase(network: Network) { return process.env[network === 'testnet' ? 'ASTER_TESTNET_BASE_URL' : 'ASTER_BASE_URL'] || ASTER_BASE[network]; }

/** Public Aster rules (no key needed). Cached for RULES_TTL_MS. */
export function asterRules(symbol: string, network: Network = 'mainnet', fetchImpl: FetchLike = fetch, base = asterBase(network), store: RulesCache = shared): Promise<InstrumentRules> {
  return cachedRules(`aster:${base}:${symbol}`, async () => rulesFromExchangeInfo(await httpJson(fetchImpl, `${base}/fapi/v3/exchangeInfo`), symbol, `aster ${base}/fapi/v3/exchangeInfo`, asterTakerFee(symbol)), store);
}

/** Public rules for venues we can read without a key. Returns null for venues without a public reader here. */
export async function publicRules(venue: string | null | undefined, symbol: string, network: Network = 'mainnet', fetchImpl: FetchLike = fetch): Promise<InstrumentRules | null> {
  if (venue === 'aster') return asterRules(symbol, network, fetchImpl);
  return null;
}

/**
 * Rules for a live adapter: its own instrumentRules() when it has one, otherwise the plain instrument()
 * (lot step, min qty, tick, and the venue minimum notional when it publishes one). No venue fee here (TAKER_FEE applies).
 */
export async function adapterRules(adapter: { name: string; instrument(symbol: string): Promise<{ qtyStep: number; minQty: number; tickSize: number; minNotional?: number | null; maxQty?: number | null; status?: string | null }>; instrumentRules?(symbol: string): Promise<InstrumentRules> }, symbol: string): Promise<InstrumentRules> {
  if (adapter.instrumentRules) return adapter.instrumentRules(symbol);
  const i = await adapter.instrument(symbol);
  const mn = Number(i.minNotional);
  return { symbol, qtyStep: i.qtyStep, minQty: i.minQty, maxQty: i.maxQty != null && i.maxQty > 0 ? i.maxQty : null, tickSize: i.tickSize, minNotional: mn > 0 ? mn : null, takerFee: null, status: i.status ? String(i.status).toUpperCase() : null, source: `${adapter.name} instrument()`, fetchedAt: Date.now() };
}
