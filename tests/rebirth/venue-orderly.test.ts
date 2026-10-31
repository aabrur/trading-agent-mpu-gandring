import { ed25519 } from '@noble/curves/ed25519.js';
import { base58 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { assertLivePermissionEvidence } from '../../server/v2/execution/adapters/types.js';
import {
  createVenueAdapter,
  orderlySymbol,
  parseOrderlySecret,
  signOrderlyRequest
} from '../../server/v2/execution/adapters/orderly.js';

const MOCK_SEED = new Uint8Array(32).fill(7);
const BASE58_SECRET = base58.encode(MOCK_SEED);
const ORDERLY_PUBKEY = `ed25519:${base58.encode(ed25519.getPublicKey(MOCK_SEED))}`;
const ACCOUNT_ID = '0x9999999999999999999999999999999999999999999999999999999999999999';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

describe('T11h Orderly Network ed25519 VenueAdapter conformance', () => {
  it('parses base58 ed25519 secret, refuses hex wallet keys, computes deterministic base64url signature vector, and verifies read,trading scope', async () => {
    expect(() =>
      parseOrderlySecret('0x1111111111111111111111111111111111111111111111111111111111111111')
    ).toThrow(/wallet private key/i);

    const parsed = parseOrderlySecret(BASE58_SECRET);
    expect(parsed.length).toBe(32);

    const sig = signOrderlyRequest({
      timestamp: 1_761_900_000_000,
      method: 'POST',
      pathWithQuery: '/v1/order',
      body: '{"symbol":"PERP_BTC_USDC"}',
      secret: parsed
    });
    expect(sig.signature).toMatch(/^[0-9A-Za-z_-]{86}$/);

    // Key with wide / unauthorized permissions (e.g. transfer) -> refused
    const wideAdapter = createVenueAdapter({
      network: 'mainnet',
      credentialRef: 'cred://orderly/wide',
      readSecret: async () => ({ key: ACCOUNT_ID, secret: BASE58_SECRET }),
      fetchImpl: (async (input) => {
        const url = new URL(String(input));
        if (url.pathname.includes('/v1/client/key_info')) {
          return jsonResponse({
            success: true,
            data: {
              rows: [
                {
                  orderly_key: ORDERLY_PUBKEY,
                  key_status: 'ACTIVE',
                  scope: 'read,trading,transfer',
                  expiration: Date.now() + 86_400_000
                }
              ]
            }
          });
        }
        return jsonResponse({ success: true, data: {} });
      }) as typeof fetch
    });
    const widePerms = await wideAdapter.permissions();
    expect(widePerms.canWithdraw).toBe(true);
    expect(() => assertLivePermissionEvidence(widePerms)).toThrow(/withdraw/i);

    // Active trade-only key -> VERIFIED
    const activeAdapter = createVenueAdapter({
      network: 'testnet',
      credentialRef: 'cred://orderly/active',
      readSecret: async () => ({ key: ACCOUNT_ID, secret: BASE58_SECRET }),
      fetchImpl: (async (input) => {
        const url = new URL(String(input));
        if (url.pathname.includes('/v1/client/key_info')) {
          return jsonResponse({
            success: true,
            data: {
              rows: [
                {
                  orderly_key: ORDERLY_PUBKEY,
                  key_status: 'ACTIVE',
                  scope: 'read,trading',
                  expiration: Date.now() + 86_400_000
                }
              ]
            }
          });
        }
        return jsonResponse({ success: true, data: {} });
      }) as typeof fetch
    });
    expect(activeAdapter.status).toBe('experimental');
    const activePerms = await activeAdapter.permissions();
    expect(() => assertLivePermissionEvidence(activePerms)).not.toThrow();
  });

  it('keeps submit ACCEPTED until client_order_id lookup confirms fill, rejects wrong hedge leg, enforces stop coverage, and preserves null history fields', async () => {
    let orderPosted = 0;
    let orderStatus = 'NEW';
    let executedQty = '0';
    let avgPrice = '';
    let algoOrders: Array<Record<string, unknown>> = [];

    const adapter = createVenueAdapter({
      network: 'testnet',
      credentialRef: 'cred://orderly/active',
      readSecret: async () => ({ key: ACCOUNT_ID, secret: BASE58_SECRET }),
      fetchImpl: (async (input, init) => {
        const url = new URL(String(input));
        const method = (init?.method ?? 'GET').toUpperCase();

        if (url.pathname.includes('/v1/public/info/')) {
          return jsonResponse({
            success: true,
            data: {
              symbol: 'PERP_BTC_USDC',
              base_tick: '0.001',
              base_min: '0.001',
              base_max: '100',
              quote_tick: '0.1',
              min_notional: '5'
            }
          });
        }
        if (url.pathname.includes('/v1/public/futures/')) {
          return jsonResponse({
            success: true,
            data: { mark_price: '68500.0' }
          });
        }
        if (url.pathname.includes('/v1/order') && method === 'POST') {
          const body = JSON.parse(String(init?.body ?? '{}'));
          orderPosted += 1;
          return jsonResponse({
            success: true,
            data: { order_id: 5501, client_order_id: body.client_order_id }
          });
        }
        if (url.pathname.includes('/v1/client/order/')) {
          return jsonResponse({
            success: true,
            data: {
              order_id: 5501,
              status: orderStatus,
              total_executed_quantity: executedQty,
              average_executed_price: avgPrice
            }
          });
        }
        if (url.pathname.includes('/v1/positions')) {
          return jsonResponse({
            success: true,
            data: {
              rows: [
                {
                  symbol: 'PERP_BTC_USDC',
                  position_qty: '0.035',
                  average_open_price: '68420.0',
                  unsettled_pnl: null
                }
              ]
            }
          });
        }
        if (url.pathname.includes('/v1/algo/orders') && method === 'GET') {
          return jsonResponse({
            success: true,
            data: { rows: algoOrders }
          });
        }
        if (url.pathname.includes('/v1/algo/order') && method === 'POST') {
          const body = JSON.parse(String(init?.body ?? '{}'));
          algoOrders = [
            {
              algo_order_id: 'ao-1',
              symbol: body.symbol,
              algo_type: 'POSITIONAL_TP_SL',
              child_orders: body.child_orders
            }
          ];
          return jsonResponse({ success: true, data: { algo_order_id: 'ao-1' } });
        }
        if (url.pathname.includes('/v1/trades')) {
          return jsonResponse({
            success: true,
            data: {
              rows: [
                {
                  id: 'ord-t1',
                  symbol: 'PERP_BTC_USDC',
                  side: 'BUY',
                  executed_quantity: '0.035',
                  executed_price: '68420.0',
                  fee: '',
                  fee_asset: 'USDC',
                  realized_pnl: '',
                  executed_timestamp: 1_761_900_007_000
                }
              ]
            }
          });
        }
        return jsonResponse({ success: true, data: {} });
      }) as typeof fetch
    });

    const rules = await adapter.instruments('BTCUSDT');
    expect(rules.nativeSymbol).toBe('PERP_BTC_USDC');
    expect(orderlySymbol('BTCUSDT')).toBe('PERP_BTC_USDC');

    // Reject hedge mode
    await expect(
      adapter.submit({
        clientOrderId: 'cid-ord-hedge',
        symbol: 'BTCUSDT',
        side: 'LONG',
        positionMode: 'HEDGE',
        hedgeLeg: 'LONG',
        orderType: 'MARKET',
        quantity: '0.035',
        limitPrice: null,
        leverage: 5,
        expireAt: null
      })
    ).rejects.toThrow(/hedge/i);

    const submitReceipt = await adapter.submit({
      clientOrderId: 'cid-ord-1',
      symbol: 'BTCUSDT',
      side: 'LONG',
      positionMode: 'ONE_WAY',
      hedgeLeg: null,
      orderType: 'MARKET',
      quantity: '0.0359',
      limitPrice: null,
      leverage: 5,
      expireAt: null
    });
    expect(submitReceipt.state).toBe('ACCEPTED');
    expect(submitReceipt.filledQty).toBeNull();
    expect(orderPosted).toBe(1);

    // Timeout lookup finds single order
    expect((await adapter.lookupOrder('BTCUSDT', 'cid-ord-1')).state).toBe('ACCEPTED');
    expect(orderPosted).toBe(1);

    orderStatus = 'FILLED';
    executedQty = '0.035';
    avgPrice = '68420.0';
    const filled = await adapter.lookupOrder('BTCUSDT', 'cid-ord-1');
    expect(filled.state).toBe('FILLED');
    expect(filled.filledQty).toBe('0.035');

    const positions = await adapter.positions();
    expect(positions).toHaveLength(1);
    expect(positions[0]?.unrealizedPnl).toBeNull();

    // Missing stop -> MISSING
    expect((await adapter.protection(positions[0]!)).state).toBe('MISSING');

    // Full stop via protect() -> VERIFIED
    const full = await adapter.protect(positions[0]!, {
      stopPrice: '67200.04',
      tpPrice: null,
      triggerBy: 'MARK_PRICE',
      clientOrderId: 'prot-ord-1'
    });
    expect(full.state).toBe('VERIFIED');
    expect(full.coveredQty).toBe('0.035');
    expect(full.stopPrice).toBe('67200.0');

    // Missing fee/PnL/funding remain null
    const hist = await adapter.financialHistory(null);
    expect(hist.records).toHaveLength(1);
    expect(hist.records[0]?.feeAmount).toBeNull();
    expect(hist.records[0]?.realizedPnl).toBeNull();
    expect(hist.records[0]?.fundingAmount).toBeNull();
  });
});
