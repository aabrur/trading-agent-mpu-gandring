import { createHmac } from 'node:crypto';
import { ExchangeError, httpJson, floorStep, roundTick, type ExchangeAdapter, type FetchLike, type Network, type PermissionReport, type PlaceOrder, type OrderRecord, type VenuePosition, type Side } from './types.js';

// EXPERIMENTAL, UNTESTED against a real account. OKX USDT swaps, net mode, cross margin.
// Testnet means OKX demo trading (same host, x-simulated-trading header, demo keys).
const instId = (symbol: string) => `${symbol.replace(/USDT$/, '')}-USDT-SWAP`;

export class OkxAdapter implements ExchangeAdapter {
  readonly name = 'okx' as const;
  private ctVal = new Map<string, number>();
  constructor(public readonly network: Network, private key: string, private secret: string, private passphrase: string, private fetchImpl: FetchLike = fetch) {
    if (!key || !secret || !passphrase) throw new ExchangeError('OKX key, secret and passphrase are required');
  }
  private async req(method: 'GET' | 'POST', path: string, params: Record<string, unknown> | unknown[] = {}) {
    const defined = Array.isArray(params) ? params : Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));
    const query = method === 'GET' && !Array.isArray(defined) && Object.keys(defined).length ? `?${new URLSearchParams(defined as Record<string, string>)}` : '';
    const body = method === 'POST' ? JSON.stringify(defined) : '';
    const ts = new Date().toISOString();
    const sign = createHmac('sha256', this.secret).update(ts + method + path + query + body).digest('base64');
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'OK-ACCESS-KEY': this.key, 'OK-ACCESS-SIGN': sign, 'OK-ACCESS-TIMESTAMP': ts, 'OK-ACCESS-PASSPHRASE': this.passphrase };
    if (this.network === 'testnet') headers['x-simulated-trading'] = '1';
    const json = await httpJson(this.fetchImpl, `https://www.okx.com${path}${query}`, { method, headers, body: body || undefined });
    if (json?.code !== '0') throw new ExchangeError(`okx ${path}: ${json?.msg || json?.data?.[0]?.sMsg || 'error'} (${json?.code})`, json?.code);
    return json.data;
  }
  async ping() { await this.req('GET', '/api/v5/account/balance', { ccy: 'USDT' }); return { ok: true, detail: 'account balance readable' }; }
  async permissions(): Promise<PermissionReport> {
    const d = (await this.req('GET', '/api/v5/account/config'))?.[0] ?? {};
    const perm = String(d.perm ?? '');
    const canWithdraw = perm.includes('withdraw');
    return { ok: !canWithdraw, canWithdraw, canTrade: perm.includes('trade'), verified: true, detail: `perm: ${perm || 'unknown'}${d.ip ? '' : '; no IP whitelist (recommended)'}` };
  }
  async balance() {
    const d = (await this.req('GET', '/api/v5/account/balance', { ccy: 'USDT' }))?.[0] ?? {};
    const usdt = (d.details ?? []).find((x: any) => x.ccy === 'USDT') ?? {};
    return { equityUsdt: Number(d.totalEq ?? 0), availableUsdt: Number(usdt.availEq ?? usdt.availBal ?? 0) };
  }
  async instrument(symbol: string) {
    const i = (await this.req('GET', '/api/v5/public/instruments', { instType: 'SWAP', instId: instId(symbol) }))?.[0];
    if (!i) throw new ExchangeError(`okx: unknown symbol ${symbol}`);
    const ct = Number(i.ctVal); this.ctVal.set(symbol, ct);
    // qty in coins: one contract = ctVal coins
    return { symbol, qtyStep: Number(i.lotSz) * ct, minQty: Number(i.minSz) * ct, tickSize: Number(i.tickSz) };
  }
  async ticker(symbol: string) { const d = await this.req('GET', '/api/v5/market/ticker', { instId: instId(symbol) }); const px = Number(d?.[0]?.last); if (!px) throw new ExchangeError('okx: no price'); return px; }
  private async contracts(symbol: string, qty: number) {
    const ins = await this.instrument(symbol);
    const coins = floorStep(qty, ins.qtyStep);
    if (coins < ins.minQty) throw new ExchangeError(`size ${coins} is under the minimum ${ins.minQty}`);
    return { sz: String(Number((coins / this.ctVal.get(symbol)!).toFixed(8))), ins };
  }
  async placeOrder(o: PlaceOrder) {
    if (!(o.stop > 0)) throw new ExchangeError('refusing an order without a stop loss');
    const { sz, ins } = await this.contracts(o.symbol, o.qty);
    await this.req('POST', '/api/v5/account/set-leverage', { instId: instId(o.symbol), lever: String(o.leverage), mgnMode: 'cross' });
    const algo: Record<string, string> = { slTriggerPx: String(roundTick(o.stop, ins.tickSize)), slOrdPx: '-1', slTriggerPxType: 'mark' };
    if (o.tp) Object.assign(algo, { tpTriggerPx: String(roundTick(o.tp, ins.tickSize)), tpOrdPx: '-1', tpTriggerPxType: 'mark' });
    const d = await this.req('POST', '/api/v5/trade/order', { instId: instId(o.symbol), tdMode: 'cross', side: o.side === 'LONG' ? 'buy' : 'sell', ordType: 'market', sz, clOrdId: o.clientId, attachAlgoOrds: [algo] });
    return { orderId: d?.[0]?.ordId ?? null };
  }
  async getOrder(symbol: string, clientId: string): Promise<OrderRecord> {
    try {
      const d = (await this.req('GET', '/api/v5/trade/order', { instId: instId(symbol), clOrdId: clientId }))?.[0];
      if (!d) return { clientId, orderId: '', status: 'unknown', filledQty: 0, avgPrice: null };
      if (!this.ctVal.has(symbol)) await this.instrument(symbol);
      const map: Record<string, OrderRecord['status']> = { filled: 'filled', partially_filled: 'partial', live: 'open', canceled: 'cancelled', mmp_canceled: 'cancelled' };
      return { clientId, orderId: d.ordId, status: map[d.state] ?? 'unknown', filledQty: Number(d.accFillSz ?? 0) * this.ctVal.get(symbol)!, avgPrice: Number(d.avgPx) || null, raw: d.state };
    } catch { return { clientId, orderId: '', status: 'unknown', filledQty: 0, avgPrice: null }; }
  }
  async positions(symbol?: string): Promise<VenuePosition[]> {
    const d = await this.req('GET', '/api/v5/account/positions', { instType: 'SWAP', instId: symbol ? instId(symbol) : undefined });
    const out: VenuePosition[] = [];
    for (const p of d ?? []) {
      const n = Number(p.pos); if (!n) continue;
      const sym = String(p.instId).replace('-USDT-SWAP', 'USDT');
      if (!this.ctVal.has(sym)) await this.instrument(sym);
      out.push({ symbol: sym, side: n > 0 ? 'LONG' : 'SHORT', qty: Math.abs(n) * this.ctVal.get(sym)!, entry: Number(p.avgPx), stop: null, tp: null, unrealizedPnl: Number(p.upl ?? 0) });
    }
    return out;
  }
  async closePosition(symbol: string, side: Side, qty: number, clientId: string) {
    const { sz } = await this.contracts(symbol, qty);
    const d = await this.req('POST', '/api/v5/trade/order', { instId: instId(symbol), tdMode: 'cross', side: side === 'LONG' ? 'sell' : 'buy', ordType: 'market', sz, reduceOnly: true, clOrdId: clientId });
    return { orderId: d?.[0]?.ordId ?? null };
  }
  async cancelAll(symbol: string) {
    const open = await this.req('GET', '/api/v5/trade/orders-pending', { instId: instId(symbol) });
    if (open?.length) await this.req('POST', '/api/v5/trade/cancel-batch-orders', open.map((o: any) => ({ instId: o.instId, ordId: o.ordId })));
  }
}
