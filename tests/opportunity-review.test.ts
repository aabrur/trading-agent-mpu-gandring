import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OpportunityReviews, type ReviewInput } from '../server/opportunity-review';
import { sampleSnapshot } from '../server/market/sample';
const input = (side: 'LONG' | 'SHORT' | null = 'LONG'): ReviewInput => ({ id: 'v1', symbol: 'BTCUSDT', side, reasonKind: 'hold', reason: 'No setup', at: 1000, horizonMs: 60000, reference: { price: 100, source: 'bybit', fetchedAt: 1000, example: false }, evidence: {} });
const snapshot = (price = 102, at = 61000) => ({ ...sampleSnapshot('BTCUSDT'), example: false, source: 'bybit' as const, last: price, fetchedAt: at });
describe('descriptive opportunity review', () => {
  it('reports a newly matured old decision and expires symbols no longer refreshed', () => {
    const store = new OpportunityReviews(null); store.record(input());
    store.observe(snapshot(), 61000);
    expect(store.since(60000)).toHaveLength(1);
    const missing = new OpportunityReviews(null); missing.record(input());
    missing.observe({ ...snapshot(100, 130000), symbol: 'ETHUSDT' }, 130000);
    expect(missing.since(60000)[0].status).toBe('unavailable');
  });
  it('calculates direction without inventing profit and deduplicates verdict ids', () => {
    for (const side of ['LONG', 'SHORT'] as const) {
      const store = new OpportunityReviews(null); store.record(input(side)); store.record(input(side));
      store.observe(snapshot(side === 'LONG' ? 102 : 98), 61000);
      expect(store.since(0)).toHaveLength(1);
      expect(store.since(0)[0]).toMatchObject({ status: 'observed', directionalMovePct: 2 });
      expect(store.since(0)[0]).not.toHaveProperty('realizedPnl');
    }
  });
  it('keeps early observations pending and rejects sample, changed feeds, expired and invalid prices', () => {
    const pending = new OpportunityReviews(null); pending.record(input()); pending.observe(snapshot(102, 60000), 60000);
    expect(pending.since(0)[0].status).toBe('pending');
    for (const snap of [snapshot(NaN), { ...snapshot(), example: true }, { ...snapshot(), source: 'aster' as const }, snapshot(102, 121001)]) {
      const store = new OpportunityReviews(null); store.record(input()); store.observe(snap, snap.fetchedAt);
      expect(store.since(0)[0]).toMatchObject({ status: 'unavailable', directionalMovePct: null });
    }
    const stale = new OpportunityReviews(null); stale.record(input()); stale.observe(snapshot(), 121001);
    expect(stale.since(0)[0].status).toBe('unavailable');
  });
  it('never infers a side and retains only the latest 500 records', () => {
    const store = new OpportunityReviews(null); store.record(input(null)); store.observe(snapshot(), 61000);
    expect(store.since(0)[0].directionalMovePct).toBeNull();
    for (let i = 0; i < 505; i++) store.record({ ...input(), id: 'v' + i });
    expect(store.since(0)).toHaveLength(500);
  });
  it('persists observations without creating duplicates after reload', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mg-opportunity-'));
    try {
      const file = path.join(dir, 'review.json'), first = new OpportunityReviews(file);
      first.record(input()); first.observe(snapshot(), 61000);
      const next = new OpportunityReviews(file); next.record(input());
      expect(next.since(0)).toHaveLength(1); expect(next.since(0)[0].directionalMovePct).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
