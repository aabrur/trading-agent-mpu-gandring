import { describe, expect, it } from 'vitest';
import { assertLivePermissionEvidence } from '../../server/v2/execution/adapters/types.js';
import {
  createVenueAdapter,
  signBinanceQuery
} from '../../server/v2/execution/adapters/binance.js';

const API_KEY = 'binanceKey00001';
const API_SECRET = 'binanceSecret99999999999999999';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

describe('T11d Binance USD-M Futures VenueAdapter conformance', () => {
  it('computes deterministic HMAC-SHA256 query signature vector, verifies apiRestrictions on mainnet, and refuses testnet unverified permissions for LIVE', async () => {
    const sig = signBinanceQuery('symbol=BTCUSDT&recvWindow=5000&timestamp=1761900000000', API_SECRET);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(sig).toBe(
      signBinanceQuery('symbol=BTCUSDT&recvWindow=5000&timestamp=1761900000000', API_SECRET)
    );

    const mainnetTradeOnly = createVenueAdapter({
      network: 'mainnet',
      credentialRef: 'cred://binance/main',
      readSecret: async () => ({ key: API_KEY, secret: API_SECRET }),
      fetchImpl: (async (input) => {
        const url = new URL(String(input));
        if (url.pathname === '/sapi/v1/account/apiRestrictions') {
          return jsonResponse({
            enableFutures: true,
            enableWithdrawals: false,
            ipRestrict: true
          });
        }
        return jsonResponse({});
      }) as typeof fetch
    });
    expect(mainnetTradeOnly.status).toBe('experimental');
    const perms = await mainnetTradeOnly.permissions();
    expect(() => assertLivePermissionEvidence(perms)).not.toThrow();

    // Testnet Demo Trading returns verified=false, canWithdraw=null -> refused for LIVE
    const testnetDemo = createVenueAdapter({
      network: 'testnet',
      credentialRef: 'cred://binance/demo',
      readSecret: async () => ({ key: API_KEY, secret: API_SECRET }),
      fetchImpl: (async () => jsonResponse([{ asset: 'USDT', balance: '1000' }])) as typeof fetch
    });
    const demoPerms = await testnetDemo.permissions();
    expect(demoPerms.verified).toBe(false);
    expect(() => assertLivePermissionEvidence(demoPerms)).toThrow(/verified|withdraw/i);
  });

  it('keeps submit ACCEPTED until lookup confirms fill, rejects wrong hedge leg, enforces stop quantity coverage, and preserves null history fields', async () => {
    let orderPosts = 0;
    let orderState = 'NEW';
    let executedQty = '0';
    let avgPrice = '0';
    let openStopOrders: Array<Record<string, unknown>> = [];

    const adapter = createVenueAdapter({
      network: 'testnet',
      credentialRef: 'cred://binance/demo',
      readSecret: async () => ({ key: API_KEY, secret: API_SECRET }),
      fetchImpl: (async (input, init) => {
        const url = new URL(String(input));
        const method = (init?.method ?? 'GET').toUpperCase();

        if (url.pathname === '/fapi/v1/exchangeInfo') {
          return jsonResponse({
            symbols: [
              {
                symbol: 'BTCUSDT',
                contractSize: 1,
                quoteAsset: 'USDT',
                filters: [
                  { filterType: 'PRICE_FILTER', tickSize: '0.1' },
                  { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '100' },
                  { filterType: 'MARKET_LOT_SIZE', stepSize: '0.001', minQty: '0.002', maxQty: '50' },
                  { filterType: 'MIN_NOTIONAL', notional: '5' }
                ]
              }
            ]
          });
        }
        if (url.pathname === '/fapi/v1/ticker/price') {
          return jsonResponse({ symbol: 'BTCUSDT', price: '68500.0', time: 1_761_900_000_050 });
        }
        if (url.pathname === '/fapi/v1/leverage') {
          return jsonResponse({ leverage: 5, symbol: 'BTCUSDT' });
        }
        if (url.pathname === '/fapi/v1/order' && method === 'POST') {
          const type = url.searchParams.get('type');
          if (type === 'MARKET') {
            orderPosts += 1;
            return jsonResponse({
              orderId: 3301,
              clientOrderId: url.searchParams.get('newClientOrderId'),
              status: 'NEW'
            });
          }
          if (type === 'STOP_MARKET') {
            openStopOrders = [
              {
                orderId: 3302,
                symbol: 'BTCUSDT',
                side: url.searchParams.get('side'),
                positionSide: url.searchParams.get('positionSide') ?? 'BOTH',
                type: 'STOP_MARKET',
                stopPrice: url.searchParams.get('stopPrice'),
                closePosition: url.searchParams.get('closePosition') === 'true',
                origQty: '0'
              }
            ];
            return jsonResponse({ orderId: 3302 });
          }
          return jsonResponse({ orderId: 3303 });
        }
        if (url.pathname === '/fapi/v1/order' && method === 'GET') {
          return jsonResponse({
            orderId: 3301,
            clientOrderId: url.searchParams.get('origClientOrderId'),
            status: orderState,
            executedQty,
            avgPrice
          });
        }
        if (url.pathname === '/fapi/v2/positionRisk') {
          return jsonResponse([
            {
              symbol: 'BTCUSDT',
              positionSide: 'LONG',
              positionAmt: '0.040',
              entryPrice: '68420.0',
              unRealizedProfit: null
            }
          ]);
        }
        if (url.pathname === '/fapi/v1/openOrders') {
          return jsonResponse(openStopOrders);
        }
        if (url.pathname === '/fapi/v1/income') {
          return jsonResponse([
            {
              tranId: 901,
              symbol: 'BTCUSDT',
              incomeType: 'COMMISSION',
              income: '',
              asset: 'USDT',
              time: 1_761_900_009_000
            }
          ]);
        }
        return jsonResponse({});
      }) as typeof fetch
    });

    // Stricter MARKET_LOT_SIZE minQty (0.002) wins
    const rules = await adapter.instruments('BTCUSDT');
    expect(rules.minQty).toBe('0.002');
    expect(rules.restingLimitGtcEntry).toBe(false);

    // Wrong hedge leg rejected
    await expect(
      adapter.submit({
        clientOrderId: 'cid-bn-bad-leg',
        symbol: 'BTCUSDT',
        side: 'LONG',
        positionMode: 'HEDGE',
        hedgeLeg: 'SHORT',
        orderType: 'MARKET',
        quantity: '0.040',
        limitPrice: null,
        leverage: 5,
        expireAt: null
      })
    ).rejects.toThrow(/hedge/i);

    const submitted = await adapter.submit({
      clientOrderId: 'cid-bn-1',
      symbol: 'BTCUSDT',
      side: 'LONG',
      positionMode: 'HEDGE',
      hedgeLeg: 'LONG',
      orderType: 'MARKET',
      quantity: '0.0409',
      limitPrice: null,
      leverage: 5,
      expireAt: null
    });
    expect(submitted.state).toBe('ACCEPTED');
    expect(submitted.filledQty).toBeNull();
    expect(orderPosts).toBe(1);

    // Timeout lookup finds single order without resend
    expect((await adapter.lookupOrder('BTCUSDT', 'cid-bn-1')).state).toBe('ACCEPTED');
    expect(orderPosts).toBe(1);

    orderState = 'FILLED';
    executedQty = '0.040';
    avgPrice = '68420.0';
    const filled = await adapter.lookupOrder('BTCUSDT', 'cid-bn-1');
    expect(filled.state).toBe('FILLED');
    expect(filled.filledQty).toBe('0.040');

    const positions = await adapter.positions();
    expect(positions).toHaveLength(1);
    expect(positions[0]?.unrealizedPnl).toBeNull();

    // Missing stop -> MISSING
    expect((await adapter.protection(positions[0]!)).state).toBe('MISSING');

    // Partial reduce-only stop (0.020 < 0.040) -> MISSING
    openStopOrders = [
      {
        orderId: 3399,
        symbol: 'BTCUSDT',
        side: 'SELL',
        positionSide: 'LONG',
        type: 'STOP_MARKET',
        stopPrice: '67200.0',
        closePosition: false,
        reduceOnly: true,
        origQty: '0.020'
      }
    ];
    const partial = await adapter.protection(positions[0]!);
    expect(partial.coveredQty).toBe('0.02');
    expect(partial.state).toBe('MISSING');

    // Full closePosition stop -> VERIFIED
    const full = await adapter.protect(positions[0]!, {
      stopPrice: '67200.08',
      tpPrice: null,
      triggerBy: 'MARK_PRICE',
      clientOrderId: 'prot-bn-1'
    });
    expect(full.state).toBe('VERIFIED');
    expect(full.coveredQty).toBe('0.040');
    expect(full.stopPrice).toBe('67200.0');

    // Financial history preserves null fields
    const hist = await adapter.financialHistory(null);
    expect(hist.records).toHaveLength(1);
    expect(hist.records[0]?.feeAmount).toBeNull();
    expect(hist.records[0]?.realizedPnl).toBeNull();
    expect(hist.records[0]?.fundingAmount).toBeNull();
  });
});
