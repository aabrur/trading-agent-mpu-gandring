import { describe, expect, it } from 'vitest';
import { unavailableEvidence, verifiedEvidence, type MarketFrame } from '../../server/v2/contracts.js';
import { revalidateEntry, type TradeThesis } from '../../server/v2/decision/revalidate.js';

function makeMarketFrame(lastPrice: string | null, evidenceId = 'ev-fresh-1'): MarketFrame {
  return {
    evidenceId,
    revision: 12,
    symbol: 'BTCUSDT',
    venue: 'bybit',
    category: 'linear',
    asOf: Date.now(),
    last:
      lastPrice !== null
        ? verifiedEvidence({ value: lastPrice, source: 'bybit.tickers.BTCUSDT', unit: 'USDT' })
        : unavailableEvidence('bybit.tickers.BTCUSDT', 'Feed disconnected', Date.now(), 'USDT'),
    bid: verifiedEvidence({ value: lastPrice ?? '0', source: 'bybit.tickers.BTCUSDT', unit: 'USDT' }),
    ask: verifiedEvidence({ value: lastPrice ?? '0', source: 'bybit.tickers.BTCUSDT', unit: 'USDT' }),
    closed: { '1m': [], '5m': [], '15m': [], '1h': [], '4h': [], '1d': [] },
    current: {},
    tradesEvidenceId: null,
    bookEvidenceId: null,
    funding: unavailableEvidence('bybit.tickers.BTCUSDT', 'n/a'),
    openInterest: unavailableEvidence('bybit.tickers.BTCUSDT', 'n/a')
  };
}

describe('T08 current thesis revalidation under post-approval and execution-lock market updates', () => {
  it('reversal_after_ai_approval invalidates both LONG and SHORT when fresh market breaches thesis predicate', () => {
    const longThesis: TradeThesis = {
      id: 'thesis-long-1',
      cycleId: 'cycle-1',
      accountRef: 'paper:default',
      symbol: 'BTCUSDT',
      side: 'LONG',
      evidenceId: 'ev-initial',
      configVersion: 1,
      claims: ['ev-initial'],
      stop: '67800',
      tp: '70500',
      orderType: 'MARKET',
      invalidation: [
        {
          kind: 'PRICE_BELOW',
          level: '67800',
          timeframe: '5m',
          description: 'Lose 5m higher low at 67800'
        }
      ]
    };

    const longReversed = revalidateEntry({
      thesis: longThesis,
      activeConfigVersion: 1,
      freshMarket: makeMarketFrame('67740', 'ev-after-approval'),
      structuralBreaks: []
    });
    expect(longReversed.status).toBe('invalidated');
    expect(longReversed.evidenceRefs).toContain('ev-after-approval');

    const shortThesis: TradeThesis = {
      ...longThesis,
      id: 'thesis-short-1',
      side: 'SHORT',
      stop: '69200',
      tp: '66000',
      invalidation: [
        {
          kind: 'PRICE_ABOVE',
          level: '69200',
          timeframe: '5m',
          description: 'Reclaim 5m lower high above 69200'
        }
      ]
    };

    const shortReversed = revalidateEntry({
      thesis: shortThesis,
      activeConfigVersion: 1,
      freshMarket: makeMarketFrame('69250', 'ev-short-reversal'),
      structuralBreaks: []
    });
    expect(shortReversed.status).toBe('invalidated');
    expect(shortReversed.evidenceRefs).toContain('ev-short-reversal');
  });

  it('reversal_after_lock_wait invalidates entry on confirmed opposing structure break and keeps unchanged thesis valid when optional research is down', () => {
    const thesis: TradeThesis = {
      id: 'thesis-lock-1',
      cycleId: 'cycle-lock',
      accountRef: 'paper:default',
      symbol: 'BTCUSDT',
      side: 'LONG',
      evidenceId: 'ev-pre-lock',
      configVersion: 4,
      claims: ['ev-pre-lock'],
      stop: '67500',
      tp: '71000',
      orderType: 'MARKET',
      invalidation: [
        {
          kind: 'STRUCTURE_BREAK',
          timeframe: '5m',
          description: 'Bearish CHoCH on 5m invalidates continuation LONG'
        }
      ]
    };

    const unchangedWithOptionalOutage = revalidateEntry({
      thesis,
      activeConfigVersion: 4,
      freshMarket: makeMarketFrame('68600', 'ev-during-lock-ok'),
      structuralBreaks: [],
      optionalResearchStatus: 'unavailable',
      jevStatus: 'unavailable'
    });
    expect(unchangedWithOptionalOutage.status).toBe('valid');

    const brokenAfterLockWait = revalidateEntry({
      thesis,
      activeConfigVersion: 4,
      freshMarket: makeMarketFrame('68100', 'ev-during-lock-choch'),
      structuralBreaks: [{ timeframe: '5m', direction: 'BEARISH', ref: 'ev-choch-5m' }]
    });
    expect(brokenAfterLockWait.status).toBe('invalidated');
    expect(brokenAfterLockWait.evidenceRefs).toContain('ev-choch-5m');

    // Passing any legacy aiApproved bypass flag is rejected by strict validation.
    expect(() =>
      revalidateEntry({
        thesis,
        activeConfigVersion: 4,
        freshMarket: makeMarketFrame('67000', 'ev-bypass-attempt'),
        structuralBreaks: [],
        // @ts-expect-error verifying runtime rejection of forbidden aiApproved bypass field
        aiApproved: true
      })
    ).toThrow();
  });
});
