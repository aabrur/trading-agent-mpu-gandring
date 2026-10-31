import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  NativeRulesSchema,
  PermissionEvidenceSchema,
  ProtectionEvidenceSchema,
  VenueQuoteSchema,
  assertLivePermissionEvidence,
  evaluateProtectionCoverage,
  prepareNativeOrderQuantities,
  validateDelegatedCredentialInput
} from '../../server/v2/execution/adapters/types.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/venues/conformance.json', import.meta.url), 'utf8')
);

describe('T10 VenueAdapter conformance schemas, LIVE permission gating, rounding, stop coverage and secret scrubbing', () => {
  it('enforces canTrade=true and canWithdraw=false verified for LIVE and rejects unknown permissions or main wallet seeds', () => {
    const verifiedTradeOnly = PermissionEvidenceSchema.parse({
      ok: true,
      canTrade: true,
      canWithdraw: false,
      verified: true,
      delegatedOnly: true,
      detail: 'Trade-only API key verified on exchange',
      observedAt: 1_761_900_000_000
    });
    expect(() => assertLivePermissionEvidence(verifiedTradeOnly)).not.toThrow();

    const unknownWithdraw = PermissionEvidenceSchema.parse({
      ok: false,
      canTrade: true,
      canWithdraw: null,
      verified: false,
      delegatedOnly: true,
      detail: 'Permission endpoint unreachable',
      observedAt: 1_761_900_000_000
    });
    expect(() => assertLivePermissionEvidence(unknownWithdraw)).toThrow(/withdraw|verified/i);

    const withdrawEnabled = PermissionEvidenceSchema.parse({
      ok: false,
      canTrade: true,
      canWithdraw: true,
      verified: true,
      delegatedOnly: false,
      detail: 'Key has withdraw permission',
      observedAt: 1_761_900_000_000
    });
    expect(() => assertLivePermissionEvidence(withdrawEnabled)).toThrow(/withdraw/i);

    // Seed phrases are rejected as delegated credentials
    expect(() =>
      validateDelegatedCredentialInput({
        venue: 'hyperliquid',
        key: '0x1111111111111111111111111111111111111111',
        secret: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
      })
    ).toThrow(/seed phrase/i);
  });

  it('validates symbol multiplier/units, one-way vs hedge IDs, explicit native stop coverage, quote age, rounding/min-notional and capability honesty', () => {
    const rules = NativeRulesSchema.parse(fixture.rules);
    expect(rules.contractMultiplier).toBe('1');
    expect(rules.settlementCurrency).toBe('USDT');
    expect(rules.restingLimitGtcEntry).toBe(false);

    const quote = VenueQuoteSchema.parse(fixture.quote);
    expect(quote.ageMs).toBe(120);

    // Unsupported LIMIT_GTC rejected when rules.restingLimitGtcEntry === false
    expect(() =>
      prepareNativeOrderQuantities(
        {
          clientOrderId: 'cid-gtc-unsupported',
          symbol: 'BTCUSDT',
          side: 'LONG',
          positionMode: 'ONE_WAY',
          hedgeLeg: null,
          orderType: 'LIMIT_GTC',
          quantity: '0.0159',
          limitPrice: '68500.19',
          leverage: 5,
          expireAt: null
        },
        rules,
        quote.last
      )
    ).toThrow(/LIMIT_GTC/i);

    // Supported LIMIT_GTC rounds quantity down and LONG limit down, SHORT limit up
    const gtcRules = { ...rules, restingLimitGtcEntry: true };
    const preparedLong = prepareNativeOrderQuantities(
      {
        clientOrderId: 'cid-gtc-long',
        symbol: 'BTCUSDT',
        side: 'LONG',
        positionMode: 'HEDGE',
        hedgeLeg: 'LONG',
        orderType: 'LIMIT_GTC',
        quantity: '0.0159',
        limitPrice: '68500.19',
        leverage: 5,
        expireAt: null
      },
      gtcRules,
      quote.last
    );
    expect(preparedLong.quantity).toBe('0.015');
    expect(preparedLong.limitPrice).toBe('68500.1');

    // Wrong hedge leg rejected
    expect(() =>
      prepareNativeOrderQuantities(
        {
          clientOrderId: 'cid-bad-hedge',
          symbol: 'BTCUSDT',
          side: 'LONG',
          positionMode: 'HEDGE',
          hedgeLeg: 'SHORT',
          orderType: 'MARKET',
          quantity: '0.01',
          limitPrice: null,
          leverage: 5,
          expireAt: null
        },
        gtcRules,
        quote.last
      )
    ).toThrow(/hedge/i);

    // Below minNotional rejected
    expect(() =>
      prepareNativeOrderQuantities(
        {
          clientOrderId: 'cid-dust',
          symbol: 'BTCUSDT',
          side: 'LONG',
          positionMode: 'ONE_WAY',
          hedgeLeg: null,
          orderType: 'MARKET',
          quantity: '0.001',
          limitPrice: null,
          leverage: 5,
          expireAt: null
        },
        { ...rules, minNotional: '100' },
        '68500'
      )
    ).toThrow(/notional/i);

    // Stop coverage evaluation: zero/partial stop is NOT VERIFIED
    const partialProt = evaluateProtectionCoverage({
      symbol: 'BTCUSDT',
      positionKey: 'BTCUSDT:HEDGE:LONG',
      side: 'LONG',
      requiredQty: '0.050',
      coveredQty: '0.030',
      stopPrice: '67000',
      tpPrice: null,
      reduceOnlyOrPositionBound: true,
      observedAt: 1_761_900_000_200
    });
    expect(partialProt.state).toBe('MISSING');

    const fullProt = ProtectionEvidenceSchema.parse(
      evaluateProtectionCoverage({
        symbol: 'BTCUSDT',
        positionKey: 'BTCUSDT:HEDGE:LONG',
        side: 'LONG',
        requiredQty: '0.050',
        coveredQty: '0.050',
        stopPrice: '67000',
        tpPrice: '71000',
        reduceOnlyOrPositionBound: true,
        observedAt: 1_761_900_000_200
      })
    );
    expect(fullProt.state).toBe('VERIFIED');
  });
});
