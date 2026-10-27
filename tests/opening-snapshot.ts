import { vi } from 'vitest';
import type { MarketSnapshot } from '../server/types.js';

/** A complete LONG pullback the debate contract can approve. Sample candles alone no longer open. */
export function openingSnapshot(symbol = 'ETHUSDT'): MarketSnapshot {
  return {
    symbol, source: 'bybit', example: false, last: 108, bid: 108, ask: 108,
    change24hPct: 1, fundingRate: null, fetchedAt: Date.now(),
    candles: Array.from({ length: 80 }, (_, i) => ({ t: Date.now() - (81 - i) * 900_000, o: 100 + i * 0.1, c: 100 + i * 0.1, h: 100.1 + i * 0.1, l: 99.9 + i * 0.1, v: 100 })),
    tacticalTradePlan: {
      symbol, timestamp: Date.now(), marketRegime: 'STRONG_UPTREND',
      scenarios: [{ id: 'duration-pullback', kind: 'PULLBACK_CONTINUATION', side: 'LONG', entryZone: { low: 107, high: 109, basis: 'observed pullback support' }, invalidationLevel: 100, target1: 120, target2: 130, evidence: ['closed-bar structure'], missingEvidence: [] }],
      exhaustion: { present: false, direction: 'NONE', evidence: [] }
    }
  };
}

type ResearchDesk = {
  collectResearchData: (symbol: string) => Promise<unknown>;
  marketSnapshot: (symbol: string) => Promise<MarketSnapshot>;
};

export function armOpening(desk: ResearchDesk, adapter?: { ticker: (symbol: string) => Promise<number>; fillAt: (o: { side: string; stop: number }) => number; closeAt: () => number }) {
  const snapshot = openingSnapshot();
  if (adapter) {
    vi.spyOn(adapter, 'ticker').mockResolvedValue(108);
    adapter.fillAt = () => 108;
    adapter.closeAt = () => 108;
  }
  vi.spyOn(desk, 'collectResearchData').mockImplementation(async () => ({
    market: snapshot, news: [],
    whale: { symbol: snapshot.symbol, providerStatus: 'UNAVAILABLE', providerName: 'Fixture', events: [], summary: 'Optional provider unavailable.', observedAt: Date.now(), disclaimer: 'No flow inferred.' },
    trace: { symbol: snapshot.symbol, route: 'PARALLEL', routedBy: 'default', routing: { status: 'not_requested', latencyMs: null, reason: 'offline fixture' }, startedAt: Date.now(), completedAt: Date.now(), feeds: {} }
  }));
  vi.spyOn(desk, 'marketSnapshot').mockImplementation(async () => snapshot);
  return snapshot;
}
