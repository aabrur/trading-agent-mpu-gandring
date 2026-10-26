import { describe, it, expect } from 'vitest';
import { BybitAdapter } from '../server/exchange/bybit';
import { AsterAdapter } from '../server/exchange/aster';
const result = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
describe('read-only financial history', () => {
  it('paginates independent Bybit sources and rejects a repeated cursor', async () => {
    let repeated = false; const calls: string[] = [];
    const fetcher = (async (url: string) => {
      const u = new URL(url); calls.push(u.pathname);
      const list = u.pathname.includes('query-api') ? { userID: 12 } : u.pathname.includes('execution/list') ? { list: [], nextPageCursor: !u.searchParams.has('cursor') || repeated ? 'next' : '' } : { list: [], nextPageCursor: '' };
      return result({ retCode: 0, result: list });
    }) as typeof fetch;
    const adapter = new BybitAdapter('testnet', 'key', 'secret', fetcher);
    const first = await adapter.financialHistory({ since: 1000, until: 2000 });
    expect(first.complete).toBe(false);
    const second = await adapter.financialHistory({ since: 1000, until: 2000, cursor: first.nextCursor! });
    expect(second.complete).toBe(true);
    expect(calls.filter((p) => p.includes('transaction-log'))).toHaveLength(1);
    repeated = true;
    await expect(adapter.financialHistory({ since: 1000, until: 2000, cursor: first.nextCursor! })).rejects.toThrow('Repeated');
  });
  it('handles null nextPageCursor returned by Bybit transaction-log on the final page', async () => {
    const fetcher = (async (url: string) => {
      const u = new URL(url);
      if (u.pathname.includes('query-api')) return result({ retCode: 0, result: { userID: 12 } });
      if (u.pathname.includes('execution/list')) return result({ retCode: 0, result: { list: [], nextPageCursor: '' } });
      return result({ retCode: 0, result: { list: [], nextPageCursor: null } });
    }) as typeof fetch;
    const adapter = new BybitAdapter('testnet', 'key', 'secret', fetcher);
    const res = await adapter.financialHistory({ since: 1000, until: 2000 });
    expect(res.complete).toBe(true);
  });
  it('Aster saturation remains incomplete and missing numeric evidence is rejected', async () => {
    let malformed = false;
    const fetcher = (async () => result(malformed ? [{ incomeType: 'FUNDING_FEE', tranId: '1', symbol: 'BTCUSDT', asset: 'USDT', time: 1500 }] : Array.from({ length: 1000 }, (_, i) => ({ incomeType: 'FUNDING_FEE', tranId: String(i), symbol: 'BTCUSDT', asset: 'USDT', time: 1500, income: '0' })))) as typeof fetch;
    const adapter = new AsterAdapter('testnet', '0x1111111111111111111111111111111111111111', '0x' + '11'.repeat(32), fetcher);
    expect((await adapter.financialHistory({ since: 1000, until: 2000 })).complete).toBe(false);
    malformed = true;
    await expect(adapter.financialHistory({ since: 1000, until: 2000 })).rejects.toThrow();
  });
  it('Bybit keeps signed funding, currency and cursors without guessing side', async () => {
    const calls: string[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      expect(init?.method).toBe('GET'); const u = new URL(url); calls.push(u.pathname);
      if (u.pathname.includes('query-api')) return result({ retCode: 0, result: { userID: 123 } });
      if (u.pathname.includes('execution/list')) return result({ retCode: 0, result: { nextPageCursor: '', list: [{ symbol: 'BTCUSDT', execId: 'e1', orderId: 'o1', orderLinkId: 'client', execQty: '1', execPrice: '100', execTime: '1500', execType: 'Trade', execFee: '0.1', feeCurrency: 'USDT' }] } });
      return result({ retCode: 0, result: { nextPageCursor: '', list: [{ id: 't1', type: 'SETTLEMENT', symbol: 'BTCUSDT', transactionTime: '1600', funding: '-2', currency: 'USDT' }, { id: 't2', tradeId: 'e1', type: 'TRADE', symbol: 'BTCUSDT', transactionTime: '1500', fee: '-0.1', cashFlow: '0', currency: 'USDT' }] } });
    }) as typeof fetch;
    const page = await new BybitAdapter('testnet', 'test-key', 'test-secret', fetcher).financialHistory({ since: 1000, until: 2000 });
    expect(page.complete).toBe(true); expect(page.accountScope).not.toContain('123');
    expect(page.records.find((r) => r.kind === 'funding')).toMatchObject({ amount: -2, currency: 'USDT' });
    expect(page.records.find((r) => r.kind === 'fee')).toMatchObject({ amount: -0.1 });
    expect(page.records.find((r) => r.kind === 'fill')).toMatchObject({ side: null });
    expect(calls).not.toContain('/v5/order/create');
  });
  it('Aster reads income fees with their sign and only requested symbols', async () => {
    const fetcher = (async (url: string, init?: RequestInit) => {
      expect(init?.method).toBe('GET'); const u = new URL(url);
      if (u.pathname.endsWith('/income')) return result([{ incomeType: 'COMMISSION', tranId: '1', tradeId: 'f1', symbol: 'BTCUSDT', income: '-0.2', asset: 'USDT', time: 1500 }, { incomeType: 'FUNDING_FEE', tranId: '2', symbol: 'BTCUSDT', income: '3', asset: 'USDT', time: 1600 }]);
      expect(u.searchParams.get('symbol')).toBe('BTCUSDT');
      return result([{ id: 'f1', orderId: 'o1', symbol: 'BTCUSDT', qty: '1', price: '100', realizedPnl: '0', positionSide: 'BOTH', time: 1500 }]);
    }) as typeof fetch;
    const a = new AsterAdapter('testnet', '0x1111111111111111111111111111111111111111', '0x' + '11'.repeat(32), fetcher);
    const page = await a.financialHistory({ since: 1000, until: 2000, symbols: ['BTCUSDT'] });
    expect(page.records.find((r) => r.kind === 'fee')).toMatchObject({ amount: 0.2 });
    expect(page.records.find((r) => r.kind === 'fill')).toMatchObject({ side: null, fee: { amount: 0.2, currency: 'USDT' } });
  });
  it('rejects malformed or missing history instead of claiming zero', async () => {
    const fetcher = (async (url: string) => result({ retCode: 0, result: url.includes('query-api') ? { userID: 123 } : {} })) as typeof fetch;
    await expect(new BybitAdapter('testnet', 'key', 'secret', fetcher).financialHistory({ since: 1000, until: 2000 })).rejects.toThrow();
  });
});
