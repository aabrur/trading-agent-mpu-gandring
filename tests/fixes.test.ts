// Fixes from the 2026-10-17 testnet run: min notional on every venue, Hyperliquid step/tick, EXCHANGE=none in gb size,
// Connect wallet verification (tests/wallet.test.ts), persisted kill switch, stop required on every ticket, no duplicate fill log,
// local-only bind by default. Mocked venues only.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { base58 } from '@scure/base';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../server/config.js';
import { Desk } from '../server/desk.js';
import { makeCaller } from '../server/providers/index.js';
import { adapterRules, clearRulesCache } from '../server/exchange/rules.js';
import { BinanceAdapter } from '../server/exchange/binance.js';
import { BybitAdapter } from '../server/exchange/bybit.js';
import { ParadexAdapter } from '../server/exchange/paradex.js';
import { OrderlyAdapter } from '../server/exchange/orderly.js';
import { HyperliquidAdapter, hlStep, hlTick, hlPrice, HL_MIN_NOTIONAL } from '../server/exchange/hyperliquid.js';
import { planOrder } from '../server/money.js';
import { gb } from '../cli/gb.js';
import { getSnapshot } from '../server/market/index.js';
import { unkill } from '../cli/unkill.js';
import { readKill } from '../server/killswitch.js';

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
const desk = { balance: 14.44, equity: 14.44, safetyNet: 3, n: 2, openPositions: 0, usedMargin: 0, sizeFactor: 1, leverage: 3, minStopPct: 0.3, maxStopPct: 1.5, minOrderUsdt: 5, maxLossPerTradePct: 10, takerFee: 0.00055, takeProfitR: 2 };
beforeEach(() => clearRulesCache());

describe('bug 1: minimum notional is read on every venue that publishes one', () => {
  it('Binance: MIN_NOTIONAL 20 from exchangeInfo; a 17 USDT order is refused instead of being sent', async () => {
    const info = { symbols: [{ symbol: 'ETHUSDT', status: 'TRADING', filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.01' }, { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '10000' }, { filterType: 'MARKET_LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '2000' }, { filterType: 'MIN_NOTIONAL', notional: '20' }] }] };
    let calls = 0;
    const f = (async (url: string) => { calls++; expect(url).toBe('https://demo-fapi.binance.com/fapi/v1/exchangeInfo'); return json(info); }) as unknown as typeof fetch;
    const a = new BinanceAdapter('testnet', 'k', 's', f);
    const r = await adapterRules(a, 'ETHUSDT');
    expect(r).toMatchObject({ qtyStep: 0.001, minQty: 0.001, tickSize: 0.01, minNotional: 20, maxQty: 2000, status: 'TRADING' });
    expect((await a.instrument('ETHUSDT')).minNotional).toBe(20);
    expect(calls).toBe(1); // cached
    const p = planOrder({ ...desk, price: 2434.8, side: 'LONG', stop: 2410.45, rules: r });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toMatch(/minimum notional 20/);
  });
  it('Bybit: minNotionalValue and status Trading (normalized to TRADING)', async () => {
    const f = (async () => json({ retCode: 0, result: { list: [{ symbol: 'ETHUSDT', status: 'Trading', lotSizeFilter: { qtyStep: '0.01', minOrderQty: '0.01', maxMktOrderQty: '2000', minNotionalValue: '5' }, priceFilter: { tickSize: '0.01' } }] } })) as unknown as typeof fetch;
    const r = await adapterRules(new BybitAdapter('testnet', 'k', 's', f), 'ETHUSDT');
    expect(r).toMatchObject({ qtyStep: 0.01, minNotional: 5, maxQty: 2000, status: 'TRADING' });
  });
  it('Paradex and Orderly: min_notional 10', async () => {
    const pf = (async () => json({ results: [{ symbol: 'ETH-USD-PERP', order_size_increment: '0.0001', price_tick_size: '0.01', min_notional: '10' }] })) as unknown as typeof fetch;
    const pr = await adapterRules(new ParadexAdapter('testnet', '0x' + 'a'.repeat(60), '0x' + 'b'.repeat(60), pf), 'ETHUSDT');
    expect(pr).toMatchObject({ qtyStep: 0.0001, tickSize: 0.01, minNotional: 10 });
    const of = (async () => json({ success: true, data: { symbol: 'PERP_ETH_USDC', base_min: 0.0001, base_tick: 0.0001, base_max: 500, quote_tick: 0.01, min_notional: 10 } })) as unknown as typeof fetch;
    const or = await adapterRules(new OrderlyAdapter('testnet', '0x' + 'c'.repeat(64), 'ed25519:' + base58.encode(randomBytes(32)), of), 'ETHUSDT');
    expect(or).toMatchObject({ qtyStep: 0.0001, tickSize: 0.01, minNotional: 10, maxQty: 500 });
    // a 9 USDT order is refused on both
    const p = planOrder({ ...desk, safetyNet: 11.4, price: 2434.8, side: 'LONG', stop: 2410.45, rules: or });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toMatch(/minimum notional 10/);
  });
});

describe('bug 2: Hyperliquid lot step and price tick', () => {
  it('step is exact and the tick follows 5 significant figures and 6 - szDecimals decimals', () => {
    expect(hlStep(4)).toBe(0.0001);
    expect(hlStep(0)).toBe(1);
    expect(hlTick(2671.9, 4)).toBe(0.1);
    expect(hlTick(117700, 5)).toBe(1); // integer prices always allowed
    expect(hlTick(115.5, 2)).toBe(0.01);
    expect(hlTick(0.0249, 0)).toBe(0.000001); // capped by 6 - szDecimals decimals
  });
  it('instrument() returns the exact step, a real tick and the $10 minimum; the planned stop never needs re-rounding', async () => {
    const f = (async (_u: string, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body));
      if (b.type === 'meta') return json({ universe: [{ name: 'ETH', szDecimals: 4 }] });
      if (b.type === 'allMids') return json({ ETH: '2429.15' });
      return json({});
    }) as unknown as typeof fetch;
    const a = new HyperliquidAdapter('testnet', privateKeyToAccount(generatePrivateKey()).address, generatePrivateKey(), f);
    const r = await adapterRules(a, 'ETHUSDT');
    expect(r).toMatchObject({ qtyStep: 0.0001, minQty: 0.0001, tickSize: 0.1, minNotional: HL_MIN_NOTIONAL });
    const p = planOrder({ ...desk, price: 2429.15, side: 'LONG', stop: 2404.8585, rules: r });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.qty).toBe(0.007);
    expect(p.stop).toBe(2404.9); // rounded UP to the tick = toward the entry, never away
    expect(hlPrice(p.stop, 4)).toBe(p.stop); // the adapter sends exactly this trigger price
    const s = planOrder({ ...desk, price: 2429.15, side: 'SHORT', stop: 2453.4567, rules: r });
    expect(s.ok && s.stop).toBe(2453.4); // SHORT: rounded DOWN toward the entry
  });
});

describe('bug 3: gb size with EXCHANGE=none uses the market source rules', () => {
  it('reads Aster exchangeInfo instead of guessing a lot step from the price', async () => {
    const info = { symbols: [{ symbol: 'ETHUSDT', status: 'TRADING', filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.01' }, { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '10000' }, { filterType: 'MIN_NOTIONAL', notional: '5' }] }] };
    const f = (async (url: string) => { if (String(url).includes('/fapi/v3/exchangeInfo')) return json(info); throw new Error('offline'); }) as unknown as typeof fetch;
    const env = { TRADING_MODE: 'PAPER', EXCHANGE: 'none', MARKET_SOURCE: 'aster', PAPER_BALANCE: '14.44', SAFETY_NET: '3', OPEN_ORDERS_N: '2', MAX_LEVERAGE: '3', MAX_LOSS_PER_TRADE_PCT: '10' };
    const r = await gb(['size', 'ETHUSDT', 'LONG', '2434.8', '2410.45'], { env, fetchImpl: f, baseUrl: 'http://127.0.0.1:1' });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/LONG 0\.007 ETHUSDT/);
    expect(r.text).toMatch(/from aster/);
  });
});

describe('bug 6: kill switch survives a restart until the owner releases it', () => {
  it('kill writes the file, a new desk starts killed and refuses orders, unkill needs --yes', async () => {
    const killFile = path.join(mkdtempSync(path.join(tmpdir(), 'mg-kill-')), 'data', 'kill-switch.json');
    const c = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEBATE_PACE_MS: '0' });
    const d1 = new Desk(c, makeCaller(c), { reportsDir: null, killFile });
    await d1.kill();
    expect(readKill(killFile)).not.toBeNull();
    const d2 = new Desk(c, makeCaller(c), { reportsDir: null, killFile }); // "restart"
    expect(d2.killed).toBe(true);
    expect((await d2.executeOpen('BTCUSDT', 'LONG', 60000, { sizeFactor: 1, leverage: 2, stopPct: 1 })).ok).toBe(false);
    expect((await d2.gbOpen({ symbol: 'BTCUSDT', side: 'LONG', confidence: 0.8, stop: 59500 })).reply).toMatch(/kill switch/);
    expect(unkill([], killFile).ok).toBe(false); // no --yes: refuses
    expect(existsSync(killFile)).toBe(true);
    expect(unkill(['--yes'], killFile).ok).toBe(true);
    expect(existsSync(killFile)).toBe(false);
    const d3 = new Desk(c, makeCaller(c), { reportsDir: null, killFile });
    expect(d3.killed).toBe(false);
  });
});

describe('profile protection on every ticket; one log line per fill', () => {
  it('gb open lets the desk derive protection from the active profile', async () => {
    let sent = 0;
    const f = (async () => { sent++; return json({ ok: true }); }) as unknown as typeof fetch;
    const r = await gb(['open', 'ETHUSDT', 'LONG'], { env: { TRADING_MODE: 'PAPER', AGENT_EVENT_SECRET: 'x'.repeat(32) }, fetchImpl: f, baseUrl: 'http://127.0.0.1:1' });
    expect(r.ok).toBe(true);
    expect(sent).toBe(1);
  });
  it('direct tickets and Lead proposals receive profile stops and log each fill once', async () => {
    const c = loadConfig({ TRADING_MODE: 'PAPER', APP_MODE: 'grokbot', AGENT_EVENT_SECRET: 'y'.repeat(32), MARKET_SOURCE: 'sample', DEBATE_PACE_MS: '0' });
    const d = new Desk(c, makeCaller(c), { reportsDir: null });
    const direct = await d.gbOpen({ symbol: 'ETHUSDT', side: 'LONG', confidence: 0.8 });
    expect(direct.ok).toBe(true);
    expect(direct.order?.stop).toBeGreaterThan(0);
    expect(direct.order?.stop).toBeLessThan(direct.order?.entry ?? 0);
    await d.gbClose('all');
    const r = await d.onAgentEvent({ agent: 'lead', kind: 'proposal', symbol: 'ETHUSDT', action: 'OPEN_LONG', confidence: 0.8 });
    expect(r.ok).toBe(true);
    expect(d.book.positions).toHaveLength(1);
    expect(d.book.positions[0].stop).toBeGreaterThan(0);
    expect(d.logs.filter((l) => /Paper fill/.test(l.text))).toHaveLength(2);
    d.stop();
  });
});

describe('bind to this computer by default', () => {
  it('PAPER and TESTNET default to 127.0.0.1, HOST=0.0.0.0 opens PAPER, LIVE always 127.0.0.1', () => {
    expect(loadConfig({ TRADING_MODE: 'PAPER' }).host).toBe('127.0.0.1');
    expect(loadConfig({ TRADING_MODE: 'PAPER', HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
  });
});
