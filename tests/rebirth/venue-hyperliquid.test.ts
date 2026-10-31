import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { verifyTypedData } from 'viem';
import { describe, expect, it } from 'vitest';
import { assertLivePermissionEvidence } from '../../server/v2/execution/adapters/types.js';
import {
  actionHash,
  cloidFor,
  createVenueAdapter,
  signHyperliquidAction
} from '../../server/v2/execution/adapters/hyperliquid.js';

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

describe('T11c Hyperliquid L1 VenueAdapter conformance', () => {
  it('computes deterministic msgpack+keccak actionHash, EIP-712 Agent signature vector, and refuses main wallet keys', async () => {
    const action = { type: 'updateLeverage', asset: 0, isCross: true, leverage: 5 };
    const nonce = 1_761_900_000_000;
    const hash = actionHash(action, nonce);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hash).toBe(actionHash(action, nonce));

    const signed = await signHyperliquidAction({
      network: 'testnet',
      agentPrivateKey: AGENT_KEY,
      action,
      nonce
    });
    const fullHexSig = `${signed.r}${signed.s.slice(2)}${signed.v.toString(16).padStart(2, '0')}` as `0x${string}`;
    const valid = await verifyTypedData({
      address: AGENT_ACCOUNT.address,
      domain: {
        name: 'Exchange',
        version: '1',
        chainId: 1337,
        verifyingContract: '0x0000000000000000000000000000000000000000'
      },
      types: {
        Agent: [
          { name: 'source', type: 'string' },
          { name: 'connectionId', type: 'bytes32' }
        ]
      },
      primaryType: 'Agent',
      message: { source: 'b', connectionId: hash },
      signature: fullHexSig
    });
    expect(valid).toBe(true);

    // Main wallet key refused
    const badAdapter = createVenueAdapter({
      network: 'mainnet',
      credentialRef: 'cred://hl/main',
      readSecret: async () => ({ key: OWNER_ACCOUNT.address, secret: OWNER_KEY }),
      fetchImpl: (async () => jsonResponse({})) as typeof fetch
    });
    const badPerms = await badAdapter.permissions();
    expect(() => assertLivePermissionEvidence(badPerms)).toThrow(/withdraw|delegated/i);
  });

  it('verifies extraAgents wallet, keeps submit ACCEPTED until cloid lookup confirms fill, rejects hedge mode, enforces quantity-matched stop coverage, and preserves null history fields', async () => {
    let orderSubmits = 0;
    let orderStatusState: 'open' | 'filled' = 'open';
    let triggerOrders: Array<Record<string, unknown>> = [];

    const adapter = createVenueAdapter({
      network: 'testnet',
      credentialRef: 'cred://hl/agent',
      readSecret: async () => ({ key: OWNER_ACCOUNT.address, secret: AGENT_KEY }),
      fetchImpl: (async (input, init) => {
        const url = new URL(String(input));
        const body = JSON.parse(String(init?.body ?? '{}'));

        if (url.pathname === '/info') {
          if (body.type === 'extraAgents') {
            return jsonResponse([
              {
                address: AGENT_ACCOUNT.address,
                name: 'mpu-desk',
                validUntil: Date.now() + 86_400_000
              }
            ]);
          }
          if (body.type === 'meta') {
            return jsonResponse({ universe: [{ name: 'BTC', szDecimals: 4 }] });
          }
          if (body.type === 'allMids') {
            return jsonResponse({ BTC: '68500.0' });
          }
          if (body.type === 'clearinghouseState') {
            return jsonResponse({
              marginSummary: { accountValue: '1000.0' },
              withdrawable: '820.0',
              assetPositions: [
                {
                  position: {
                    coin: 'BTC',
                    szi: '0.0250',
                    entryPx: '68400.0',
                    unrealizedPnl: null
                  }
                }
              ]
            });
          }
          if (body.type === 'orderStatus') {
            expect(body.oid).toBe(cloidFor('cid-hl-1'));
            return jsonResponse({
              status: 'order',
              order: {
                status: orderStatusState,
                order: {
                  oid: 7701,
                  origSz: '0.025',
                  sz: orderStatusState === 'filled' ? '0' : '0.025'
                }
              }
            });
          }
          if (body.type === 'userFills') {
            return jsonResponse(
              orderStatusState === 'filled'
                ? [
                    {
                      oid: 7701,
                      tid: 8801,
                      coin: 'BTC',
                      side: 'B',
                      px: '68410.0',
                      sz: '0.025',
                      fee: null,
                      closedPnl: null,
                      time: 1_761_900_002_000
                    }
                  ]
                : []
            );
          }
          if (body.type === 'userFunding') {
            return jsonResponse([]);
          }
          if (body.type === 'frontendOpenOrders') {
            return jsonResponse(triggerOrders);
          }
        }

        if (url.pathname === '/exchange') {
          const act = body.action;
          if (act.type === 'updateLeverage') {
            return jsonResponse({ status: 'ok', response: { type: 'default' } });
          }
          if (act.type === 'order') {
            const first = act.orders[0];
            if (first?.t?.trigger) {
              triggerOrders = act.orders.map((o: Record<string, unknown>, i: number) => ({
                oid: 9900 + i,
                coin: 'BTC',
                side: o.b ? 'B' : 'A',
                sz: o.s,
                reduceOnly: o.r,
                isTrigger: true,
                triggerPx: (o.t as { trigger: { triggerPx: string } }).trigger.triggerPx,
                orderType:
                  (o.t as { trigger: { tpsl: string } }).trigger.tpsl === 'sl'
                    ? 'Stop Market'
                    : 'Take Profit Market'
              }));
              return jsonResponse({
                status: 'ok',
                response: { data: { statuses: [{ resting: { oid: 9900 } }] } }
              });
            }
            orderSubmits += 1;
            return jsonResponse({
              status: 'ok',
              response: { data: { statuses: [{ resting: { oid: 7701 } }] } }
            });
          }
        }
        return jsonResponse({ status: 'ok' });
      }) as typeof fetch
    });

    expect(adapter.status).toBe('experimental');
    const perms = await adapter.permissions();
    expect(() => assertLivePermissionEvidence(perms)).not.toThrow();

    // Hedge mode rejected on ONE_WAY-only Hyperliquid
    await expect(
      adapter.submit({
        clientOrderId: 'cid-hl-hedge',
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

    const submitted = await adapter.submit({
      clientOrderId: 'cid-hl-1',
      symbol: 'BTCUSDT',
      side: 'LONG',
      positionMode: 'ONE_WAY',
      hedgeLeg: null,
      orderType: 'MARKET',
      quantity: '0.02509',
      limitPrice: null,
      leverage: 5,
      expireAt: null
    });
    expect(submitted.state).toBe('ACCEPTED');
    expect(submitted.filledQty).toBeNull();
    expect(orderSubmits).toBe(1);

    // Timeout lookup finds single order without resending
    const openLookup = await adapter.lookupOrder('BTCUSDT', 'cid-hl-1');
    expect(openLookup.state).toBe('ACCEPTED');
    expect(orderSubmits).toBe(1);

    orderStatusState = 'filled';
    const filledLookup = await adapter.lookupOrder('BTCUSDT', 'cid-hl-1');
    expect(filledLookup.state).toBe('FILLED');
    expect(filledLookup.filledQty).toBe('0.025');
    expect(filledLookup.avgFillPrice).toBe('68410');

    const positions = await adapter.positions();
    expect(positions).toHaveLength(1);
    expect(positions[0]?.unrealizedPnl).toBeNull();

    // Missing stop -> MISSING
    expect((await adapter.protection(positions[0]!)).state).toBe('MISSING');

    // Partial stop (0.010 < 0.0250) -> MISSING
    triggerOrders = [
      {
        oid: 9900,
        coin: 'BTC',
        side: 'A',
        sz: '0.010',
        reduceOnly: true,
        isTrigger: true,
        triggerPx: '67200',
        orderType: 'Stop Market'
      }
    ];
    const partialProt = await adapter.protection(positions[0]!);
    expect(partialProt.coveredQty).toBe('0.01');
    expect(partialProt.state).toBe('MISSING');

    // Full stop via protect() -> VERIFIED
    const fullProt = await adapter.protect(positions[0]!, {
      stopPrice: '67200',
      tpPrice: null,
      triggerBy: 'MARK_PRICE',
      clientOrderId: 'prot-hl-1'
    });
    expect(fullProt.state).toBe('VERIFIED');
    expect(fullProt.coveredQty).toBe('0.025');

    // Financial history preserves null fee/PnL/funding
    const hist = await adapter.financialHistory(null);
    expect(hist.records).toHaveLength(1);
    expect(hist.records[0]?.feeAmount).toBeNull();
    expect(hist.records[0]?.realizedPnl).toBeNull();
    expect(hist.records[0]?.fundingAmount).toBeNull();
  });
});
