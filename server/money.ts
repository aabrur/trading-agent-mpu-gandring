// Boss's money split rule.
// Money Trade = total balance - safety net
// Allocation per order = Money Trade / N   (N is 1, 2, 3 or 4)

export interface SplitInput { balance: number; safetyNet: number; n: number }
export interface Split {
  balance: number;
  safetyNet: number;
  n: number;
  moneyTrade: number;
  perOrder: number;
  canOpen: boolean;
  note: string;
}

export function assertN(n: number): asserts n is 1 | 2 | 3 | 4 {
  if (![1, 2, 3, 4].includes(n)) throw new Error('N (open orders) must be 1, 2, 3 or 4');
}

export function moneySplit({ balance, safetyNet, n }: SplitInput): Split {
  assertN(n);
  const moneyTrade = Math.max(0, round2(balance - safetyNet));
  const perOrder = round2(moneyTrade / n);
  const canOpen = balance > safetyNet && moneyTrade > 0;
  return {
    balance: round2(balance), safetyNet: round2(safetyNet), n, moneyTrade, perOrder, canOpen,
    note: canOpen ? `Money Trade ${moneyTrade} / ${n} = ${perOrder} per order` : 'Balance is at or below the safety net. No new orders.'
  };
}

export interface PlanInput {
  balance: number;
  safetyNet: number;
  n: number;
  openPositions: number;
  usedMargin: number;
  price: number;
  side: 'LONG' | 'SHORT';
  sizeFactor: number; // 0..1 from the risk gate, never above 1
  leverage: number;
  stopPct: number;
  minOrderUsdt: number;
  maxLossPerTradePct: number;
  qtyStep?: number;
  takeProfitR?: number; // take profit at R times the stop distance, 0 = none
}

export type Plan =
  | { ok: true; margin: number; notional: number; qty: number; stop: number; tp: number | null; leverage: number; split: Split; notes: string[] }
  | { ok: false; reason: string; split: Split; suggestion?: string };

export function planOrder(p: PlanInput): Plan {
  const split = moneySplit(p);
  if (!split.canOpen) return { ok: false, reason: 'Balance is at or below the safety net. Not opening anything.', split };
  if (p.openPositions >= p.n) return { ok: false, reason: `Already ${p.openPositions} open position(s). The limit is N = ${p.n}.`, split };
  if (!(p.stopPct > 0)) return { ok: false, reason: 'No stop loss. Every paper order needs one.', split };
  if (!(p.price > 0)) return { ok: false, reason: 'No valid price.', split };

  const notes: string[] = [];
  const factor = Math.min(1, Math.max(0, p.sizeFactor));
  let margin = split.perOrder * factor;
  const headroom = round2(split.moneyTrade - p.usedMargin);
  if (headroom < p.minOrderUsdt) return { ok: false, reason: `Money Trade is already in use (${round2(p.usedMargin)} of ${split.moneyTrade} USDT). The safety net stays untouched.`, split };
  if (margin > headroom) { margin = headroom; notes.push('Trimmed to stay inside Money Trade so the safety net stays untouched.'); }

  let notional = margin * p.leverage;
  // Loss cap: if the stop hits, the loss must stay under maxLossPerTradePct of balance.
  const maxLoss = (p.balance * p.maxLossPerTradePct) / 100;
  const lossAtStop = notional * (p.stopPct / 100);
  if (lossAtStop > maxLoss) {
    notional = maxLoss / (p.stopPct / 100);
    margin = notional / p.leverage;
    notes.push(`Cut size so a stop hit loses at most ${p.maxLossPerTradePct}% of balance.`);
  }
  const step = p.qtyStep ?? qtyStepFor(p.price);
  const qty = floorTo(notional / p.price, step); // floor only, never round up
  notional = qty * p.price;
  margin = notional / p.leverage;
  if (qty <= 0) {
    const suggestion = p.n > 1 ? `Try a smaller N (for example ${p.n - 1}) or a bigger paper balance.` : 'Add paper balance or lower the safety net.';
    return { ok: false, reason: `This allocation buys less than one lot step (${step}) at ${roundPrice(p.price)}. Not rounding up.`, split, suggestion };
  }
  if (margin < p.minOrderUsdt) {
    const suggestion = p.n > 1 ? `Try a smaller N (for example ${p.n - 1}) so each order gets more money.` : 'Add paper balance or lower the safety net.';
    return { ok: false, reason: `Allocation ${round2(margin)} USDT is below the minimum order of ${p.minOrderUsdt} USDT. Not rounding up.`, split, suggestion };
  }
  const stop = p.side === 'LONG' ? p.price * (1 - p.stopPct / 100) : p.price * (1 + p.stopPct / 100);
  const r = p.takeProfitR ?? 2;
  const dist = p.price * (p.stopPct / 100) * r;
  const tp = r > 0 ? roundPrice(p.side === 'LONG' ? p.price + dist : p.price - dist) : null;
  return { ok: true, margin: round2(margin), notional: round2(notional), qty, stop: roundPrice(stop), tp, leverage: p.leverage, split, notes };
}

export function qtyStepFor(price: number): number {
  if (price >= 10000) return 0.001;
  if (price >= 100) return 0.01;
  if (price >= 1) return 0.1;
  return 1;
}
export function floorTo(v: number, step: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const f = Math.floor(v / step + 1e-9) * step;
  return Number(f.toFixed(decimals));
}
export const round2 = (v: number) => Math.round(v * 100) / 100;
export function roundPrice(v: number): number {
  if (v >= 1000) return Math.round(v * 10) / 10;
  if (v >= 1) return Math.round(v * 1000) / 1000;
  return Number(v.toPrecision(5));
}
