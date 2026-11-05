import { describe, expect, it } from 'vitest';
import {
  prepareNativeOrderQuantities
} from '../../server/v2/execution/adapters/types.js';
import {
  createVenueAdapter
} from '../../server/v2/execution/adapters/bybit.js';

const API_KEY = 'bybitTestKey00001';
const API_SECRET = 'bybitTestSecret999999999999999';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

describe('Task 1: LIMIT_GTC execution capability and Bybit adapter integration', () => {
  it('prepares LIMIT_GTC quantities without capability error when restingLimitGtcEntry is true', () => {
    const rules = {
      venue: 'bybit' as const,
      nativeSymbol: 'BTCUSDT',
      minQty: '0.001',
      maxQty: '100',
      qtyStep: '0.001',
      tickSize: '0.1',
      minNotional: '5',
      contractMultiplier: '1',
      settlementCurrency: 'USDT',
      positionModeCapability: 'BOTH' as const,
      exchangeStops: true,
      restingLimitGtcEntry: true
    };

    const prepared = prepareNativeOrderQuantities(
      {
        clientOrderId: 'cid-limit-1',
        symbol: 'BTCUSDT',
        side: 'LONG',
        positionMode: 'ONE_WAY',
        hedgeLeg: null,
        orderType: 'LIMIT_GTC',
        quantity: '0.015',
        limitPrice: '68000.5',
        leverage: 5,
        expireAt: null
      },
      rules,
      '68100'
    );

    expect(prepared.quantity).toBe('0.015');
    expect(prepared.limitPrice).toBe('68000.5');
  });

  it('submits native LIMIT_GTC order to Bybit v5 with Limit orderType and GTC timeInForce', async () => {
    let capturedBody: any = null;

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
                  lotSizeFilter: { minOrderQty: '0.001', maxOrderQty: '100', qtyStep: '0.001', minNotionalValue: '5' }
                }
              ]
            }
          });
        }
        if (url.pathname === '/v5/market/tickers') {
          return jsonResponse({
            retCode: 0,
            result: { list: [{ symbol: 'BTCUSDT', lastPrice: '68050' }] }
          });
        }
        if (url.pathname === '/v5/position/set-leverage') {
          return jsonResponse({ retCode: 0, retMsg: 'OK' });
        }
        if (url.pathname === '/v5/order/create') {
          capturedBody = JSON.parse(String(init?.body));
          return jsonResponse({
            retCode: 0,
            retMsg: 'OK',
            result: { orderId: 'bybit-limit-ord-1', orderLinkId: capturedBody.orderLinkId }
          });
        }
        return jsonResponse({ retCode: 0, retMsg: 'OK', result: { list: [] } });
      }) as typeof fetch
    });

    expect(adapter.capabilities.restingLimitGtcEntry).toBe(true);

    const rules = await adapter.instruments('BTCUSDT');
    expect(rules.restingLimitGtcEntry).toBe(true);

    const submitted = await adapter.submit({
      clientOrderId: 'cid-limit-gtc-1',
      symbol: 'BTCUSDT',
      side: 'LONG',
      positionMode: 'ONE_WAY',
      hedgeLeg: null,
      orderType: 'LIMIT_GTC',
      quantity: '0.015',
      limitPrice: '68000.5',
      leverage: 5,
      expireAt: null
    });

    expect(submitted.state).toBe('ACCEPTED');
    expect(submitted.venueOrderId).toBe('bybit-limit-ord-1');
    expect(capturedBody).not.toBeNull();
    expect(capturedBody.orderType).toBe('Limit');
    expect(capturedBody.timeInForce).toBe('GTC');
    expect(capturedBody.price).toBe('68000.5');
    expect(capturedBody.qty).toBe('0.015');
  });
});
