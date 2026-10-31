import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { verifyTypedData } from 'viem';
import { describe, expect, it } from 'vitest';
import { assertLivePermissionEvidence } from '../../server/v2/execution/adapters/types.js';
import {
  ASTER_CHAIN_ID,
  createVenueAdapter,
  signAsterV3Query
} from '../../server/v2/execution/adapters/aster.js';

const OWNER_KEY = generatePrivateKey();
const OWNER_ACCOUNT = privateKeyToAccount(OWNER_KEY);
const AGENT_KEY = generatePrivateKey();
const AGENT_ACCOUNT = privateKeyToAccount(AGENT_KEY);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

describe('T11b Aster v3 Futures VenueAdapter conformance + LIMIT_GTC lifecycle', () => {
  it('computes verifiable EIP-712 AsterSignTransaction signature vector, refuses main wallet key, and verifies Pro API agent canWithdraw=false', async () => {
    const signed = await signAsterV3Query({
      network: 'testnet',
      userAddress: OWNER_ACCOUNT.address,
      signerPrivateKey: AGENT_KEY,
      params: { symbol: 'BTCUSDT', type: 'LIMIT' },
      nonce: 1_761_900_000_000_001
    });

    const recoveredOk = await verifyTypedData({
      address: AGENT_ACCOUNT.address,
      domain: {
        name: 'AsterSignTransaction',
        version: '1',
        chainId: ASTER_CHAIN_ID.testnet,
        verifyingContract: '0x0000000000000000000000000000000000000000'
      },
      types: { Message: [{ name: 'msg', type: 'string' }] },
      primaryType: 'Message',
      message: { msg: signed.msg },
      signature: signed.signature
    });
    expect(recoveredOk).toBe(true);

    // Main wallet key used as signer -> refused for LIVE
    const mainWalletAdapter = createVenueAdapter({
      network: 'mainnet',
      credentialRef: 'cred://aster/main-wallet',
      readSecret: async () => ({ key: OWNER_ACCOUNT.address, secret: OWNER_KEY }),
      fetchImpl: (async () => jsonResponse({})) as typeof fetch
    });
    const badPerms = await mainWalletAdapter.permissions();
    expect(badPerms.delegatedOnly).toBe(false);
    expect(() => assertLivePermissionEvidence(badPerms)).toThrow(/withdraw|delegated/i);

    // Pinned Pro API agent with canWithdraw=false on /fapi/v3/agent -> verified for LIVE
    const agentAdapter = createVenueAdapter({
      network: 'testnet',
      credentialRef: 'cred://aster/agent',
      readSecret: async () => ({
        key: OWNER_ACCOUNT.address,
        secret: AGENT_KEY,
        verifiedAgentAddress: AGENT_ACCOUNT.address
      }),
      fetchImpl: (async (input) => {
        const url = new URL(String(input));
        if (url.pathname === '/fapi/v3/account') {
          return jsonResponse({ canTrade: true, canWithdraw: true });
        }
        if (url.pathname === '/fapi/v3/agent') {
          return jsonResponse([
            {
              agentAddress: AGENT_ACCOUNT.address,
              canWithdraw: false,
              canPerpTrade: true,
              expired: Date.now() + 86_400_000
            }
          ]);
        }
        return jsonResponse({});
      }) as typeof fetch
    });
    expect(agentAdapter.status).toBe('experimental');
    const agentPerms = await agentAdapter.permissions();
    expect(() => assertLivePermissionEvidence(agentPerms)).not.toThrow();
  });

  it('supports LIMIT_GTC opt-in, side-safe price rounding, expiration/cancel with additional partial fill, stop repair, hedge check, and null history fields', async () => {
    let submittedOrders = 0;
    let cancelledClientId: string | null = null;
    let orderStatus = 'NEW';
    let executedQty = '0';
    let avgPrice = '0';
    let posAmt = '0';
    let openStopOrders: Array<Record<string, unknown>> = [];

    const adapter = createVenueAdapter({
      network: 'testnet',
      credentialRef: 'cred://aster/agent',
      readSecret: async () => ({
        key: OWNER_ACCOUNT.address,
        secret: AGENT_KEY,
        verifiedAgentAddress: AGENT_ACCOUNT.address
      }),
      fetchImpl: (async (input, init) => {
        const url = new URL(String(input));
        const method = (init?.method ?? 'GET').toUpperCase();

        if (url.pathname === '/fapi/v3/exchangeInfo') {
          return jsonResponse({
            symbols: [
              {
                symbol: 'BTCUSDT',
                contractType: 'PERPETUAL',
                contractSize: 1,
                quoteAsset: 'USDT',
                filters: [
                  { filterType: 'PRICE_FILTER', tickSize: '0.1' },
                  { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '50' },
                  { filterType: 'MIN_NOTIONAL', notional: '5' }
                ]
              }
            ]
          });
        }
        if (url.pathname === '/fapi/v3/ticker/price') {
          return jsonResponse({ symbol: 'BTCUSDT', price: '68500.0', time: 1_761_900_000_050 });
        }
        if (url.pathname === '/fapi/v3/leverage') {
          return jsonResponse({ leverage: 5, symbol: 'BTCUSDT' });
        }
        if (url.pathname === '/fapi/v3/order' && method === 'POST') {
          const type = url.searchParams.get('type');
          if (type === 'LIMIT') {
            submittedOrders += 1;
            // LONG limit 68450.19 must round DOWN to 68450.1
            expect(url.searchParams.get('price')).toBe('68450.1');
            expect(url.searchParams.get('quantity')).toBe('0.025');
            expect(url.searchParams.get('timeInForce')).toBe('GTC');
            return jsonResponse({ orderId: 9001, clientOrderId: url.searchParams.get('newClientOrderId') });
          }
          if (type === 'STOP_MARKET') {
            openStopOrders = [
              {
                orderId: 9002,
                symbol: 'BTCUSDT',
                side: url.searchParams.get('side'),
                positionSide: url.searchParams.get('positionSide') ?? 'BOTH',
                type: 'STOP_MARKET',
                stopPrice: url.searchParams.get('stopPrice'),
                closePosition: url.searchParams.get('closePosition') === 'true',
                origQty: '0'
              }
            ];
            return jsonResponse({ orderId: 9002 });
          }
          return jsonResponse({ orderId: 9003 });
        }
        if (url.pathname === '/fapi/v3/order' && method === 'DELETE') {
          cancelledClientId = url.searchParams.get('origClientOrderId');
          // Additional fill occurred just before cancel completed on venue!
          orderStatus = 'CANCELED';
          executedQty = '0.015';
          avgPrice = '68450.1';
          posAmt = '0.015';
          return jsonResponse({ orderId: 9001, status: 'CANCELED' });
        }
        if (url.pathname === '/fapi/v3/order' && method === 'GET') {
          return jsonResponse({
            orderId: 9001,
            clientOrderId: url.searchParams.get('origClientOrderId'),
            status: orderStatus,
            executedQty,
            avgPrice
          });
        }
        if (url.pathname === '/fapi/v3/positionRisk') {
          return jsonResponse(
            posAmt === '0'
              ? []
              : [
                  {
                    symbol: 'BTCUSDT',
                    positionSide: 'BOTH',
                    positionAmt: posAmt,
                    entryPrice: '68450.1',
                    leverage: '5',
                    unRealizedProfit: null
                  }
                ]
          );
        }
        if (url.pathname === '/fapi/v3/openOrders') {
          return jsonResponse(openStopOrders);
        }
        if (url.pathname === '/fapi/v3/income') {
          return jsonResponse([
            {
              tranId: 501,
              symbol: 'BTCUSDT',
              incomeType: 'FUNDING_FEE',
              income: '',
              asset: 'USDT',
              time: 1_761_900_005_000
            }
          ]);
        }
        return jsonResponse({});
      }) as typeof fetch
    });

    const rules = await adapter.instruments('BTCUSDT');
    expect(rules.restingLimitGtcEntry).toBe(true);

    // Expired LIMIT_GTC rejected before send
    await expect(
      adapter.submit({
        clientOrderId: 'cid-aster-expired',
        symbol: 'BTCUSDT',
        side: 'LONG',
        positionMode: 'ONE_WAY',
        hedgeLeg: null,
        orderType: 'LIMIT_GTC',
        quantity: '0.025',
        limitPrice: '68450.19',
        leverage: 5,
        expireAt: Date.now() - 1_000
      })
    ).rejects.toThrow(/expir/i);

    // Wrong hedge leg rejected
    await expect(
      adapter.submit({
        clientOrderId: 'cid-aster-hedge-bad',
        symbol: 'BTCUSDT',
        side: 'LONG',
        positionMode: 'HEDGE',
        hedgeLeg: 'SHORT',
        orderType: 'LIMIT_GTC',
        quantity: '0.025',
        limitPrice: '68450.19',
        leverage: 5,
        expireAt: Date.now() + 60_000
      })
    ).rejects.toThrow(/hedge/i);

    // Valid LIMIT_GTC submit -> ACCEPTED (not FILLED)
    const submitReceipt = await adapter.submit({
      clientOrderId: 'cid-aster-gtc-1',
      symbol: 'BTCUSDT',
      side: 'LONG',
      positionMode: 'ONE_WAY',
      hedgeLeg: null,
      orderType: 'LIMIT_GTC',
      quantity: '0.0259',
      limitPrice: '68450.19',
      leverage: 5,
      expireAt: Date.now() + 60_000
    });
    expect(submitReceipt.state).toBe('ACCEPTED');
    expect(submitReceipt.filledQty).toBeNull();
    expect(submittedOrders).toBe(1);

    // Timeout recovery lookup produces single order, not resend
    const restingLookup = await adapter.lookupOrder('BTCUSDT', 'cid-aster-gtc-1');
    expect(restingLookup.state).toBe('ACCEPTED');
    expect(submittedOrders).toBe(1);

    // Cancel on expiration observes additional partial fill (0.015) without cancelling stops
    const cancelReceipt = await adapter.cancelEntry('BTCUSDT', 'cid-aster-gtc-1');
    expect(cancelledClientId).toBe('cid-aster-gtc-1');
    expect(cancelReceipt.state).toBe('CANCELLED');
    expect(cancelReceipt.filledQty).toBe('0.015');

    const positions = await adapter.positions();
    expect(positions).toHaveLength(1);
    expect(positions[0]?.qty).toBe('0.015');
    expect(positions[0]?.unrealizedPnl).toBeNull();

    // Missing stop readback -> MISSING (not VERIFIED)
    const missingStop = await adapter.protection(positions[0]!);
    expect(missingStop.state).toBe('MISSING');

    // Partial reduce-only stop (0.010 < 0.015) -> MISSING
    openStopOrders = [
      {
        orderId: 9009,
        symbol: 'BTCUSDT',
        side: 'SELL',
        positionSide: 'BOTH',
        type: 'STOP_MARKET',
        stopPrice: '67200.0',
        closePosition: false,
        reduceOnly: true,
        origQty: '0.010'
      }
    ];
    const partialStop = await adapter.protection(positions[0]!);
    expect(partialStop.coveredQty).toBe('0.01');
    expect(partialStop.state).toBe('MISSING');

    // Repair via protect() places closePosition=true STOP_MARKET -> VERIFIED across full 0.015 exposure
    const repaired = await adapter.protect(positions[0]!, {
      stopPrice: '67200.09',
      tpPrice: null,
      triggerBy: 'MARK_PRICE',
      clientOrderId: 'prot-aster-1'
    });
    expect(repaired.state).toBe('VERIFIED');
    expect(repaired.coveredQty).toBe('0.015');
    expect(repaired.stopPrice).toBe('67200.0');

    // Missing funding amount remains null
    const history = await adapter.financialHistory(null);
    expect(history.records).toHaveLength(1);
    expect(history.records[0]?.fundingAmount).toBeNull();
    expect(history.records[0]?.feeAmount).toBeNull();
    expect(history.records[0]?.realizedPnl).toBeNull();
  });
});
