import { afterEach, expect, it, vi } from 'vitest';
import { getSnapshot } from '../server/market/index.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it.each([false, true])('T9 Aster snapshot with reference depth fallback=%s preserves per-field provenance', async partial => {
  vi.stubEnv('COINMARKETCAP_API_KEY', ''); vi.stubEnv('CMC_API_KEY', '');
  const now = Date.now();
  const bars = Array.from({ length: 80 }, (_, i) => [now - (81-i)*900_000, '108', '109', '107', '108', '10']);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input), json = (body: unknown) => new Response(JSON.stringify(body));
    if (url.includes('asterdex.com') && url.includes('/ticker/24hr')) return json({ lastPrice: '108', priceChangePercent: '1' });
    if (url.includes('asterdex.com') && url.includes('/klines')) return json(bars);
    if (url.includes('asterdex.com') && url.includes('/premiumIndex')) return json({ lastFundingRate: '.0001' });
    if (url.includes('asterdex.com') && url.includes('/depth')) return partial ? new Response('unavailable', { status: 503 }) : json({ bids: [['107.9', '2']], asks: [['108.1', '2']] });
    if (url.includes('asterdex.com') && url.includes('/aggTrades')) return json([{ a: 1, p: '108', q: '1', T: Date.now() - 5000, m: false }]);
    if (url.includes('bybit.com') && url.includes('/orderbook')) return json({ retCode: 0, result: { b: [['107.9', '2']], a: [['108.1', '2']] } });
    return new Response('fixture unavailable', { status: 503 });
  }));
  const snapshot = await getSnapshot('BTCUSDT', 'aster', true);
  expect(snapshot).toMatchObject({ source: 'aster', example: false, dataProvenance: { requestedVenue: 'aster', actualVenue: 'aster', symbolMapping: { transformed: false } } });
  expect(snapshot.orderbook).toMatchObject({ requestedVenue: 'aster', actualDataVenue: partial ? 'bybit' : 'aster', dataType: partial ? 'external_proxy' : 'native' });
  expect(snapshot.orderflow).toMatchObject({ requestedVenue: 'aster', actualDataVenue: 'aster', dataType: 'native' });
});
