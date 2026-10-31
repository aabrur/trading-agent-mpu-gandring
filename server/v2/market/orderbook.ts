import type { DecimalString } from '../contracts.js';

export interface OrderbookLevel {
  price: DecimalString;
  size: DecimalString;
}

export interface OrderbookView {
  symbol: string;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  updateId: number;
  seq: number | null;
  sourceAt: number;
  observedAt: number;
}

function isZeroSize(size: string): boolean {
  const trimmed = size.trim();
  if (!trimmed) return true;
  return /^0+(?:\.0+)?$/.test(trimmed);
}

function compareDecimalStrings(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (na !== nb) return na < nb ? -1 : 1;
  return 0;
}

export class LocalOrderbook {
  private bids = new Map<string, string>();
  private asks = new Map<string, string>();
  private updateId: number | null = null;
  private seq: number | null = null;
  private sourceAt = 0;
  private observedAt = 0;
  private valid = false;

  constructor(
    public readonly symbol: string,
    private readonly depthLimit = 50
  ) {}

  isValid(): boolean {
    return this.valid;
  }

  applySnapshot(input: {
    bids: Array<[string, string]>;
    asks: Array<[string, string]>;
    u: number;
    seq?: number | null;
    sourceAt: number;
    observedAt: number;
  }): void {
    this.bids.clear();
    this.asks.clear();
    for (const [p, s] of input.bids) {
      if (!isZeroSize(s)) this.bids.set(p, s);
    }
    for (const [p, s] of input.asks) {
      if (!isZeroSize(s)) this.asks.set(p, s);
    }
    this.updateId = input.u;
    this.seq = input.seq ?? null;
    this.sourceAt = input.sourceAt;
    this.observedAt = input.observedAt;
    this.valid = true;
    this.trimDepth();
  }

  applyDelta(input: {
    bids: Array<[string, string]>;
    asks: Array<[string, string]>;
    u: number;
    seq?: number | null;
    sourceAt: number;
    observedAt: number;
  }): { applied: boolean; needsResync: boolean } {
    // Official Bybit V5 rule: u === 1 indicates server restart snapshot semantics.
    if (input.u === 1) {
      this.applySnapshot(input);
      return { applied: true, needsResync: false };
    }

    if (!this.valid || this.updateId === null) {
      return { applied: false, needsResync: true };
    }

    // Sequence regression invalidates local book; nonconsecutive forward u > prevU is valid on Bybit V5!
    if (input.u < this.updateId) {
      this.valid = false;
      return { applied: false, needsResync: true };
    }
    if (input.u === this.updateId) {
      return { applied: false, needsResync: false };
    }

    for (const [p, s] of input.bids) {
      if (isZeroSize(s)) this.bids.delete(p);
      else this.bids.set(p, s);
    }
    for (const [p, s] of input.asks) {
      if (isZeroSize(s)) this.asks.delete(p);
      else this.asks.set(p, s);
    }
    this.updateId = input.u;
    if (input.seq !== undefined && input.seq !== null) {
      this.seq = input.seq;
    }
    this.sourceAt = input.sourceAt;
    this.observedAt = input.observedAt;
    this.trimDepth();
    return { applied: true, needsResync: false };
  }

  private trimDepth(): void {
    if (this.bids.size > this.depthLimit) {
      const sortedBids = [...this.bids.keys()].sort((a, b) => compareDecimalStrings(b, a));
      for (const k of sortedBids.slice(this.depthLimit)) this.bids.delete(k);
    }
    if (this.asks.size > this.depthLimit) {
      const sortedAsks = [...this.asks.keys()].sort((a, b) => compareDecimalStrings(a, b));
      for (const k of sortedAsks.slice(this.depthLimit)) this.asks.delete(k);
    }
  }

  view(): OrderbookView | null {
    if (!this.valid || this.updateId === null) return null;
    const bids = [...this.bids.entries()]
      .sort(([pa], [pb]) => compareDecimalStrings(pb, pa))
      .slice(0, this.depthLimit)
      .map(([price, size]) => ({ price, size }));
    const asks = [...this.asks.entries()]
      .sort(([pa], [pb]) => compareDecimalStrings(pa, pb))
      .slice(0, this.depthLimit)
      .map(([price, size]) => ({ price, size }));
    return {
      symbol: this.symbol,
      bids,
      asks,
      updateId: this.updateId,
      seq: this.seq,
      sourceAt: this.sourceAt,
      observedAt: this.observedAt
    };
  }
}
