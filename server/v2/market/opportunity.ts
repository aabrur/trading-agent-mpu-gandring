import type { BybitMarketHub } from './bybit.js';
import { calculateAlphaFactors } from '../../market/alpha-factors.js';
import { detectHarmonicPatterns } from '../../market/harmonics.js';

export interface CandidateOpportunity {
  symbol: string;
  score: number;
  reasons: string[];
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
}

export interface WatchlistFunnelOptions {
  allocatedMarginUsdt?: number;
  leverage?: number;
  minNotionalUsdt?: number;
  systemicRiskOff?: boolean;
  rejectedRecently?: boolean;
}

type OpportunityHub = Pick<BybitMarketHub, 'snapshot'>;

/**
 * Quantitative pre-screen for one watchlist symbol.
 * Directional signals are scored per side; the opposing side is subtracted so a symbol
 * with conflicting signals (e.g. bullish harmonic against a bearish alpha regime) ranks
 * lower than one where the evidence points the same way.
 */
export function evaluateWatchlistOpportunity(
  symbol: string,
  hub?: OpportunityHub | null,
  opts?: WatchlistFunnelOptions
): CandidateOpportunity {
  const cleanSym = symbol.trim().toUpperCase();
  const reasons: string[] = [];
  let base = 50;
  let bull = 0;
  let bear = 0;

  if (!hub) {
    return { symbol: cleanSym, score: base, reasons: ['Standard queue order'], bias: 'NEUTRAL' };
  }

  const vote = (side: 'BULLISH' | 'BEARISH', points: number, label: string) => {
    if (side === 'BULLISH') bull += points;
    else bear += points;
    reasons.push(`${label} (${side === 'BULLISH' ? 'bull' : 'bear'} +${points})`);
  };

  try {
    const frame = hub.snapshot(cleanSym);
    if (!frame || frame.last?.availability !== 'AVAILABLE') {
      return { symbol: cleanSym, score: base, reasons: ['Market feed pending'], bias: 'NEUTRAL' };
    }

    const currentPrice = Number(frame.last.value);
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      return { symbol: cleanSym, score: base, reasons: ['Price feed unavailable'], bias: 'NEUTRAL' };
    }

    if (opts?.allocatedMarginUsdt && opts?.leverage && opts?.minNotionalUsdt) {
      const effectiveNotional = opts.allocatedMarginUsdt * opts.leverage;
      if (effectiveNotional < opts.minNotionalUsdt) {
        return {
          symbol: cleanSym,
          score: 15,
          reasons: [`INSUFFICIENT_NOTIONAL (${effectiveNotional.toFixed(1)} < min ${opts.minNotionalUsdt})`],
          bias: 'NEUTRAL'
        };
      }
    }

    if (opts?.rejectedRecently) {
      base = Math.max(20, base - 20);
      reasons.push('REJECT_COOLDOWN (-20)');
    }

    const closed15m = frame.closed?.['15m']?.filter((b) => b.confirmed) ?? [];
    const closed1h = frame.closed?.['1h']?.filter((b) => b.confirmed) ?? [];
    const closed5m = frame.closed?.['5m']?.filter((b) => b.confirmed) ?? [];

    const primaryClosed = closed15m.length >= 20 ? closed15m : (closed5m.length >= 20 ? closed5m : closed1h);

    if (primaryClosed.length >= 20) {
      const lastBar = primaryClosed.at(-1)!;
      const priorBars = primaryClosed.slice(-21, -1);
      const priorHigh20 = priorBars.reduce((max, b) => Math.max(max, Number(b.high) || 0), -Infinity);
      const priorLow20 = priorBars.reduce((min, b) => Math.min(min, Number(b.low) || Infinity), Infinity);

      const barHigh = Number(lastBar.high);
      const barLow = Number(lastBar.low);
      const barClose = Number(lastBar.close);

      // 1. Liquidity sweep (fakeout rejection)
      if (barHigh > priorHigh20 && barClose < priorHigh20) {
        vote('BEARISH', 25, 'BEARISH_SWEEP_REJECT');
      } else if (barLow < priorLow20 && barClose > priorLow20) {
        vote('BULLISH', 25, 'BULLISH_SWEEP_RECLAIM');
      }

      // 2. Volume spike: non-directional, it only says the symbol is active
      const volumes = priorBars.map((b) => Number(b.volume) || 0);
      const avgVol = volumes.reduce((sum, v) => sum + v, 0) / (volumes.length || 1);
      const lastVol = Number(lastBar.volume) || 0;
      const relVol = avgVol > 0 ? lastVol / avgVol : 1;

      if (relVol >= 2.5) {
        base += 20;
        reasons.push(`VOLUME_CLIMAX (${relVol.toFixed(1)}x) (+20)`);
      } else if (relVol >= 1.8) {
        base += 15;
        reasons.push(`HIGH_REL_VOL (${relVol.toFixed(1)}x) (+15)`);
      }

      const normalizedCandles = primaryClosed.map((b) => ({
        timestamp: b.startAt,
        open: Number(b.open),
        high: Number(b.high),
        low: Number(b.low),
        close: Number(b.close),
        volume: Number(b.volume)
      }));

      // 3. Alpha factors (composite score and regime)
      try {
        const alpha = calculateAlphaFactors(normalizedCandles);
        const comp = alpha?.compositeScore || 0;
        const absComp = Math.abs(comp);
        if (alpha && absComp >= 0.2) {
          const side = comp > 0 ? 'BULLISH' : 'BEARISH';
          if (absComp >= 0.35) vote(side, 15, `ALPHA_STRONG (${alpha.regime}, ${comp.toFixed(2)})`);
          else vote(side, 10, `ALPHA_MOMENTUM (${comp.toFixed(2)})`);
        }
      } catch {}

      // 4. Harmonic patterns
      try {
        const best = detectHarmonicPatterns(normalizedCandles)?.[0];
        if (best && (best.orientation === 'BULLISH' || best.orientation === 'BEARISH')) {
          vote(best.orientation, 20, `HARMONIC_${best.name.toUpperCase()} (Q:${best.qualityScore})`);
        }
      } catch {}
    }

    // 5. 24h momentum
    const p24 = frame.price24hPcnt != null ? Number(frame.price24hPcnt) : null;
    if (p24 !== null && Number.isFinite(p24) && Math.abs(p24) >= 0.03) {
      vote(p24 > 0 ? 'BULLISH' : 'BEARISH', 10, `HIGH_24H_MOMENTUM (${(p24 * 100).toFixed(1)}%)`);
    }

    const dominant = Math.max(bull, bear);
    const opposing = Math.min(bull, bear);
    if (opposing > 0) reasons.push(`CONFLICT (-${opposing})`);
    if (reasons.length === 0) reasons.push('CONSOLIDATION');

    let effectiveDominant = dominant;
    let bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = bull > bear ? 'BULLISH' : bear > bull ? 'BEARISH' : 'NEUTRAL';

    if (opts?.systemicRiskOff && bias === 'BULLISH') {
      reasons.push('SYSTEMIC_RISK_OFF (bullish long blocked -30)');
      bias = 'NEUTRAL';
      effectiveDominant = 0;
      base = Math.max(20, base - 30);
    }

    return { symbol: cleanSym, score: Math.max(0, base + effectiveDominant - opposing), reasons, bias };
  } catch (err) {
    return { symbol: cleanSym, score: 35, reasons: [`Evaluation error: ${(err as Error).message}`], bias: 'NEUTRAL' };
  }
}
