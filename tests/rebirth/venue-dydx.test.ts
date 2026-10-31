import { describe, expect, it } from 'vitest';
import { assertLivePermissionEvidence } from '../../server/v2/execution/adapters/types.js';
import {
  createVenueAdapter,
  dydxAddressOf,
  dydxClientId,
  flattenAuthenticator,
  type DydxChain
} from '../../server/v2/execution/adapters/dydx.js';

const API_KEY = '0x1111111111111111111111111111111111111111111111111111111111111111';
const OWNER_ADDR = 'dydx14zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
const AUTH_ID = '42';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

describe('T11f dYdX v4 VenueAdapter conformance + authenticator verification', () => {
  it('derives deterministic Cosmos bech32 address, maps uint32 client ID, and verifies AllOf trade-only authenticator', async () => {
    const addr = dydxAddressOf(API_KEY);
    expect(addr.address).toMatch(/^dydx1/);
    expect(addr.pubKey.length).toBe(33);

    const numCid = dydxClientId('cid-dydx-1');
    expect(typeof numCid).toBe('number');
    expect(numCid).toBe(dydxClientId('cid-dydx-1'));

    const flattened = flattenAuthenticator('AllOf', JSON.stringify([
      { type: 'SignatureVerification', config: addr.pubKey.toString('base64') },
      { type: 'MessageFilter', config: '/dydxprotocol.clob.MsgPlaceOrder,/dydxprotocol.clob.MsgCancelOrder' }
    ]));
    expect(flattened.anyOf).toBe(false);
    expect(flattened.messages).toContain('/dydxprotocol.clob.MsgPlaceOrder');

    // Refuses owner address used as API trading key
    const ownerAsApiKey = createVenueAdapter({
      network: 'mainnet',
      credentialRef: 'cred://dydx/owner-key',
      readSecret: async () => ({ key: addr.address, secret: API_KEY, passphrase: AUTH_ID }),
      fetchImpl: (async () => jsonResponse({})) as typeof fetch
    });
    const badPerms = await ownerAsApiKey.permissions();
    expect(badPerms.delegatedOnly).toBe(false);
    expect(() => assertLivePermissionEvidence(badPerms)).toThrow(/withdraw|delegated|owner/i);
  });

  it('keeps submit ACCEPTED until lookup confirms fill, rejects wrong hedge leg, enforces stop quantity coverage, and preserves null history fields', async () => {
    let orderPlaced = 0;
    let orderStatus = 'OPEN';
    let filledSize = '0';
    let avgPrice = '';
    let openOrdersList: Array<Record<string, unknown>> = [];

    const mockChain: DydxChain = {
      async getAuthenticators() {
        const addr = dydxAddressOf(API_KEY);
        return [
          {
            id: AUTH_ID,
            type: 'AllOf',
            config: JSON.stringify([
              { type: 'SignatureVerification', config: addr.pubKey.toString('base64') },
              {
                type: 'MessageFilter',
                config:
                  '/dydxprotocol.clob.MsgPlaceOrder,/dydxprotocol.clob.MsgCancelOrder,/dydxprotocol.clob.MsgBatchCancel'
              }
            ])
          }
        ];
      },
      async placeOrder(p) {
        if (p.type === 'MARKET') {
          orderPlaced += 1;
          openOrdersList = [
            {
              id: 'dydx-ord-1',
              clientId: String(p.clientId),
              status: orderStatus,
              totalFilled: filledSize
            }
          ];
          return { txHash: '0xhash123' };
        }
        // Conditional STOP_MARKET
        openOrdersList.push({
          id: 'dydx-stop-1',
          clientId: String(p.clientId),
          status: 'UNTRIGGERED',
          triggerPrice: String(p.triggerPrice),
          type: 'STOP_MARKET',
          side: p.side,
          size: String(p.size),
          reduceOnly: true
        });
        return { txHash: '0xstophash' };
      },
      async cancelOrder() {}
    };

    const adapter = createVenueAdapter({
      network: 'testnet',
      credentialRef: 'cred://dydx/test',
      readSecret: async () => ({ key: OWNER_ADDR, secret: API_KEY, passphrase: AUTH_ID }),
      fetchImpl: (async (input) => {
        const url = new URL(String(input));

        if (url.pathname === '/v4/perpetualMarkets') {
          return jsonResponse({
            markets: {
              'BTC-USD': {
                ticker: 'BTC-USD',
                stepSize: '0.001',
                tickSize: '0.1',
                oraclePrice: '68500.0'
              }
            }
          });
        }
        if (url.pathname.includes('/subaccountNumber/')) {
          return jsonResponse({
            subaccount: {
              equity: '1500.0',
              freeCollateral: '1200.0'
            }
          });
        }
        if (url.pathname === '/v4/orders') {
          const dynamicList = openOrdersList.map((o) =>
            o.id === 'dydx-ord-1'
              ? { ...o, status: orderStatus, totalFilled: filledSize }
              : o
          );
          const status = url.searchParams.get('status');
          if (status === 'UNTRIGGERED') {
            return jsonResponse(dynamicList.filter((o) => o.status === 'UNTRIGGERED'));
          }
          return jsonResponse(dynamicList);
        }
        if (url.pathname === '/v4/fills') {
          return jsonResponse({
            fills:
              orderStatus === 'FILLED'
                ? [
                    {
                      orderId: 'dydx-ord-1',
                      size: '0.025',
                      price: '68410.0',
                      fee: '',
                      closedPnl: '',
                      createdAt: '2026-10-31T10:00:05.000Z'
                    }
                  ]
                : []
          });
        }
        if (url.pathname === '/v4/perpetualPositions') {
          return jsonResponse({
            positions: [
              {
                market: 'BTC-USD',
                side: 'LONG',
                size: '0.025',
                entryPrice: '68410.0',
                unrealizedPnl: null
              }
            ]
          });
        }
        return jsonResponse({});
      }) as typeof fetch,
      chain: mockChain
    });

    expect(adapter.status).toBe('experimental');
    const perms = await adapter.permissions();
    expect(() => assertLivePermissionEvidence(perms)).not.toThrow();

    // Hedge mode rejected on dYdX
    await expect(
      adapter.submit({
        clientOrderId: 'cid-dydx-hedge',
        symbol: 'BTCUSDT',
        side: 'LONG',
        positionMode: 'HEDGE',
        hedgeLeg: 'LONG',
        orderType: 'MARKET',
        quantity: '0.025',
        limitPrice: null,
        leverage: 5,
        expireAt: null
      })
    ).rejects.toThrow(/hedge/i);

    const submitReceipt = await adapter.submit({
      clientOrderId: 'cid-dydx-1',
      symbol: 'BTCUSDT',
      side: 'LONG',
      positionMode: 'ONE_WAY',
      hedgeLeg: null,
      orderType: 'MARKET',
      quantity: '0.0259',
      limitPrice: null,
      leverage: 5,
      expireAt: null
    });
    expect(submitReceipt.state).toBe('ACCEPTED');
    expect(submitReceipt.filledQty).toBeNull();
    expect(orderPlaced).toBe(1);

    // Timeout lookup finds single order without resending
    expect((await adapter.lookupOrder('BTCUSDT', 'cid-dydx-1')).state).toBe('ACCEPTED');
    expect(orderPlaced).toBe(1);

    orderStatus = 'FILLED';
    filledSize = '0.025';
    avgPrice = '68410.0';
    const filled = await adapter.lookupOrder('BTCUSDT', 'cid-dydx-1');
    expect(filled.state).toBe('FILLED');
    expect(filled.filledQty).toBe('0.025');
    expect(filled.avgFillPrice).toBe('68410.0');

    const positions = await adapter.positions();
    expect(positions).toHaveLength(1);
    expect(positions[0]?.unrealizedPnl).toBeNull();

    // Missing stop -> MISSING
    expect((await adapter.protection(positions[0]!)).state).toBe('MISSING');

    // Full stop placed via protect() -> VERIFIED
    const full = await adapter.protect(positions[0]!, {
      stopPrice: '67200.05',
      tpPrice: null,
      triggerBy: 'MARK_PRICE',
      clientOrderId: 'protdydx1'
    });
    expect(full.state).toBe('VERIFIED');
    expect(full.coveredQty).toBe('0.025');
    expect(full.stopPrice).toBe('67200');

    // Missing fees/funding/PnL remain null
    const hist = await adapter.financialHistory(null);
    expect(hist.records).toHaveLength(1);
    expect(hist.records[0]?.feeAmount).toBeNull();
    expect(hist.records[0]?.realizedPnl).toBeNull();
    expect(hist.records[0]?.fundingAmount).toBeNull();
  });
});
