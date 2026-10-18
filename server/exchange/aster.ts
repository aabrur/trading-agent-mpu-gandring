import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { ExchangeError, httpJson, floorStep, roundTick, pickProtection, type ExchangeAdapter, type FetchLike, type Network, type PermissionReport, type PlaceOrder, type OrderRecord, type VenuePosition, type Side, type Protection, type ProtectRequest } from './types.js';
import { asterRules, type InstrumentRules, type RulesCache } from './rules.js';
import { readEnv } from '../../cli/envfile.js';

// EXPERIMENTAL, UNTESTED against a real account. Aster perpetual futures, API v3, one-way mode.
// Docs: https://github.com/asterdex/api-docs (V3 Futures), https://asterdex.github.io/aster-api-website/asterCode/authentication/
// Auth: the main wallet ADDRESS (public, "user") plus a Pro API agent wallet ("signer") private key.
// Every signed request sends user, signer, nonce (microseconds) and an EIP-712 signature over the exact
// query string (domain AsterSignTransaction, version 1, chainId 1666 mainnet / 714 testnet, primaryType Message{msg}).
// The main wallet key is refused. Stops are STOP_MARKET closePosition orders resting on Aster.

export const ASTER_CHAIN_ID: Record<Network, number> = { mainnet: 1666, testnet: 714 };
const BASE: Record<Network, string> = { mainnet: 'https://fapi.asterdex.com', testnet: 'https://fapi.asterdex-testnet.com' };
const ZERO = '0x0000000000000000000000000000000000000000';

let lastNonce = 0;
/** Microsecond nonce, strictly increasing inside this process (Aster keeps the last 100 per agent). */
export function asterNonce(now = Date.now()) { lastNonce = Math.max(lastNonce + 1, now * 1000); return lastNonce; }

export class AsterAdapter implements ExchangeAdapter {
  readonly name = 'aster' as const;
  readonly exchangeStops = true;
  private base: string;
  private account: ReturnType<typeof privateKeyToAccount>;
  private pinnedAgent: string;
  constructor(public readonly network: Network, private user: string, signerPrivateKey: string, private fetchImpl: FetchLike = fetch, base = process.env[network === 'testnet' ? 'ASTER_TESTNET_BASE_URL' : 'ASTER_BASE_URL'], pinnedAgent?: string) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(user)) throw new ExchangeError('ASTER user address must be the 0x main wallet address (public)');
    if (!/^0x[0-9a-fA-F]{64}$/.test(signerPrivateKey)) throw new ExchangeError('Aster signer key must be the 0x private key of a Pro API agent wallet');
    this.account = privateKeyToAccount(signerPrivateKey as Hex);
    this.base = base || BASE[network];
    const envKey = network === 'testnet' ? 'ASTER_TESTNET_AGENT_WITHDRAW_OFF_VERIFIED' : 'ASTER_AGENT_WITHDRAW_OFF_VERIFIED';
    const fromEnv = () => { try { const e = readEnv(process.env.DOTENV_PATH || '.env') as Record<string, string>; return e[envKey] ?? e.ASTER_AGENT_WITHDRAW_OFF_VERIFIED ?? ''; } catch { return ''; } };
    const rawPin = pinnedAgent !== undefined ? pinnedAgent : (fromEnv() || process.env[envKey] || process.env.ASTER_AGENT_WITHDRAW_OFF_VERIFIED || '');
    this.pinnedAgent = (pinnedAgent !== undefined ? rawPin : this.account.address).trim();
  }
  get signerAddress() { return this.account.address; }

  /** Builds the exact query string Aster verifies and signs it. Exposed for tests. */
  async signedQuery(params: Record<string, string | number | boolean | undefined>, nonce = asterNonce()) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) q.append(k, String(v));
    q.append('nonce', String(nonce)); q.append('user', this.user); q.append('signer', this.account.address);
    const msg = q.toString();
    const signature = await this.account.signTypedData({
      domain: { name: 'AsterSignTransaction', version: '1', chainId: ASTER_CHAIN_ID[this.network], verifyingContract: ZERO },
      types: { Message: [{ name: 'msg', type: 'string' }] }, primaryType: 'Message', message: { msg }
    });
    return { msg, signature, query: `${msg}&signature=${signature}` };
  }
  private async req(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, string | number | boolean | undefined> = {}) {
    const { query } = await this.signedQuery(params);
    const r = await httpJson(this.fetchImpl, `${this.base}${path}?${query}`, { method, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    if (r && typeof r === 'object' && !Array.isArray(r) && typeof r.code === 'number' && r.code < 0) throw new ExchangeError(`aster ${path}: ${r.msg ?? 'error'} (${r.code})`, r.code);
    return r;
  }
  private pub(path: string) { return httpJson(this.fetchImpl, `${this.base}${path}`); }

  async ping() { const r = await this.req('GET', '/fapi/v3/balance'); return { ok: Array.isArray(r), detail: 'futures balance readable' }; }
  async permissions(): Promise<PermissionReport> {
    if (this.account.address.toLowerCase() === this.user.toLowerCase()) {
      return { ok: false, canWithdraw: true, canTrade: true, verified: true, detail: 'this is the MAIN wallet key, not a Pro API agent wallet. Refusing. Create an API wallet (asterdex.com/en/api-wallet, Pro API) with withdraw off and use that key.' };
    }
    // Account flags read with the agent signature. canWithdraw here is the ACCOUNT flag ("can transfer out asset").
    const r = await this.req('GET', '/fapi/v3/account');
    const canWithdraw = r?.canWithdraw === false ? false : r?.canWithdraw === true ? true : null;
    const canTrade = r?.canTrade !== false;
    const detail = `agent ${this.account.address} for ${this.user}; account reports canTrade ${String(r?.canTrade)}, canWithdraw ${String(r?.canWithdraw)}`;
    if (canWithdraw === false) return { ok: true, canWithdraw, canTrade, verified: true, detail };
    if (!this.pinnedAgent) return { ok: false, canWithdraw, canTrade, verified: false, detail: `${detail}. Refusing unless Aster reports canWithdraw false for this signer (opt in: ASTER_AGENT_WITHDRAW_OFF_VERIFIED=<your agent address>, see docs/venues.md).` };
    return this.pinnedAgentCheck(r, detail, canWithdraw, canTrade);
  }

  /**
   * Opt-in exception (ASTER_AGENT_WITHDRAW_OFF_VERIFIED=<agent address>). On Aster the account-level canWithdraw stays true
   * for normal accounts; withdraw permission is set PER AGENT (approveAgent / registerAndApproveAgent canWithdraw, docs:
   * https://asterdex.github.io/aster-api-website/asterCode/endpoints/). We accept only when the exchange's own per-agent
   * record (GET /fapi/v3/agent) for THIS signer says canWithdraw false. The account reading is kept in the report.
   */
  private async pinnedAgentCheck(acct: any, detail: string, acctWithdraw: boolean | null, acctTrade: boolean): Promise<PermissionReport> {
    const refuse = (why: string): PermissionReport => ({ ok: false, canWithdraw: acctWithdraw, canTrade: acctTrade, verified: false, detail: `${detail}. ASTER_AGENT_WITHDRAW_OFF_VERIFIED exception refused: ${why}` });
    const signer = this.account.address.toLowerCase();
    if (!/^0x[0-9a-fA-F]{40}$/.test(this.pinnedAgent)) return refuse('the pinned value is not a 0x address');
    if (this.pinnedAgent.toLowerCase() !== signer) return refuse(`the signer ${this.account.address} is not the pinned agent ${this.pinnedAgent}`);
    if (signer === this.user.toLowerCase()) return refuse('the signer is the main wallet');
    if (acct?.canTrade !== true) return refuse(`the account does not report canTrade true (got ${String(acct?.canTrade)})`);
    let agents: unknown;
    try { agents = await this.req('GET', '/fapi/v3/agent'); } catch (e) { return refuse(`could not read the agent list: ${(e as Error).message}`); }
    if (!Array.isArray(agents)) return refuse('the agent list is not readable');
    const me = agents.filter((a: any) => typeof a?.agentAddress === 'string' && a.agentAddress.toLowerCase() === signer);
    if (me.length !== 1) return refuse(`the signer is not registered as an agent of ${this.user}`);
    const a: any = me[0];
    if (a.canWithdraw !== false) return refuse(`Aster reports this agent canWithdraw ${String(a.canWithdraw)}`);
    if (a.canPerpTrade !== true) return refuse(`Aster reports this agent canPerpTrade ${String(a.canPerpTrade)}`);
    if (!(Number(a.expired) > Date.now())) return refuse(`the agent approval is expired or has no expiry (${String(a.expired)})`);
    return {
      ok: true, canWithdraw: false, canTrade: true, verified: true,
      exception: `ASTER_AGENT_WITHDRAW_OFF_VERIFIED accepted: account canWithdraw ${String(acct?.canWithdraw)}; signer ${this.account.address} is a registered agent of ${this.user} and Aster reports this agent canWithdraw false, canPerpTrade true (GET /fapi/v3/agent)`,
      detail: `${detail}; accepted because signer ${this.account.address} is a registered agent of ${this.user} and Aster's per-agent record reports canWithdraw false, canPerpTrade true (ASTER_AGENT_WITHDRAW_OFF_VERIFIED pinned). The report's canWithdraw is the agent's flag; the account flag is canWithdraw ${String(acct?.canWithdraw)}`
    };
  }
  async balance() { const r = await this.req('GET', '/fapi/v3/account'); if (r?.totalMarginBalance == null || r?.availableBalance == null || !Number.isFinite(Number(r.totalMarginBalance)) || !Number.isFinite(Number(r.availableBalance))) throw new ExchangeError('aster: incomplete account response'); return { equityUsdt: Number(r.totalMarginBalance), availableUsdt: Number(r.availableBalance) }; }
  private rulesCache: RulesCache = new Map();
  /** Lot step, min qty, tick, min notional and taker fee straight from Aster exchangeInfo, cached 5 min. */
  instrumentRules(symbol: string): Promise<InstrumentRules> { return asterRules(symbol, this.network, this.fetchImpl, this.base, this.rulesCache); }
  async instrument(symbol: string) {
    const r = await this.instrumentRules(symbol).catch((e) => { throw new ExchangeError(`aster: ${(e as Error).message}`); });
    return { symbol, qtyStep: r.qtyStep, minQty: r.minQty, tickSize: r.tickSize };
  }
  async ticker(symbol: string) { const r = await this.pub(`/fapi/v3/ticker/price?symbol=${symbol}`); const px = Number(r?.price); if (!px) throw new ExchangeError('aster: no price'); return px; }
  async funding(symbol: string) { const r = await this.pub(`/fapi/v3/premiumIndex?symbol=${symbol}`); return Number(r?.lastFundingRate ?? NaN); }

  async placeOrder(o: PlaceOrder) {
    if (!(o.stop > 0)) throw new ExchangeError('refusing an order without a stop loss');
    const ins = await this.instrument(o.symbol);
    const qty = floorStep(o.qty, ins.qtyStep);
    if (qty < ins.minQty) throw new ExchangeError(`size ${qty} is under the minimum ${ins.minQty}`);
    await this.req('POST', '/fapi/v3/leverage', { symbol: o.symbol, leverage: Math.round(o.leverage) });
    const side = o.side === 'LONG' ? 'BUY' : 'SELL', exit = o.side === 'LONG' ? 'SELL' : 'BUY';
    const r = await this.req('POST', '/fapi/v3/order', { symbol: o.symbol, side, type: 'MARKET', quantity: qty, newClientOrderId: o.clientId });
    try {
      await this.req('POST', '/fapi/v3/order', { symbol: o.symbol, side: exit, type: 'STOP_MARKET', stopPrice: roundTick(o.stop, ins.tickSize), closePosition: 'true', workingType: 'MARK_PRICE', newClientOrderId: `${o.clientId}s` });
    } catch (e) {
      await this.req('POST', '/fapi/v3/order', { symbol: o.symbol, side: exit, type: 'MARKET', quantity: qty, reduceOnly: 'true', newClientOrderId: `${o.clientId}x` }).catch(() => {});
      throw new ExchangeError(`stop could not be placed, entry closed: ${(e as Error).message}`);
    }
    if (o.tp) await this.req('POST', '/fapi/v3/order', { symbol: o.symbol, side: exit, type: 'TAKE_PROFIT_MARKET', stopPrice: roundTick(o.tp, ins.tickSize), closePosition: 'true', workingType: 'MARK_PRICE', newClientOrderId: `${o.clientId}t` }).catch(() => {});
    return { orderId: r?.orderId != null ? String(r.orderId) : null };
  }
  async getOrder(symbol: string, clientId: string): Promise<OrderRecord> {
    try {
      const r = await this.req('GET', '/fapi/v3/order', { symbol, origClientOrderId: clientId });
      const map: Record<string, OrderRecord['status']> = { FILLED: 'filled', PARTIALLY_FILLED: 'partial', NEW: 'open', REJECTED: 'rejected', CANCELED: 'cancelled', EXPIRED: 'cancelled' };
      return { clientId, orderId: String(r.orderId), status: map[r.status] ?? 'unknown', filledQty: Number(r.executedQty ?? 0), avgPrice: Number(r.avgPrice) || null, raw: r.status };
    } catch { return { clientId, orderId: '', status: 'unknown', filledQty: 0, avgPrice: null }; }
  }
  async positions(symbol?: string): Promise<VenuePosition[]> {
    const r = await this.req('GET', '/fapi/v3/positionRisk', { symbol });
    if (!Array.isArray(r)) throw new ExchangeError('aster: incomplete position response');
    const rows = r as Array<{ symbol: string; positionAmt: unknown; entryPrice: unknown; leverage?: unknown; markPrice?: unknown; unRealizedProfit?: unknown }>;
    return rows.filter((p) => Number(p.positionAmt) !== 0).map((p) => ({ symbol: p.symbol, side: Number(p.positionAmt) > 0 ? 'LONG' : 'SHORT', qty: Math.abs(Number(p.positionAmt)), entry: Number(p.entryPrice), leverage: Number(p.leverage) || undefined, mark: Number(p.markPrice) || undefined, stop: null, tp: null, unrealizedPnl: Number(p.unRealizedProfit ?? 0) }));
  }
  async closePosition(symbol: string, side: Side, qty: number, clientId: string) {
    const r = await this.req('POST', '/fapi/v3/order', { symbol, side: side === 'LONG' ? 'SELL' : 'BUY', type: 'MARKET', quantity: qty, reduceOnly: 'true', newClientOrderId: clientId });
    return { orderId: r?.orderId != null ? String(r.orderId) : null };
  }
  async cancelOrder(symbol: string, clientId: string) { await this.req('DELETE', '/fapi/v3/order', { symbol, origClientOrderId: clientId }); }
  async cancelAll(symbol: string) { await this.req('DELETE', '/fapi/v3/allOpenOrders', { symbol }); }
  async protection(symbol: string, side: Side): Promise<Protection> {
    const open: any[] = await this.req('GET', '/fapi/v3/openOrders', { symbol });
    return pickProtection(side, (open ?? []).map((o) => ({
      price: Number(o.stopPrice), kind: /^STOP/.test(o.type) ? 'stop' as const : /^TAKE_PROFIT/.test(o.type) ? 'tp' as const : 'unknown' as const,
      closes: (o.side === 'SELL' ? 'LONG' : 'SHORT') as Side
    })).filter((t) => t.kind !== 'unknown'));
  }
  async protect(p: ProtectRequest) {
    const ins = await this.instrument(p.symbol);
    const exit = p.side === 'LONG' ? 'SELL' : 'BUY';
    if (p.stop) await this.req('POST', '/fapi/v3/order', { symbol: p.symbol, side: exit, type: 'STOP_MARKET', stopPrice: roundTick(p.stop, ins.tickSize), closePosition: 'true', workingType: 'MARK_PRICE', newClientOrderId: `${p.clientId}s` });
    if (p.tp) await this.req('POST', '/fapi/v3/order', { symbol: p.symbol, side: exit, type: 'TAKE_PROFIT_MARKET', stopPrice: roundTick(p.tp, ins.tickSize), closePosition: 'true', workingType: 'MARK_PRICE', newClientOrderId: `${p.clientId}t` });
  }
}
