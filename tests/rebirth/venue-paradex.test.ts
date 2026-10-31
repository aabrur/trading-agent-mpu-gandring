import { ec } from 'starknet';
import { describe, expect, it } from 'vitest';
import { assertLivePermissionEvidence } from '../../server/v2/execution/adapters/types.js';
import {
  chainNumber,
  createVenueAdapter,
  paradexMarket
} from '../../server/v2/execution/adapters/paradex.js';

const SUBKEY = '0x0123456789abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
const SUBKEY_PUB = ec.starkCurve.getStarkKey(SUBKEY);
const ACCOUNT_ADDR = '0x0444444444444444444444444444444444444444444444444444444444444444';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

describe('T11g Paradex Starknet subkey VenueAdapter conformance', () => {
  it('computes 8-decimal chainNumber quantum, verifies registered subkey permissions, and refuses main account keys or revoked subkeys', async () => {
    expect(chainNumber(0.015)).toBe('1500000');
    expect(chainNumber(1)).toBe('100000000');

    // Main account address passed as subkey -> refused
    const mainAsSubkey = createVenueAdapter({
      network: 'mainnet',
      credentialRef: 'cred://paradex/main',
      readSecret: async () => ({ key: ACCOUNT_ADDR, secret: ACCOUNT_ADDR }),
      fetchImpl: (async () => jsonResponse({})) as typeof fetch
    });
    const badPerms = await mainAsSubkey.permissions();
    expect(badPerms.delegatedOnly).toBe(false);
    expect(() => assertLivePermissionEvidence(badPerms)).toThrow(/withdraw|delegated/i);

    // Revoked subkey -> refused
    const revokedSubkeyAdapter = createVenueAdapter({
      network: 'testnet',
      credentialRef: 'cred://paradex/revoked',
      readSecret: async () => ({ key: ACCOUNT_ADDR, secret: SUBKEY }),
      fetchImpl: (async (input) => {
        const url = new URL(String(input));
        if (url.pathname.includes('/system/config')) {
          return jsonResponse({ starknet_chain_id: 'PRIVATE_SN_POTC_SEPOLIA' });
        }
        if (url.pathname.includes('/account/keys/subkeys/')) {
          return jsonResponse({
            public_key: SUBKEY_PUB,
            state: 'REVOKED',
            revoked_at: 1_761_900_000
          });
        }
        return jsonResponse({});
      }) as typeof fetch
    });
    const revPerms = await revokedSubkeyAdapter.permissions();
    expect(revPerms.canTrade).toBe(false);
    expect(() => assertLivePermissionEvidence(revPerms)).toThrow(/trade/i);

    // Active subkey -> VERIFIED trade-only
    const activeSubkeyAdapter = createVenueAdapter({
      network: 'testnet',
      credentialRef: 'cred://paradex/active',
      readSecret: async () => ({ key: ACCOUNT_ADDR, secret: SUBKEY }),
      fetchImpl: (async (input) => {
        const url = new URL(String(input));
        if (url.pathname.includes('/system/config')) {
          return jsonResponse({ starknet_chain_id: 'PRIVATE_SN_POTC_SEPOLIA' });
        }
        if (url.pathname.includes('/auth/')) {
          return jsonResponse({ jwt_token: 'mock-jwt-token' });
        }
        if (url.pathname.includes('/account/keys/subkeys/')) {
          return jsonResponse({
            public_key: SUBKEY_PUB,
            state: 'ACTIVE',
            revoked_at: null,
            allowed_cidrs: ['127.0.0.1/32']
          });
        }
        return jsonResponse({});
      }) as typeof fetch
    });
    const activePerms = await activeSubkeyAdapter.permissions();
    expect(() => assertLivePermissionEvidence(activePerms)).not.toThrow();
  });

  it('keeps submit ACCEPTED until client_id lookup confirms fill, rejects wrong hedge leg, enforces stop coverage, and preserves null history fields', async () => {
    let orderPosted = 0;
    let orderStatus = 'OPEN';
    let remainingSize = '0.025';
    let avgFillPrice: string | null = null;
    let stopOrders: Array<Record<string, unknown>> = [];

    const adapter = createVenueAdapter({
      network: 'testnet',
      credentialRef: 'cred://paradex/test',
      readSecret: async () => ({ key: ACCOUNT_ADDR, secret: SUBKEY }),
      fetchImpl: (async (input, init) => {
        const url = new URL(String(input));
        const method = (init?.method ?? 'GET').toUpperCase();

        if (url.pathname.includes('/system/config')) {
          return jsonResponse({ starknet_chain_id: 'PRIVATE_SN_POTC_SEPOLIA' });
        }
        if (url.pathname.includes('/auth/')) {
          return jsonResponse({ jwt_token: 'mock-jwt-token' });
        }
        if (url.pathname.includes('/markets/summary')) {
          return jsonResponse({
            results: [
              {
                market: 'BTC-USD-PERP',
                last_traded_price: '68500.0',
                mark_price: '68500.0'
              }
            ]
          });
        }
        if (url.pathname.endsWith('/markets')) {
          return jsonResponse({
            results: [
              {
                market: 'BTC-USD-PERP',
                order_size_increment: '0.001',
                price_tick_size: '0.1',
                min_notional: '5'
              }
            ]
          });
        }
        if (url.pathname.endsWith('/orders') && method === 'POST') {
          const body = JSON.parse(String(init?.body ?? '{}'));
          if (body.type === 'MARKET') {
            orderPosted += 1;
            return jsonResponse({ id: 'para-ord-1', client_id: body.client_id, status: 'NEW' });
          }
          if (body.type === 'STOP_MARKET') {
            stopOrders = [
              {
                id: 'para-stop-1',
                market: body.market,
                side: body.side,
                type: 'STOP_MARKET',
                trigger_price: body.trigger_price,
                size: body.size,
                flags: body.flags
              }
            ];
            return jsonResponse({ id: 'para-stop-1' });
          }
        }
        if (url.pathname.includes('/orders/by_client_id/')) {
          const cid = decodeURIComponent(url.pathname.split('/').pop() ?? '');
          return jsonResponse({
            id: 'para-ord-1',
            client_id: cid,
            size: '0.025',
            remaining_size: remainingSize,
            status: orderStatus,
            avg_fill_price: avgFillPrice
          });
        }
        if (url.pathname.endsWith('/positions')) {
          return jsonResponse({
            results: [
              {
                market: 'BTC-USD-PERP',
                status: 'OPEN',
                side: 'BUY',
                size: '0.025',
                average_entry_price: '68420.0',
                unrealized_pnl: null
              }
            ]
          });
        }
        if (url.pathname.endsWith('/orders') && method === 'GET') {
          return jsonResponse({ results: stopOrders });
        }
        if (url.pathname.endsWith('/fills')) {
          return jsonResponse({
            results: [
              {
                id: 'fill-p1',
                market: 'BTC-USD-PERP',
                side: 'BUY',
                size: '0.025',
                price: '68420.0',
                fee: '',
                fee_currency: '',
                created_at: 1_761_900_006_000
              }
            ]
          });
        }
        return jsonResponse({});
      }) as typeof fetch
    });

    const rules = await adapter.instruments('BTCUSDT');
    expect(rules.nativeSymbol).toBe('BTC-USD-PERP');

    // Reject hedge mode
    await expect(
      adapter.submit({
        clientOrderId: 'cid-para-hedge',
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
      clientOrderId: 'cid-para-1',
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
    expect(orderPosted).toBe(1);

    // Timeout lookup finds single order
    expect((await adapter.lookupOrder('BTCUSDT', 'cid-para-1')).state).toBe('ACCEPTED');
    expect(orderPosted).toBe(1);

    orderStatus = 'CLOSED';
    remainingSize = '0';
    avgFillPrice = '68420.0';
    const filled = await adapter.lookupOrder('BTCUSDT', 'cid-para-1');
    expect(filled.state).toBe('FILLED');
    expect(filled.filledQty).toBe('0.025');

    const positions = await adapter.positions();
    expect(positions).toHaveLength(1);
    expect(positions[0]?.unrealizedPnl).toBeNull();

    // Missing stop -> MISSING
    expect((await adapter.protection(positions[0]!)).state).toBe('MISSING');

    // Partial stop (0.015 < 0.025) -> MISSING
    stopOrders = [
      {
        id: 'stop-part',
        market: 'BTC-USD-PERP',
        side: 'SELL',
        type: 'STOP_MARKET',
        trigger_price: '67200.0',
        size: '0.015',
        flags: ['REDUCE_ONLY']
      }
    ];
    const partial = await adapter.protection(positions[0]!);
    expect(partial.coveredQty).toBe('0.015');
    expect(partial.state).toBe('MISSING');

    // Full stop via protect() -> VERIFIED
    const full = await adapter.protect(positions[0]!, {
      stopPrice: '67200.04',
      tpPrice: null,
      triggerBy: 'MARK_PRICE',
      clientOrderId: 'prot-para-1'
    });
    expect(full.state).toBe('VERIFIED');
    expect(full.coveredQty).toBe('0.025');
    expect(full.stopPrice).toBe('67200');

    // Missing fee/PnL/funding remain null
    const hist = await adapter.financialHistory(null);
    expect(hist.records).toHaveLength(1);
    expect(hist.records[0]?.feeAmount).toBeNull();
    expect(hist.records[0]?.realizedPnl).toBeNull();
    expect(hist.records[0]?.fundingAmount).toBeNull();
  });
});
