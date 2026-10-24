import type { MeasurementEvidence } from '../types.js';

export interface NormalizedTrade {
  id: string;
  time: number;
  price: number;
  quantity: number;
  takerSide: 'Buy' | 'Sell';
}

export interface FlowWindow {
  windowMs: number;
  startAt: number | null;
  endAt: number | null;
  coverageMs: number;
  coveragePct: number;
  partial: boolean;
  tradesCount: number;
  takerBuyVol: number;
  takerSellVol: number;
  delta: number;
  cumulativeDelta: number;
  buySellRatio: number | null;
}

export interface DepthBand {
  bidVolume: number;
  askVolume: number;
  imbalance: number;
  coveredPct: number;
  levels: number;
  complete: boolean;
}

export interface LiquidityChanges {
  addedBidVolume: number;
  removedBidVolume: number;
  addedAskVolume: number;
  removedAskVolume: number;
  observedAt: number;
}

export interface DepthCoverageSummary {
  bidObservedCoveragePct: number;
  askObservedCoveragePct: number;
  maxObservedCoveragePct: number;
  liquidityChanges: LiquidityChanges | null;
}

export interface NormalizedTradeInput {
  id?: string | number | null;
  time: unknown;
  price: unknown;
  quantity: unknown;
  takerSide: unknown;
  tie?: number;
}

const WINDOWS = { '1m': 60_000, '5m': 300_000, '15m': 900_000 } as const;
const round = (value: number, digits = 8) => Number(value.toFixed(digits));
const number = (value: unknown) => typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;

export function normalizeTrades(rows: NormalizedTradeInput[]): NormalizedTrade[] {
  const normalized = rows.flatMap((row, tie) => {
    const time = number(row.time), price = number(row.price), quantity = number(row.quantity);
    const takerSide = row.takerSide;
    if (!Number.isFinite(time) || time <= 0 || !Number.isFinite(price) || price <= 0 || !Number.isFinite(quantity) || quantity <= 0 || (takerSide !== 'Buy' && takerSide !== 'Sell')) return [];
    return [{ id: String(row.id ?? `${time}:${price}:${quantity}:${takerSide}`), time, price, quantity, takerSide: takerSide as 'Buy' | 'Sell', tie: row.tie ?? tie }];
  });
  normalized.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id, undefined, { numeric: true }) || a.tie - b.tie);
  const seen = new Set<string>();
  return normalized.filter(({ id, time }) => {
    const key = id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(({ tie: _tie, ...trade }) => trade);
}

interface FlowState {
  trades: Map<string, NormalizedTrade>;
  coverageSpans: Array<[number, number]>;
  previousBatchKeys: Set<string>;
  lastPollAt: number | null;
  previousBatchLatestAt: number | null;
  previousBatchEmpty: boolean;
  truncatedBefore: number | null;
}
const flowHistory = new Map<string, FlowState>();
const tradeLimits = new Map<string, number>();

export function tradeRequestLimit(historyKey: string): number { return tradeLimits.get(historyKey) ?? 100; }
export function noteTradeRequest(historyKey: string, returned: number, limit: number): void {
  const next = returned >= limit ? Math.min(1000, limit * 2) : returned < limit / 2 ? Math.max(50, Math.ceil(returned / 50) * 50) : limit;
  tradeLimits.set(historyKey, next);
  if (tradeLimits.size > 200) tradeLimits.delete(tradeLimits.keys().next().value!);
}

export function summarizeOrderflow(
  incoming: NormalizedTradeInput[],
  options: { now?: number; observedAt?: number; venue: string; sourceEndpoint?: string; actualDataVenue?: string; dataType?: string; historyKey?: string; emptyActivity?: boolean }
) {
  const now = options.now ?? Date.now();
  const observedAt = options.observedAt ?? now;
  const incomingTrades = normalizeTrades(incoming).filter(trade => trade.time <= observedAt);
  const historyKey = options.historyKey ?? `${options.actualDataVenue ?? options.venue}:${options.venue}`;
  const state = flowHistory.get(historyKey) ?? { trades: new Map<string, NormalizedTrade>(), coverageSpans: [], previousBatchKeys: new Set<string>(), lastPollAt: null, previousBatchLatestAt: null, previousBatchEmpty: false, truncatedBefore: null };
  const batchKeys = new Set(incomingTrades.map(t => t.id));
  const overlapsPrevious = [...batchKeys].some(id => state.previousBatchKeys.has(id));
  const latestIncomingAt = incomingTrades.at(-1)?.time ?? null;
  const latestIsFresh = latestIncomingAt !== null && observedAt - latestIncomingAt >= 0 && observedAt - latestIncomingAt <= 30_000;
  const hasNewerTrade = state.previousBatchLatestAt !== null && incomingTrades.some(trade => !state.previousBatchKeys.has(trade.id) && trade.time > state.previousBatchLatestAt!);
  if (options.emptyActivity && state.lastPollAt !== null && observedAt > state.lastPollAt && observedAt - state.lastPollAt <= 120_000) {
    state.coverageSpans.push([state.lastPollAt, observedAt]);
  } else if (state.previousBatchEmpty && latestIsFresh && state.lastPollAt !== null && latestIncomingAt! > state.lastPollAt && latestIncomingAt! - state.lastPollAt <= 120_000) {
    state.coverageSpans.push([state.lastPollAt, latestIncomingAt!]);
  } else if (overlapsPrevious && hasNewerTrade && latestIsFresh && state.lastPollAt !== null && state.previousBatchLatestAt !== null
    && latestIncomingAt! > Math.max(state.previousBatchLatestAt, state.lastPollAt) && observedAt - state.lastPollAt <= 120_000) {
    state.coverageSpans.push([Math.max(state.previousBatchLatestAt, state.lastPollAt), latestIncomingAt!]);
  }
  if (incomingTrades.length || options.emptyActivity) {
    state.previousBatchKeys = batchKeys;
    state.previousBatchLatestAt = latestIncomingAt;
    state.previousBatchEmpty = options.emptyActivity === true && incomingTrades.length === 0;
    state.lastPollAt = observedAt;
  }
  state.coverageSpans = state.coverageSpans.filter(([start, end]) => end >= now - 15 * 60_000 && end <= now).slice(-300);
  for (const trade of incomingTrades) if (!state.trades.has(trade.id)) state.trades.set(trade.id, trade);
  for (const [id, trade] of state.trades) if (trade.time < now - 15 * 60_000) state.trades.delete(id);
  while (state.trades.size > 5000) {
    const oldestKey = state.trades.keys().next().value!;
    const removed = state.trades.get(oldestKey)!;
    state.trades.delete(oldestKey);
    state.truncatedBefore = Math.max(state.truncatedBefore ?? 0, removed.time);
  }
  flowHistory.delete(historyKey);
  flowHistory.set(historyKey, state);
  while (flowHistory.size > 100) flowHistory.delete(flowHistory.keys().next().value!);

  const allTrades = [...state.trades.values()].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  const makeWindow = (windowMs: number): FlowWindow => {
    const startAt = now - windowMs;
    const trades = allTrades.filter(t => t.time >= startAt && t.time <= now);
    const takerBuyVol = trades.filter(t => t.takerSide === 'Buy').reduce((sum, t) => sum + t.quantity, 0);
    const takerSellVol = trades.filter(t => t.takerSide === 'Sell').reduce((sum, t) => sum + t.quantity, 0);
    const spans = state.coverageSpans.map(([start, end]) => [Math.max(startAt, start), Math.min(now, end)] as [number, number]).filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
    let coverageMs = 0, coveredUntil = startAt;
    for (const [start, end] of spans) { const nextStart = Math.max(start, coveredUntil); if (end > nextStart) coverageMs += end - nextStart; coveredUntil = Math.max(coveredUntil, end); }
    coverageMs = Math.min(windowMs, coverageMs);
    if (state.truncatedBefore !== null && state.truncatedBefore > startAt) coverageMs = Math.min(coverageMs, Math.max(0, now - state.truncatedBefore));
    const delta = takerBuyVol - takerSellVol;
    return {
      windowMs, startAt: trades[0]?.time ?? null, endAt: trades.at(-1)?.time ?? null,
      coverageMs, coveragePct: round(coverageMs / windowMs * 100, 2), partial: coverageMs < windowMs * 0.95,
      tradesCount: trades.length, takerBuyVol: round(takerBuyVol), takerSellVol: round(takerSellVol),
      delta: round(delta), cumulativeDelta: round(delta), buySellRatio: takerSellVol > 0 ? round(takerBuyVol / takerSellVol, 4) : null
    };
  };
  const oneMin = makeWindow(WINDOWS['1m']);
  const takerBuyVol = oneMin.takerBuyVol, takerSellVol = oneMin.takerSellVol;
  const prices = allTrades.filter(t => t.time >= now - WINDOWS['1m'] && t.time <= now);
  const priceDelta = prices.length > 1 ? prices.at(-1)!.price - prices[0].price : 0;
  const delta = takerBuyVol - takerSellVol;
  const result: {
    evidence: MeasurementEvidence; requestedVenue: string; actualDataVenue: string; dataType: string; sourceEndpoint?: string;
    takerBuyVol: number; takerSellVol: number; cvdDelta: number; buySellRatio: number | null; deltaDivergence: boolean;
    tradesCount: number; rollingWindows: Record<'1m'|'5m'|'15m', FlowWindow>;
  } = {
    evidence: { source: options.sourceEndpoint ?? options.actualDataVenue ?? options.venue, observedAt, status: incomingTrades.length || options.emptyActivity ? 'live' : 'unavailable', basis: 'Chronological deduplicated public trades; rolling coverage requires advancing overlapping trade timestamps or a valid empty-activity response', ...(!incomingTrades.length && !options.emptyActivity ? { reason: 'No valid fresh trade records were returned' } : {}) },
    requestedVenue: options.venue, actualDataVenue: options.actualDataVenue ?? options.venue,
    dataType: options.dataType ?? (options.actualDataVenue && options.actualDataVenue !== options.venue ? 'external_proxy' : 'native'),
    ...(options.sourceEndpoint ? { sourceEndpoint: options.sourceEndpoint } : {}),
    takerBuyVol, takerSellVol, cvdDelta: round(delta),
    buySellRatio: takerSellVol > 0 ? round(takerBuyVol / takerSellVol, 4) : null,
    deltaDivergence: prices.length >= 10 && ((priceDelta > 0 && delta < 0) || (priceDelta < 0 && delta > 0)),
    tradesCount: oneMin.tradesCount,
    rollingWindows: { '1m': oneMin, '5m': makeWindow(WINDOWS['5m']), '15m': makeWindow(WINDOWS['15m']) }
  };
  return result;
}

interface BookState { bids: [number, number][]; asks: [number, number][]; midPrice: number; }
const bookHistory = new Map<string, BookState>();

export function summarizeDepth(
  bids: [number, number][], asks: [number, number][], midPrice: number,
  options: { historyKey?: string; observedAt?: number } = {}
): { depthBands: Record<'0.5%'|'1.0%'|'2.0%', DepthBand> } & DepthCoverageSummary {
  const bands = [0.5, 1, 2] as const;
  const depthBands = Object.fromEntries(bands.map(percent => {
    const fraction = percent / 100;
    const bidRange = midPrice * fraction, askRange = midPrice * fraction;
    const bidLevels = bids.filter(([price, size]) => price <= midPrice && price >= midPrice - bidRange && size > 0);
    const askLevels = asks.filter(([price, size]) => price >= midPrice && price <= midPrice + askRange && size > 0);
    const bidVolume = bidLevels.reduce((sum, [, size]) => sum + size, 0);
    const askVolume = askLevels.reduce((sum, [, size]) => sum + size, 0);
    const bidReach = bids.length ? Math.max(0, Math.min(1, (midPrice - Math.min(...bids.map(([p]) => p))) / bidRange)) : 0;
    const askReach = asks.length ? Math.max(0, Math.min(1, (Math.max(...asks.map(([p]) => p)) - midPrice) / askRange)) : 0;
    const coveredPct = round(Math.min(bidReach, askReach) * 100, 2);
    return [`${percent.toFixed(1)}%`, { bidVolume: round(bidVolume), askVolume: round(askVolume), imbalance: bidVolume + askVolume > 0 ? round(bidVolume / (bidVolume + askVolume), 4) : 0.5, coveredPct, levels: bidLevels.length + askLevels.length, complete: coveredPct >= 99.9 }];
  })) as Record<'0.5%'|'1.0%'|'2.0%', DepthBand>;
  const bidObservedCoveragePct = round(Math.max(0, (midPrice - Math.min(...bids.map(([price]) => price))) / midPrice * 100), 4);
  const askObservedCoveragePct = round(Math.max(0, (Math.max(...asks.map(([price]) => price)) - midPrice) / midPrice * 100), 4);
  let liquidityChanges: LiquidityChanges | null = null;
  const { historyKey, observedAt = Date.now() } = options;
  if (historyKey) {
    const previous = bookHistory.get(historyKey);
    if (previous) {
      const bidLow = Math.max(Math.min(...bids.map(([price]) => price)), Math.min(...previous.bids.map(([price]) => price)));
      const bidHigh = Math.min(Math.max(...bids.map(([price]) => price)), Math.max(...previous.bids.map(([price]) => price)));
      const askLow = Math.max(Math.min(...asks.map(([price]) => price)), Math.min(...previous.asks.map(([price]) => price)));
      const askHigh = Math.min(Math.max(...asks.map(([price]) => price)), Math.max(...previous.asks.map(([price]) => price)));
      if (bidLow <= bidHigh && askLow <= askHigh) {
        const changes = (current: [number, number][], prior: [number, number][], low: number, high: number) => {
          let added = 0, removed = 0;
          const priorByPrice = new Map(prior.filter(([price]) => price >= low && price <= high).map(([price, size]) => [price, size]));
          for (const [price, size] of current) {
            if (price < low || price > high || !priorByPrice.has(price)) continue;
            const change = size - priorByPrice.get(price)!;
            if (change > 0) added += change; else removed -= change;
          }
          return { added: round(added), removed: round(removed) };
        };
        const bidChange = changes(bids, previous.bids, bidLow, bidHigh);
        const askChange = changes(asks, previous.asks, askLow, askHigh);
        liquidityChanges = {
          addedBidVolume: bidChange.added, removedBidVolume: bidChange.removed,
          addedAskVolume: askChange.added, removedAskVolume: askChange.removed, observedAt
        };
      }
    }
    bookHistory.delete(historyKey);
    bookHistory.set(historyKey, { bids: bids.map(row => [...row] as [number, number]), asks: asks.map(row => [...row] as [number, number]), midPrice });
    while (bookHistory.size > 100) bookHistory.delete(bookHistory.keys().next().value!);
  }
  return { depthBands, bidObservedCoveragePct, askObservedCoveragePct, maxObservedCoveragePct: Math.min(bidObservedCoveragePct, askObservedCoveragePct), liquidityChanges };
}

export function clearFlowHistoryForTest() { flowHistory.clear(); tradeLimits.clear(); bookHistory.clear(); }
