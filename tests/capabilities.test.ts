import { describe, expect, it } from 'vitest';
import { capabilityManifest } from '../server/research/catalog.js';
import { capitalAndSlots } from '../server/collaboration.js';
import { loadConfig } from '../server/config.js';
import { Desk } from '../server/desk.js';
import { makeCaller } from '../server/providers/index.js';

describe('sanitized capability awareness', () => {
  it('does not equate configuration with connectivity or expose credentials', () => {
    const cfg = loadConfig({ TRADING_MODE: 'PAPER', CRYPTOPANIC_API_KEY: 'private-fixture-key', NEWS_PROVIDER: 'cryptopanic' });
    const manifest = capabilityManifest(cfg, null);
    expect(manifest.find(item => item.name === 'cryptopanic')).toMatchObject({ configured: true, status: 'CONFIGURED' });
    expect(manifest.find(item => item.name === 'cryptopanic')?.reachable).toBeUndefined();
    expect(manifest.find(item => item.name === 'coinglass')).toMatchObject({ status: 'NOT_IMPLEMENTED', available: false });
    expect(JSON.stringify(manifest)).not.toContain('private-fixture-key');
  });
  it('requires an actual observation before claiming available data', () => {
    const cfg = loadConfig({ TRADING_MODE: 'PAPER' });
    const now = Date.now();
    const manifest = capabilityManifest(cfg, { symbol: 'SUIUSDT', route: 'PARALLEL', routedBy: 'default', routing: { status: 'not_requested', latencyMs: null, reason: null }, startedAt: now, completedAt: now, feeds: { market: { status: 'available', observedAt: now } } });
    expect(manifest.find(item => item.name === 'market_snapshot')).toMatchObject({ status: 'DATA_AVAILABLE', lastSuccessfulObservation: now });
  });
});

describe('capital versus slots', () => {
  it('uses confirmed venue capital and leaves unknown venue data unknown', () => {
    const cfg = loadConfig({ TRADING_MODE: 'PAPER' });
    const desk = new Desk(cfg, makeCaller(cfg), { reportsDir: null, learningsPath: null, killFile: null, opportunityReviewsPath: null });
    cfg.tradingMode = 'LIVE';
    expect(desk.accountState().hasTradableCapital).toBeNull();
    desk.venueAccount = { equity: 1000, available: 0, unrealized: 0, at: Date.now(), status: 'confirmed', positions: [] };
    expect(desk.accountState().hasTradableCapital).toBe(false);
    desk.venueAccount.available = 100;
    expect(desk.accountState().hasTradableCapital).toBe(true);
    desk.venueAccount.status = 'stale';
    expect(desk.accountState().hasTradableCapital).toBeNull();
  });
  it.each([[true, 0, 2, 2], [true, 2, 2, 0], [false, 0, 2, 2]] as const)('keeps independent dimensions %s %s', (capital, count, max, free) => {
    expect(capitalAndSlots(capital, count, max)).toEqual({ hasTradableCapital: capital, openPositionsCount: count, maxPositions: max, freeSlots: free, canOpenNewSlot: free > 0 });
  });
});
