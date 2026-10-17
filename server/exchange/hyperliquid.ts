import { encode } from '@msgpack/msgpack';
import { keccak256, concat, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createHash } from 'node:crypto';
import { ExchangeError, httpJson, type ExchangeAdapter, type FetchLike, type Network, type PermissionReport, type PlaceOrder, type OrderRecord, type VenuePosition, type Side, type Protection, type ProtectRequest, pickProtection } from './types.js';

// EXPERIMENTAL, UNTESTED against a real account. Hyperliquid perps through an API agent wallet.
// The agent wallet can trade for the account but cannot withdraw. The main wallet's private key
// must never be used here: permissions() refuses it.
const SLIPPAGE = 0.05;

/** Hyperliquid wire format for numbers: at most 8 decimals, no trailing zeros. */
export function floatToWire(x: number) {
  let s = x.toFixed(8);
  if (Math.abs(Number(s) - x) >= 1e-12) throw new ExchangeError(`float_to_wire rounding: ${x}`);
  s = s.replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}
/** Hyperliquid perp order value minimum (docs: "Order must have minimum value of $10"). */
export const HL_MIN_NOTIONAL = 10;
/** Lot step for szDecimals, exact (10 ** -4 is 0.00009999... in floating point; toFixed makes it 0.0001). */
export function hlStep(szDecimals: number) { return Number((10 ** -szDecimals).toFixed(szDecimals)); }
/**
 * A price tick that is valid for every price up to `px`: at most 5 significant figures and at most
 * 6 - szDecimals decimals (integer prices are always allowed). A multiple of this tick never needs
 * re-rounding by hlPrice, so a stop rounded to it toward the entry stays exactly where the planner put it.
 */
export function hlTick(px: number, szDecimals: number) {
  const maxDec = Math.max(0, 6 - szDecimals);
  const sigTick = 10 ** (Math.floor(Math.log10(px)) - 4);
  const t = Math.min(1, Math.max(sigTick, 10 ** -maxDec));
  return Number(t.toFixed(Math.max(maxDec, 0)));
}
/** Perp prices: 5 significant figures and at most 6 - szDecimals decimals. */
export function hlPrice(px: number, szDecimals: number) {
  const sig = Number(px.toPrecision(5));
  return Number(sig.toFixed(Math.max(0, 6 - szDecimals)));
}
/** L1 action hash: keccak(msgpack(action) | nonce u64 BE | vault flag). */
export function actionHash(action: unknown, nonce: number): Hex {
  const packed = encode(action);
  const n = new Uint8Array(8); new DataView(n.buffer).setBigUint64(0, BigInt(nonce));
  return keccak256(concat([packed, n, new Uint8Array([0])]));
}
export function cloidFor(clientId: string): Hex { return `0x${createHash('sha256').update(clientId).digest('hex').slice(0, 32)}`; }

export class HyperliquidAdapter implements ExchangeAdapter {
  readonly name = 'hyperliquid' as const;
  /** Stop and take profit are reduce-only trigger orders resting on Hyperliquid (tpsl sl / tp). */
  readonly exchangeStops = true;
  private base: string;
  private account: ReturnType<typeof privateKeyToAccount>;
  private meta: { universe: { name: string; szDecimals: number }[] } | null = null;
  constructor(public readonly network: Network, private user: string, agentPrivateKey: string, private fetchImpl: FetchLike = fetch) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(user)) throw new ExchangeError('HYPERLIQUID account address must be a 0x address (the main account, public)');
    if (!/^0x[0-9a-fA-F]{64}$/.test(agentPrivateKey)) throw new ExchangeError('Hyperliquid agent wallet key must be a 0x private key of the API agent wallet');
    this.account = privateKeyToAccount(agentPrivateKey as Hex);
    this.base = network === 'testnet' ? 'https://api.hyperliquid-testnet.xyz' : 'https://api.hyperliquid.xyz';
  }
  get agentAddress() { return this.account.address; }
  private info(body: Record<string, unknown>) { return httpJson(this.fetchImpl, `${this.base}/info`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  private async exchange(action: Record<string, unknown>) {
    const nonce = Date.now();
    const signature = await this.account.signTypedData({
      domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: '0x0000000000000000000000000000000000000000' },
      types: { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] },
      primaryType: 'Agent',
      message: { source: this.network === 'mainnet' ? 'a' : 'b', connectionId: actionHash(action, nonce) }
    });
    const sig = { r: `0x${signature.slice(2, 66)}`, s: `0x${signature.slice(66, 130)}`, v: parseInt(signature.slice(130, 132), 16) };
    const r = await httpJson(this.fetchImpl, `${this.base}/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, nonce, signature: sig, vaultAddress: null }) });
    if (r?.status !== 'ok') throw new ExchangeError(`hyperliquid: ${typeof r?.response === 'string' ? r.response : JSON.stringify(r).slice(0, 200)}`);
    const statuses = r?.response?.data?.statuses ?? [];
    const err = statuses.find((s: any) => s?.error);
    if (err) throw new ExchangeError(`hyperliquid: ${err.error}`);
    return statuses;
  }
  private async asset(symbol: string) {
    if (!this.meta) this.meta = await this.info({ type: 'meta' });
    const coin = symbol.replace(/USDT?$/, '');
    const idx = this.meta!.universe.findIndex((u) => u.name === coin);
    if (idx < 0) throw new ExchangeError(`hyperliquid: unknown coin ${coin}`);
    return { idx, coin, szDecimals: this.meta!.universe[idx].szDecimals };
  }
  private async mid(coin: string) { const m = await this.info({ type: 'allMids' }); const px = Number(m?.[coin]); if (!px) throw new ExchangeError(`no mid price for ${coin}`); return px; }

  async ping() { const r = await this.info({ type: 'clearinghouseState', user: this.user }); return { ok: !!r?.marginSummary, detail: 'account state readable' }; }
  async permissions(): Promise<PermissionReport> {
    if (this.agentAddress.toLowerCase() === this.user.toLowerCase()) {
      return { ok: false, canWithdraw: true, canTrade: true, verified: true, detail: 'this is the MAIN wallet key, not an API agent wallet. Refusing. Create an API wallet in the Hyperliquid app and use that key.' };
    }
    const agents: { address: string; name: string; validUntil: number | null }[] = await this.info({ type: 'extraAgents', user: this.user });
    const hit = (agents ?? []).find((a) => a.address.toLowerCase() === this.agentAddress.toLowerCase());
    if (!hit) return { ok: false, canWithdraw: null, canTrade: false, verified: true, detail: `agent ${this.agentAddress} is not an approved API wallet of ${this.user}` };
    if (hit.validUntil && hit.validUntil < Date.now()) return { ok: false, canWithdraw: false, canTrade: false, verified: true, detail: `agent wallet "${hit.name}" expired` };
    return { ok: true, canWithdraw: false, canTrade: true, verified: true, detail: `approved agent wallet "${hit.name}"${hit.validUntil ? `, valid until ${new Date(hit.validUntil).toISOString().slice(0, 10)}` : ''}; agent wallets cannot withdraw` };
  }
  async balance() {
    const r = await this.info({ type: 'clearinghouseState', user: this.user });
    return { equityUsdt: Number(r?.marginSummary?.accountValue ?? 0), availableUsdt: Number(r?.withdrawable ?? 0) };
  }
  async instrument(symbol: string) {
    const a = await this.asset(symbol);
    // Tick sized for prices up to 10% above the mid, so a SHORT stop above the entry is on a valid tick too.
    const px = await this.mid(a.coin);
    return { symbol, qtyStep: hlStep(a.szDecimals), minQty: hlStep(a.szDecimals), tickSize: hlTick(px * 1.1, a.szDecimals), minNotional: HL_MIN_NOTIONAL };
  }
  async ticker(symbol: string) { return this.mid((await this.asset(symbol)).coin); }
  async placeOrder(o: PlaceOrder) {
    if (!(o.stop > 0)) throw new ExchangeError('refusing an order without a stop loss');
    const a = await this.asset(o.symbol);
    const sz = Number(o.qty.toFixed(a.szDecimals));
    if (!(sz > 0)) throw new ExchangeError('size rounds to zero');
    const buy = o.side === 'LONG';
    const px = await this.mid(a.coin);
    await this.exchange({ type: 'updateLeverage', asset: a.idx, isCross: true, leverage: Math.round(o.leverage) });
    const slip = (p: number, isBuy: boolean) => floatToWire(hlPrice(isBuy ? p * (1 + SLIPPAGE) : p * (1 - SLIPPAGE), a.szDecimals));
    const orders: Record<string, unknown>[] = [
      { a: a.idx, b: buy, p: slip(px, buy), s: floatToWire(sz), r: false, t: { limit: { tif: 'Ioc' } }, c: cloidFor(o.clientId) },
      { a: a.idx, b: !buy, p: slip(o.stop, !buy), s: floatToWire(sz), r: true, t: { trigger: { isMarket: true, triggerPx: floatToWire(hlPrice(o.stop, a.szDecimals)), tpsl: 'sl' } } }
    ];
    if (o.tp) orders.push({ a: a.idx, b: !buy, p: slip(o.tp, !buy), s: floatToWire(sz), r: true, t: { trigger: { isMarket: true, triggerPx: floatToWire(hlPrice(o.tp, a.szDecimals)), tpsl: 'tp' } } });
    const st = await this.exchange({ type: 'order', orders, grouping: 'normalTpsl' });
    const first = st?.[0];
    return { orderId: first?.filled?.oid != null ? String(first.filled.oid) : first?.resting?.oid != null ? String(first.resting.oid) : null };
  }
  async getOrder(symbol: string, clientId: string): Promise<OrderRecord> {
    try {
      const r = await this.info({ type: 'orderStatus', user: this.user, oid: cloidFor(clientId) });
      if (r?.status !== 'order') return { clientId, orderId: '', status: 'unknown', filledQty: 0, avgPrice: null };
      const ord = r.order.order, status = String(r.order.status);
      const filledQty = Number(ord.origSz) - Number(ord.sz);
      const fills: any[] = await this.info({ type: 'userFills', user: this.user });
      const mine = (fills ?? []).filter((f) => f.oid === ord.oid);
      const notional = mine.reduce((s, f) => s + Number(f.px) * Number(f.sz), 0), q = mine.reduce((s, f) => s + Number(f.sz), 0);
      const map: Record<string, OrderRecord['status']> = { filled: 'filled', open: 'open', canceled: 'cancelled', rejected: 'rejected', marginCanceled: 'cancelled' };
      return { clientId, orderId: String(ord.oid), status: map[status] ?? (filledQty > 0 ? 'partial' : 'unknown'), filledQty, avgPrice: q ? notional / q : null, raw: status };
    } catch { return { clientId, orderId: '', status: 'unknown', filledQty: 0, avgPrice: null }; }
  }
  async positions(symbol?: string): Promise<VenuePosition[]> {
    const r = await this.info({ type: 'clearinghouseState', user: this.user });
    return (r?.assetPositions ?? []).map((x: any) => x.position).filter((p: any) => Number(p.szi) !== 0)
      .map((p: any) => ({ symbol: `${p.coin}USDT`, side: Number(p.szi) > 0 ? 'LONG' : 'SHORT', qty: Math.abs(Number(p.szi)), entry: Number(p.entryPx), stop: null, tp: null, unrealizedPnl: Number(p.unrealizedPnl ?? 0) }))
      .filter((p: VenuePosition) => !symbol || p.symbol === symbol);
  }
  async closePosition(symbol: string, side: Side, qty: number, clientId: string) {
    const a = await this.asset(symbol);
    const px = await this.mid(a.coin);
    const buy = side === 'SHORT';
    const st = await this.exchange({ type: 'order', orders: [{ a: a.idx, b: buy, p: floatToWire(hlPrice(buy ? px * (1 + SLIPPAGE) : px * (1 - SLIPPAGE), a.szDecimals)), s: floatToWire(Number(qty.toFixed(a.szDecimals))), r: true, t: { limit: { tif: 'Ioc' } }, c: cloidFor(clientId) }], grouping: 'na' });
    return { orderId: st?.[0]?.filled?.oid != null ? String(st[0].filled.oid) : null };
  }
  async cancelAll(symbol: string) {
    const a = await this.asset(symbol);
    const open: any[] = await this.info({ type: 'openOrders', user: this.user });
    const cancels = (open ?? []).filter((o) => o.coin === a.coin).map((o) => ({ a: a.idx, o: o.oid }));
    if (cancels.length) await this.exchange({ type: 'cancel', cancels });
  }
  async protection(symbol: string, side: Side): Promise<Protection> {
    const a = await this.asset(symbol);
    const open: any[] = await this.info({ type: 'frontendOpenOrders', user: this.user });
    return pickProtection(side, (open ?? []).filter((o) => o.coin === a.coin && o.isTrigger).map((o) => ({
      price: Number(o.triggerPx), kind: /stop/i.test(String(o.orderType)) ? 'stop' as const : /take profit/i.test(String(o.orderType)) ? 'tp' as const : 'unknown' as const,
      closes: (o.side === 'A' ? 'LONG' : 'SHORT') as Side
    })));
  }
  async protect(p: ProtectRequest) {
    const a = await this.asset(p.symbol);
    const sz = floatToWire(Number(p.qty.toFixed(a.szDecimals)));
    const buy = p.side === 'SHORT';
    const leg = (px: number, tpsl: 'sl' | 'tp') => ({ a: a.idx, b: buy, p: floatToWire(hlPrice(buy ? px * (1 + SLIPPAGE) : px * (1 - SLIPPAGE), a.szDecimals)), s: sz, r: true, t: { trigger: { isMarket: true, triggerPx: floatToWire(hlPrice(px, a.szDecimals)), tpsl } } });
    const orders = [...(p.stop ? [leg(p.stop, 'sl')] : []), ...(p.tp ? [leg(p.tp, 'tp')] : [])];
    if (orders.length) await this.exchange({ type: 'order', orders, grouping: 'na' });
  }
}
