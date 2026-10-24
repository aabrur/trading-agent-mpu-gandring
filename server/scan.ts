import type { Desk } from './desk.js';
import { round2 } from './money.js';

// proaktif-agent: a proactive scan that runs before every auto cycle (and on demand via
// `npm run gb -- scan`). It never trades. It reports problems early so the agents and the
// owner see them: loss cap usage, positions without a stop, API or exchange errors, stale
// data, balance close to the safety net.

export interface Finding { level: 'ok' | 'info' | 'warn' | 'alert'; code: string; text: string }

export function capitalFinding(balance: number, safetyNet: number, split: { moneyTrade: number; perOrder: number }, minOrderUsdt: number): Finding | null {
  if (split.moneyTrade <= 0) return { level: 'alert', code: 'safety_net', text: `Balance ${balance} is at or below the safety net ${safetyNet}. Nothing left to trade.` };
  if (split.moneyTrade < balance * 0.1) return { level: 'warn', code: 'safety_net', text: `Tradable capital is ${split.moneyTrade} USDT; less than 10% of balance remains above the ${safetyNet} USDT safety net.` };
  if (split.perOrder < minOrderUsdt) return { level: 'warn', code: 'safety_net', text: `Allocation ${split.perOrder} USDT per order is below the ${minOrderUsdt} USDT minimum. Reduce open-order slots or add capital.` };
  return null;
}

export function proactiveScan(desk: Desk, now = Date.now()): Finding[] {
  const cfg = desk.cfg, book = desk.book, out: Finding[] = [];
  // 1. daily loss cap usage
  desk.checkDay();
  const equity = round2(book.balance + book.unrealized);
  const start = desk.day.startEquity || equity;
  const lossPct = start > 0 ? Math.max(0, ((start - equity) / start) * 100) : 0;
  const usage = Math.round((lossPct / cfg.risk.dailyLossLimitPct) * 100);
  if (desk.day.lossHit) out.push({ level: 'alert', code: 'daily_loss_hit', text: `Daily loss stop is on (${cfg.risk.dailyLossLimitPct}%). No new orders until the next UTC day.` });
  else if (usage >= 90) out.push({ level: 'alert', code: 'daily_loss_usage', text: `Daily loss cap ${usage}% used (${round2(lossPct)}% of ${cfg.risk.dailyLossLimitPct}%). One more loss may pause new orders.` });
  else if (usage >= cfg.learning.lossWarnPct) out.push({ level: 'warn', code: 'daily_loss_usage', text: `Daily loss cap ${usage}% used (${round2(lossPct)}% of ${cfg.risk.dailyLossLimitPct}%). Be selective.` });
  // 2. positions without a stop
  for (const p of book.positions) if (!(p.stop > 0)) out.push({ level: 'alert', code: 'no_stop', text: `${p.symbol} ${p.side} has no stop loss. Close it or set a stop now.` });
  // 3. API and exchange errors since the last scan (or the last 30 minutes)
  const since = desk.lastScan?.at ?? now - 30 * 60_000;
  const errs = desk.errors.filter((e) => e.at >= since && !e.source.startsWith('agent:'));
  if (errs.length) out.push({ level: errs.length >= 3 ? 'alert' : 'warn', code: 'errors', text: `${errs.length} API or exchange error${errs.length > 1 ? 's' : ''} since the last scan. Latest: ${errs[errs.length - 1].text.slice(0, 160)}` });
  // 4. stale or sample data feed
  const symbols = cfg.auto.symbols.length ? cfg.auto.symbols : cfg.watchlist;
  for (const s of symbols) {
    const t = desk.tickers[s];
    if (!t) { out.push({ level: 'info', code: 'no_feed', text: `No price for ${s} yet.` }); continue; }
    const ageMin = (now - t.at) / 60_000;
    if (ageMin > cfg.learning.staleFeedMin) out.push({ level: 'warn', code: 'stale_feed', text: `${s} price is ${Math.round(ageMin)} min old (limit ${cfg.learning.staleFeedMin}).` });
    if (t.example && cfg.marketSource !== 'sample') out.push({ level: 'warn', code: 'sample_fallback', text: `${s} is on offline sample data because the live feed failed. No exchange orders on sample data.` });
  }
  // 5. balance near the safety net
  const split = book.split();
  const capital = capitalFinding(book.balance, book.safetyNet, split, cfg.risk.minOrderUsdt);
  if (capital) out.push(capital);
  if (desk.killed) out.push({ level: 'alert', code: 'killed', text: 'Kill switch is on. Restart the server to trade again.' });
  else if (desk.paused) out.push({ level: 'info', code: 'paused', text: 'Desk is paused.' });
  if (!out.some((f) => f.level === 'warn' || f.level === 'alert')) out.push({ level: 'ok', code: 'ok', text: 'Scan clean: loss cap fine, every position has a stop, no errors, data fresh.' });
  return out;
}
