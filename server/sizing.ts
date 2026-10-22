// Size a ticket (read only). Shared by `npm run gb -- size` and the office Desk ops panel, so both give the same answer.
// Lot step, tick, min notional and fee come from the venue's own instrument rules, never guessed from price.
import type { AppConfig } from './config.js';
import type { InstrumentRules } from './exchange/rules.js';
import { publicRules } from './exchange/index.js';
import { planOrder } from './money.js';
import { normSymbol } from './commands.js';
import { safe } from './redact.js';

export interface SizeBook { balance: number; equity: number; safetyNet: number; n: number; open: number; used: number; mode: string; availableFunds?: number }
export interface SizeInput { symbol: string; side: string; entry: number; stop?: number; leverage?: number }
export interface SizeResult { ok: boolean; text: string; data: Record<string, unknown> | null }

export async function sizeTicket(cfg: AppConfig, env: NodeJS.ProcessEnv, book: SizeBook, i: SizeInput, f: typeof fetch = fetch): Promise<SizeResult> {
  const s = normSymbol(i.symbol ?? ''); const side = String(i.side ?? '').toUpperCase(); const entry = Number(i.entry);
  const fail = (text: string, data: Record<string, unknown> | null = null): SizeResult => ({ ok: false, text, data });
  if (!s || (side !== 'LONG' && side !== 'SHORT') || !(entry > 0)) return fail('usage: size <symbol> <LONG|SHORT> <entry>');
  const leverage = Math.max(1, Math.min(cfg.risk.maxLeverage, Math.floor(i.leverage ?? cfg.risk.maxLeverage)));
  // EXCHANGE=none (or empty) means no venue: read the rules of the market data source instead.
  const ex = (env.EXCHANGE ?? '').trim().toLowerCase();
  const venue = ex && ex !== 'none' ? ex : cfg.marketSource;
  const network = String(env.TRADING_MODE ?? '').toUpperCase() === 'TESTNET' ? 'testnet' : 'mainnet';
  let rules: Awaited<ReturnType<typeof publicRules>> = null;
  try { rules = await publicRules(venue, s, network, f); }
  catch (e) { return fail(`no ticket: could not read ${venue} instrument rules for ${s} (${safe((e as Error).message)}). Not sizing on guessed lot sizes.`); }
  if (rules?.status && rules.status !== 'TRADING') return fail(`no ticket: ${s} status on ${venue} is ${rules.status}, not TRADING`);
  const notes = [(i.leverage ?? 0) > cfg.risk.maxLeverage ? `leverage capped to ${cfg.risk.maxLeverage}x` : '', rules ? '' : `no public instrument reader for ${venue}; lot step guessed here, the office re-sizes with the exchange rules before any order`].filter(Boolean);
  return previewTicket(cfg, book, { ...i, side: side as 'LONG' | 'SHORT' }, rules, notes);
}

export function previewTicket(cfg: AppConfig, book: SizeBook, i: { symbol: string; side: 'LONG' | 'SHORT'; entry: number; stop?: number; leverage?: number }, rules: InstrumentRules | null, notes: string[] = []): SizeResult {
  const s = normSymbol(i.symbol), side = i.side, entry = i.entry;
  const leverage = Math.max(1, Math.min(cfg.risk.maxLeverage, Math.floor(i.leverage ?? cfg.risk.maxLeverage)));
  const fail = (text: string, data: Record<string, unknown> | null = null): SizeResult => ({ ok: false, text, data });
  const plan = planOrder({ availableFunds: book.availableFunds, balance: book.balance, equity: book.equity, safetyNet: book.safetyNet, n: book.n, orderSizePct: cfg.risk.orderSizePct, adjustToVenueMinimum: book.mode === 'LIVE' || book.mode === 'TESTNET', openPositions: book.open, usedMargin: book.used, price: entry, side, sizeFactor: 1, leverage, stopPct: cfg.risk.defaultStopPct, minOrderUsdt: cfg.risk.minOrderUsdt, takerFee: cfg.risk.takerFee, rules, takeProfitPct: cfg.risk.takeProfitPct });
  if (!plan.ok) return fail(`no ticket: ${plan.reason}${plan.suggestion ? ' ' + plan.suggestion : ''}`, { ok: false, reason: plan.reason, suggestion: plan.suggestion, split: plan.split, rules, notes });
  const d = { symbol: s, side, entry, qty: plan.qty, margin: plan.margin, notional: plan.notional, leverage: plan.leverage, stop: plan.stop, stopPct: plan.stopPct, stopMarginPct: cfg.risk.defaultStopPct, takeProfitMarginPct: cfg.risk.takeProfitPct, tp: plan.tp, riskAtStop: plan.lossAtStop, fees: plan.fees, takerFee: plan.takerFee, equity: book.equity, book: book.mode, rules: plan.rules, split: plan.split, notes: [...notes, ...plan.notes] };
  return { ok: true, data: d, text: `${side} ${plan.qty} ${s} at ${entry}: notional ${plan.notional}, margin ${plan.margin} at ${plan.leverage}x (allocation ${plan.split.perOrder}), SL ${plan.stop}${plan.tp ? `, TP ${plan.tp}` : ''}. Profile: SL ${cfg.risk.defaultStopPct}% / TP ${cfg.risk.takeProfitPct}% of margin before fees and venue rounding. Loss at stop incl. fees ${plan.lossAtStop} USDT. Rules: step ${plan.rules.qtyStep}, min qty ${plan.rules.minQty}, tick ${plan.rules.tickSize}, min notional ${plan.rules.minNotional} from ${plan.rules.source ?? 'n/a'}.${d.notes.length ? ' ' + d.notes.join('. ') : ''}` };
}
