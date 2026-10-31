import { describe, expect, it } from 'vitest';
import {
  assertLivePermissionEvidence
} from '../../server/v2/execution/adapters/types.js';
import {
  createVenueAdapter,
  signBybitV5
} from '../../server/v2/execution/adapters/bybit.js';

const API_KEY = 'bybitTestKey00001';
const API_SECRET = 'bybitTestSecret999999999999999';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

describe('T11a Bybit v5 linear VenueAdapter conformance', () => {
  it('computes deterministic Bybit V5 HMAC-SHA256 signature vector and scrubs secrets from transport errors', async () => {
    const sig = signBybitV5({
      timestamp: '1761900000000',
      apiKey: API_KEY,
      recvWindow: '5000',
      payload: 'accountType=UNIFIED',
      secret: API_SECRET
    });
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(sig).toBe(
      signBybitV5({
        timestamp: '1761900000000',
        apiKey: API_KEY,
        recvWindow: '5000',
        payload: 'accountType=UNIFIED',
        secret: API_SECRET
      })
    );

    const adapter = createVenueAdapter({
      network: 'testnet',
      credentialRef: 'cred://bybit/testnet',
      readSecret: async () => ({ key: API_KEY, secret: API_SECRET }),
      fetchImpl: (async () =>
        jsonResponse(
          { retCode: 10003, retMsg: `Invalid api_key ${API_SECRET}` },
          401
        )) as typeof fetch
    });

    await expect(adapter.balance()).rejects.toThrow();
    try {
      await adapter.balance();
    } catch (err) {
      expect(String(err)).not.toContain(API_SECRET);
    }
  });

  it('verifies trade-only permissions, refuses withdraw-enabled keys for LIVE, and keeps submit acknowledgement ACCEPTED until lookup confirms fill', async () => {
    let createCalls = 0;
    let orderFilled = false;

    const adapter = createVenueAdapter({
      network: 'testnet',
      credentialRef: 'cred://bybit/testnet',
      readSecret: async () => ({ key: API_KEY, secret: API_SECRET }),
      fetchImpl: (async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === '/v5/market/time') {
          return jsonResponse({ retCode: 0, retMsg: 'OK', time: 1_761_900_000_000, result: { timeNano: '1761900000000000000' } });
        }
        if (url.pathname === '/v5/user/query-api') {
          return jsonResponse({
            retCode: 0,
            retMsg: 'OK',
            result: {
              userID: '884422',
              readOnly: 0,
              permissions: { ContractTrade: ['Order', 'Position'], Wallet: [] },
              ips: ['127.0.0.1']
            }
          });
        }
        if (url.pathname === '/v5/market/instruments-info') {
          return jsonResponse({
            retCode: 0,
            retMsg: 'OK',
            result: {
              list: [
                {
                  symbol: 'BTCUSDT',
                  settleCoin: 'USDT',
                  priceFilter: { tickSize: '0.1' },
                  lotSizeFilter: { qtyStep: '0.001', minOrderQty: '0.001', maxMktOrderQty: '100', minNotionalValue: '5' }
                }
              ]
            }
          });
        }
        if (url.pathname === '/v5/market/tickers') {
          return jsonResponse({
            retCode: 0,
            retMsg: 'OK',
            time: 1_761_900_000_100,
            result: { list: [{ symbol: 'BTCUSDT', lastPrice: '68500.0', bid1Price: '68499.9', ask1Price: '68500.1' }] }
          });
        }
        if (url.pathname === '/v5/position/set-leverage') {
          return jsonResponse({ retCode: 110043, retMsg: 'leverage not modified', result: {} });
        }
        if (url.pathname === '/v5/order/create') {
          createCalls += 1;
          const body = JSON.parse(String(init?.body ?? '{}'));
          expect(body.orderLinkId).toBe('cid-bybit-1');
          return jsonResponse({ retCode: 0, retMsg: 'OK', result: { orderId: 'bybit-ord-1', orderLinkId: 'cid-bybit-1' } });
        }
        if (url.pathname === '/v5/order/realtime') {
          return jsonResponse({
            retCode: 0,
            retMsg: 'OK',
            result: {
              list: [
                orderFilled
                  ? {
                      orderId: 'bybit-ord-1',
                      orderLinkId: 'cid-bybit-1',
                      symbol: 'BTCUSDT',
                      orderStatus: 'Filled',
                      cumExecQty: '0.015',
                      avgPrice: '68501.2'
                    }
                  : {
                      orderId: 'bybit-ord-1',
                      orderLinkId: 'cid-bybit-1',
                      symbol: 'BTCUSDT',
                      orderStatus: 'New',
                      cumExecQty: '0',
                      avgPrice: ''
                    }
              ]
            }
          });
        }
        return jsonResponse({ retCode: 0, retMsg: 'OK', result: { list: [] } });
      }) as typeof fetch
    });

    expect(adapter.status).toBe('implemented');
    const perms = await adapter.permissions();
    expect(() => assertLivePermissionEvidence(perms)).not.toThrow();

    const withdrawAdapter = createVenueAdapter({
      network: 'mainnet',
      credentialRef: 'cred://bybit/bad',
      readSecret: async () => ({ key: API_KEY, secret: API_SECRET }),
      fetchImpl: (async (input) => {
        const url = new URL(String(input));
        if (url.pathname === '/v5/market/time') return jsonResponse({ retCode: 0, time: 1_761_900_000_000 });
        return jsonResponse({
          retCode: 0,
          retMsg: 'OK',
          result: { userID: '99', readOnly: 0, permissions: { ContractTrade: ['Order'], Wallet: ['Withdraw'] } }
        });
      }) as typeof fetch
    });
    const badPerms = await withdrawAdapter.permissions();
    expect(() => assertLivePermissionEvidence(badPerms)).toThrow(/withdraw/i);

    const submitted = await adapter.submit({
      clientOrderId: 'cid-bybit-1',
      symbol: 'BTCUSDT',
      side: 'LONG',
      positionMode: 'ONE_WAY',
      hedgeLeg: null,
      orderType: 'MARKET',
      quantity: '0.0159',
      limitPrice: null,
      leverage: 5,
      expireAt: null
    });
    // Submit ack alone MUST NOT claim FILLED
    expect(submitted.state).toBe('ACCEPTED');
    expect(submitted.filledQty).toBeNull();
    expect(createCalls).toBe(1);

    // Timeout recovery via lookupOrder finds single order without resending
    const openLookup = await adapter.lookupOrder('BTCUSDT', 'cid-bybit-1');
    expect(openLookup.state).toBe('ACCEPTED');
    expect(createCalls).toBe(1);

    orderFilled = true;
    const filledLookup = await adapter.lookupOrder('BTCUSDT', 'cid-bybit-1');
    expect(filledLookup.state).toBe('FILLED');
    expect(filledLookup.filledQty).toBe('0.015');
    expect(filledLookup.avgFillPrice).toBe('68501.2');
    expect(createCalls).toBe(1);
  });

  it('rejects wrong hedge leg, treats zero/partial stop readback as not VERIFIED, and preserves null fees/funding/PnL', async () => {
    let stopLossOnPos = '';
    let stopOrders: Array<Record<string, unknown>> = [];

    const adapter = createVenueAdapter({
      network: 'testnet',
      credentialRef: 'cred://bybit/testnet',
      readSecret: async () => ({ key: API_KEY, secret: API_SECRET }),
      fetchImpl: (async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === '/v5/market/time') {
          return jsonResponse({ retCode: 0, time: 1_761_900_000_000 });
        }
        if (url.pathname === '/v5/market/instruments-info') {
          return jsonResponse({
            retCode: 0,
            result: {
              list: [
                {
                  symbol: 'BTCUSDT',
                  settleCoin: 'USDT',
                  priceFilter: { tickSize: '0.1' },
                  lotSizeFilter: { qtyStep: '0.001', minOrderQty: '0.001', maxMktOrderQty: '100', minNotionalValue: '5' }
                }
              ]
            }
          });
        }
        if (url.pathname === '/v5/market/tickers') {
          return jsonResponse({
            retCode: 0,
            time: 1_761_900_000_100,
            result: { list: [{ symbol: 'BTCUSDT', lastPrice: '68500.0', bid1Price: '68499.9', ask1Price: '68500.1' }] }
          });
        }
        if (url.pathname === '/v5/position/list') {
          return jsonResponse({
            retCode: 0,
            result: {
              list: [
                {
                  symbol: 'BTCUSDT',
                  side: 'Buy',
                  positionIdx: 1,
                  size: '0.050',
                  avgPrice: '68400.0',
                  stopLoss: stopLossOnPos,
                  takeProfit: '',
                  unrealisedPnl: ''
                }
              ],
              nextPageCursor: ''
            }
          });
        }
        if (url.pathname === '/v5/order/realtime') {
          return jsonResponse({ retCode: 0, result: { list: stopOrders } });
        }
        if (url.pathname === '/v5/position/trading-stop') {
          const body = JSON.parse(String(init?.body ?? '{}'));
          expect(body.positionIdx).toBe(1);
          stopLossOnPos = String(body.stopLoss ?? '');
          return jsonResponse({ retCode: 0, result: {} });
        }
        if (url.pathname === '/v5/execution/list') {
          return jsonResponse({
            retCode: 0,
            result: {
              list: [
                {
                  execId: 'exec-1',
                  symbol: 'BTCUSDT',
                  side: 'Buy',
                  execQty: '0.050',
                  execPrice: '68400.0',
                  execFee: '',
                  closedPnl: '',
                  execTime: '1761900001000'
                }
              ],
              nextPageCursor: ''
            }
          });
        }
        if (url.pathname === '/v5/account/transaction-log') {
          return jsonResponse({ retCode: 0, result: { list: [], nextPageCursor: '' } });
        }
        return jsonResponse({ retCode: 0, result: { list: [] } });
      }) as typeof fetch
    });

    // Wrong hedge leg rejected
    await expect(
      adapter.submit({
        clientOrderId: 'cid-wrong-leg',
        symbol: 'BTCUSDT',
        side: 'LONG',
        positionMode: 'HEDGE',
        hedgeLeg: 'SHORT',
        orderType: 'MARKET',
        quantity: '0.010',
        limitPrice: null,
        leverage: 5,
        expireAt: null
      })
    ).rejects.toThrow(/hedge/i);

    const positions = await adapter.positions();
    expect(positions).toHaveLength(1);
    expect(positions[0]?.positionMode).toBe('HEDGE');
    expect(positions[0]?.hedgeLeg).toBe('LONG');
    expect(positions[0]?.unrealizedPnl).toBeNull();

    // Missing stop -> MISSING (not VERIFIED)
    const missingProt = await adapter.protection(positions[0]!);
    expect(missingProt.state).toBe('MISSING');

    // Partial reduce-only stop order -> coveredQty 0.030 < 0.050 -> MISSING (not VERIFIED)
    stopOrders = [
      {
        orderId: 'sl-part-1',
        symbol: 'BTCUSDT',
        side: 'Sell',
        positionIdx: 1,
        reduceOnly: true,
        qty: '0.030',
        triggerPrice: '67200.0',
        orderStatus: 'Untriggered'
      }
    ];
    const partialProt = await adapter.protection(positions[0]!);
    expect(partialProt.coveredQty).toBe('0.03');
    expect(partialProt.state).toBe('MISSING');

    // Full position-bound trading-stop -> VERIFIED on readback
    stopOrders = [];
    const verifiedProt = await adapter.protect(positions[0]!, {
      stopPrice: '67200.04',
      tpPrice: null,
      triggerBy: 'MARK_PRICE',
      clientOrderId: 'prot-bybit-1'
    });
    expect(verifiedProt.state).toBe('VERIFIED');
    expect(verifiedProt.coveredQty).toBe('0.050');
    expect(verifiedProt.stopPrice).toBe('67200.0');

    // Financial history preserves null fee/PnL/funding when absent
    const history = await adapter.financialHistory(null);
    expect(history.records).toHaveLength(1);
    expect(history.records[0]?.feeAmount).toBeNull();
    expect(history.records[0]?.realizedPnl).toBeNull();
    expect(history.records[0]?.fundingAmount).toBeNull();
  });
});
