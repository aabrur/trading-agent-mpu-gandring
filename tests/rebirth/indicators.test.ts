import { describe, expect, it } from 'vitest';
import {
  TIMEFRAMES,
  unavailableEvidence,
  verifiedEvidence,
  type MarketCandle,
  type MarketFrame,
  type TF
} from '../../server/v2/contracts.js';
import {
  computeBollinger20,
  computeConfirmedPivots,
  computeEma,
  computeMacd12269,
  computeRelativeVolume,
  computeSma,
  computeUtcVwap,
  computeWilderAtr14,
  computeWilderRsi14,
  FORMULA_VERSION
} from '../../server/v2/market/indicators.js';
import { computeIntelligence } from '../../server/v2/market/intelligence.js';

function makeCandles(
  tf: TF,
  rows: Array<{ o: number; h: number; l: number; c: number; v?: number }>,
  baseStart = Date.UTC(2026, 9, 31, 0, 0, 0)
): MarketCandle[] {
  const stepMs = tf === '4h' ? 14_400_000 : 60_000;
  return rows.map((r, idx) => {
    const startAt = baseStart + idx * stepMs;
    return {
      symbol: 'BTCUSDT',
      tf,
      startAt,
      endAt: startAt + stepMs - 1,
      open: String(r.o),
      high: String(r.h),
      low: String(r.l),
      close: String(r.c),
      volume: String(r.v ?? 10),
      volumeUnit: 'BTC',
      confirmed: true,
      sourceAt: startAt + stepMs,
      observedAt: startAt + stepMs
    };
  });
}

function emptyFrameWith(overrides: Partial<Record<TF, MarketCandle[]>>): MarketFrame {
  const closed = {} as Record<TF, MarketCandle[]>;
  for (const tf of TIMEFRAMES) {
    closed[tf] = overrides[tf] ?? [];
  }
  const now = Date.UTC(2026, 9, 31, 12, 0, 0);
  return {
    evidenceId: 'mkt-BTCUSDT-r1',
    revision: 1,
    symbol: 'BTCUSDT',
    venue: 'bybit',
    category: 'linear',
    asOf: now,
    last: verifiedEvidence({ value: '100', source: 'bybit.linear.tickers', sourceAt: now, observedAt: now, unit: 'USDT' }),
    bid: verifiedEvidence({ value: '99.9', source: 'bybit.linear.orderbook.50', sourceAt: now, observedAt: now, unit: 'USDT' }),
    ask: verifiedEvidence({ value: '100.1', source: 'bybit.linear.orderbook.50', sourceAt: now, observedAt: now, unit: 'USDT' }),
    closed,
    current: {},
    tradesEvidenceId: null,
    bookEvidenceId: 'book-BTCUSDT-1',
    funding: unavailableEvidence('bybit.linear.tickers', 'none', now, 'ratio'),
    openInterest: unavailableEvidence('bybit.linear.tickers', 'none', now, 'BTC')
  };
}

describe('T05 deterministic indicators and traceable intelligence', () => {
  it('computes_exact_sma20_seeded_ema_wilder_rsi14_atr14_macd_and_population_bollinger20', () => {
    // Insufficient warmup returns null + explicit reason, never 0
    const shortBars = makeCandles('1m', Array.from({ length: 10 }, (_, i) => ({ o: 100 + i, h: 101 + i, l: 99 + i, c: 100 + i })));
    expect(computeSma(shortBars, 20)).toEqual({ value: null, reason: 'insufficient_warmup:need_20_have_10' });
    expect(computeEma(shortBars, 200)).toEqual({ value: null, reason: 'insufficient_warmup:need_200_have_10' });
    expect(computeWilderRsi14(shortBars)).toEqual({ value: null, reason: 'insufficient_warmup:need_15_have_10' });
    expect(computeWilderAtr14(shortBars)).toEqual({ value: null, reason: 'insufficient_warmup:need_15_have_10' });
    expect(computeMacd12269(shortBars)).toEqual({ value: null, reason: 'insufficient_warmup:need_34_have_10' });

    // 1..20 linear closes -> SMA20 = (1 + 20) / 2 = 10.5
    const twentyBars = makeCandles(
      '1m',
      Array.from({ length: 20 }, (_, i) => ({ o: i + 1, h: i + 2, l: i + 0.5, c: i + 1 }))
    );
    const sma20 = computeSma(twentyBars, 20);
    expect(sma20.value).toBeCloseTo(10.5, 10);

    // Population SD of 1..20 is sqrt((20^2 - 1) / 12) = sqrt(399 / 12) = sqrt(33.25) = 5.766281297335398
    const bb = computeBollinger20(twentyBars);
    const expectedPopSd = Math.sqrt(33.25);
    expect(bb.value).not.toBeNull();
    expect(bb.value!.middle).toBeCloseTo(10.5, 10);
    expect(bb.value!.stdDev).toBeCloseTo(expectedPopSd, 10);
    expect(bb.value!.upper).toBeCloseTo(10.5 + 2 * expectedPopSd, 10);
    expect(bb.value!.lower).toBeCloseTo(10.5 - 2 * expectedPopSd, 10);

    // Seeded EMA9 on 1..10: seed at bar 9 (1..9) = 5.0; bar 10 close=10, alpha=2/10=0.2 -> 5*0.8 + 10*0.2 = 6.0
    const tenRising = makeCandles('1m', Array.from({ length: 10 }, (_, i) => ({ o: i + 1, h: i + 1, l: i + 1, c: i + 1 })));
    expect(computeEma(tenRising, 9).value).toBeCloseTo(6.0, 10);

    // Seeded EMA21 / EMA50 / EMA200 on constant 42 -> exact 42
    const twoHundredFlat = makeCandles('1m', Array.from({ length: 200 }, () => ({ o: 42, h: 44, l: 40, c: 42 })));
    expect(computeEma(twoHundredFlat, 21).value).toBeCloseTo(42, 10);
    expect(computeEma(twoHundredFlat, 50).value).toBeCloseTo(42, 10);
    expect(computeEma(twoHundredFlat, 200).value).toBeCloseTo(42, 10);
    expect(computeWilderAtr14(twoHundredFlat).value).toBeCloseTo(4, 10);
    const macdFlat = computeMacd12269(twoHundredFlat);
    expect(macdFlat.value).toEqual({ macd: 0, signal: 0, histogram: 0 });

    // Wilder RSI14: 14 gains of +1 then 1 loss of -1 (16 bars total, 15 deltas):
    // Seed (first 14 deltas: all +1): avgGain0 = 1, avgLoss0 = 0
    // Step 15 (delta = -1): avgGain1 = 13/14, avgLoss1 = 1/14 -> RS = 13 -> RSI = 100 - 100/14 = 92.85714285714286
    const rsiCloses = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 113];
    const rsiBars = makeCandles('1m', rsiCloses.map((c) => ({ o: c, h: c, l: c, c })));
    expect(computeWilderRsi14(rsiBars).value).toBeCloseTo(100 - 100 / 14, 10);
  });

  it('computes_utc_vwap_with_honest_candle_approximation_and_waits_for_two_right_bars_on_pivots', () => {
    const dayStart = Date.UTC(2026, 9, 31, 0, 0, 0);
    const bars = makeCandles(
      '1m',
      [
        { o: 100, h: 102, l: 98, c: 100, v: 10 }, // hlc3 = 100
        { o: 100, h: 105, l: 99, c: 102, v: 10 }, // hlc3 = 102
        { o: 102, h: 112, l: 101, c: 110, v: 30 }, // index 2 peak high=112
        { o: 110, h: 106, l: 100, c: 103, v: 10 }
      ],
      dayStart
    );

    // At 4 bars, index 2 only has ONE bar to its right -> pivot NOT yet confirmed!
    expect(computeConfirmedPivots(bars)).toEqual([]);

    // Add 5th bar (2nd bar to the right of index 2 with lower high) -> index 2 pivot high is now confirmed!
    const fiveBars = [
      ...bars,
      ...makeCandles('1m', [{ o: 103, h: 104, l: 99, c: 101, v: 10 }], dayStart + 4 * 60_000)
    ];
    const pivots = computeConfirmedPivots(fiveBars);
    expect(pivots).toContainEqual(
      expect.objectContaining({ index: 2, kind: 'HIGH', price: 112 })
    );

    // Candle-approximated UTC VWAP is explicitly INFERRED, while complete session trade VWAP is VERIFIED
    const approxVwap = computeUtcVwap(fiveBars, []);
    expect(approxVwap.certainty).toBe('INFERRED');
    expect(approxVwap.source).toBe('candle_hlc3_approximation');
    expect(approxVwap.value).not.toBeNull();

    const verifiedVwap = computeUtcVwap(
      fiveBars,
      [
        { tradeId: 't1', symbol: 'BTCUSDT', price: '100', size: '2', side: 'Buy', sourceAt: dayStart + 1000, observedAt: dayStart + 1000 },
        { tradeId: 't2', symbol: 'BTCUSDT', price: '106', size: '1', side: 'Sell', sourceAt: dayStart + 2000, observedAt: dayStart + 2000 }
      ],
      { completeUtcSessionTrades: true }
    );
    expect(verifiedVwap.certainty).toBe('VERIFIED');
    expect(verifiedVwap.value).toBeCloseTo(102, 10);

    // Relative volume excludes the evaluated bar from the prior 20-bar median baseline
    const volBars = makeCandles(
      '1m',
      [
        ...Array.from({ length: 20 }, () => ({ o: 100, h: 101, l: 99, c: 100, v: 10 })),
        { o: 100, h: 102, l: 99, c: 101, v: 35 }
      ]
    );
    const relVol = computeRelativeVolume(volBars, 20);
    expect(relVol.value).toBeCloseTo(3.5, 10);
  });

  it('preserves_opposing_bullish_4h_and_reversing_1m_facts_and_never_labels_incomplete_flow_broad_market_verified', () => {
    const bullish4h = makeCandles(
      '4h',
      Array.from({ length: 60 }, (_, i) => {
        const base = 80_000 + i * 250;
        return { o: base - 80, h: base + 120, l: base - 100, c: base, v: 100 };
      })
    );
    const reversing1m = makeCandles(
      '1m',
      Array.from({ length: 60 }, (_, i) => {
        const base = i < 35 ? 95_000 + i * 20 : 95_700 - (i - 35) * 90;
        return { o: base + 30, h: base + 40, l: base - 40, c: base, v: 25 };
      })
    );

    const frame = emptyFrameWith({ '4h': bullish4h, '1m': reversing1m });
    const intel = computeIntelligence(frame);

    expect(intel.formulaVersion).toBe(FORMULA_VERSION);
    expect(intel.byTimeframe['4h'].momentumRegime).toBe('BULLISH');
    expect(intel.byTimeframe['1m'].momentumRegime).toBe('BEARISH');
    expect(intel.opposingFacts.length).toBeGreaterThan(0);
    expect(intel.microstructure.coverage).not.toBe('broad_market_verified');
    expect(intel.microstructure.takerFlow.certainty).not.toBe('VERIFIED');
  });
});
