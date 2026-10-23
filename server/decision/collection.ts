import type { JevService } from './jev.js';
import type { MarketSnapshot, NewsItem } from '../types.js';
import type { WhaleBriefing } from '../market/whale.js';

export type CollectionRoute = 'PARALLEL' | 'MARKET_FIRST' | 'NEWS_FIRST' | 'WHALE_FIRST';
const routes: CollectionRoute[] = ['PARALLEL', 'MARKET_FIRST', 'NEWS_FIRST', 'WHALE_FIRST'];
export interface CollectionTrace {
  symbol: string;
  route: CollectionRoute;
  routedBy: 'jev' | 'default';
  routing: { status: 'not_requested' | 'succeeded' | 'failed' | 'low_confidence'; latencyMs: number | null; reason: string | null };
  startedAt: number;
  completedAt: number;
  feeds: Record<string, { status: 'available' | 'unavailable'; observedAt: number; reason?: string }>;
}

/** Jev selects an acquisition priority; code runs every collector and performs all arithmetic. */
export async function collectTradingData(input: {
  symbol: string;
  objective: string;
  jev: JevService;
  live: boolean;
  market: () => Promise<MarketSnapshot>;
  news: () => Promise<NewsItem[]>;
  whale: () => Promise<WhaleBriefing>;
}) {
  const startedAt = Date.now();
  let route: CollectionRoute = 'PARALLEL', routedBy: CollectionTrace['routedBy'] = 'default';
  let routing: CollectionTrace['routing'] = { status: 'not_requested', latencyMs: null, reason: 'Jev collection routing requires LIVE assist' };
  if (input.live && input.jev.settings.effectiveMode === 'assist') {
    const plan = await input.jev.evaluate({ symbol: input.symbol, objective: input.objective.slice(0, 500),
      collectors: ['market: public exchange APIs and measured indicators', 'news: configured provider or public exchange announcements', 'whale: configured on-chain provider'],
      constraints: 'Read data only. Every collector runs. Missing observations stay unavailable. No order or setting changes.' }, {
      acquisition_priority: { type: 'choice', instructions: 'Choose which collector should run first for this research objective. PARALLEL is preferred when no sequential dependency exists. This selects data collection order only.',
        criteria: { PARALLEL: 'Collect all feeds concurrently', MARKET_FIRST: 'Obtain market evidence first', NEWS_FIRST: 'Obtain news context first', WHALE_FIRST: 'Obtain on-chain context first' } }
    }, 15_000, { timeoutMs: input.jev.settings.assistBudgetMs });
    const answer = plan.response?.answers.acquisition_priority;
    if (plan.ok && answer?.type === 'choice' && answer.confidence >= 0.7 && routes.includes(answer.choice as CollectionRoute)) {
      route = answer.choice as CollectionRoute; routedBy = 'jev';
      routing = { status: 'succeeded', latencyMs: plan.latencyMs, reason: null };
    } else {
      routing = { status: plan.ok ? 'low_confidence' : 'failed', latencyMs: plan.latencyMs, reason: plan.error ?? 'No applicable acquisition priority met the configured confidence threshold' };
    }
  }
  const jobs = { market: input.market, news: input.news, whale: input.whale };
  type Feed = keyof typeof jobs;
  const first: Feed | null = route === 'MARKET_FIRST' ? 'market' : route === 'NEWS_FIRST' ? 'news' : route === 'WHALE_FIRST' ? 'whale' : null;
  // Settle optional collectors independently: an absent whale service must not invent a zero reading.
  let firstResult: PromiseSettledResult<unknown> | undefined;
  if (first) [firstResult] = await Promise.allSettled([jobs[first]()]);
  const [marketResult, newsResult, whaleResult] = await Promise.all([
    first === 'market' ? Promise.resolve(firstResult as PromiseSettledResult<MarketSnapshot>) : settle(input.market),
    first === 'news' ? Promise.resolve(firstResult as PromiseSettledResult<NewsItem[]>) : settle(input.news),
    first === 'whale' ? Promise.resolve(firstResult as PromiseSettledResult<WhaleBriefing>) : settle(input.whale)
  ]);
  if (marketResult.status === 'rejected') throw new Error('Live market collector unavailable; analysis cannot proceed on sample data.');
  if (input.live && marketResult.value.example) throw new Error('Sample market observations are forbidden in live collection.');
  const news = newsResult.status === 'fulfilled' ? newsResult.value.filter(item => !input.live || !item.example) : [];
  const whale = whaleResult.status === 'fulfilled' ? whaleResult.value : {
    symbol: input.symbol, providerStatus: 'UNAVAILABLE' as const, providerName: 'Whale Alert', events: [], summary: 'On-chain provider unavailable', observedAt: Date.now(), disclaimer: 'Do not infer wallet activity from missing observations.'
  };
  const trace: CollectionTrace = { symbol: input.symbol, route, routedBy, routing, startedAt, completedAt: Date.now(), feeds: {
    market: { status: 'available', observedAt: marketResult.value.fetchedAt },
    news: { status: news.length ? 'available' : 'unavailable', observedAt: Date.now(), ...(!news.length ? { reason: 'No relevant live news items were returned' } : {}) },
    whale: { status: whale.providerStatus === 'CONFIGURED_LIVE' ? 'available' : 'unavailable', observedAt: whale.observedAt,
      ...(whale.providerStatus !== 'CONFIGURED_LIVE' ? { reason: whale.providerStatus } : {}) }
  } };
  return { market: marketResult.value, news, whale, trace };
}

async function settle<T>(job: () => Promise<T>): Promise<PromiseSettledResult<T>> {
  try { return { status: 'fulfilled', value: await job() }; } catch (reason) { return { status: 'rejected', reason }; }
}
