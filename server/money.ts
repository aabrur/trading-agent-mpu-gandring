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

/** Exchange instrument rules the planner needs. Comes from the venue (exchangeInfo), never guessed in LIVE. */
export interface SizingRules { qtyStep: number; minQty: number; tickSize: number; minNotional?: number | null; maxQty?: number | null; takerFee?: number | null; source?: string }

export interface PlanInput {
  balance: number;
  /** Account equity for the loss cap. Defaults to balance. */
  equity?: number;
  safetyNet: number;
  n: number;
  openPositions: number;
  usedMargin: number;
  /** Expected entry price (ask for LONG, bid for SHORT). */
  price: number;
  side: 'LONG' | 'SHORT';
  sizeFactor: number; // 0..1 from the risk gate, never above 1
  leverage: number;
  /** The stop price given by the Strategist. Used exactly (only rounded to the tick toward the entry). Never moved. */
  stop?: number | null;
  /** Used only when no stop price is given (internal debate): the stop is placed this far from the entry. */
  stopPct?: number;
  /** Stops closer than this (in % of entry) are refused. */
  minStopPct?: number;
  /** A given stop wider than this (in % of entry, DEFAULT_STOP_PCT) is refused, never tightened or moved. */
  maxStopPct?: number;
  /** Fallback minimum order value (qty * price) when the venue publishes none. */
  minOrderUsdt: number;
  maxLossPerTradePct: number;
  /** Taker fee fraction (0.00055 = 0.055%). The larger of this and the venue fee is charged on entry and exit. */
  takerFee?: number;
  /** Exchange rules. Without them the lot step is a paper-only guess and the plan says so. */
  rules?: SizingRules | null;
  /** @deprecated use rules.qtyStep */
  qtyStep?: number;
  takeProfitR?: number; // take profit at R times the stop distance, 0 = none
}

export type Plan =
  | { ok: true; margin: number; notional: number; qty: number; stop: number; tp: number | null; leverage: number; lossAtStop: number; fees: number; stopPct: number; takerFee: number; rules: SizingRules; split: Split; notes: string[] }
  | { ok: false; reason: string; split: Split; suggestion?: string };

/**
 * Sizes one order. Order of work:
 *  1. guards: safety net, N, valid price, a stop on the right side, not closer than MIN_STOP_PCT and not wider than DEFAULT_STOP_PCT
 *  2. stop = the given stop rounded to the tick TOWARD the entry (less risk), never moved otherwise
 *  3. qty = the smallest of: allocation * leverage / price, Money Trade headroom, and the loss cap
 *     (|entry - stop| * qty + round-trip taker fee <= MAX_LOSS_PER_TRADE_PCT of equity), floored to the lot step
 *  4. refuse if qty < minQty or qty * price < min notional. Never round up to a minimum.
 */
export function planOrder(p: PlanInput): Plan {
  const split = moneySplit(p);
  if (!split.canOpen) return { ok: false, reason: 'Balance is at or below the safety net. Not opening anything.', split };
  if (p.openPositions >= p.n) return { ok: false, reason: `Already ${p.openPositions} open position(s). The limit is N = ${p.n}.`, split };
  if (!(p.price > 0)) return { ok: false, reason: 'No valid price.', split };
  if (!(p.leverage >= 1)) return { ok: false, reason: 'No valid leverage.', split };

  const notes: string[] = [];
  const rules: SizingRules = p.rules ?? { qtyStep: p.qtyStep ?? qtyStepFor(p.price), minQty: p.qtyStep ?? qtyStepFor(p.price), tickSize: 0, source: 'guessed from price (paper only)' };
  if (!p.rules && !p.qtyStep) notes.push('Lot step guessed from price, not read from an exchange.');
  const step = rules.qtyStep;
  const minQty = Math.max(rules.minQty || 0, step);
  const minNotional = rules.minNotional != null && rules.minNotional > 0 ? rules.minNotional : p.minOrderUsdt;
  const fee = Math.max(p.takerFee ?? 0, rules.takerFee ?? 0);

  // Stop: the given price, exactly. Only the internal debate (no stop price) derives one from stopPct.
  let rawStop: number;
  if (p.stop != null) rawStop = p.stop;
  else if (p.stopPct != null && p.stopPct > 0) rawStop = p.side === 'LONG' ? p.price * (1 - p.stopPct / 100) : p.price * (1 + p.stopPct / 100);
  else return { ok: false, reason: 'No stop loss. Every order needs one.', split };
  if (!(rawStop > 0)) return { ok: false, reason: 'No stop loss. Every order needs one.', split };
  if (p.side === 'LONG' ? rawStop >= p.price : rawStop <= p.price) return { ok: false, reason: `Stop ${rawStop} is on the wrong side of the entry ${p.price} for a ${p.side}.`, split };
  const stop = tickToward(rawStop, rules.tickSize, p.side); // toward the entry = never more risk
  if (p.stop != null && stop !== p.stop) notes.push(`Stop ${p.stop} is off the ${rules.tickSize} tick, rounded toward the entry to ${stop}.`);
  if (p.side === 'LONG' ? stop >= p.price : stop <= p.price) return { ok: false, reason: `Stop ${stop} is not beyond the entry ${p.price} after tick rounding.`, split };
  const dist = Math.abs(p.price - stop);
  const stopPct = (dist / p.price) * 100;
  if (p.minStopPct != null && stopPct < p.minStopPct - 1e-9) return { ok: false, reason: `Stop ${stop} is ${round2(stopPct)}% from the entry ${p.price}, closer than the ${p.minStopPct}% floor. Not moving it; refusing.`, split };
  if (p.maxStopPct != null && p.maxStopPct > 0 && stopPct > p.maxStopPct + 1e-9) return { ok: false, reason: `Stop ${stop} is ${round2(stopPct)}% from the entry ${p.price}, wider than the ${p.maxStopPct}% limit (DEFAULT_STOP_PCT). Not moving it; refusing.`, split };

  // Margin: allocation per order (Money Trade / N) times the risk factor, inside Money Trade headroom.
  const factor = Math.min(1, Math.max(0, p.sizeFactor));
  let margin = split.perOrder * factor;
  const headroom = round2(split.moneyTrade - p.usedMargin);
  if (!(headroom > 0)) return { ok: false, reason: `Money Trade is already in use (${round2(p.usedMargin)} of ${split.moneyTrade} USDT). The safety net stays untouched.`, split };
  if (margin > headroom) { margin = headroom; notes.push('Trimmed to stay inside Money Trade so the safety net stays untouched.'); }
  let qtyMax = (margin * p.leverage) / p.price;

  // Loss cap including the round-trip taker fee: qty * (dist + fee * (entry + stop)) <= maxLoss.
  // Loss cap base: the lower of balance and equity, so unrealized profit never raises the cap.
  const equity = Math.min(p.balance, p.equity ?? p.balance);
  const maxLoss = (equity * p.maxLossPerTradePct) / 100;
  const lossPerUnit = dist + fee * (p.price + stop);
  const qtyLoss = maxLoss / lossPerUnit;
  if (qtyLoss < qtyMax) { qtyMax = qtyLoss; notes.push(`Size cut so a stop hit (with fees) loses at most ${p.maxLossPerTradePct}% of equity (${round2(maxLoss)} USDT).`); }
  if (rules.maxQty && qtyMax > rules.maxQty) { qtyMax = rules.maxQty; notes.push(`Capped at the venue max quantity ${rules.maxQty}.`); }

  const qty = floorTo(qtyMax, step); // floor only, never round up
  const suggestion = p.n > 1 ? `Try a smaller N (for example ${p.n - 1}) so each order gets more money, or a closer stop.` : 'Add balance, lower the safety net, or use a closer stop.';
  if (qty < minQty - 1e-12 || qty <= 0) return { ok: false, reason: `Allowed size ${round6(qtyMax)} is below the minimum quantity ${minQty} (step ${step}) at ${p.price}. Not rounding up.`, split, suggestion };
  const notional = qty * p.price;
  if (notional < minNotional - 1e-9) return { ok: false, reason: `Order value ${round2(notional)} USDT (${qty} x ${p.price}) is below the minimum notional ${minNotional} USDT. Not rounding up.`, split, suggestion };
  margin = notional / p.leverage;
  const fees = fee * qty * (p.price + stop);
  const lossAtStop = dist * qty + fees;
  // Belt and braces: the floored plan must satisfy every cap.
  if (margin > Math.min(split.perOrder * factor, headroom) + 1e-9 || lossAtStop > maxLoss + 1e-9) return { ok: false, reason: 'Internal sizing check failed (margin or loss over the cap). Refusing.', split };

  const r = p.takeProfitR ?? 2;
  const tp = r > 0 ? tickToward(p.side === 'LONG' ? p.price + dist * r : p.price - dist * r, rules.tickSize, p.side === 'LONG' ? 'SHORT' : 'LONG') : null;
  return {
    ok: true, margin: round2(margin), notional: round2(notional), qty, stop, tp: tp != null && rules.tickSize > 0 ? tp : tp != null ? roundPrice(tp) : null, leverage: p.leverage,
    lossAtStop: round4(lossAtStop), fees: round4(fees), stopPct: round4(stopPct), takerFee: fee, rules: { ...rules, minQty, minNotional }, split, notes
  };
}

/**
 * Rounds a stop to the tick toward the entry: up for a LONG stop (below entry), down for a SHORT stop (above entry).
 * A price already on the tick is returned unchanged. Tick 0 means no rounding.
 */
export function tickToward(v: number, tick: number, side: 'LONG' | 'SHORT'): number {
  if (!(tick > 0)) return v;
  const dec = decimalsOf(tick);
  const k = v / tick;
  const near = Math.round(k);
  const units = Math.abs(k - near) < 1e-7 ? near : side === 'LONG' ? Math.ceil(k) : Math.floor(k);
  return Number((units * tick).toFixed(dec));
}
function decimalsOf(step: number) {
  const s = step.toString();
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  return (s.split('.')[1] ?? '').length;
}
const round4 = (v: number) => Math.round(v * 1e4) / 1e4;
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

export function qtyStepFor(price: number): number {
  if (price >= 10000) return 0.001;
  if (price >= 100) return 0.01;
  if (price >= 1) return 0.1;
  return 1;
}
export function floorTo(v: number, step: number): number {
  const decimals = decimalsOf(step);
  const f = Math.floor(v / step + 1e-9) * step;
  return Number(f.toFixed(decimals));
}
export const round2 = (v: number) => Math.round(v * 100) / 100;
export function roundPrice(v: number): number {
  if (v >= 1000) return Math.round(v * 10) / 10;
  if (v >= 1) return Math.round(v * 1000) / 1000;
  return Number(v.toPrecision(5));
}
