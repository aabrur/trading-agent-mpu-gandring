import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Desk, Activity } from './desk.js';
import type { AppConfig } from './config.js';
import { sendToGrokBot } from './bridge.js';
import { safe, log } from './redact.js';
import { round2 } from './money.js';

export interface ReportPosition { symbol: string; side: string; qty: number; entry: number; stop: number; tp: number | null; mark: number; pnl: number; openedAt: number }
export interface Report {
  id: string; at: number; since: number; mode: string; exchange: string | null;
  balance: number; safetyNet: number; moneyTrade: number; n: number; perOrder: number; equity: number; unrealized: number; realized: number;
  dailyLoss: { limitPct: number; hit: boolean }; auto: { on: boolean; cycles: number; intervalMin: number };
  positions: ReportPosition[]; opened: Activity[]; closed: Activity[]; skipped: Activity[];
  text: string;
}

export function buildReport(desk: Desk, since: number): Report {
  const s = desk.book.split();
  const acts = desk.activity.filter((a) => a.at > since);
  const realized = round2(desk.book.closed.filter((t) => t.closedAt > since).reduce((sum, t) => sum + t.realizedPnl, 0));
  const r: Omit<Report, 'text'> = {
    id: `rep-${Date.now().toString(36)}`, at: Date.now(), since, mode: desk.cfg.tradingMode, exchange: desk.cfg.live?.exchange ?? null,
    balance: desk.book.balance, safetyNet: desk.book.safetyNet, moneyTrade: s.moneyTrade, n: desk.book.n, perOrder: s.perOrder,
    equity: round2(desk.book.balance + desk.book.unrealized), unrealized: desk.book.unrealized, realized,
    dailyLoss: { limitPct: desk.cfg.risk.dailyLossLimitPct, hit: desk.day.lossHit },
    auto: { on: desk.autoState.on, cycles: desk.autoState.cycles, intervalMin: desk.cfg.auto.intervalMin },
    positions: desk.book.positions.map((p) => ({ symbol: p.symbol, side: p.side, qty: p.qty, entry: p.entry, stop: p.stop, tp: p.tp, mark: p.mark, pnl: p.unrealizedPnl, openedAt: p.openedAt })),
    opened: acts.filter((a) => a.kind === 'opened'), closed: acts.filter((a) => a.kind === 'closed'), skipped: acts.filter((a) => a.kind === 'skipped')
  };
  return { ...r, text: safe(renderText(r)) };
}

const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16);
function renderText(r: Omit<Report, 'text'>) {
  const lines = [
    `Trading Agent Mpu Gandring report (${r.mode}${r.exchange ? ` on ${r.exchange}` : ''})`,
    `${new Date(r.since).toISOString().slice(0, 16)}Z to ${new Date(r.at).toISOString().slice(0, 16)}Z`,
    '',
    `Balance ${r.balance} USDT, equity ${r.equity}, safety net ${r.safetyNet}`,
    `Money Trade ${r.moneyTrade} / N ${r.n} = ${r.perOrder} per order`,
    `Realized this period ${r.realized >= 0 ? '+' : ''}${r.realized}, unrealized ${r.unrealized >= 0 ? '+' : ''}${r.unrealized}`,
    `Daily loss stop ${r.dailyLoss.limitPct}%${r.dailyLoss.hit ? ' (HIT, no new orders until next UTC day)' : ''}. Auto ${r.auto.on ? `on, every ${r.auto.intervalMin} min, ${r.auto.cycles} cycles` : 'off'}`,
    '',
    `Open positions (${r.positions.length}):`,
    ...(r.positions.length ? r.positions.map((p) => `- ${p.side} ${p.qty} ${p.symbol} entry ${p.entry} SL ${p.stop}${p.tp ? ` TP ${p.tp}` : ''} mark ${p.mark} PnL ${p.pnl >= 0 ? '+' : ''}${p.pnl}`) : ['- none']),
    '',
    `Opened (${r.opened.length}):`, ...(r.opened.length ? r.opened.map((a) => `- ${hhmm(a.at)} ${a.symbol}: ${a.detail}`) : ['- none']),
    `Closed (${r.closed.length}):`, ...(r.closed.length ? r.closed.map((a) => `- ${hhmm(a.at)} ${a.symbol}: ${a.detail}`) : ['- none']),
    `Skipped (${r.skipped.length}):`, ...(r.skipped.length ? r.skipped.slice(-12).map((a) => `- ${hhmm(a.at)} ${a.symbol}: ${a.detail}`) : ['- none']),
    '',
    'Not financial advice.'
  ];
  return lines.join('\n');
}

/** Optional Telegram channel (EXPERIMENTAL). One send, 8 second timeout, no retry. */
export async function sendTelegram(cfg: AppConfig, text: string, fetchImpl: typeof fetch = fetch): Promise<'sent' | 'failed' | 'off'> {
  const tg = cfg.reports.telegram;
  if (!tg.enabled) return 'off';
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${tg.token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tg.chatId, text: safe(text).slice(0, 4000), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) throw new Error(`telegram HTTP ${res.status}`);
    return 'sent';
  } catch (e) { log(`[report] telegram not delivered: ${safe((e as Error).message)}`); return 'failed'; }
}

export class Reporter {
  private timer: NodeJS.Timeout | null = null;
  private last = Date.now();
  constructor(private desk: Desk, private dir: string | null, private outboxPath?: string, private fetchImpl: typeof fetch = fetch) {}
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.generate(), this.desk.cfg.reports.intervalMin * 60_000);
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async generate(): Promise<Report> {
    const rep = buildReport(this.desk, this.last);
    this.last = rep.at;
    this.desk.reports.unshift(rep);
    this.desk.reports = this.desk.reports.slice(0, 50);
    if (this.dir) {
      try {
        const day = path.join(this.dir, new Date(rep.at).toISOString().slice(0, 10));
        mkdirSync(day, { recursive: true });
        const stamp = new Date(rep.at).toISOString().slice(11, 19).replace(/:/g, '');
        writeFileSync(path.join(day, `report-${stamp}.md`), rep.text + '\n');
        writeFileSync(path.join(day, `report-${stamp}.json`), safe(rep) + '\n');
      } catch (e) { log('[report]', e); }
    }
    this.desk.emit('report', rep);
    this.desk.emit('state', this.desk.snapshot());
    const { text, ...data } = rep;
    void sendToGrokBot(this.desk.cfg, 'report', { ...data, text } as Record<string, unknown>, this.outboxPath);
    void sendTelegram(this.desk.cfg, text, this.fetchImpl);
    return rep;
  }
}
