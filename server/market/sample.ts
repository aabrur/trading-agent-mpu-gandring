import type { Candle, MarketSnapshot } from '../types.js';
import { buildTechnicalSummary } from '../strategy.js';

// Offline sample market. Deterministic, labeled EXAMPLE. Used when public APIs
// are unreachable or MARKET_SOURCE=sample.
const BASE: Record<string, number> = { BTCUSDT: 67250, ETHUSDT: 3120, SOLUSDT: 151.4, BNBUSDT: 585, XRPUSDT: 0.52, DOGEUSDT: 0.124, AVAXUSDT: 27.8, LINKUSDT: 13.9, ZECUSDT: 38.2 };
const DRIFT: Record<string, number> = { BTCUSDT: 0.00035, ETHUSDT: -0.0004, SOLUSDT: 0.0001, ZECUSDT: 0.0002 };

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
export function hashStr(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function sampleCandles(symbol: string, count = 300, endTime = Date.UTC(2026, 9, 17, 3, 0, 0)): Candle[] {
  const r = rng(hashStr(symbol));
  const base = BASE[symbol] ?? 10 + (hashStr(symbol) % 900);
  const drift = DRIFT[symbol] ?? (r() - 0.5) * 0.0006;
  const bar = 15 * 60_000;
  let price = base * (1 - drift * count * 0.6);
  const out: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const t = endTime - (count - i) * bar;
    const noise = (r() - 0.5) * 0.006;
    const shock = (i >= count - 8 && drift !== 0)
      ? (drift > 0 ? Math.abs(noise * 0.3) + drift : -Math.abs(noise * 0.3) + drift)
      : noise + drift + Math.sin(i / 17) * 0.0007;
    const o = price;
    const c = Math.max(o * (1 + shock), 0.00001);
    const h = Math.max(o, c) * (1 + r() * 0.002);
    const l = Math.min(o, c) * (1 - r() * 0.002);
    out.push({ t, o, h, l, c, v: Math.round(100 + r() * 900) });
    price = c;
  }
  return out;
}

export function sampleSnapshot(symbol: string, now = Date.now()): MarketSnapshot {
  const candles = sampleCandles(symbol);
  const last = candles.at(-1)!.c;
  const dayAgo = candles.at(-97)!.c;
  // small wobble on the live price so the office ticker moves; candles stay fixed
  const wobble = 1 + Math.sin(now / 45_000 + (hashStr(symbol) % 7)) * 0.0012;
  const drift = DRIFT[symbol] ?? 0;
  const isBearish = drift < 0;
  const px = last * wobble;
  return {
    symbol, source: 'sample', example: true, last: px,
    change24hPct: ((px - dayAgo) / dayAgo) * 100,
    fundingRate: ((hashStr(symbol) % 21) - 10) / 100000,
    bid: px * 0.9999, ask: px * 1.0001, candles, fetchedAt: now,
    orderbook: {
      bidAskImbalance05Pct: 0.52,
      bidAskImbalance1Pct: 0.51,
      spreadBps: 2,
      microPrice: Math.round(px * 1.00002 * 100) / 100,
      topBidWall: { price: Math.round(px * 0.995 * 100) / 100, size: 45.2 },
      topAskWall: { price: Math.round(px * 1.005 * 100) / 100, size: 52.8 }
    },
    orderflow: {
      takerBuyVol: isBearish ? 1180 : 1250,
      takerSellVol: isBearish ? 1250 : 1180,
      cvdDelta: isBearish ? -70 : 70,
      buySellRatio: isBearish ? 0.94 : 1.06,
      deltaDivergence: false,
      tradesCount: 48
    },
    derivatives: {
      fundingRate: ((hashStr(symbol) % 21) - 10) / 100000,
      predictedFunding: 0.0001,
      openInterest: 15200,
      oiDelta15mPct: 0.45,
      oiDelta1hPct: 1.2,
      oiDelta4hPct: 2.8,
      spotPerpBasisBps: 3.5,
      multiVenueFunding: {
        bybit: { fundingRate: 0.0001, openInterest: 8500 },
        binance: { fundingRate: 0.00009, openInterest: 12400 },
        hyperliquid: { fundingRate: 0.00012, openInterest: 3200 }
      }
    },
    technicalSummary: buildTechnicalSummary({ '15m': candles }),
    whaleOnChain: {
      hyperliquidWhales: {
        longCount: 14,
        shortCount: 8,
        avgLongNotional: 850000,
        avgShortNotional: 620000,
        totalUnrealizedPnl: 420000
      },
      deribitMacro: {
        dvol: 52.4,
        putCallRatio: 0.68,
        indexPrice: px
      }
    }
  };
}
