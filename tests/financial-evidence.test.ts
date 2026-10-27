import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FinancialEvidence } from '../server/live/financial-evidence';
import type { FinancialPage } from '../server/exchange/types';
import type { ExecutionIntent } from '../server/live/journal';
import { PaperBook } from '../server/paper';
import { LiveExecutor } from '../server/live/executor';
import { MemoryAdapter } from './fakes';
import { Desk } from '../server/desk';
import { loadConfig } from '../server/config';
import { makeCaller } from '../server/providers/index';
import { buildReport, Reporter } from '../server/reports';
const empty = (): FinancialPage => ({ accountScope: 'scope-a', records: [], nextCursor: null, complete: true, supported: ['fills', 'fees', 'funding'] });
const window = { since: 1000, until: 2000 };
describe('financial evidence ledger', () => {
  it('captures the report book before awaiting read-only history', async () => {
    const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample' });
    const desk = new Desk(cfg, makeCaller(cfg), { reportsDir: null });
    let release!: () => void;
    vi.spyOn(desk, 'refreshFinancialEvidence').mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const before = desk.book.balance, work = new Reporter(desk, null).generate();
    desk.book.balance += 5;
    release(); const report = await work;
    expect(report.balance).toBe(before);
    expect(desk.book.balance).toBe(before + 5);
  });
  it('invalidates existing complete coverage when pagination changes account', async () => {
    let page = 0;
    const a = empty(); a.records = [{ kind: 'fee', id: 'old', symbol: 'BTCUSDT', amount: 3, currency: 'USDT', at: 1500 }];
    const adapter = Object.assign(new MemoryAdapter(), { financialHistory: async () => ++page === 1 ? { ...empty(), complete: false, nextCursor: 'next' } : { ...empty(), accountScope: 'scope-b' } });
    const executor = new LiveExecutor(adapter, 0); executor.financialEvidence.ingest(a, window);
    await executor.refreshFinancialEvidence(1000, 2000);
    expect(executor.financialEvidence.summary(1000, 2000)).toMatchObject({ coverage: 'unsupported', accountScope: null, actualFees: null });
    executor.financialEvidence.ingest(a, window);
    expect(executor.financialEvidence.summary(1000, 2000).actualFees).toBeNull();
  });
  it('uses unmatched fill fees and never turns unknown or foreign-currency fill fees into zero', () => {
    const page = empty();
    page.records = [{ kind: 'fill', id: 'f', orderId: 'o', symbol: 'BTCUSDT', side: null, qty: 1, price: 100, fee: { amount: 0.5, currency: 'USDT' }, realizedPnl: null, at: 1500 }];
    const e = new FinancialEvidence(null); e.ingest(page, window);
    expect(e.summary(1000, 2000).actualFees).toBe(0.5);
    page.records[0].fee = null; e.ingest(page, window); expect(e.summary(1000, 2000).actualFees).toBeNull();
    page.records[0].fee = { amount: 0.001, currency: 'BTC' }; e.ingest(page, window); expect(e.summary(1000, 2000).actualFees).toBeNull();
    page.records.push({ kind: 'fee', id: 'linked', tradeId: 'f', symbol: 'BTCUSDT', amount: 0.5, currency: 'USDT', at: 1500 });
    e.ingest(page, window); expect(e.summary(1000, 2000).actualFees).toBe(0.5);
  });
  it('coalesces history reads without holding an exchange order behind them', async () => {
    let release!: (p: FinancialPage) => void, calls = 0, historyResolved = false;
    const adapter = Object.assign(new MemoryAdapter(), { financialHistory: async () => { calls++; return new Promise<FinancialPage>((r) => { release = r; }); } });
    const executor = new LiveExecutor(adapter, 0);
    const first = executor.refreshFinancialEvidence(1000, 2000).then(() => { historyResolved = true; });
    const second = executor.refreshFinancialEvidence(1000, 2000);
    const fill = await executor.open({ symbol: 'BTCUSDT', side: 'LONG', qty: 0.001, stop: 59000, tp: null, leverage: 2 });
    expect(fill.ok).toBe(true); expect(historyResolved).toBe(false); expect(calls).toBe(1); expect(adapter.placed).toHaveLength(1);
    release(empty()); await first; await second;
  });
  it('adds account evidence to reports without changing the book or day baseline', () => {
    const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample' });
    const executor = new LiveExecutor(new MemoryAdapter(), 0), desk = new Desk(cfg, makeCaller(cfg), { executor, reportsDir: null });
    const p = empty(); p.records = [{ kind: 'fee', id: 'cost', symbol: 'BTCUSDT', amount: 1, currency: 'USDT', at: 1500 }];
    executor.financialEvidence.ingest(p, window);
    const before = { balance: desk.book.balance, day: structuredClone(desk.day), closed: structuredClone(desk.book.closed) };
    const report = buildReport(desk, 999, 2000);
    expect(report.accounting?.actualFees).toBe(1);
    expect({ balance: desk.book.balance, day: desk.day, closed: desk.book.closed }).toEqual(before);
  });
  it('confirms net only for an exactly matched complete lifecycle without ambiguous funding', () => {
    const book = new PaperBook(1000, 200, 4, 0.001);
    const p = book.open({ symbol: 'BTCUSDT', side: 'LONG', qty: 1, entry: 100, stop: 98, tp: 104, margin: 50, leverage: 2 });
    const t = book.close(p.id, 110, 'test')!; t.closedAt = 1600;
    const before = structuredClone(book.closed);
    const intents: ExecutionIntent[] = (['open', 'close'] as const).map((kind, i) => ({ clientId: 'c' + i, symbol: p.symbol, side: 'LONG', kind, requestedQty: 1, positionId: p.id, accountedQty: 1, accountedValue: i ? 110 : 100, record: { clientId: 'c' + i, orderId: 'o' + i, status: 'filled', filledQty: 1, avgPrice: i ? 110 : 100 }, at: i ? 1600 : 1100 }));
    const page = empty();
    page.records = [0, 1].flatMap((i) => [
      { kind: 'fill' as const, id: 'f' + i, symbol: p.symbol, orderId: 'o' + i, side: null, qty: 1, price: i ? 110 : 100, fee: { amount: 0.5, currency: 'USDT' }, realizedPnl: { amount: i ? 10 : 0, currency: 'USDT' }, at: i ? 1600 : 1100 },
      { kind: 'fee' as const, id: 'fee' + i, tradeId: 'f' + i, symbol: p.symbol, amount: 0.5, currency: 'USDT', at: i ? 1600 : 1100 }
    ]);
    const e = new FinancialEvidence(null); e.ingest(page, window); e.attribute(intents, [t]);
    expect(e.summary(1000, 2000)).toMatchObject({ confirmedNetRealized: 9, slippage: 0, expectancyUsdt: 9 });
    expect(book.closed).toEqual(before);
    page.records.push({ kind: 'funding', id: 'fund', symbol: p.symbol, amount: -1, currency: 'USDT', at: 1400 });
    e.ingest(page, window); e.attribute(intents, [t]);
    expect(e.summary(1000, 2000)).toMatchObject({ confirmedNetRealized: 8, slippage: 0, expectancyUsdt: 8, funding: -1 });
    page.records[page.records.length - 1].currency = 'BTC';
    e.ingest(page, window); e.attribute(intents, [t]);
    expect(e.summary(1000, 2000).confirmedNetRealized).toBeNull();
    e.attribute([], [t]); expect(e.summary(1000, 2000).confirmedNetRealized).toBeNull();
  });
  it('distinguishes unsupported, partial, complete zero and signed account totals', () => {
    const e = new FinancialEvidence(null);
    expect(e.summary(1000, 2000).actualFees).toBeNull();
    e.ingest({ ...empty(), complete: false }, window);
    expect(e.summary(1000, 2000)).toMatchObject({ coverage: 'partial', actualFees: null });
    const page = empty();
    page.records = [{ kind: 'fee', id: 'fee1', symbol: 'BTCUSDT', amount: -0.1, currency: 'USDT', at: 1500 }, { kind: 'funding', id: 'f1', symbol: 'BTCUSDT', amount: -2, currency: 'USDT', at: 1600 }];
    e.ingest(page, window); e.ingest(page, window);
    expect(e.summary(1000, 2000)).toMatchObject({ coverage: 'complete', actualFees: -0.1, funding: -2, confirmedNetRealized: null });
    expect(e.summary(1000, 2001).actualFees).toBeNull();
    const zero = new FinancialEvidence(null); zero.ingest(empty(), window);
    expect(zero.summary(1000, 2000)).toMatchObject({ actualFees: 0, funding: 0 });
  });
  it('preserves currency and invalidates current summaries on account mismatch', () => {
    const e = new FinancialEvidence(null), p = empty();
    p.records = [{ kind: 'fee', id: 'btcfee', symbol: 'BTCUSDT', amount: 0.1, currency: 'BTC', at: 1500 }];
    e.ingest(p, window); expect(e.summary(1000, 2000).actualFees).toBeNull();
    expect(() => e.ingest({ ...empty(), accountScope: 'scope-b' }, window)).toThrow();
    expect(e.summary(1000, 2000)).toMatchObject({ coverage: 'unsupported', actualFees: null });
  });
  it('deduplicates across restart without mutating a stored trade book', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mg-financial-'));
    try {
      const file = path.join(dir, 'evidence.json'), e = new FinancialEvidence(file), p = empty();
      p.records = [{ kind: 'fee', id: 'fee1', symbol: 'BTCUSDT', amount: 1, currency: 'USDT', at: 1500 }];
      e.ingest(p, window);
      const next = new FinancialEvidence(file); next.ingest(p, window);
      expect(next.summary(1000, 2000).actualFees).toBe(1);
      expect(next.summary(1000, 2000).confirmedNetRealized).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
