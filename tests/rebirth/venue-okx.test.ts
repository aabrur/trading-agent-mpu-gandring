import { describe, expect, it } from 'vitest';
import { assertLivePermissionEvidence } from '../../server/v2/execution/adapters/types.js';
import {
  createVenueAdapter,
  signOkxV5
} from '../../server/v2/execution/adapters/okx.js';

const API_KEY = 'okxKey00001';
const API_SECRET = 'okxSecret99999999999999999';
const API_PASS = 'okxPassphrase777';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

describe('T11e OKX v5 SWAP VenueAdapter conformance', () => {
  it('computes deterministic HMAC-SHA256 Base64 signature vector, requires passphrase, sends x-simulated-trading on testnet, and refuses withdraw keys', async () => {
    const sig = signOkxV5({
      timestampIso: '2026-10-31T10:00:00.000Z',
      method: 'GET',
      requestPath: '/api/v5/account/config',
      body: '',
      secret: API_SECRET
    });
    expect(sig).toBe(
      signOkxV5({
        timestampIso: '2026-10-31T10:00:00.000Z',
        method: 'GET',
        requestPath: '/api/v5/account/config',
        body: '',
        secret: API_SECRET
      })
    );

    let sawSimHeader = false;
    const okAdapter = createVenueAdapter({
      network: 'testnet',
      credentialRef: 'cred://okx/demo',
      readSecret: async () => ({ key: API_KEY, secret: API_SECRET, passphrase: API_PASS }),
      fetchImpl: (async (_input, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        if (headers['x-simulated-trading'] === '1') sawSimHeader = true;
        return jsonResponse({
          code: '0',
          msg: '',
          data: [{ uid: '701', perm: 'read_only,trade', posMode: 'long_short_mode', ip: '127.0.0.1' }]
        });
      }) as typeof fetch
    });
    expect(okAdapter.status).toBe('experimental');
    const perms = await okAdapter.permissions();
    expect(sawSimHeader).toBe(true);
    expect(() => assertLivePermissionEvidence(perms)).not.toThrow();

    const withdrawAdapter = createVenueAdapter({
      network: 'mainnet',
      credentialRef: 'cred://okx/bad',
      readSecret: async () => ({ key: API_KEY, secret: API_SECRET, passphrase: API_PASS }),
      fetchImpl: (async () =>
        jsonResponse({
          code: '0',
          msg: '',
          data: [{ uid: '702', perm: 'read_only,trade,withdraw', posMode: 'net_mode' }]
        })) as typeof fetch
    });
    const badPerms = await withdrawAdapter.permissions();
    expect(() => assertLivePermissionEvidence(badPerms)).toThrow(/withdraw/i);
  });

  it('exposes exact ctVal contractMultiplier, keeps submit ACCEPTED until clOrdId lookup confirms fill, rejects wrong hedge leg, enforces algo stop coverage, and preserves null history fields', async () => {
    let orderPosts = 0;
    let orderState = 'live';
    let accFillSz = '0';
    let avgPx = '';
    let algoOrders: Array<Record<string, unknown>> = [];

    const adapter = createVenueAdapter({
      network: 'testnet',
      credentialRef: 'cred://okx/demo',
      readSecret: async () => ({ key: API_KEY, secret: API_SECRET, passphrase: API_PASS }),
      fetchImpl: (async (input, init) => {
        const url = new URL(String(input));
        const method = (init?.method ?? 'GET').toUpperCase();

        if (url.pathname === '/api/v5/public/instruments') {
          return jsonResponse({
            code: '0',
            data: [
              {
                instId: 'BTC-USDT-SWAP',
                ctVal: '0.01',
                lotSz: '1',
                minSz: '1',
                maxMktSz: '1000',
                tickSz: '0.1',
                settleCcy: 'USDT'
              }
            ]
          });
        }
        if (url.pathname === '/api/v5/market/ticker') {
          return jsonResponse({
            code: '0',
            data: [{ instId: 'BTC-USDT-SWAP', last: '68500.0', bidPx: '68499.9', askPx: '68500.1', ts: '1761900000100' }]
          });
        }
        if (url.pathname === '/api/v5/account/set-leverage') {
          return jsonResponse({ code: '0', data: [{ lever: '5' }] });
        }
        if (url.pathname === '/api/v5/trade/order' && method === 'POST') {
          orderPosts += 1;
          const body = JSON.parse(String(init?.body ?? '{}'));
          expect(body.posSide).toBe('long');
          expect(body.sz).toBe('3');
          return jsonResponse({ code: '0', data: [{ ordId: 'okx-ord-1', clOrdId: body.clOrdId, sCode: '0' }] });
        }
        if (url.pathname === '/api/v5/trade/order' && method === 'GET') {
          return jsonResponse({
            code: '0',
            data: [
              {
                ordId: 'okx-ord-1',
                clOrdId: url.searchParams.get('clOrdId'),
                state: orderState,
                accFillSz,
                avgPx
              }
            ]
          });
        }
        if (url.pathname === '/api/v5/account/positions') {
          return jsonResponse({
            code: '0',
            data: [
              {
                instId: 'BTC-USDT-SWAP',
                posSide: 'long',
                pos: '3',
                avgPx: '68410.0',
                lever: '5',
                upl: ''
              }
            ]
          });
        }
        if (url.pathname === '/api/v5/trade/orders-algo-pending') {
          const ordType = url.searchParams.get('ordType');
          return jsonResponse({
            code: '0',
            data: ordType === 'conditional' ? algoOrders : []
          });
        }
        if (url.pathname === '/api/v5/trade/order-algo' && method === 'POST') {
          const body = JSON.parse(String(init?.body ?? '{}'));
          algoOrders = [
            {
              algoId: 'algo-1',
              instId: body.instId,
              side: body.side,
              posSide: body.posSide,
              slTriggerPx: body.slTriggerPx,
              closeFraction: body.closeFraction,
              reduceOnly: 'true'
            }
          ];
          return jsonResponse({ code: '0', data: [{ algoId: 'algo-1', sCode: '0' }] });
        }
        if (url.pathname === '/api/v5/trade/fills') {
          return jsonResponse({
            code: '0',
            data: [
              {
                tradeId: 't-1',
                instId: 'BTC-USDT-SWAP',
                side: 'buy',
                fillSz: '3',
                fillPx: '68410.0',
                fee: '',
                pnl: '',
                ts: '1761900003000'
              }
            ]
          });
        }
        if (url.pathname === '/api/v5/account/bills') {
          return jsonResponse({ code: '0', data: [] });
        }
        return jsonResponse({ code: '0', data: [] });
      }) as typeof fetch
    });

    const rules = await adapter.instruments('BTCUSDT');
    expect(rules.contractMultiplier).toBe('0.01');
    expect(rules.qtyStep).toBe('1');

    // Wrong hedge leg rejected
    await expect(
      adapter.submit({
        clientOrderId: 'cid-okx-bad',
        symbol: 'BTCUSDT',
        side: 'LONG',
        positionMode: 'HEDGE',
        hedgeLeg: 'SHORT',
        orderType: 'MARKET',
        quantity: '3',
        limitPrice: null,
        leverage: 5,
        expireAt: null
      })
    ).rejects.toThrow(/hedge/i);

    const submitted = await adapter.submit({
      clientOrderId: 'cidokx1',
      symbol: 'BTCUSDT',
      side: 'LONG',
      positionMode: 'HEDGE',
      hedgeLeg: 'LONG',
      orderType: 'MARKET',
      quantity: '3.9',
      limitPrice: null,
      leverage: 5,
      expireAt: null
    });
    expect(submitted.state).toBe('ACCEPTED');
    expect(submitted.filledQty).toBeNull();
    expect(orderPosts).toBe(1);

    // Timeout lookup finds single order without resend
    expect((await adapter.lookupOrder('BTCUSDT', 'cidokx1')).state).toBe('ACCEPTED');
    expect(orderPosts).toBe(1);

    orderState = 'filled';
    accFillSz = '3';
    avgPx = '68410.0';
    const filled = await adapter.lookupOrder('BTCUSDT', 'cidokx1');
    expect(filled.state).toBe('FILLED');
    expect(filled.filledQty).toBe('3');

    const positions = await adapter.positions();
    expect(positions).toHaveLength(1);
    expect(positions[0]?.unrealizedPnl).toBeNull();

    // Missing stop -> MISSING
    expect((await adapter.protection(positions[0]!)).state).toBe('MISSING');

    // Partial algo stop (sz=1 < 3 contracts) -> MISSING
    algoOrders = [
      {
        algoId: 'algo-part',
        instId: 'BTC-USDT-SWAP',
        side: 'sell',
        posSide: 'long',
        slTriggerPx: '67200.0',
        sz: '1',
        reduceOnly: 'true'
      }
    ];
    const partial = await adapter.protection(positions[0]!);
    expect(partial.coveredQty).toBe('1');
    expect(partial.state).toBe('MISSING');

    // Full closeFraction=1 algo stop -> VERIFIED
    const full = await adapter.protect(positions[0]!, {
      stopPrice: '67200.04',
      tpPrice: null,
      triggerBy: 'MARK_PRICE',
      clientOrderId: 'protokx1'
    });
    expect(full.state).toBe('VERIFIED');
    expect(full.coveredQty).toBe('3');
    expect(full.stopPrice).toBe('67200.0');

    // Missing fee/PnL/funding remain null
    const hist = await adapter.financialHistory(null);
    expect(hist.records).toHaveLength(1);
    expect(hist.records[0]?.feeAmount).toBeNull();
    expect(hist.records[0]?.realizedPnl).toBeNull();
    expect(hist.records[0]?.fundingAmount).toBeNull();
  });
});
