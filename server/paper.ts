import type { ClosedTrade, Position } from './types.js';
import { moneySplit, round2, roundPrice } from './money.js';

let seq = 0;
const id = (p: string) => `${p}-${Date.now().toString(36)}-${(++seq).toString(36)}`;

// Paper book. No exchange, no wallet, no keys. Balance moves only on realized PnL.
export class PaperBook {
  positions: Position[] = [];
  closed: ClosedTrade[] = [];
  /** false in LIVE: the exchange holds the real stop and take profit. */
  autoExit = true;
  constructor(public balance: number, public safetyNet: number, public n: number, public takerFee: number) {}

  get usedMargin() { return round2(this.positions.reduce((s, p) => s + p.margin, 0)); }
  get unrealized() { return round2(this.positions.reduce((s, p) => s + p.unrealizedPnl, 0)); }
  split() { return moneySplit({ balance: this.balance, safetyNet: this.safetyNet, n: this.n }); }

  open(o: { symbol: string; side: 'LONG' | 'SHORT'; qty: number; entry: number; stop: number; tp?: number | null; margin: number; leverage: number }): Position {
    if (!(o.stop > 0)) throw new Error('refusing a paper order without a stop loss');
    if (this.positions.length >= this.n) throw new Error('N limit reached');
    if ((o.side === 'LONG' && o.stop >= o.entry) || (o.side === 'SHORT' && o.stop <= o.entry)) throw new Error('stop is on the wrong side of entry');
    const pos: Position = { id: id('pos'), ...o, tp: o.tp ?? null, openedAt: Date.now(), mark: o.entry, unrealizedPnl: 0 };
    this.positions.push(pos);
    return pos;
  }

  pnl(p: Position, price: number) {
    const gross = (p.side === 'LONG' ? price - p.entry : p.entry - price) * p.qty;
    const fees = (p.entry * p.qty + price * p.qty) * this.takerFee;
    return round2(gross - fees);
  }

  mark(symbol: string, price: number): ClosedTrade[] {
    const hits: ClosedTrade[] = [];
    for (const p of [...this.positions]) {
      if (p.symbol !== symbol) continue;
      p.mark = price;
      p.unrealizedPnl = this.pnl(p, price);
      const stopped = p.side === 'LONG' ? price <= p.stop : price >= p.stop;
      const target = p.tp != null && (p.side === 'LONG' ? price >= p.tp : price <= p.tp);
      if (!this.autoExit) continue;
      if (stopped) hits.push(this.close(p.id, p.stop, 'stop loss hit')!);
      else if (target) hits.push(this.close(p.id, p.tp!, 'take profit hit')!);
    }
    return hits;
  }

  close(positionId: string, price: number, reason: string): ClosedTrade | null {
    const i = this.positions.findIndex((p) => p.id === positionId);
    if (i < 0) return null;
    const p = this.positions[i];
    const realizedPnl = this.pnl(p, price);
    this.positions.splice(i, 1);
    this.balance = round2(this.balance + realizedPnl);
    const { unrealizedPnl: _u, ...rest } = p;
    const t: ClosedTrade = { ...rest, exit: roundPrice(price), closedAt: Date.now(), realizedPnl, reason };
    this.closed.unshift(t);
    this.closed = this.closed.slice(0, 100);
    return t;
  }

  closeSymbol(symbol: string, price: number, reason: string) {
    return this.positions.filter((p) => p.symbol === symbol).map((p) => this.close(p.id, price, reason)!).filter(Boolean);
  }
  closeAll(prices: Record<string, number>, reason: string) {
    return [...this.positions].map((p) => this.close(p.id, prices[p.symbol] ?? p.mark, reason)!).filter(Boolean);
  }
}
