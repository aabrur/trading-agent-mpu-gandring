import { createHmac } from 'node:crypto';
import { historyObject, historyRows, historyText, historyScope, historyWindow, bybitIncome, bybitFills } from './financial-history.js';
import type { FinancialQuery, FinancialPage } from './types.js';
import { ExchangeError, httpJson, floorStep, roundTick, type ExchangeAdapter, type FetchLike, type Network, type PermissionReport, type PlaceOrder, type OrderRecord, type VenuePosition, type Side, type Protection, type ProtectRequest } from './types.js';

// Bybit v5, USDT linear perpetuals, one-way mode. Docs: https://bybit-exchange.github.io/docs/v5/intro
export class BybitAdapter implements ExchangeAdapter {
  readonly name = 'bybit' as const;
  /** The stop is attached to the position on Bybit's side (stopLoss on the order, tpslMode Full). */
  readonly exchangeStops = true;
  private base: string;
  private recvWindow = '5000';
  private financialScope: string | null = null;
  async financialHistory(q: FinancialQuery): Promise<FinancialPage> {
    historyWindow(q);
    if (!this.financialScope) this.financialScope = historyScope(this.name, this.network, historyObject(await this.req('GET', '/v5/user/query-api')).userID);
    const c = q.cursor ? JSON.parse(q.cursor) as { fills?: string; income?: string; fillsDone?: boolean; incomeDone?: boolean } : {};
    const params = { category: 'linear', startTime: q.since, endTime: q.until };
    const [fills, income] = await Promise.all([
      c.fillsDone ? Promise.resolve({ list: [], nextPageCursor: '' }) : this.req('GET', '/v5/execution/list', { ...params, cursor: c.fills, limit: 100 }),
      c.incomeDone ? Promise.resolve({ list: [], nextPageCursor: '' }) : this.req('GET', '/v5/account/transaction-log', { ...params, accountType: 'UNIFIED', cursor: c.income, limit: 50 })
    ]);
    const f = historyObject(fills), i = historyObject(income);
    if (typeof f.nextPageCursor !== 'string' || typeof i.nextPageCursor !== 'string') throw new Error('Missing financial history cursor');
    if (f.nextPageCursor && f.nextPageCursor === c.fills || i.nextPageCursor && i.nextPageCursor === c.income) throw new Error('Repeated financial history cursor');
    const records = bybitIncome(historyRows(i.list));
    const complete = !f.nextPageCursor && !i.nextPageCursor;
    return { accountScope: this.financialScope, records: [...records, ...bybitFills(historyRows(f.list), records)], complete, supported: ['fills', 'fees', 'funding'], nextCursor: complete ? null : JSON.stringify({ fills: f.nextPageCursor, income: i.nextPageCursor, fillsDone: !f.nextPageCursor, incomeDone: !i.nextPageCursor }) };
  }
  constructor(public readonly network: Network, private key: string, private secret: string, private fetchImpl: FetchLike = fetch) {
    if (!key || !secret) throw new ExchangeError('Bybit key and secret are required');
    this.base = network === 'testnet' ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
  }

  private async req(method: 'GET' | 'POST', path: string, params: Record<string, string | number | boolean | undefined> = {}) {
    const ts = Date.now().toString();
    const defined = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));
    const query = method === 'GET' ? new URLSearchParams(Object.fromEntries(Object.entries(defined).map(([k, v]) => [k, String(v)]))).toString() : '';
    const body = method === 'POST' ? JSON.stringify(defined) : '';
    const sign = createHmac('sha256', this.secret).update(ts + this.key + this.recvWindow + (method === 'GET' ? query : body)).digest('hex');
    const json = await httpJson(this.fetchImpl, `${this.base}${path}${query ? `?${query}` : ''}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-BAPI-API-KEY': this.key, 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': this.recvWindow, 'X-BAPI-SIGN': sign },
      body: method === 'POST' ? body : undefined
    });
    if (json?.retCode !== 0) throw new ExchangeError(`bybit ${path}: ${json?.retMsg ?? 'error'} (${json?.retCode})`, json?.retCode);
    return json.result;
  }

  async ping() {
    const r = await this.req('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' });
    return { ok: true, detail: `wallet readable, ${r?.list?.length ?? 0} account(s)` };
  }

  async permissions(): Promise<PermissionReport> {
    const r = await this.req('GET', '/v5/user/query-api');
    const wallet: string[] = r?.permissions?.Wallet ?? [];
    const canWithdraw = wallet.includes('Withdraw');
    const trade = [...(r?.permissions?.ContractTrade ?? []), ...(r?.permissions?.Derivatives ?? [])];
    const canTrade = r?.readOnly === 0 && trade.length > 0;
    const notes = [canWithdraw ? 'key HAS withdraw permission' : 'no withdraw permission', canTrade ? 'can trade contracts' : 'cannot trade contracts (read only or no ContractTrade)'];
    if (wallet.some((w) => w !== 'Withdraw')) notes.push(`wallet transfer permissions present: ${wallet.filter((w) => w !== 'Withdraw').join(', ')}`);
    if (!r?.ips?.length) notes.push('no IP whitelist set (recommended)');
    return { ok: !canWithdraw, canWithdraw, canTrade, verified: true, detail: notes.join('; ') };
  }

  async balance() {
    const r = await this.req('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' });
    const acc = r?.list?.[0];
    if (acc?.totalEquity == null || acc?.totalAvailableBalance == null || !Number.isFinite(Number(acc.totalEquity)) || !Number.isFinite(Number(acc.totalAvailableBalance))) throw new ExchangeError('bybit: incomplete account balance response');
    const equityUsdt = Number(acc.totalEquity ?? 0);
    let availableUsdt = Number(acc.totalAvailableBalance ?? 0);
    if (availableUsdt <= 0 && equityUsdt > 0 && !(Number(acc.totalInitialMargin ?? 0) > 0)) {
      const usdtCoin = Array.isArray(acc.coin) ? acc.coin.find((c: Record<string, unknown>) => c?.coin === 'USDT') : null;
      const coinFree = usdtCoin ? Math.max(0, Number(usdtCoin.walletBalance ?? 0) - Number(usdtCoin.totalPositionIM ?? 0) - Number(usdtCoin.totalOrderIM ?? 0) - Number(usdtCoin.locked ?? 0)) : 0;
      const walletFree = Math.max(0, Number(acc.totalMarginBalance || acc.totalWalletBalance || 0) - Number(acc.totalInitialMargin || 0));
      availableUsdt = coinFree > 0 ? coinFree : walletFree > 0 ? walletFree : equityUsdt;
    }
    return { equityUsdt, availableUsdt };
  }

  async instrument(symbol: string) {
    const r = await this.req('GET', '/v5/market/instruments-info', { category: 'linear', symbol });
    const i = r?.list?.[0];
    if (!i) throw new ExchangeError(`bybit: unknown symbol ${symbol}`);
    const mn = Number(i.lotSizeFilter.minNotionalValue), mx = Number(i.lotSizeFilter.maxMktOrderQty ?? i.lotSizeFilter.maxOrderQty);
    return { symbol, qtyStep: Number(i.lotSizeFilter.qtyStep), minQty: Number(i.lotSizeFilter.minOrderQty), tickSize: Number(i.priceFilter.tickSize), minNotional: mn > 0 ? mn : null, maxQty: mx > 0 ? mx : null, status: i.status ?? null };
  }

  async ticker(symbol: string) {
    const r = await httpJson(this.fetchImpl, `${this.base}/v5/market/tickers?category=linear&symbol=${symbol}`);
    const px = Number(r?.result?.list?.[0]?.lastPrice);
    if (!px) throw new ExchangeError(`bybit: no price for ${symbol}`);
    return px;
  }

  async placeOrder(o: PlaceOrder) {
    const ins = await this.instrument(o.symbol);
    const qty = floorStep(o.qty, ins.qtyStep);
    if (qty < ins.minQty) throw new ExchangeError(`size ${qty} is under the minimum ${ins.minQty}`);
    if (!(o.stop > 0)) throw new ExchangeError('refusing an order without a stop loss');
    try {
      await this.req('POST', '/v5/position/set-leverage', { category: 'linear', symbol: o.symbol, buyLeverage: String(o.leverage), sellLeverage: String(o.leverage) });
    } catch (e) { if ((e as ExchangeError).code !== 110043) throw e; } // 110043 = leverage not modified
    const r = await this.req('POST', '/v5/order/create', {
      category: 'linear', symbol: o.symbol, side: o.side === 'LONG' ? 'Buy' : 'Sell', orderType: 'Market', qty: String(qty),
      stopLoss: String(roundTick(o.stop, ins.tickSize)), takeProfit: o.tp ? String(roundTick(o.tp, ins.tickSize)) : undefined,
      tpslMode: 'Full', slTriggerBy: 'MarkPrice', tpTriggerBy: 'MarkPrice', positionIdx: 0, orderLinkId: o.clientId
    });
    return { orderId: r?.orderId ?? null };
  }

  async getOrder(symbol: string, clientId: string): Promise<OrderRecord> {
    let row = (await this.req('GET', '/v5/order/realtime', { category: 'linear', symbol, orderLinkId: clientId }))?.list?.[0];
    if (!row) row = (await this.req('GET', '/v5/order/history', { category: 'linear', symbol, orderLinkId: clientId }))?.list?.[0];
    if (!row) return { clientId, orderId: '', status: 'unknown', filledQty: 0, avgPrice: null };
    const map: Record<string, OrderRecord['status']> = { Filled: 'filled', PartiallyFilled: 'partial', PartiallyFilledCanceled: 'cancelled', New: 'open', Created: 'open', Untriggered: 'open', Rejected: 'rejected', Cancelled: 'cancelled', Deactivated: 'cancelled' };
    return { clientId, orderId: row.orderId, status: map[row.orderStatus] ?? 'unknown', filledQty: Number(row.cumExecQty ?? 0), avgPrice: Number(row.avgPrice) || null, raw: row.orderStatus };
  }

  async positions(symbol?: string): Promise<VenuePosition[]> {
    const result: VenuePosition[] = [];
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const response = await this.req('GET', '/v5/position/list', { category: 'linear', symbol, settleCoin: symbol ? undefined : 'USDT', cursor });
      if (!Array.isArray(response?.list)) throw new ExchangeError('bybit: incomplete position response');
      for (const p of response.list as Record<string, unknown>[]) {
        const qty = Number(p.size);
        if (!Number.isFinite(qty) || qty < 0) throw new ExchangeError('bybit: invalid position quantity');
        if (!qty) continue;
        if (p.side !== 'Buy' && p.side !== 'Sell') throw new ExchangeError('bybit: invalid position side');
        result.push({ symbol: String(p.symbol), side: p.side === 'Buy' ? 'LONG' : 'SHORT', qty, entry: Number(p.avgPrice), stop: Number(p.stopLoss) || null, tp: Number(p.takeProfit) || null, unrealizedPnl: p.unrealisedPnl == null ? NaN : Number(p.unrealisedPnl) });
      }
      cursor = response.nextPageCursor || undefined;
      if (cursor && cursors.has(cursor)) throw new ExchangeError('bybit: repeated position page');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return result;
  }

  async closePosition(symbol: string, side: Side, qty: number, clientId: string) {
    const r = await this.req('POST', '/v5/order/create', { category: 'linear', symbol, side: side === 'LONG' ? 'Sell' : 'Buy', orderType: 'Market', qty: String(qty), reduceOnly: true, positionIdx: 0, orderLinkId: clientId });
    return { orderId: r?.orderId ?? null };
  }

  async cancelAll(symbol: string) {
    await this.req('POST', '/v5/order/cancel-all', { category: 'linear', symbol });
  }

  async protection(symbol: string, side: Side): Promise<Protection> {
    const p = (await this.positions(symbol)).find((x) => x.side === side);
    return { stop: p?.stop ?? null, tp: p?.tp ?? null };
  }

  /** Sets the position stop loss / take profit on Bybit itself. */
  async protect(p: ProtectRequest) {
    if (!p.stop && !p.tp) return;
    const ins = await this.instrument(p.symbol);
    await this.req('POST', '/v5/position/trading-stop', {
      category: 'linear', symbol: p.symbol, tpslMode: 'Full', positionIdx: 0,
      stopLoss: p.stop ? String(roundTick(p.stop, ins.tickSize)) : undefined, slTriggerBy: p.stop ? 'MarkPrice' : undefined,
      takeProfit: p.tp ? String(roundTick(p.tp, ins.tickSize)) : undefined, tpTriggerBy: p.tp ? 'MarkPrice' : undefined
    });
  }
}
