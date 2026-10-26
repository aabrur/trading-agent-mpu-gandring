import { describe, expect, it, vi } from 'vitest';
import { gb } from '../cli/gb.js';

const env = { APP_MODE: 'grokbot', TRADING_MODE: 'PAPER' };
function backend(body: unknown, status = 200) {
  return vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

describe('Grok Bot shared engine access', () => {
  it('preserves evidence availability and safely encodes objectives', async () => {
    const evidence = { ok: true, dataStatus: 'UNAVAILABLE', data: { items: [] }, observedAt: 123 };
    const fetchImpl = backend(evidence);
    const r = await gb(['research', 'market_news', 'BTCUSDT', '--objective', 'news & name=desk_account'], { env, fetchImpl });
    expect(r.data).toEqual(evidence);
    const url = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(url.searchParams.get('name')).toBe('market_news');
    expect(url.searchParams.get('objective')).toBe('news & name=desk_account');
  });

  it('does not disguise denied research as success or substitute offline data', async () => {
    const fetchImpl = backend({ ok: false, error: 'local clients only' }, 403);
    expect((await gb(['research', 'market_snapshot', 'BTCUSDT'], { env, fetchImpl })).ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown tools, unimplemented strategies and invalid simulation inputs before calling the server', async () => {
    const fetchImpl = backend({ ok: true });
    for (const args of [['research', 'execute_order', 'BTCUSDT'], ['backtest', 'BTCUSDT', '--strategy', 'mean_reversion'], ['backtest', 'BTCUSDT', '--leverage', 'NaN'], ['backtest', 'BTCUSDT', '--capital', '0']]) {
      expect((await gb(args, { env, fetchImpl })).ok).toBe(false);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends simulation parameters only to the existing backtest endpoint', async () => {
    const fetchImpl = backend({ ok: true, metrics: { trades: 0 } });
    const r = await gb(['backtest', 'BTCUSDT', '--capital', '500', '--slippage-bps', '7', '--leverage', '2'], { env, fetchImpl });
    expect(r.ok).toBe(true);
    expect(String(fetchImpl.mock.calls[0][0])).toMatch(/\/api\/research\/backtest$/);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({ symbol: 'BTCUSDT', strategy: 'simple_momentum', initialCapital: 500, slippageBps: 7, maxLeverage: 2 });
    expect(r.text).toContain('Simulation only');
  });

  it('never presents a numeric stop as confirmed protection', async () => {
    const fetchImpl = backend({ paper: { positions: [{ symbol: 'BTCUSDT', stop: 50000 }] } });
    const r = await gb(['positions'], { env, fetchImpl });
    expect(r.data).toMatchObject([{ protectionStatus: 'unknown' }]);
    expect(r.text).toContain('protection unknown');
  });

  it('reads capabilities and context without mutating the desk', async () => {
    for (const command of ['health', 'context', 'capabilities', 'reports']) {
      const fetchImpl = backend({ ok: true });
      expect((await gb([command], { env, fetchImpl })).ok).toBe(true);
      expect(fetchImpl.mock.calls[0][1]?.method).toBe('GET');
      expect(fetchImpl.mock.calls[0][1]?.body).toBeUndefined();
    }
  });
});
