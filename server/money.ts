// Boss's money split rule.
// Money Trade = total balance - safety net
// Allocation per order = Money Trade / N   (N is 1, 2, 3 or 4)

export interface SplitInput { balance: number; safetyNet?: number; n: number; orderSizePct?: number }
export interface Split {
  balance: number;
  safetyNet: number;
  n: number;
  moneyTrade: number;
  perOrder: number;
  orderSizePct?: number;
  canOpen: boolean;
  note: string;
  activeRatio?: number;
  safetyRatio?: number;
  activeCapital?: number;
  triggerLoss?: number;
  marginBuffer?: number;
}

export function assertN(n: number): asserts n is 1 | 2 | 3 | 4 {
  if (![1, 2, 3, 4].includes(n)) throw new Error('N (open orders) must be 1, 2, 3 or 4');
}

export function moneySplit({ balance, safetyNet, n, orderSizePct }: SplitInput): Split {
  assertN(n);
  if (orderSizePct != null && (!Number.isFinite(orderSizePct) || orderSizePct < 1.5 || orderSizePct > 100)) throw new Error('Order size must be 1.5..100% of Money Trade');
  const activeRatio = 0.60;
  const safetyRatio = 0.40;
  const effectiveSafetyNet = safetyNet != null && safetyNet >= 0 ? safetyNet : round2(balance * safetyRatio);
  const activeCapital = round2(balance * activeRatio);
  const moneyTrade = Math.max(0, round2(balance - effectiveSafetyNet));
  const perOrder = round2(orderSizePct == null ? moneyTrade / n : moneyTrade * orderSizePct / 100);
  const canOpen = balance > effectiveSafetyNet && moneyTrade > 0;
  const triggerLoss = -round2(effectiveSafetyNet * 0.625);
  const marginBuffer = round2(effectiveSafetyNet - Math.abs(triggerLoss));
  return {
    balance: round2(balance),
    safetyNet: round2(effectiveSafetyNet),
    n,
    moneyTrade,
    perOrder,
    ...(orderSizePct != null ? { orderSizePct } : {}),
    canOpen,
    activeRatio,
    safetyRatio,
    activeCapital,
    triggerLoss,
    marginBuffer,
    note: canOpen ? (orderSizePct == null ? `Money Trade ${moneyTrade} / ${n} = ${perOrder} per order` : `${orderSizePct}% of Money Trade ${moneyTrade} = ${perOrder} per order`) : 'Balance is at or below the safety net. No new orders.'
  };
}

export interface SafetyNetHedgeSpec {
  balance: number;
  activeRatio: number;
  safetyRatio: number;
  activeCapital: number;
  safetyNet: number;
  n: number;
  perOrder: number;
  triggerLoss: number;
  triggerEquity: number;
  marginBuffer: number;
}

export function calculateSafetyNetHedge(balance: number, n: number): SafetyNetHedgeSpec {
  assertN(n);
  const activeRatio = 0.60;
  const safetyRatio = 0.40;
  const activeCapital = round2(balance * activeRatio);
  const safetyNet = round2(balance * safetyRatio);
  const perOrder = round2(activeCapital / n);
  const triggerLoss = -round2(safetyNet * 0.625);
  const triggerEquity = round2(balance + triggerLoss);
  const marginBuffer = round2(safetyNet - Math.abs(triggerLoss));
  return {
    balance: round2(balance),
    activeRatio,
    safetyRatio,
    activeCapital,
    safetyNet,
    n,
    perOrder,
    triggerLoss,
    triggerEquity,
    marginBuffer
  };
}

export interface AutoHedgeResult {
  triggered: boolean;
  triggerLoss: number;
  marginBuffer: number;
  unrealizedPnl: number;
  buyVolume: number;
  sellVolume: number;
  vHedge: number;
  direction: 'BUY' | 'SELL' | null;
}

export function evaluateAutoHedge(
  balance: number,
  safetyNet: number,
  unrealizedPnl: number,
  positions: { side: 'LONG' | 'SHORT'; qty: number }[]
): AutoHedgeResult {
  const mSafety = safetyNet > 0 ? safetyNet : round2(balance * 0.40);
  const triggerLoss = -round2(mSafety * 0.625);
  const marginBuffer = round2(mSafety - Math.abs(triggerLoss));
  const buyVolume = round6(positions.filter((p) => p.side === 'LONG').reduce((sum, p) => sum + p.qty, 0));
  const sellVolume = round6(positions.filter((p) => p.side === 'SHORT').reduce((sum, p) => sum + p.qty, 0));
  const diff = round6(buyVolume - sellVolume);
  const vHedge = Math.abs(diff);
  const triggered = unrealizedPnl <= triggerLoss;
  let direction: 'BUY' | 'SELL' | null = null;
  if (triggered && vHedge > 1e-9) {
    direction = diff > 0 ? 'SELL' : 'BUY';
  }
  return {
    triggered,
    triggerLoss,
    marginBuffer,
    unrealizedPnl: round2(unrealizedPnl),
    buyVolume,
    sellVolume,
    vHedge: round6(vHedge),
    direction
  };
}

/** Exchange instrument rules the planner needs. Comes from the venue (exchangeInfo), never guessed in LIVE. */
export interface SizingRules { qtyStep: number; minQty: number; tickSize: number; minNotional?: number | null; maxQty?: number | null; takerFee?: number | null; source?: string }

export interface PlanInput {
  availableFunds?: number;
  orderSizePct?: number;
  /** LIVE/TESTNET can meet the exchange minimum within available capital. */
  adjustToVenueMinimum?: boolean;
  balance: number;
  /** Account equity, retained for callers displaying account observations. */
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
  /** Stop loss as a percentage of committed margin, converted to price distance using leverage. */
  stopPct?: number;
  /** @deprecated Read compatibility only. There is no minimum stop distance. */
  minStopPct?: number;
  /** @deprecated Read compatibility only. The profile supplies the stop. */
  maxStopPct?: number;
  /** Fallback minimum order value (qty * price) when the venue publishes none. */
  minOrderUsdt: number;
  maxOrderUsdt?: number;
  /** @deprecated Read compatibility only. No account-equity loss cap changes order size. */
  maxLossPerTradePct?: number;
  /** Taker fee fraction (0.00055 = 0.055%). The larger of this and the venue fee is charged on entry and exit. */
  takerFee?: number;
  /** Exchange rules. Without them the lot step is a paper-only guess and the plan says so. */
  rules?: SizingRules | null;
  /** @deprecated use rules.qtyStep */
  qtyStep?: number;
  takeProfitR?: number; // take profit at R times the stop distance, 0 = none
  /** Take profit as a percentage of committed margin. Takes precedence over legacy R. */
  takeProfitPct?: number;
}

export type Plan =
  | { ok: true; margin: number; notional: number; qty: number; stop: number; tp: number | null; leverage: number; lossAtStop: number; fees: number; stopPct: number; takerFee: number; rules: SizingRules; split: Split; notes: string[]; takeProfitPct?: number }
  | { ok: false; reason: string; split: Split; suggestion?: string };

/**
 * Sizes one order. Order of work:
 *  1. check available allocation, N, valid price and a stop on the right side
 *  2. stop = the given stop rounded to the tick TOWARD the entry (less risk), never moved otherwise
 *  3. qty = allocation * leverage / price within available funds, floored to the venue lot step
 *  4. optionally meet the venue minimum within available funds.
 */
export function planOrder(p: PlanInput): Plan {
  const split = moneySplit(p);
  if (!split.canOpen) return { ok: false, reason: 'Balance is at or below the safety net. Not opening anything.', split };
  if (p.openPositions >= p.n) return { ok: false, reason: `Already ${p.openPositions} open position(s). The limit is N = ${p.n}.`, split };
  if (!(p.price > 0) || !Number.isFinite(p.price)) return { ok: false, reason: 'No valid price.', split };
  if (!(p.leverage >= 1) || !Number.isFinite(p.leverage)) return { ok: false, reason: 'No valid leverage.', split };

  const notes: string[] = [];
  const rules: SizingRules = p.rules ?? { qtyStep: p.qtyStep ?? qtyStepFor(p.price), minQty: p.qtyStep ?? qtyStepFor(p.price), tickSize: 0, source: 'guessed from price (paper only)' };
  if (!p.rules && !p.qtyStep) notes.push('Lot step guessed from price, not read from an exchange.');
  const step = rules.qtyStep;
  const minQty = Math.max(rules.minQty || 0, step);
  const minNotional = Math.max(rules.minNotional ?? 0, p.minOrderUsdt);
  const maximum = p.maxOrderUsdt ?? 0;
  if (!Number.isFinite(maximum) || maximum < 0) return {ok: false, reason: 'Invalid Owner maximum trade limit.', split};
  const fee = Math.max(p.takerFee ?? 0, rules.takerFee ?? 0);
  if (![step, minQty].every((v) => Number.isFinite(v) && v > 0) || !Number.isFinite(minNotional) || minNotional < 0 || !Number.isFinite(fee) || fee < 0) return { ok: false, reason: 'Invalid exchange quantity, minimum or fee rule.', split };

  // App entry paths derive protection from profile margin percentages. Explicit prices support low-level previews.
  let rawStop: number;
  if (p.stop != null) rawStop = p.stop;
  else if (p.stopPct != null && p.stopPct > 0) rawStop = p.side === 'LONG' ? p.price * (1 - p.stopPct / (100 * p.leverage)) : p.price * (1 + p.stopPct / (100 * p.leverage));
  else return { ok: false, reason: 'No stop loss. Every order needs one.', split };
  if (!(rawStop > 0)) return { ok: false, reason: 'No stop loss. Every order needs one.', split };
  if (p.side === 'LONG' ? rawStop >= p.price : rawStop <= p.price) return { ok: false, reason: `Stop ${rawStop} is on the wrong side of the entry ${p.price} for a ${p.side}.`, split };
  const stop = tickToward(rawStop, rules.tickSize, p.side); // toward the entry = never more risk
  if (p.stop != null && stop !== p.stop) notes.push(`Stop ${p.stop} is off the ${rules.tickSize} tick, rounded toward the entry to ${stop}.`);
  if (p.side === 'LONG' ? stop >= p.price : stop <= p.price) return { ok: false, reason: `Stop ${stop} is not beyond the entry ${p.price} after tick rounding.`, split };
  const dist = Math.abs(p.price - stop);
  const stopPct = (dist / p.price) * 100;

  // Margin: allocation per order (Money Trade / N) times the risk factor, inside Money Trade headroom.
  const factor = Math.min(1, Math.max(0, p.sizeFactor));
  let margin = split.perOrder * factor;
  const headroom = Math.min(round2(split.moneyTrade - p.usedMargin), p.availableFunds ?? Infinity);
  if (!(headroom > 0)) return { ok: false, reason: `Money Trade is already in use (${round2(p.usedMargin)} of ${split.moneyTrade} USDT). The safety net stays untouched.`, split };
  if (margin > headroom) { margin = headroom; notes.push('Trimmed to stay inside Money Trade so the safety net stays untouched.'); }
  const capitalPerUnit = p.price / p.leverage + fee * p.price;
  let qtyMax = Math.min((margin * p.leverage) / p.price, headroom / capitalPerUnit);

  if (rules.maxQty && qtyMax > rules.maxQty) { qtyMax = rules.maxQty; notes.push(`Capped at the venue max quantity ${rules.maxQty}.`); }

  if (maximum > 0 && qtyMax * p.price > maximum) { qtyMax = maximum / p.price; notes.push(`Capped at Owner maximum trade value ${maximum} USDT.`); }
  let qty = floorTo(qtyMax, step);
  const venueMinimum = Math.ceil(Math.max(minQty, minNotional / p.price) / step - 1e-9) * step;
  let adjusted = false;
  if (p.adjustToVenueMinimum && factor > 0 && qty < venueMinimum - 1e-12) {
    const requiredMargin = venueMinimum * p.price / p.leverage;
    if (venueMinimum * capitalPerUnit <= headroom + 1e-9 && (!rules.maxQty || venueMinimum <= rules.maxQty + 1e-12)) {
      qty = venueMinimum; adjusted = true;
      notes.push(`Raised to exchange minimum quantity ${qty}: margin ${round4(requiredMargin)} USDT (requested allocation ${split.perOrder}).`);
    }
  }
  const suggestion = p.n > 1 ? `Try a smaller N (for example ${p.n - 1}) so each order gets more money.` : 'Add balance or lower the safety net.';
  if (qty < minQty - 1e-12 || qty <= 0) return { ok: false, reason: `Allowed size ${round6(qtyMax)} is below the minimum quantity ${minQty} (step ${step}) at ${p.price}. Not rounding up.`, split, suggestion };
  const notional = qty * p.price;
  if (notional < minNotional - 1e-9) return { ok: false, reason: `Order value ${round2(notional)} USDT (${qty} x ${p.price}) is below the minimum notional ${minNotional} USDT. Not rounding up.`, split, suggestion };
  if (maximum > 0 && notional > maximum + 1e-9) return {ok: false, reason: `Exchange minimum exceeds Owner maximum trade limit ${maximum} USDT.`, split};
  margin = notional / p.leverage;
  const fees = fee * qty * (p.price + stop);
  const lossAtStop = dist * qty + fees;
  // Belt and braces: the floored plan must satisfy every cap.
  if (margin > (adjusted ? headroom : Math.min(split.perOrder * factor, headroom)) + 1e-9 || qty * capitalPerUnit > headroom + 1e-9) return { ok: false, reason: 'Internal sizing check failed (margin exceeds available funds). Refusing.', split };

  const r = p.takeProfitR != null && p.takeProfitR > 0
    ? p.takeProfitR
    : (p.takeProfitPct != null && stopPct > 0 ? p.takeProfitPct / stopPct : 2);
  const targetDistance = p.takeProfitPct != null ? p.price * p.takeProfitPct / (100 * p.leverage) : dist * r;
  const rawTp = p.side === 'LONG' ? p.price + targetDistance : p.price - targetDistance;
  const tp = targetDistance > 0 && rawTp > 0 ? tickToward(rawTp, rules.tickSize, p.side === 'LONG' ? 'SHORT' : 'LONG') : null;
  return {
    ok: true, margin: round2(margin), notional: round2(notional), qty, stop, tp: tp != null && rules.tickSize > 0 ? tp : tp != null ? roundPrice(tp) : null, leverage: p.leverage,
    lossAtStop: round4(lossAtStop), fees: round4(fees), stopPct: round4(stopPct), takerFee: fee, rules: { ...rules, minQty, minNotional }, split, notes, takeProfitPct: p.takeProfitPct ?? round2(stopPct * r)
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
