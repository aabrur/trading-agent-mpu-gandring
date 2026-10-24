import { describe, expect, it } from 'vitest';
import { buildTacticalTradePlan, type TacticalTradePlan } from '../server/market/tactical.js';
import type { MarketSnapshot } from '../server/types.js';
import { buildTechnicalSummary, strategyVote } from '../server/strategy.js';

function snapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    symbol: 'BTCUSDT', source: 'bybit', example: false, last: 94, change24hPct: 0,
    fundingRate: null, bid: null, ask: null, candles: [], fetchedAt: 1234,
    technicalSummary: {
      mtfTrend: {
        '5m': null, '15m': { ema9: 98, ema21: 100, ema50: 105, ema200: null, regime: 'STRONG_DOWNTREND' },
        '1h': null, '4h': null
      },
      volatility: null,
      momentum: { rsi14_15m: null, rsi14_1h: null, rsi14_4h: null },
      volumeProfile: { sessionVwap: 101, poc: 99, vah: 106, val: 96 },
      swingLevels: { recentSwingHigh: 110, recentSwingLow: 95, distToLiquiditySweepPct: 1 }
    },
    ...overrides
  };
}

describe('buildTacticalTradePlan', () => {
  it('returns typed advisory scenarios and identifies unavailable evidence without inventing zones', () => {
    const input = snapshot();
    const before = structuredClone(input);
    const voteBefore = strategyVote(input.candles);
    const plan: TacticalTradePlan = buildTacticalTradePlan(input);

    expect(plan.symbol).toBe('BTCUSDT');
    expect(plan.timestamp).toBe(1234);
    expect(plan.scenarios.map((scenario) => scenario.kind)).toEqual(expect.arrayContaining([
      'PULLBACK_CONTINUATION', 'BREAKDOWN_CONTINUATION', 'FAILED_BREAKDOWN_REVERSAL',
      'BREAKOUT_CONTINUATION', 'FAILED_BREAKOUT_REVERSAL'
    ]));
    expect(plan.scenarios.every((scenario) => scenario.missingEvidence.some((item) => /flow history|depth/i.test(item)))).toBe(true);
    expect(plan.scenarios.find((scenario) => scenario.kind === 'PULLBACK_CONTINUATION')?.entryZone).toEqual({ low: 98, high: 101, basis: expect.stringMatching(/EMA|VWAP/) });
    expect(plan.exhaustion).toMatchObject({ present: false, direction: 'NONE' });
    expect(input).toEqual(before);
    expect(strategyVote(input.candles)).toEqual(voteBefore);
  });

  it('mirrors directional candidates when the supplied technical evidence is bullish', () => {
    const input = snapshot({
      last: 111,
      technicalSummary: {
        mtfTrend: { '5m': null, '15m': { ema9: 108, ema21: 106, ema50: 102, ema200: null, regime: 'STRONG_UPTREND' }, '1h': null, '4h': null },
        volatility: null, momentum: { rsi14_15m: null, rsi14_1h: null, rsi14_4h: null },
        volumeProfile: { sessionVwap: 107, poc: 105, vah: 110, val: 100 },
        swingLevels: { recentSwingHigh: 110, recentSwingLow: 95, distToLiquiditySweepPct: 1 }
      }
    });
    const plan = buildTacticalTradePlan(input);
    const byKind = new Map(plan.scenarios.map((scenario) => [scenario.kind, scenario]));

    expect(byKind.get('PULLBACK_CONTINUATION')?.side).toBe('LONG');
    expect(byKind.get('BREAKDOWN_CONTINUATION')?.side).toBe('SHORT');
    expect(byKind.get('FAILED_BREAKDOWN_REVERSAL')?.side).toBe('LONG');
    expect(byKind.get('BREAKOUT_CONTINUATION')?.side).toBe('LONG');
    expect(byKind.get('FAILED_BREAKOUT_REVERSAL')?.side).toBe('SHORT');
  });

  it('accepts snapshots with no technical, flow, depth or derivatives inputs', () => {
    const plan = buildTacticalTradePlan(snapshot({ technicalSummary: null, orderflow: null, orderbook: null, derivatives: null }));
    expect(plan.scenarios).toHaveLength(5);
    expect(plan.scenarios.every((scenario) => scenario.entryZone === null && scenario.invalidationLevel === null && scenario.target1 === null && scenario.target2 === null)).toBe(true);
    expect(plan.scenarios.every((scenario) => scenario.evidence.length === 0)).toBe(true);
  });

  it('confirms breakout and breakdown against the prior twenty candles on the canonical summary path', () => {
    const closes = (up: boolean) => Array.from({ length: 54 }, (_, i) => up ? 100 + i : 154 - i);
    const make = (up: boolean): MarketSnapshot => {
      const values = closes(up);
      const candles = values.map((c, i) => ({ t: i * 900_000, o: c - 0.1, h: c + 0.1, l: c - 0.2, c, v: 1 }));
      const technicalSummary = buildTechnicalSummary({ '15m': candles });
      return snapshot({ last: values.at(-1)!, candles, technicalSummary });
    };
    const breakout = buildTacticalTradePlan(make(true)).scenarios.find((scenario) => scenario.kind === 'BREAKOUT_CONTINUATION')!;
    const breakdown = buildTacticalTradePlan(make(false)).scenarios.find((scenario) => scenario.kind === 'BREAKDOWN_CONTINUATION')!;
    expect(breakout.evidence.some((item) => /closed-candle price is above/i.test(item))).toBe(true);
    expect(breakdown.evidence.some((item) => /closed-candle price is below/i.test(item))).toBe(true);
  });

  it('confirms swing failures from a prior lookback wick and a later closed reclaim or rejection', () => {
    const make = (direction: 'breakdown' | 'breakout'): MarketSnapshot => {
      const candles = Array.from({ length: 50 }, (_, i) => ({ t: i * 900_000, o: 100, h: 101, l: 99, c: 100, v: 1 }));
      candles.push(direction === 'breakdown'
        ? { t: 50 * 900_000, o: 99.5, h: 100, l: 98, c: 99.5, v: 1 }
        : { t: 50 * 900_000, o: 100.5, h: 102, l: 100, c: 100.5, v: 1 });
      candles.push(direction === 'breakdown'
        ? { t: 51 * 900_000, o: 99.5, h: 101, l: 99, c: 100.5, v: 1 }
        : { t: 51 * 900_000, o: 100.5, h: 101, l: 99, c: 99.5, v: 1 });
      return snapshot({ last: candles.at(-1)!.c, candles, technicalSummary: buildTechnicalSummary({ '15m': candles }) });
    };
    const failedBreakdown = buildTacticalTradePlan(make('breakdown')).scenarios.find((scenario) => scenario.kind === 'FAILED_BREAKDOWN_REVERSAL')!;
    const failedBreakout = buildTacticalTradePlan(make('breakout')).scenarios.find((scenario) => scenario.kind === 'FAILED_BREAKOUT_REVERSAL')!;
    expect(failedBreakdown.evidence.some((item) => /previous candle broke below prior-20 swing low.*latest closed candle reclaimed/i.test(item))).toBe(true);
    expect(failedBreakout.evidence.some((item) => /previous candle broke above prior-20 swing high.*latest closed candle rejected/i.test(item))).toBe(true);
  });
});

  it('does not call RSI-only extremes exhaustion', () => {
    const input = snapshot({ technicalSummary: {
      ...snapshot().technicalSummary!, momentum: { rsi14_15m: 20, rsi14_1h: null, rsi14_4h: null }
    } });
    expect(buildTacticalTradePlan(input).exhaustion).toMatchObject({ present: false, direction: 'NONE' });
  });

  it('requires a prior closed-candle breakdown before calling a swing-low reclaim confirmed', () => {
    const input = snapshot({
      last: 97,
      candles: [{ t: 1, o: 96, h: 98, l: 94, c: 97, v: 1 }]
    });
    const scenario = buildTacticalTradePlan(input).scenarios.find((item) => item.kind === 'FAILED_BREAKDOWN_REVERSAL')!;
    expect(scenario.evidence.some((item) => /reclaim/i.test(item))).toBe(false);
    expect(scenario.missingEvidence).toContain('A prior closed-candle breakdown and subsequent reclaim of the supplied swing low are unconfirmed.');
  });

  it('omits profile targets that fall on the wrong side of a short entry zone', () => {
    const scenario = buildTacticalTradePlan(snapshot()).scenarios.find((item) => item.kind === 'BREAKDOWN_CONTINUATION')!;
    expect(scenario.entryZone).toEqual({ low: 95, high: 95, basis: 'reported recent swing low retest' });
    expect(scenario.target1).toBeNull();
    expect(scenario.target2).toBeNull();
  });

  it('uses complete rolling flow coverage and labels partial flow coverage honestly', () => {
    const window = (partial: boolean) => ({ windowMs: 300_000, startAt: 1, endAt: 300_000, coverageMs: partial ? 120_000 : 300_000, coveragePct: partial ? 40 : 100, partial, tradesCount: 20, takerBuyVol: 5, takerSellVol: 10, delta: -5, cumulativeDelta: -5, buySellRatio: 0.5 });
    const input = snapshot({ orderflow: {
      takerBuyVol: 5, takerSellVol: 10, cvdDelta: -5, buySellRatio: 0.5, deltaDivergence: false,
      rollingWindows: { '1m': window(false), '5m': window(false), '15m': window(false) }
    } });
    const full = buildTacticalTradePlan(input).scenarios[0];
    expect(full.missingEvidence.some((item) => /CVD history is unavailable/i.test(item))).toBe(false);
    expect(full.evidence.some((item) => /rolling|taker/i.test(item))).toBe(true);
    const partial = buildTacticalTradePlan(snapshot({ orderflow: {
      ...input.orderflow!, rollingWindows: { '1m': window(true), '5m': window(true), '15m': window(true) }
    } })).scenarios[0];
    expect(partial.missingEvidence.some((item) => /partial/i.test(item))).toBe(true);
  });
