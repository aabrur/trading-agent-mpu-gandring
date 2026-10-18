import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bech32 } from '@scure/base';
import { ExchangeError, httpJson, floorStep, roundTick, pickProtection, type ExchangeAdapter, type FetchLike, type Network, type PermissionReport, type PlaceOrder, type OrderRecord, type VenuePosition, type Side, type Protection, type ProtectRequest } from './types.js';

// EXPERIMENTAL, UNTESTED against a real account. dYdX v4 perpetuals (<COIN>-USD), cross margin.
// Docs: https://docs.dydx.xyz/concepts/trading/authenticators and https://docs.dydx.xyz/interaction/permissioned-keys
// Auth: the owner dYdX ADDRESS (public) plus an API Trading Key (permissioned key) private key and its authenticator id.
// The authenticator must be AllOf(SignatureVerification(this key), MessageFilter(place / cancel orders only)).
// Anything wider (no message filter, AnyOf, transfer or withdraw messages) is refused. The owner key is refused.
// Reads go to the public indexer over plain HTTPS. Order signing and broadcasting use the official
// @dydxprotocol/v4-client-js SDK, loaded only when trading on dYdX (npm install @dydxprotocol/v4-client-js).
// Stops are conditional STOP_MARKET reduce-only orders resting on the dYdX chain.

const INDEXER: Record<Network, string> = { mainnet: 'https://indexer.dydx.trade/v4', testnet: 'https://indexer.v4testnet.dydx.exchange/v4' };
export const dydxMarket = (symbol: string) => `${symbol.replace(/USDT?$|USDC$/, '')}-USD`;
export const fromDydxMarket = (m: string) => `${m.replace(/-USD$/, '')}USDT`;
/** dYdX client ids are uint32. Derived from our string client id, so the same intent always maps to the same id. */
export const dydxClientId = (clientId: string) => createHash('sha256').update(clientId).digest().readUInt32BE(0);
export const TRADE_ONLY_MESSAGES = new Set(['/dydxprotocol.clob.MsgPlaceOrder', '/dydxprotocol.clob.MsgCancelOrder', '/dydxprotocol.clob.MsgBatchCancel']);
const SLIPPAGE = 0.02;
const COND_GOOD_TIL_S = 28 * 24 * 3600;

/** Cosmos address (bech32 "dydx") of a secp256k1 private key. */
export function dydxAddressOf(privateKeyHex: string) {
  const pub = secp256k1.getPublicKey(Buffer.from(privateKeyHex.replace(/^0x/, ''), 'hex'), true);
  const h = createHash('ripemd160').update(createHash('sha256').update(pub).digest()).digest();
  return { address: bech32.encode('dydx', bech32.toWords(h)), pubKey: Buffer.from(pub) };
}

export interface DydxAuthenticator { id: string; type: string; config: unknown }
export interface DydxOrderParams { market: string; side: 'BUY' | 'SELL'; type: 'MARKET' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET'; size: number; price: number; triggerPrice?: number; clientId: number; reduceOnly: boolean; goodTilTimeSec?: number }
export interface DydxCancelParams { market: string; clientId: number; orderFlags: number; goodTilBlock?: number; goodTilBlockTimeSec?: number }
/** The chain side (signing and broadcasting). Real one wraps the official SDK; tests inject a fake. */
export interface DydxChain {
  getAuthenticators(owner: string): Promise<DydxAuthenticator[]>;
  placeOrder(p: DydxOrderParams): Promise<{ txHash: string | null }>;
  cancelOrder(p: DydxCancelParams): Promise<void>;
}

function bytesOf(v: unknown): Buffer {
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (Array.isArray(v)) return Buffer.from(v as number[]);
  if (typeof v === 'string') { try { const b = Buffer.from(v, 'base64'); if (b.toString('base64').replace(/=+$/, '') === v.replace(/=+$/, '')) return b; } catch { /* plain text */ } return Buffer.from(v, 'utf8'); }
  return Buffer.alloc(0);
}
interface Flat { types: string[]; pubKeys: Buffer[]; messages: string[]; anyOf: boolean }
/** Flattens an authenticator tree. Exposed for tests. */
export function flattenAuthenticator(type: string, config: unknown, acc: Flat = { types: [], pubKeys: [], messages: [], anyOf: false }): Flat {
  acc.types.push(type);
  if (type === 'AnyOf') acc.anyOf = true;
  if (type === 'AllOf' || type === 'AnyOf') {
    let subs: any[] = [];
    try { subs = JSON.parse(bytesOf(config).toString('utf8')); } catch { subs = []; }
    for (const s of subs) flattenAuthenticator(String(s.type ?? s.Type), s.config ?? s.Config, acc);
  } else if (type === 'SignatureVerification') acc.pubKeys.push(bytesOf(config));
  else if (type === 'MessageFilter') acc.messages.push(...bytesOf(config).toString('utf8').split(',').map((m) => m.trim()).filter(Boolean));
  return acc;
}

export class DydxAdapter implements ExchangeAdapter {
  readonly name = 'dydx' as const;
  readonly exchangeStops = true;
  private indexer: string;
  readonly apiAddress: string;
  private pubKey: Buffer;
  private chainImpl: DydxChain | null;
  constructor(public readonly network: Network, private owner: string, private apiKey: string, private authenticatorId: string, private fetchImpl: FetchLike = fetch, chain: DydxChain | null = null, private subaccount = Number(process.env.DYDX_SUBACCOUNT ?? 0)) {
    if (!/^dydx1[02-9ac-hj-np-z]{38,58}$/.test(owner)) throw new ExchangeError('DYDX address must be the owner dydx1... address (public)');
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(apiKey)) throw new ExchangeError('dYdX API trading key must be a 64 hex char private key (from API Trading Keys), never the seed phrase');
    if (!/^\d+$/.test(authenticatorId)) throw new ExchangeError('dYdX authenticator id must be a number');
    const d = dydxAddressOf(apiKey);
    this.apiAddress = d.address; this.pubKey = d.pubKey;
    this.indexer = (process.env[network === 'testnet' ? 'DYDX_TESTNET_INDEXER_URL' : 'DYDX_INDEXER_URL'] || INDEXER[network]).replace(/\/$/, '');
    this.chainImpl = chain;
  }
  private chain(): DydxChain { return (this.chainImpl ??= sdkChain(this.network, this.owner, this.apiKey, this.authenticatorId, this.subaccount)); }
  private get(path: string) { return httpJson(this.fetchImpl, `${this.indexer}${path}`); }
  private async market(symbol: string) {
    const r = await this.get(`/perpetualMarkets?ticker=${dydxMarket(symbol)}`);
    const m = r?.markets?.[dydxMarket(symbol)];
    if (!m) throw new ExchangeError(`dydx: unknown market ${dydxMarket(symbol)}`);
    return m;
  }

  async ping() { const r = await this.get(`/addresses/${this.owner}/subaccountNumber/${this.subaccount}`); return { ok: !!r?.subaccount, detail: 'subaccount readable on the indexer' }; }
  async permissions(): Promise<PermissionReport> {
    if (this.apiAddress === this.owner) return { ok: false, canWithdraw: true, canTrade: true, verified: true, detail: 'this is the OWNER key, not an API Trading Key. Refusing. Create one under More, API Trading Keys.' };
    const auths = await this.chain().getAuthenticators(this.owner);
    const a = auths.find((x) => String(x.id) === this.authenticatorId);
    if (!a) return { ok: false, canWithdraw: null, canTrade: false, verified: true, detail: `authenticator ${this.authenticatorId} not found on ${this.owner}` };
    const f = flattenAuthenticator(a.type, a.config);
    if (f.anyOf || a.type !== 'AllOf') return { ok: false, canWithdraw: null, canTrade: false, verified: true, detail: `authenticator ${a.id} is ${a.type}${f.anyOf ? ' with AnyOf' : ''}, cannot prove it is trade only. Refusing.` };
    if (!f.pubKeys.some((k) => k.equals(this.pubKey))) return { ok: false, canWithdraw: null, canTrade: false, verified: true, detail: `authenticator ${a.id} does not verify this key` };
    if (!f.messages.length) return { ok: false, canWithdraw: true, canTrade: true, verified: true, detail: `authenticator ${a.id} has no message filter, so it allows any message (including transfers). Refusing.` };
    const wide = f.messages.filter((m) => !TRADE_ONLY_MESSAGES.has(m));
    if (wide.length) return { ok: false, canWithdraw: true, canTrade: true, verified: true, detail: `authenticator ${a.id} allows ${wide.join(', ')}. Refusing; trade only (place and cancel orders) is required.` };
    return { ok: true, canWithdraw: false, canTrade: f.messages.includes('/dydxprotocol.clob.MsgPlaceOrder'), verified: true, detail: `permissioned key ${this.apiAddress} with authenticator ${a.id}: ${f.messages.map((m) => m.split('.').pop()).join(', ')} only; cannot withdraw or transfer` };
  }
  async balance() { const r = await this.get(`/addresses/${this.owner}/subaccountNumber/${this.subaccount}`); return { equityUsdt: Number(r?.subaccount?.equity ?? 0), availableUsdt: Number(r?.subaccount?.freeCollateral ?? 0) }; }
  async instrument(symbol: string) { const m = await this.market(symbol); return { symbol, qtyStep: Number(m.stepSize), minQty: Number(m.stepSize), tickSize: Number(m.tickSize) }; }
  async ticker(symbol: string) { const m = await this.market(symbol); const px = Number(m.oraclePrice); if (!px) throw new ExchangeError('dydx: no price'); return px; }
  async funding(symbol: string) { return Number((await this.market(symbol)).nextFundingRate ?? NaN); }
  private worst(px: number, buy: boolean, tick: number) { return roundTick(buy ? px * (1 + SLIPPAGE) : px * (1 - SLIPPAGE), tick); }

  async placeOrder(o: PlaceOrder) {
    if (!(o.stop > 0)) throw new ExchangeError('refusing an order without a stop loss');
    const m = await this.market(o.symbol);
    const step = Number(m.stepSize), tick = Number(m.tickSize), px = Number(m.oraclePrice);
    const qty = floorStep(o.qty, step);
    if (qty < step) throw new ExchangeError(`size ${qty} is under the minimum ${step}`);
    const market = dydxMarket(o.symbol), buy = o.side === 'LONG';
    const r = await this.chain().placeOrder({ market, side: buy ? 'BUY' : 'SELL', type: 'MARKET', size: qty, price: this.worst(px, buy, tick), clientId: dydxClientId(o.clientId), reduceOnly: false });
    try {
      await this.chain().placeOrder({ market, side: buy ? 'SELL' : 'BUY', type: 'STOP_MARKET', size: qty, price: this.worst(o.stop, !buy, tick), triggerPrice: roundTick(o.stop, tick), clientId: dydxClientId(`${o.clientId}s`), reduceOnly: true, goodTilTimeSec: COND_GOOD_TIL_S });
    } catch (e) {
      await this.chain().placeOrder({ market, side: buy ? 'SELL' : 'BUY', type: 'MARKET', size: qty, price: this.worst(px, !buy, tick), clientId: dydxClientId(`${o.clientId}x`), reduceOnly: true }).catch(() => {});
      throw new ExchangeError(`stop could not be placed, entry closed: ${(e as Error).message}`);
    }
    if (o.tp) await this.chain().placeOrder({ market, side: buy ? 'SELL' : 'BUY', type: 'TAKE_PROFIT_MARKET', size: qty, price: this.worst(o.tp, !buy, tick), triggerPrice: roundTick(o.tp, tick), clientId: dydxClientId(`${o.clientId}t`), reduceOnly: true, goodTilTimeSec: COND_GOOD_TIL_S }).catch(() => {});
    return { orderId: r.txHash };
  }
  private async orders(symbol: string, status?: string): Promise<any[]> {
    const q = `/orders?address=${this.owner}&subaccountNumber=${this.subaccount}&ticker=${dydxMarket(symbol)}&limit=100${status ? `&status=${status}` : ''}`;
    return (await this.get(q)) ?? [];
  }
  async getOrder(symbol: string, clientId: string): Promise<OrderRecord> {
    try {
      const cid = String(dydxClientId(clientId));
      const o = (await this.orders(symbol)).find((x) => String(x.clientId) === cid);
      if (!o) return { clientId, orderId: '', status: 'unknown', filledQty: 0, avgPrice: null };
      const filled = Number(o.totalFilled ?? 0);
      let avg: number | null = null;
      if (filled > 0) {
        const fills = (await this.get(`/fills?address=${this.owner}&subaccountNumber=${this.subaccount}&market=${dydxMarket(symbol)}&marketType=PERPETUAL&limit=100`))?.fills ?? [];
        const mine = fills.filter((f: any) => f.orderId === o.id);
        const q = mine.reduce((s: number, f: any) => s + Number(f.size), 0);
        avg = q ? mine.reduce((s: number, f: any) => s + Number(f.size) * Number(f.price), 0) / q : null;
      }
      const map: Record<string, OrderRecord['status']> = { FILLED: 'filled', OPEN: 'open', BEST_EFFORT_OPENED: 'open', UNTRIGGERED: 'open', CANCELED: 'cancelled', BEST_EFFORT_CANCELED: 'cancelled' };
      return { clientId, orderId: String(o.id), status: map[o.status] ?? (filled > 0 ? 'partial' : 'unknown'), filledQty: filled, avgPrice: avg, raw: o.status };
    } catch { return { clientId, orderId: '', status: 'unknown', filledQty: 0, avgPrice: null }; }
  }
  async positions(symbol?: string): Promise<VenuePosition[]> {
    const r = await this.get(`/perpetualPositions?address=${this.owner}&subaccountNumber=${this.subaccount}&status=OPEN`);
    return (r?.positions ?? []).filter((p: any) => Number(p.size) !== 0).map((p: any) => ({
      symbol: fromDydxMarket(p.market), side: (p.side === 'SHORT' || Number(p.size) < 0 ? 'SHORT' : 'LONG') as Side, qty: Math.abs(Number(p.size)), entry: Number(p.entryPrice),
      stop: null, tp: null, unrealizedPnl: Number(p.unrealizedPnl ?? 0)
    })).filter((p: VenuePosition) => !symbol || p.symbol === symbol);
  }
  async closePosition(symbol: string, side: Side, qty: number, clientId: string) {
    const m = await this.market(symbol);
    const buy = side === 'SHORT';
    const r = await this.chain().placeOrder({ market: dydxMarket(symbol), side: buy ? 'BUY' : 'SELL', type: 'MARKET', size: floorStep(qty, Number(m.stepSize)), price: this.worst(Number(m.oraclePrice), buy, Number(m.tickSize)), clientId: dydxClientId(clientId), reduceOnly: true });
    return { orderId: r.txHash };
  }
  async cancelAll(symbol: string) {
    const open = [...await this.orders(symbol, 'OPEN'), ...await this.orders(symbol, 'UNTRIGGERED')];
    for (const o of open) await this.chain().cancelOrder({ market: dydxMarket(symbol), clientId: Number(o.clientId), orderFlags: Number(o.orderFlags ?? 0), goodTilBlock: o.goodTilBlock ? Number(o.goodTilBlock) : undefined, goodTilBlockTimeSec: o.goodTilBlockTime ? Math.floor(Date.parse(o.goodTilBlockTime) / 1000) : undefined });
  }
  async protection(symbol: string, side: Side): Promise<Protection> {
    const rows = await this.orders(symbol, 'UNTRIGGERED');
    return pickProtection(side, rows.filter((o) => Number(o.triggerPrice) > 0).map((o) => ({
      price: Number(o.triggerPrice), kind: /STOP/.test(o.type) ? 'stop' as const : /TAKE_PROFIT/.test(o.type) ? 'tp' as const : 'unknown' as const, closes: (o.side === 'SELL' ? 'LONG' : 'SHORT') as Side
    })));
  }
  async protect(p: ProtectRequest) {
    const m = await this.market(p.symbol);
    const tick = Number(m.tickSize), qty = floorStep(p.qty, Number(m.stepSize)), buy = p.side === 'SHORT';
    if (p.stop) await this.chain().placeOrder({ market: dydxMarket(p.symbol), side: buy ? 'BUY' : 'SELL', type: 'STOP_MARKET', size: qty, price: this.worst(p.stop, buy, tick), triggerPrice: roundTick(p.stop, tick), clientId: dydxClientId(`${p.clientId}s`), reduceOnly: true, goodTilTimeSec: COND_GOOD_TIL_S });
    if (p.tp) await this.chain().placeOrder({ market: dydxMarket(p.symbol), side: buy ? 'BUY' : 'SELL', type: 'TAKE_PROFIT_MARKET', size: qty, price: this.worst(p.tp, buy, tick), triggerPrice: roundTick(p.tp, tick), clientId: dydxClientId(`${p.clientId}t`), reduceOnly: true, goodTilTimeSec: COND_GOOD_TIL_S });
  }
}

/** Wraps the official SDK. Loaded lazily; the dependency is optional (only needed to trade on dYdX). */
function sdkChain(network: Network, owner: string, apiKey: string, authenticatorId: string, subaccount: number): DydxChain {
  let ctx: Promise<{ sdk: any; client: any; sub: any }> | null = null;
  const load = () => (ctx ??= (async () => {
    let sdk: any;
    try { sdk = createRequire(import.meta.url)('@dydxprotocol/v4-client-js'); }
    catch { throw new ExchangeError('dYdX trading needs the official SDK: run  npm install @dydxprotocol/v4-client-js'); }
    const net = network === 'testnet' ? sdk.Network.testnet() : new sdk.Network('mainnet',
      new sdk.IndexerConfig(process.env.DYDX_INDEXER_URL?.replace(/\/v4\/?$/, '') || sdk.IndexerApiHost.MAINNET, sdk.IndexerWSHost.MAINNET),
      new sdk.ValidatorConfig(process.env.DYDX_VALIDATOR_URL || sdk.ValidatorApiHost.MAINNET, 'dydx-mainnet-1', { CHAINTOKEN_DENOM: 'adydx', USDC_DENOM: 'ibc/8E27BA2D5493AF5636760E354E46004562C46AB7EC0CC4C1CA14E9E20E2545B5', USDC_GAS_DENOM: 'uusdc', USDC_DECIMALS: 6, CHAINTOKEN_DECIMALS: 18 }, undefined, 'Trading Agent Mpu Gandring'));
    const client = await sdk.CompositeClient.connect(net);
    const wallet = await sdk.LocalWallet.fromPrivateKey(apiKey.replace(/^0x/, ''), 'dydx');
    const sub = sdk.SubaccountInfo.forPermissionedWallet(wallet, owner, subaccount, [Number(authenticatorId)]);
    return { sdk, client, sub };
  })());
  return {
    async getAuthenticators(addr) {
      const { client } = await load();
      const r = await client.validatorClient.get.getAuthenticators(addr);
      return (r?.accountAuthenticators ?? []).map((a: any) => ({ id: String(a.id), type: String(a.type), config: a.config }));
    },
    async placeOrder(p) {
      const { sdk, client, sub } = await load();
      const isCond = p.type !== 'MARKET';
      const tx = await client.placeOrder(sub, p.market, sdk.OrderType[p.type], sdk.OrderSide[p.side], p.price, p.size, p.clientId,
        sdk.OrderTimeInForce.IOC, isCond ? p.goodTilTimeSec ?? COND_GOOD_TIL_S : 0, sdk.OrderExecution.IOC, false, p.reduceOnly, p.triggerPrice);
      return { txHash: tx?.hash ? Buffer.from(tx.hash).toString('hex') : null };
    },
    async cancelOrder(p) {
      const { client, sub } = await load();
      await client.cancelOrder(sub, p.clientId, p.orderFlags, p.market, p.goodTilBlock ?? 0, p.goodTilBlockTimeSec ? Math.max(0, p.goodTilBlockTimeSec - Math.floor(Date.now() / 1000)) : 0);
    }
  };
}
