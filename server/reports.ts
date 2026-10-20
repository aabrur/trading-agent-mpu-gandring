import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Desk, Activity } from './desk.js';
import type { AppConfig } from './config.js';
import { sendToGrokBot } from './bridge.js';
import { safe, log } from './redact.js';
import { round2 } from './money.js';
import type { RoleScore } from './scorecard.js';
import type { Finding } from './scan.js';
import { capitalFinding } from './scan.js';

export interface ReportPosition { ownership?: string; protectionStatus?: string; entryStatus?: string; symbol: string; side: string; qty: number; entry: number; stop: number; tp: number | null; mark: number; pnl: number; openedAt: number }
export interface Report {
  monitoring?: { symbols: string[]; killed: boolean; running: boolean; current: string | null; previous: string | null };
  opportunityReviews?: { observed: number; pending: number; unavailable: number; items: import('./opportunity-review.js').OpportunityReview[] };
  id: string; at: number; since: number; mode: string; exchange: string | null;
  accounting?: { source: string; status: string; observedAt: number | null; confirmedRealized: number; estimatedRealized: number; unknownExits: number; actualFees: number | null; funding: number | null; financialEvidence?: import('./live/financial-evidence.js').FinancialSummary };
  balance: number; safetyNet: number; moneyTrade: number; n: number; perOrder: number; equity: number; unrealized: number; realized: number;
  dailyLoss: { limitPct: number; hit: boolean }; auto: { on: boolean; cycles: number; intervalMin: number };
  positions: ReportPosition[]; opened: Activity[]; closed: Activity[]; skipped: Activity[];
  /** Desk Lead supervision */
  scorecard: RoleScore[];
  /** self-improving: lessons written or reinforced this period */
  lessons: { role: string; kind: string; status: string; count: number; symbol?: string; happened: string; rootCause: string; lesson: string }[];
  standingRules: string[];
  /** proaktif-agent: latest scan */
  scan: Finding[];
  text: string;
}

export function buildReport(desk: Desk, since: number, at = Date.now()): Report {
  const s = desk.book.split();
  const acts = desk.activity.filter((a) => a.at > since && a.at <= at);
  const exits = desk.book.closed.filter((t) => t.closedAt > since && t.closedAt <= at);
  const reviews = desk.opportunityReviews.since(since).filter((r) => (r.updatedAt ?? r.at) <= at);
  const financial = desk.financialSummary(since + 1, at);
  const confirmedRealized = round2(exits.filter((t) => !t.pnlStatus || t.pnlStatus === 'confirmed').reduce((sum, t) => sum + t.realizedPnl, 0));
  const estimatedRealized = round2(exits.filter((t) => t.pnlStatus === 'estimated').reduce((sum, t) => sum + t.realizedPnl, 0));
  const realized = round2(confirmedRealized + estimatedRealized);
  const capital = capitalFinding(desk.book.balance, desk.book.safetyNet, s, desk.cfg.risk.minOrderUsdt);
  const r: Omit<Report, 'text'> = {
    monitoring: { symbols: [...new Set(desk.autoState.on ? desk.cfg.auto.symbols : desk.cfg.watchlist)], killed: desk.killed, running: desk.autoState.running, current: desk.debate?.symbol ?? null, previous: desk.lastCycle ? `${desk.lastCycle.symbol} · ${desk.lastCycle.verdict ?? desk.lastCycle.stage} · ${desk.lastCycle.outcome ?? desk.lastCycle.executionStatus ?? 'no fill recorded'}` : null },
    id: `rep-${at.toString(36)}`, at, since, mode: desk.cfg.tradingMode, exchange: desk.cfg.live?.exchange ?? null,
    accounting: { source: desk.venueAccount ? 'exchange' : 'local book', status: desk.venueAccount?.status ?? (desk.cfg.tradingMode === 'PAPER' ? 'paper' : 'unverified'), observedAt: desk.venueAccount?.at ?? null, confirmedRealized, estimatedRealized, unknownExits: exits.filter((t) => t.pnlStatus === 'unknown').length, actualFees: financial?.actualFees ?? null, funding: financial?.funding ?? null, financialEvidence: financial },
    opportunityReviews: { observed: reviews.filter((r) => r.status === 'observed').length, pending: reviews.filter((r) => r.status === 'pending').length, unavailable: reviews.filter((r) => r.status === 'unavailable').length, items: reviews.slice(-10) },
    balance: desk.book.balance, safetyNet: desk.book.safetyNet, moneyTrade: s.moneyTrade, n: desk.book.n, perOrder: s.perOrder,
    equity: round2(desk.book.balance + desk.book.unrealized), unrealized: desk.book.unrealized, realized,
    dailyLoss: { limitPct: desk.cfg.risk.dailyLossLimitPct, hit: desk.day.lossHit },
    auto: { on: desk.autoState.on, cycles: desk.autoState.cycles, intervalMin: desk.cfg.auto.intervalMin },
    positions: desk.book.positions.map((p) => ({ ownership: p.ownership, protectionStatus: p.protectionStatus, entryStatus: p.entryStatus, symbol: p.symbol, side: p.side, qty: p.qty, entry: p.entry, stop: p.stop, tp: p.tp, mark: p.mark, pnl: p.unrealizedPnl, openedAt: p.openedAt })),
    opened: acts.filter((a) => a.kind === 'opened'), closed: acts.filter((a) => a.kind === 'closed'), skipped: acts.filter((a) => a.kind === 'skipped'),
    scorecard: desk.scorecard.rows(),
    lessons: desk.learnings.since(since + 1).slice(0, 20).map((l) => ({ role: l.role, kind: l.kind, status: l.status, count: l.count, symbol: l.symbol, happened: l.happened, rootCause: l.rootCause, lesson: l.lesson })),
    standingRules: desk.learnings.standingRules().map((l) => `${l.role}: ${l.lesson}`).slice(-10),
    scan: [...(desk.lastScan?.findings ?? []).filter((f) => f.code !== 'safety_net'), ...(capital ? [capital] : [])]
  };
  return { ...r, text: safe(renderText(r)) };
}

const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16);
export function renderText(r: Omit<Report, 'text'>) {
  const short = (value: string, max = 130) => value.replace(/\s+/g, ' ').slice(0, max);
  const signed = (n: number) => `${n >= 0 ? '+' : ''}${round2(n)}`;
  const m = r.monitoring;
  const alerts = r.scan.filter((f) => f.level === 'alert' || f.level === 'warn');
  const unprotected = r.positions.filter((p) => !(p.stop > 0) || (r.mode !== 'PAPER' && p.protectionStatus !== 'confirmed'));
  const lines = [
    `Trading Agent Mpu Gandring | ${r.mode}${r.exchange ? ` / ${r.exchange}` : ''}`,
    `Period (UTC): ${new Date(r.since).toISOString().slice(0, 10)} ${hhmm(r.since)} to ${new Date(r.at).toISOString().slice(0, 10)} ${hhmm(r.at)}`,
    '',
    'STATUS',
    `Kill ${m ? (m.killed ? 'ON (desk stopped)' : 'OFF') : 'unknown'}`,
    `Daily loss stop: ${r.dailyLoss.hit ? 'HIT' : 'not hit'} (limit ${r.dailyLoss.limitPct}% per UTC day)`,
    `Protection ${unprotected.length ? `${unprotected.length} UNVERIFIED` : !r.positions.length ? 'not applicable: no open positions' : r.mode === 'PAPER' ? 'simulated (PAPER)' : 'confirmed on exchange for all open positions'}`,
    `Auto: ${r.auto.on ? `ON, every ${r.auto.intervalMin} min` : 'OFF'} | ${m?.current ? `Analyzing ${short(m.current, 24)}` : m?.running ? 'Cycle running' : 'Idle'}`,
    ...(alerts.length ? ['', 'ATTENTION', ...alerts.slice(0, 3).map((f) => `- ${f.level === 'alert' ? 'ALERT' : 'Warning'}: ${short(f.text, 220)}`)] : []),
    ...(alerts.length > 3 ? [`- ${alerts.length - 3} more findings in the office.`] : []),
    '',
    'CAPITAL (USDT)',
    `Equity: ${r.equity} | Balance: ${r.balance}`,
    `Protected reserve: ${r.safetyNet} | Tradable: ${r.moneyTrade}`,
    `Allocation: ${r.moneyTrade} / ${r.n} slots = ${r.perOrder} per order`,
    `Realized this period: ${signed(r.realized)} | Unrealized: ${signed(r.unrealized)}`,
    '',
    `POSITIONS (${r.positions.length})`,
    ...(r.positions.length ? r.positions.slice(0, 6).map((p) => `${short(p.symbol, 24)} ${p.side} ${p.qty} · Entry ${p.entry} · SL ${p.stop > 0 ? p.stop : 'MISSING'} (${p.protectionStatus ?? (r.mode === 'PAPER' ? 'paper' : 'unverified')})${p.tp ? ` · TP ${p.tp}` : ''} · PnL ${signed(p.pnl)}`) : ['None']),
    ...(r.positions.length > 6 ? [`${r.positions.length - 6} more positions in the office.`] : []),
    '',
    'ACTIVITY THIS PERIOD',
    `Opened ${r.opened.length} | Closed ${r.closed.length} | Skipped ${r.skipped.length}`,
    `Previous: ${m?.previous ? short([...new Set(m.previous.split(' · '))].join(' · ')) : 'none recorded'}`,
    ...r.closed.slice(-2).map((a) => `✓ ${hhmm(a.at)} ${short(a.symbol, 24)}: ${short(a.detail)}`),
    ...(r.skipped.length ? [`Latest skip: ${short(r.skipped.at(-1)!.symbol, 24)} · ${short(r.skipped.at(-1)!.detail)}`] : []),
    `Watching: ${m?.symbols.length ? m.symbols.slice(0, 12).join(', ') + (m.symbols.length > 12 ? ` +${m.symbols.length - 12}` : '') : 'not recorded'}`,
    '',
    'ACCOUNTING (USDT)',
    ...(r.accounting ? [
      `Source: ${r.accounting.source} (${r.accounting.status})`,
      `Realized: confirmed ${signed(r.accounting.confirmedRealized)} | estimated ${signed(r.accounting.estimatedRealized)}`,
      `Unknown exits: ${r.accounting.unknownExits} | Fees: ${r.accounting.actualFees ?? 'unknown'} | Funding: ${r.accounting.funding ?? 'unknown'}`,
      `Managed net: ${r.accounting.financialEvidence?.confirmedNetRealized ?? 'unknown'}`
    ] : ['Evidence unavailable']),
    '',
    `Scorecard (Desk Lead): ${r.scorecard.reduce((n, x) => n + x.right + x.wrong, 0) ? `${r.scorecard.reduce((n, x) => n + x.right, 0)} right / ${r.scorecard.reduce((n, x) => n + x.right + x.wrong, 0)} scored calls` : 'no scored calls yet'}.`,
    `Lessons this period (${r.lessons.length}): ${r.lessons.length ? [...new Set(r.lessons.map((l) => l.lesson))].slice(0, 2).map((l) => short(l, 100)).join(' / ') : 'none'}`,
    `Needs you: ${m?.killed ? 'review the cause before releasing the kill switch' : r.dailyLoss.hit ? 'daily loss stop hit; new orders are blocked' : unprotected.length ? 'check unverified position protection now' : alerts.length ? 'review the warnings above' : 'nothing'}.`,
    'Details in the office. Not financial advice.'
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
    const at = Date.now();
    const since = this.last;
    const rep = structuredClone(buildReport(this.desk, since, at));
    await this.desk.refreshFinancialEvidence(since + 1, at);
    const financial = this.desk.financialSummary(since + 1, at);
    if (rep.accounting) { rep.accounting.actualFees = financial?.actualFees ?? null; rep.accounting.funding = financial?.funding ?? null; rep.accounting.financialEvidence = financial; }
    rep.text = safe(renderText(rep));
    this.last = Math.max(this.last, rep.at);
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
