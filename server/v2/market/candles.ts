import { TIMEFRAMES, type MarketCandle, type TF } from '../contracts.js';

export const BYBIT_INTERVAL_BY_TF: Record<TF, string> = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '1h': '60',
  '4h': '240',
  '1d': 'D'
};

export const TF_BY_BYBIT_INTERVAL: Record<string, TF> = {
  '1': '1m',
  '5': '5m',
  '15': '15m',
  '60': '1h',
  '240': '4h',
  D: '1d'
};

export const TF_DURATION_MS: Record<TF, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000
};

export class SymbolCandleBook {
  private readonly closedByTf = new Map<TF, Map<number, MarketCandle>>();
  private readonly currentByTf = new Map<TF, MarketCandle>();
  private readonly maxClosedPerTf: number;

  constructor(maxClosedPerTf = 500) {
    this.maxClosedPerTf = maxClosedPerTf;
    for (const tf of TIMEFRAMES) {
      this.closedByTf.set(tf, new Map());
    }
  }

  seedRestCandles(
    symbol: string,
    tf: TF,
    rows: string[][],
    options: { volumeUnit: string; sourceAt: number; observedAt: number; nowMs?: number }
  ): void {
    const duration = TF_DURATION_MS[tf];
    const cutoff = options.nowMs ?? options.sourceAt;
    // Bybit REST /v5/market/kline returns newest-first; sort ascending by startAt.
    const sorted = [...rows]
      .filter((r) => r.length >= 6)
      .sort((a, b) => Number(a[0]) - Number(b[0]));

    for (const r of sorted) {
      const startAt = Number(r[0]);
      if (!Number.isFinite(startAt)) continue;
      const endAt = startAt + duration - 1;
      const confirmed = endAt < cutoff;
      const candle: MarketCandle = {
        symbol,
        tf,
        startAt,
        endAt,
        open: String(r[1]),
        high: String(r[2]),
        low: String(r[3]),
        close: String(r[4]),
        volume: String(r[5]),
        volumeUnit: options.volumeUnit,
        confirmed,
        sourceAt: options.sourceAt,
        observedAt: options.observedAt
      };
      this.upsertCandle(candle);
    }
  }

  upsertCandle(candle: MarketCandle): void {
    const map = this.closedByTf.get(candle.tf)!;
    if (candle.confirmed) {
      // Deduplicate by startAt: overwrite with latest confirmed bar, never sum volume twice.
      map.set(candle.startAt, candle);
      const current = this.currentByTf.get(candle.tf);
      if (current && current.startAt <= candle.startAt) {
        this.currentByTf.delete(candle.tf);
      }
      this.trimClosed(map);
    } else {
      // Never place unconfirmed bar in closed map.
      if (!map.has(candle.startAt)) {
        const prev = this.currentByTf.get(candle.tf);
        if (!prev || candle.startAt >= prev.startAt) {
          this.currentByTf.set(candle.tf, candle);
        }
      }
    }
  }

  private trimClosed(map: Map<number, MarketCandle>): void {
    if (map.size <= this.maxClosedPerTf) return;
    const keys = [...map.keys()].sort((a, b) => a - b);
    const excess = keys.length - this.maxClosedPerTf;
    for (let i = 0; i < excess; i++) {
      map.delete(keys[i]!);
    }
  }

  snapshot(): { closed: Record<TF, MarketCandle[]>; current: Partial<Record<TF, MarketCandle>> } {
    const closed = {} as Record<TF, MarketCandle[]>;
    for (const tf of TIMEFRAMES) {
      const map = this.closedByTf.get(tf)!;
      closed[tf] = [...map.values()]
        .sort((a, b) => a.startAt - b.startAt)
        .map((c) => ({ ...c }));
    }
    const current: Partial<Record<TF, MarketCandle>> = {};
    for (const [tf, bar] of this.currentByTf.entries()) {
      current[tf] = { ...bar };
    }
    return { closed, current };
  }
}
