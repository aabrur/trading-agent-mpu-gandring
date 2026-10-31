import { randomUUID } from 'node:crypto';
import {
  TIMEFRAMES,
  unavailableEvidence,
  type Evidence,
  type MarketFrame,
  type TF
} from '../contracts.js';
import type { OrderbookView } from './orderbook.js';
import type { PublicTradeRecord } from './bybit.js';
import {
  computeBollinger20,
  computeEma,
  computeMacd12269,
  computeRelativeVolume,
  computeSma,
  computeStructureSummary,
  computeUtcVwap,
  computeWilderAtr14,
  computeWilderRsi14,
  FORMULA_VERSION,
  type BollingerReading,
  type IndicatorValue,
  type MacdReading,
  type StructureSummary
} from './indicators.js';

export type MomentumRegime = 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'INSUFFICIENT_WARMUP';
export type VolatilityRegime = 'EXPANDING' | 'COMPRESSING' | 'NORMAL' | 'UNKNOWN';

export interface TimeframeFeatures {
  tf: TF;
  closedBarCount: number;
  lastClosedStartAt: number | null;
  sma20: IndicatorValue<number>;
  ema9: IndicatorValue<number>;
  ema21: IndicatorValue<number>;
  ema50: IndicatorValue<number>;
  ema200: IndicatorValue<number>;
  rsi14: IndicatorValue<number>;
  atr14: IndicatorValue<number>;
  macd: IndicatorValue<MacdReading>;
  bollinger20: IndicatorValue<BollingerReading>;
  vwapUtc: Evidence<number>;
  relativeVolume20: IndicatorValue<number>;
  structure: StructureSummary;
  momentumRegime: MomentumRegime;
  volatilityRegime: VolatilityRegime;
  inputBarRefs: { firstStartAt: number | null; lastStartAt: number | null; count: number };
}

export interface MicrostructureSummary {
  coverage: 'single_venue_bybit_linear' | 'partial_window' | 'unavailable';
  spreadBps: Evidence<number>;
  bookImbalanceTop10: Evidence<number>;
  takerFlow: Evidence<{ buyVolume: number; sellVolume: number; netDelta: number; windowTrades: number }>;
  funding: Evidence<string>;
  openInterest: Evidence<string>;
}

export interface OpposingFact {
  code: string;
  higherTf?: TF;
  lowerTf?: TF;
  summary: string;
}

export interface IntelligenceFrame {
  evidenceId: string;
  marketEvidenceId: string;
  marketRevision: number;
  symbol: string;
  formulaVersion: string;
  byTimeframe: Record<TF, TimeframeFeatures>;
  microstructure: MicrostructureSummary;
  opposingFacts: OpposingFact[];
  generatedAt: number;
}

export interface ComputeIntelligenceOptions {
  orderbook?: OrderbookView | null;
  trades?: readonly PublicTradeRecord[];
  completeUtcSessionTrades?: boolean;
}

function classifyMomentum(
  ema9: IndicatorValue<number>,
  ema21: IndicatorValue<number>,
  macd: IndicatorValue<MacdReading>
): MomentumRegime {
  if (ema9.value === null || ema21.value === null) {
    return 'INSUFFICIENT_WARMUP';
  }
  const macdHist = macd.value?.histogram ?? 0;
  if (ema9.value > ema21.value && macdHist >= 0) return 'BULLISH';
  if (ema9.value < ema21.value && macdHist <= 0) return 'BEARISH';
  return 'NEUTRAL';
}

function classifyVolatility(bb: IndicatorValue<BollingerReading>): VolatilityRegime {
  const bw = bb.value?.bandwidth;
  if (bw === null || bw === undefined) return 'UNKNOWN';
  if (bw >= 0.04) return 'EXPANDING';
  if (bw <= 0.008) return 'COMPRESSING';
  return 'NORMAL';
}

export function computeIntelligence(
  frame: MarketFrame,
  options: ComputeIntelligenceOptions = {}
): IntelligenceFrame {
  const now = Date.now();
  const byTimeframe = {} as Record<TF, TimeframeFeatures>;

  for (const tf of TIMEFRAMES) {
    const closed = frame.closed[tf].filter((b) => b.confirmed);
    const sma20 = computeSma(closed, 20);
    const ema9 = computeEma(closed, 9);
    const ema21 = computeEma(closed, 21);
    const ema50 = computeEma(closed, 50);
    const ema200 = computeEma(closed, 200);
    const rsi14 = computeWilderRsi14(closed);
    const atr14 = computeWilderAtr14(closed);
    const macd = computeMacd12269(closed);
    const bollinger20 = computeBollinger20(closed);
    const vwapUtc = computeUtcVwap(closed, options.trades ?? [], {
      completeUtcSessionTrades: options.completeUtcSessionTrades,
      asOfMs: frame.asOf
    });
    const relativeVolume20 = computeRelativeVolume(closed, 20);
    const structure = computeStructureSummary(closed);

    byTimeframe[tf] = {
      tf,
      closedBarCount: closed.length,
      lastClosedStartAt: closed.at(-1)?.startAt ?? null,
      sma20,
      ema9,
      ema21,
      ema50,
      ema200,
      rsi14,
      atr14,
      macd,
      bollinger20,
      vwapUtc,
      relativeVolume20,
      structure,
      momentumRegime: classifyMomentum(ema9, ema21, macd),
      volatilityRegime: classifyVolatility(bollinger20),
      inputBarRefs: {
        firstStartAt: closed[0]?.startAt ?? null,
        lastStartAt: closed.at(-1)?.startAt ?? null,
        count: closed.length
      }
    };
  }

  // Opposing-fact extraction: preserve cross-timeframe disagreement honestly!
  const opposingFacts: OpposingFact[] = [];
  const higherTfs: TF[] = ['1d', '4h', '1h'];
  const lowerTfs: TF[] = ['15m', '5m', '1m'];

  for (const htf of higherTfs) {
    const hRegime = byTimeframe[htf].momentumRegime;
    if (hRegime !== 'BULLISH' && hRegime !== 'BEARISH') continue;
    for (const ltf of lowerTfs) {
      const lRegime = byTimeframe[ltf].momentumRegime;
      if (
        (hRegime === 'BULLISH' && lRegime === 'BEARISH') ||
        (hRegime === 'BEARISH' && lRegime === 'BULLISH')
      ) {
        opposingFacts.push({
          code: 'TIMEFRAME_MOMENTUM_CONFLICT',
          higherTf: htf,
          lowerTf: ltf,
          summary: `${htf} momentum is ${hRegime} while ${ltf} momentum is ${lRegime}.`
        });
      }
    }
  }

  for (const tf of TIMEFRAMES) {
    const div = byTimeframe[tf].structure.rsiDivergence;
    if (div) {
      opposingFacts.push({
        code: 'CONFIRMED_RSI_DIVERGENCE',
        lowerTf: tf,
        summary: `Confirmed ${div} RSI pivot divergence on ${tf}.`
      });
    }
  }

  // Microstructure: single-venue Bybit linear or partial window, NEVER broad-market VERIFIED!
  const bidNum = frame.bid.value !== null ? Number(frame.bid.value) : null;
  const askNum = frame.ask.value !== null ? Number(frame.ask.value) : null;
  const spreadBps: Evidence<number> =
    bidNum !== null && askNum !== null && bidNum > 0 && askNum >= bidNum
      ? {
          id: `ev-spread-${randomUUID()}`,
          value: ((askNum - bidNum) / ((askNum + bidNum) / 2)) * 10_000,
          certainty: 'VERIFIED',
          availability: 'AVAILABLE',
          freshness: frame.bid.freshness,
          source: frame.bid.source,
          sourceAt: frame.bid.sourceAt,
          observedAt: now,
          publishedAt: null,
          eventAt: null,
          unit: 'bps',
          reason: null
        }
      : unavailableEvidence('bybit.linear.orderbook', 'Bid/ask quote incomplete', now, 'bps');

  const book = options.orderbook ?? null;
  let bookImbalanceTop10: Evidence<number>;
  if (book && book.bids.length > 0 && book.asks.length > 0) {
    const bidSum = book.bids.slice(0, 10).reduce((s, l) => s + Number(l.size), 0);
    const askSum = book.asks.slice(0, 10).reduce((s, l) => s + Number(l.size), 0);
    const total = bidSum + askSum;
    bookImbalanceTop10 =
      total > 0
        ? {
            id: `ev-imb-${randomUUID()}`,
            value: (bidSum - askSum) / total,
            certainty: 'REPORTED',
            availability: 'AVAILABLE',
            freshness: 'CURRENT',
            source: 'bybit.linear.orderbook.50:top10',
            sourceAt: book.sourceAt,
            observedAt: now,
            publishedAt: null,
            eventAt: null,
            unit: 'ratio_-1_to_1',
            reason: 'single_venue_top10_depth'
          }
        : unavailableEvidence('bybit.linear.orderbook.50', 'Zero top-10 depth', now, 'ratio_-1_to_1');
  } else {
    bookImbalanceTop10 = unavailableEvidence(
      'bybit.linear.orderbook.50',
      'Orderbook snapshot unavailable',
      now,
      'ratio_-1_to_1'
    );
  }

  const trades = options.trades ?? [];
  const takerFlow: Evidence<{ buyVolume: number; sellVolume: number; netDelta: number; windowTrades: number }> =
    trades.length > 0
      ? (() => {
          let buyVolume = 0;
          let sellVolume = 0;
          for (const t of trades) {
            const sz = Number(t.size);
            if (!Number.isFinite(sz)) continue;
            if (t.side === 'Buy') buyVolume += sz;
            else sellVolume += sz;
          }
          return {
            id: `ev-flow-${randomUUID()}`,
            value: {
              buyVolume,
              sellVolume,
              netDelta: buyVolume - sellVolume,
              windowTrades: trades.length
            },
            // Incomplete / bounded trade sample is INFERRED/REPORTED, never broad-market VERIFIED
            certainty: 'INFERRED',
            availability: 'AVAILABLE',
            freshness: 'CURRENT',
            source: 'bybit.linear.publicTrade:bounded_sample',
            sourceAt: trades.at(-1)?.sourceAt ?? now,
            observedAt: now,
            publishedAt: null,
            eventAt: null,
            unit: 'base_coin',
            reason: 'bounded_single_venue_trade_window'
          };
        })()
      : unavailableEvidence(
          'bybit.linear.publicTrade',
          'No recent trade sample buffered',
          now,
          'base_coin'
        );

  const coverage: MicrostructureSummary['coverage'] =
    book && trades.length > 0
      ? 'single_venue_bybit_linear'
      : book || trades.length > 0 || spreadBps.availability === 'AVAILABLE'
        ? 'partial_window'
        : 'unavailable';

  return {
    evidenceId: `intel-${frame.symbol}-r${frame.revision}-${randomUUID().slice(0, 8)}`,
    marketEvidenceId: frame.evidenceId,
    marketRevision: frame.revision,
    symbol: frame.symbol,
    formulaVersion: FORMULA_VERSION,
    byTimeframe,
    microstructure: {
      coverage,
      spreadBps,
      bookImbalanceTop10,
      takerFlow,
      funding: frame.funding,
      openInterest: frame.openInterest
    },
    opposingFacts,
    generatedAt: now
  };
}
