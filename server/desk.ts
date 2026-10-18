import { VENUE_KIND, VENUE_LABEL, ADAPTER_STATUS } from './exchange/types.js';
import { readKill, writeKill, clearKill, DEFAULT_KILL_FILE } from './killswitch.js';
import { adapterRules, publicRules, type InstrumentRules } from './exchange/rules.js';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import type { AppConfig } from './config.js';
import { AGENT_IDS } from './config.js';
import type { AgentId, AgentStatus, ChatLine, MarketSnapshot, Stance, Verdict, Action } from './types.js';
import { ROLES } from './agents/roles.js';
import { runAgent, type Out } from './agents/run.js';
import type { ModelCaller } from './providers/index.js';
import { getSnapshot, getNews } from './market/index.js';
import { strategyVote } from './strategy.js';
import { applyRiskGate } from './risk.js';
import { planOrder, moneySplit, round2, roundPrice } from './money.js';
import { PaperBook } from './paper.js';
import { parseCommand, HELP, normSymbol, type Command } from './commands.js';
import { sendToGrokBot } from './bridge.js';
import { safe, log } from './redact.js';
import type { LiveExecutor } from './live/executor.js';
import type { ClosedTrade } from './types.js';
import { getNewsFor } from './market/index.js';
import { Learnings, type LessonInput } from './learnings.js';
import { Scorecard } from './scorecard.js';
import { proactiveScan, type Finding } from './scan.js';
import { codeReview } from './providers/mock.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DEBATERS: AgentId[] = ['market', 'research', 'strategist'];
const val = (s: Stance) => (s === 'LONG' ? 1 : s === 'SHORT' ? -1 : 0);

export interface AgentView {
  id: AgentId; name: string; title: string; color: string; desk: { x: number; y: number };
  provider: string; model: string; fellBackToMock: boolean;
  status: AgentStatus; mood: number; stance: Stance | null; confidence: number | null; lastLine: string;
}
export interface Ticker { symbol: string; last: number; change24hPct: number; source: string; example: boolean; at: number }
export interface LogLine { at: number; kind: 'info' | 'speech' | 'fight' | 'verdict' | 'trade' | 'command' | 'warn'; agent?: AgentId; text: string; example?: boolean }

export interface DeskOptions { reportsDir?: string | null; outboxPath?: string; executor?: LiveExecutor | null; learningsPath?: string | null; /** Persisted kill switch file. null = in memory only (tests). */ killFile?: string | null }
export interface Activity { at: number; kind: 'opened' | 'closed' | 'skipped'; symbol: string; detail: string }
export interface ExternalSignal { source: 'tradingview'; symbol: string; action: string; price: number | null; note: string; at: number }
export interface AgentEvent { agent: AgentId; kind: 'say' | 'status' | 'proposal'; text?: string; stance?: Stance; confidence?: number; status?: AgentStatus; target?: AgentId; symbol?: string; action?: Action; stop?: number; tp?: number }

export class Desk extends EventEmitter {
  agents: Record<AgentId, AgentView>;
  tickers: Record<string, Ticker> = {};
  book: PaperBook;
  verdicts: Verdict[] = [];
  logs: LogLine[] = [];
  chats: Record<AgentId, ChatLine[]>;
  debate: null | { id: string; symbol: string; phase: string; round: number; disagreement: number; weighted: number; camps: Verdict['camps'] } = null;
  paused = false;
  killed = false;
  killedAt = 0;
  /** Everything the desk opened, closed or skipped, with the reason. Feeds the periodic reports. */
  activity: Activity[] = [];
  autoState = { on: false, intervalMin: 0, nextAt: 0, cycles: 0, lastCycleAt: 0, running: false };
  reports: import('./reports.js').Report[] = [];
  signals: ExternalSignal[] = [];
  day = { key: '', startEquity: 0, lossHit: false };
  equityHistory: { t: number; equity: number; balance: number }[] = [];
  /** self-improving: persistent lessons, promoted into standing rules */
  learnings: Learnings;
  /** Desk Lead supervision: per-role scorecard */
  scorecard = new Scorecard();
  /** proaktif-agent: latest proactive scan */
  lastScan: { at: number; findings: Finding[] } | null = null;
  /** API, exchange and agent errors, for the scan and the reflection step */
  errors: { at: number; source: string; text: string }[] = [];
  private stopFlag = false;
  private liveBackoffUntil = 0;
  private timers: NodeJS.Timeout[] = [];
  private killFilePath: string | null = null;
  private syncedLive = false;

  constructor(public cfg: AppConfig, private call: ModelCaller, private opts: DeskOptions = {}) {
    super();
    this.setMaxListeners(50);
    this.autoState.intervalMin = cfg.auto.intervalMin;
    this.book = new PaperBook(cfg.paper.balance, cfg.paper.safetyNet, cfg.paper.n, cfg.risk.takerFee);
    // A kill switch pressed before a restart stays on until the owner runs `npm run unkill -- --yes`.
    this.killFilePath = opts.killFile !== undefined ? opts.killFile : process.env.VITEST ? null : (process.env.KILL_SWITCH_FILE || DEFAULT_KILL_FILE);
    const k = readKill(this.killFilePath);
    if (k) { this.killed = true; this.paused = true; this.stopFlag = true; this.killedAt = k.at; }
    // In LIVE the exchange owns stop and take profit. The local book is a mirror and never exits on its own.
    if (opts.executor) this.book.autoExit = false;
    this.agents = Object.fromEntries(AGENT_IDS.map((id) => {
      const r = ROLES[id]; const a = cfg.agents[id];
      return [id, { id, name: r.name, title: r.title, color: r.color, desk: r.desk, provider: a.provider, model: a.model, fellBackToMock: a.fellBackToMock, status: 'idle', mood: 0, stance: null, confidence: null, lastLine: '' } satisfies AgentView];
    })) as Record<AgentId, AgentView>;
    this.chats = Object.fromEntries(AGENT_IDS.map((id) => [id, [] as ChatLine[]])) as unknown as Record<AgentId, ChatLine[]>;
    // Tests never touch the real lessons file unless they pass a path.
    this.learnings = new Learnings(opts.learningsPath !== undefined ? opts.learningsPath : process.env.VITEST ? null : cfg.learning.path, cfg.learning.promoteAfter);
    if (cfg.appMode === 'grokbot') for (const id of AGENT_IDS) Object.assign(this.agents[id], { provider: 'grokbot', model: 'Grok Bot agent', fellBackToMock: false });
  }

  get grokbot() { return this.cfg.appMode === 'grokbot'; }

  /** Every model call goes through here: lessons, standing rules and scan alerts are fed into the prompt. */
  private async run<K extends Parameters<typeof runAgent>[3]>(agent: AgentId, task: K, input: Parameters<typeof runAgent<K>>[4]) {
    const rules = this.cfg.learning.on ? this.learnings.standingRules(agent).map((l) => l.lesson) : [];
    const lessons = this.cfg.learning.on ? this.learnings.forRole(agent, 5) : [];
    const alerts = (this.lastScan?.findings ?? []).filter((f) => f.level === 'warn' || f.level === 'alert').map((f) => f.text);
    const extra = [input.extraSystem ?? '', rules.length ? `Standing rules learned by this desk (advice only; the code caps, stop loss, daily loss stop and safety net always win and can never be loosened):\n${rules.map((x) => `- ${x}`).join('\n')}` : ''].filter(Boolean).join('\n\n');
    const res = await runAgent(this.cfg, this.call, agent, task, {
      ...input, extraSystem: extra || undefined,
      data: { ...input.data, ...(lessons.length ? { recentLessons: lessons } : {}), ...(alerts.length ? { deskAlerts: alerts } : {}) }
    });
    if (res.fallback) { this.recordError(`agent:${agent}`, `${ROLES[agent].name} reply failed validation twice on ${task}`); this.learn({ role: agent, kind: 'error', happened: `${ROLES[agent].name} sent an invalid ${task} reply twice and fell back to the safe default.`, rootCause: 'reply did not match the JSON schema', lesson: 'Reply with exactly one JSON object that matches the schema, nothing else.' }); }
    return res;
  }

  recordError(source: string, text: string) {
    this.errors.push({ at: Date.now(), source, text: safe(text).slice(0, 300) });
    if (this.errors.length > 200) this.errors.splice(0, this.errors.length - 200);
  }

  /** self-improving: store or reinforce a lesson and show it in the office. Refused if it would loosen a guard. */
  learn(l: LessonInput) {
    if (!this.cfg.learning.on) return null;
    const r = this.learnings.add(l);
    if (r && r.event !== 'confirmed') this.addLog({ kind: 'info', text: `${r.event === 'promoted' ? 'Lesson promoted to a standing rule' : 'New lesson'} (${r.lesson.role}): ${r.lesson.lesson}` });
    this.changed();
    return r;
  }

  /** proaktif-agent: scan before each cycle. Findings go to the office and into the agents' next prompts. */
  scan(): Finding[] {
    const findings = proactiveScan(this);
    this.lastScan = { at: Date.now(), findings };
    const bad = findings.filter((f) => f.level === 'warn' || f.level === 'alert');
    for (const f of bad) this.addLog({ kind: 'warn', text: `Scan ${f.level}: ${f.text}` });
    if (!bad.length) this.addLog({ kind: 'info', text: `Scan: ${findings[findings.length - 1]?.text ?? 'clean'}` });
    this.changed();
    return findings;
  }

  /** self-improving: reflect on what happened since \`since\` (no-fills, errors, scan alerts) and write lessons. */
  reflect(since: number): number {
    if (!this.cfg.learning.on) return 0;
    let n = 0;
    const add = (l: LessonInput) => { if (this.learn(l)) n++; };
    for (const a of this.activity.filter((x) => x.at >= since && x.kind === 'skipped')) {
      if (/Daily loss stop/i.test(a.detail)) add({ role: 'risk', kind: 'loss', symbol: a.symbol, happened: `New order blocked: ${a.detail}`, rootCause: 'losses reached the daily loss cap', lesson: 'After the daily loss stop, only manage open positions and wait for the next UTC day. Be more selective early in the day.' });
      else if (/below|minimum|too small|nothing left/i.test(a.detail)) add({ role: 'execution', kind: 'error', symbol: a.symbol, happened: a.detail, rootCause: 'allocation per order too small for the exchange minimum', lesson: 'When the allocation per order is near the minimum, prefer HOLD over a ticket that cannot fill.' });
      else if (/not filled|LIVE order/i.test(a.detail)) add({ role: 'execution', kind: 'error', symbol: a.symbol, happened: a.detail, rootCause: 'the exchange did not fill the order', lesson: 'Check the exchange record after a failed send and skip the symbol this cycle; one send per ticket.' });
    }
    const errs = this.errors.filter((e) => e.at >= since && !e.source.startsWith('agent:'));
    if (errs.length) add({ role: 'desk', kind: 'error', happened: `${errs.length} API or exchange error(s), latest: ${errs[errs.length - 1].text.slice(0, 120)}`, rootCause: 'feed or exchange API failure', lesson: 'When the feed or exchange errors, trust only the exchange record and fresh data; HOLD on stale or sample data.' });
    for (const f of (this.lastScan && this.lastScan.at >= since ? this.lastScan.findings : []).filter((x) => x.level === 'alert' || x.level === 'warn')) {
      const map: Record<string, LessonInput> = {
        daily_loss_usage: { role: 'risk', kind: 'scan', happened: f.text, rootCause: 'losses are using most of the daily loss cap', lesson: 'When the daily loss cap is mostly used, REDUCE size or REJECT marginal setups until the next UTC day.' },
        no_stop: { role: 'execution', kind: 'scan', happened: f.text, rootCause: 'a position was found without a stop loss', lesson: 'Every position needs a stop on the exchange; close any position found without one.' },
        stale_feed: { role: 'market', kind: 'scan', happened: f.text, rootCause: 'price data stopped updating', lesson: 'Do not take a stance on stale prices; say NEUTRAL until the feed is fresh.' },
        sample_fallback: { role: 'market', kind: 'scan', happened: f.text, rootCause: 'live feed failed, sample data in use', lesson: 'Treat sample data as a demo only; no exchange order on sample data.' },
        safety_net: { role: 'lead', kind: 'scan', happened: f.text, rootCause: 'balance is close to the safety net', lesson: 'Near the safety net, prefer HOLD and smaller tickets; the safety net is never traded.' }
      };
      const l = map[f.code]; if (l) add(l);
    }
    return n;
  }

  // ---------- state ----------
  snapshot() {
    const split = this.book.split();
    return {
      app: 'Trading Agent Mpu Gandring', mode: this.cfg.tradingMode, appMode: this.cfg.appMode,
      live: this.cfg.live, killed: this.killed,
      venue: this.cfg.exchange.name ? { name: this.cfg.exchange.name, label: VENUE_LABEL[this.cfg.exchange.name], kind: VENUE_KIND[this.cfg.exchange.name], experimental: ADAPTER_STATUS[this.cfg.exchange.name] === 'experimental' } : null,
      dailyLoss: { limitPct: this.cfg.risk.dailyLossLimitPct, startEquity: this.day.startEquity, hit: this.day.lossHit },
      tradingview: { widget: this.cfg.tradingview.widget, prefix: this.cfg.tradingview.prefix, webhook: this.cfg.tradingview.webhookEnabled },
      agentEvents: this.cfg.agentEvents.enabled, signals: this.signals.slice(0, 10),
      lessons: this.learnings.recent(12), standingRules: this.learnings.standingRules().slice(-8).reverse(), lessonsRefused: this.learnings.refused, scan: this.lastScan, scorecard: this.scorecard.rows(), learning: { on: this.cfg.learning.on, scan: this.cfg.learning.scan, promoteAfter: this.cfg.learning.promoteAfter },
      auto: { ...this.autoState, symbols: this.cfg.auto.symbols, maxHoldHours: this.cfg.auto.maxHoldHours },
      reports: this.reports.slice(0, 12), reportIntervalMin: this.cfg.reports.intervalMin,
      marketSource: this.cfg.marketSource, bridgeEnabled: this.cfg.bridge.enabled, paused: this.paused,
      agents: this.agents, tickers: this.tickers, debate: this.debate,
      paper: {
        balance: this.book.balance, safetyNet: this.book.safetyNet, n: this.book.n, moneyTrade: split.moneyTrade, perOrder: split.perOrder,
        canOpen: split.canOpen, usedMargin: this.book.usedMargin, unrealized: this.book.unrealized,
        equity: round2(this.book.balance + this.book.unrealized), positions: this.book.positions, closed: this.book.closed.slice(0, 20),
        minOrderUsdt: this.cfg.risk.minOrderUsdt, maxLeverage: this.cfg.risk.maxLeverage
      },
      equityHistory: this.equityHistory.slice(-240), verdicts: this.verdicts.slice(0, 20), logs: this.logs.slice(-120), chats: this.chats,
      watchlist: this.cfg.watchlist, fightThreshold: this.cfg.debate.fightThreshold
    };
  }
  /** Daily loss stop: once equity falls DAILY_LOSS_LIMIT_PCT below the day's start, no new orders until tomorrow (UTC). */
  checkDay() {
    const equity = round2(this.book.balance + this.book.unrealized);
    const key = new Date().toISOString().slice(0, 10);
    if (this.day.key !== key) this.day = { key, startEquity: equity, lossHit: false };
    const lim = this.cfg.risk.dailyLossLimitPct;
    if (!this.day.lossHit && lim > 0 && this.day.startEquity > 0 && ((this.day.startEquity - equity) / this.day.startEquity) * 100 >= lim) {
      this.day.lossHit = true;
      this.addLog({ kind: 'warn', text: `Daily loss stop: equity ${equity} is ${lim}% or more below today's start ${this.day.startEquity}. No new orders until tomorrow (UTC).` });
    }
    return this.day.lossHit;
  }
  note(kind: Activity['kind'], symbol: string, detail: string) {
    this.activity.push({ at: Date.now(), kind, symbol, detail: safe(detail) });
    if (this.activity.length > 500) this.activity.splice(0, this.activity.length - 500);
  }
  recordEquity() {
    this.checkDay();
    this.equityHistory.push({ t: Date.now(), equity: round2(this.book.balance + this.book.unrealized), balance: this.book.balance });
    if (this.equityHistory.length > 600) this.equityHistory.splice(0, this.equityHistory.length - 600);
  }
  private changed() { this.emit('state', this.snapshot()); }
  private addLog(l: Omit<LogLine, 'at'>) {
    const line = { ...l, text: safe(l.text), at: Date.now() };
    this.logs.push(line); if (this.logs.length > 400) this.logs.splice(0, this.logs.length - 400);
    this.emit('log', line);
  }
  private setStatus(id: AgentId, status: AgentStatus) { this.agents[id].status = status; this.emit('status', { agent: id, status }); }
  private setAll(status: AgentStatus) { for (const id of AGENT_IDS) this.agents[id].status = status; this.changed(); }

  /** Speech bubble in the office. log=false when the same line was already logged as a trade (no duplicate log line). */
  private async say(agent: AgentId, text: string, example: boolean, after: AgentStatus = 'arguing', log = true) {
    const clean = safe(text);
    const pace = this.cfg.debate.paceMs;
    this.setStatus(agent, 'typing');
    const words = clean.split(' ');
    const chunk = 3;
    let shown = '';
    for (let i = 0; i < words.length; i += chunk) {
      shown = words.slice(0, i + chunk).join(' ');
      this.emit('speech', { agent, text: shown, done: false, example });
      if (pace) await sleep(Math.max(25, pace / 8));
    }
    this.emit('speech', { agent, text: clean, done: true, example });
    this.agents[agent].lastLine = clean;
    this.setStatus(agent, after);
    if (log) this.addLog({ kind: 'speech', agent, text: clean, example });
    this.changed();
    if (pace) await sleep(pace / 2);
  }

  // ---------- market ----------
  async refreshTickers() {
    const live = Date.now() >= this.liveBackoffUntil ? this.cfg.marketSource : 'sample';
    let allSample = true;
    const symbols = [...new Set([...this.cfg.watchlist, ...this.cfg.auto.symbols])];
    await Promise.all(symbols.map(async (s) => {
      const snap = await getSnapshot(s, live);
      if (snap.source !== 'sample') allSample = false;
      else if (live !== 'sample' && snap.errors.length) this.recordError('market', `${s}: ${snap.errors.join('; ')}`);
      this.updateTicker(snap);
    }));
    if (live !== 'sample' && allSample) this.liveBackoffUntil = Date.now() + 5 * 60_000;
    this.recordEquity();
    this.changed();
  }
  private updateTicker(snap: MarketSnapshot) {
    this.tickers[snap.symbol] = { symbol: snap.symbol, last: snap.last, change24hPct: snap.change24hPct, source: snap.source, example: snap.example, at: snap.fetchedAt };
    for (const t of this.book.mark(snap.symbol, snap.last)) {
      this.addLog({ kind: 'trade', text: `${t.reason}: ${t.symbol} ${t.side} closed at ${t.exit}, PnL ${t.realizedPnl} USDT` });
      this.note('closed', t.symbol, `${t.side} at ${t.exit}, PnL ${t.realizedPnl} USDT (${t.reason})`);
      void this.review(t);
    }
  }

  /** LIVE: pull balance and positions from the exchange. Positions gone on the venue were closed there (stop, take profit or by hand). */
  async syncLive() {
    const ex = this.opts.executor;
    if (!ex) return;
    try {
      const [bal, venue] = await Promise.all([ex.adapter.balance(), ex.adapter.positions()]);
      const venueUpnl = venue.reduce((sum, p) => sum + p.unrealizedPnl, 0);
      const isInitial = !this.syncedLive;
      this.syncedLive = true;
      this.book.balance = round2(bal.equityUsdt - venueUpnl);
      if (isInitial) {
        const key = new Date().toISOString().slice(0, 10);
        this.day = { key, startEquity: round2(bal.equityUsdt), lossHit: false };
      }
      for (const p of [...this.book.positions]) {
        const v = venue.find((x) => x.symbol === p.symbol && x.side === p.side);
        if (!v) {
          const t = this.book.close(p.id, this.tickers[p.symbol]?.last ?? p.mark, 'closed on the exchange (stop, take profit or manual)');
          if (t) { this.addLog({ kind: 'trade', text: `${t.symbol} ${t.side} is flat on the exchange. Local PnL estimate ${t.realizedPnl} USDT.` }); this.note('closed', t.symbol, `${t.side} flat on the exchange (stop, take profit or manual), est. PnL ${t.realizedPnl} USDT`); void this.review(t); }
        } else { p.qty = v.qty; p.unrealizedPnl = round2(v.unrealizedPnl); }
      }
      for (const v of venue) if (!this.book.positions.some((p) => p.symbol === v.symbol)) this.addLog({ kind: 'warn', text: `Exchange shows a ${v.side} ${v.qty} ${v.symbol} position the desk did not open. Leaving it alone.` });
    } catch (e) { this.recordError('exchange', `sync failed: ${(e as Error).message}`); this.addLog({ kind: 'warn', text: `Exchange sync failed: ${safe((e as Error).message)}` }); }
  }

  start() {
    if (this.opts.executor) { void this.syncLive().then(() => this.checkDay()); this.timers.push(setInterval(() => void this.syncLive(), 30_000)); }
    void this.refreshTickers();
    this.timers.push(setInterval(() => void this.refreshTickers(), this.cfg.tickerRefreshSeconds * 1000));
  }
  stop() { this.timers.forEach(clearInterval); this.timers = []; }

  // ---------- debate ----------
  async runDebate(symbolIn: string, signal?: ExternalSignal): Promise<Verdict> {
    const symbol = normSymbol(symbolIn);
    if (!symbol) throw new Error('no symbol');
    if (this.killed) throw new Error('kill switch is on. Release it with npm run unkill -- --yes, then restart the server');
    if (this.paused) throw new Error('desk is paused, send "resume" first');
    if (this.debate) throw new Error(`a debate on ${this.debate.symbol} is already running`);
    if (this.grokbot) throw new Error('Grok Bot mode: the debate runs in your Grok Bot group chat (npm run gb -- event ...), the internal engine is off');
    this.stopFlag = false;
    const id = `deb-${Date.now().toString(36)}`;
    this.debate = { id, symbol, phase: 'opening', round: 0, disagreement: 0, weighted: 0, camps: { bull: [], bear: [], neutral: [] } };
    this.emit('debate', { id, symbol, phase: 'opening' });
    const transcript: string[] = [`# Debate ${id} on ${symbol}`, `Mode: ${this.cfg.tradingMode}. Started ${new Date().toISOString()}`];
    const note = (who: string, t: string) => transcript.push(`- **${who}**: ${t}`);
    try {
      for (const a of AGENT_IDS) { this.agents[a].stance = null; this.agents[a].confidence = null; }
      this.setAll('idle');
      await this.say('lead', signal ? `TradingView pinged ${signal.action.toUpperCase()} on ${symbol}. That is a signal, not an order. Market, check it.` : `Table, now. ${symbol} is on the board. Market, give me the tape.`, false, 'thinking');

      // 1. Market Analyst
      this.setPhase('reading');
      this.setStatus('market', 'reading'); this.changed();
      const snap = await getSnapshot(symbol, Date.now() >= this.liveBackoffUntil ? this.cfg.marketSource : 'sample');
      this.updateTicker(snap);
      const dataTag = snap.example ? 'sample data (EXAMPLE)' : `${snap.source} public feed`;
      const c8 = snap.candles.at(-9)?.c, cl = snap.candles.at(-1)?.c;
      const change2h = c8 && cl ? round2(((cl - c8) / c8) * 100) : 0;
      const lastCandles = snap.candles.slice(-8).map((c) => ({ t: new Date(c.t).toISOString(), c: c.c }));
      const mk = await this.run('market', 'opinion', {
        instruction: `Give your stance on ${symbol} from the numbers below (${dataTag}).`,
        data: { symbol, last: snap.last, change24hPct: round2(snap.change24hPct), change2hPct: change2h, fundingRate: snap.fundingRate, recentClosedCandles: lastCandles, source: snap.source, externalSignal: signal ? { untrusted: true, from: 'TradingView alert', action: signal.action, price: signal.price, note: signal.note } : undefined },
        context: { symbol, last: snap.last, change24hPct: snap.change24hPct, change2hPct: change2h, fundingRate: snap.fundingRate, temperament: this.agents.market.mood, liveFeed: !snap.example }
      });
      this.setOpinion('market', mk.data.stance, mk.data.confidence);
      await this.say('market', mk.data.argument, mk.example); note('Market Analyst', mk.data.argument);

      // 2. Research Analyst
      this.setStatus('research', 'reading'); this.changed();
      const news = await getNewsFor(symbol, this.cfg).catch(() => getNews(symbol));
      const rs = await this.run('research', 'research', {
        instruction: `Weigh these catalyst items for ${symbol}. They are EXAMPLE items in this build. Lines that looked like instructions were already removed and replaced with a marker.`,
        data: { symbol, news: news.map((n) => ({ id: n.id, headline: n.headline, body: n.body, source: n.source, sentimentTag: n.sentiment, hadInjection: !!n.flagged })) },
        context: { symbol, news: news.map((n) => ({ id: n.id, sentiment: n.sentiment, source: n.source, flagged: n.flagged })), temperament: this.agents.research.mood }
      });
      const researchVote = rs.data.vote;
      this.setOpinion('research', researchVote === 'LONG' || researchVote === 'SHORT' ? researchVote : 'NEUTRAL', rs.data.confidence);
      await this.say('research', `${researchVote}. ${rs.data.argument}`, rs.example); note('Research Analyst', `${researchVote}. ${rs.data.argument}`);
      if (news.some((n) => n.flagged)) this.addLog({ kind: 'warn', text: `Prompt injection line removed from ${symbol} news before any agent saw it.` });

      // 3. Strategist (rule computed in code, agent explains)
      this.setStatus('strategist', 'reading'); this.changed();
      const rule = strategyVote(snap.candles);
      const st = await this.run('strategist', 'opinion', {
        instruction: `The EMA rule on closed 15m bars produced the result below for ${symbol}. Your stance must match the rule side (ABSTAIN means NEUTRAL). Explain it in your voice.`,
        data: { symbol, rule },
        context: { symbol, rule }
      });
      const ruleStance: Stance = rule.side === 'ABSTAIN' ? 'NEUTRAL' : rule.side;
      // The rule wins over the model if they disagree.
      this.setOpinion('strategist', ruleStance, st.data.stance === ruleStance ? st.data.confidence : 0.5);
      await this.say('strategist', st.data.argument, st.example); note('Strategist', st.data.argument);

      const journal = this.book.closed.slice(0, 5).map((t) => ({ symbol: t.symbol, side: t.side, pnl: t.realizedPnl, reason: t.reason }));

      // 4. Rebuttal rounds
      for (let round = 1; round <= this.cfg.debate.rounds; round++) {
        if (this.stopFlag) break;
        this.setPhase(`round ${round}`, round);
        for (const a of DEBATERS) {
          if (this.stopFlag) break;
          const others = DEBATERS.filter((o) => o !== a).map((o) => ({ agent: o, stance: this.agents[o].stance ?? 'NEUTRAL', confidence: this.agents[o].confidence ?? 0, lastLine: this.agents[o].lastLine }));
          this.setStatus(a, 'thinking'); this.changed();
          const rb = await this.run(a, 'rebuttal', {
            instruction: `Round ${round} of the ${symbol} debate. Answer the strongest view you disagree with. You may change your stance if the evidence is better.`,
            data: { symbol, round, you: { stance: this.agents[a].stance, confidence: this.agents[a].confidence }, others },
            context: { symbol, round, myStance: this.agents[a].stance, myConfidence: this.agents[a].confidence, others, temperament: this.agents[a].mood }
          });
          let stance = rb.data.stance;
          if (a === 'strategist') stance = ruleStance; // the rule does not change mid debate
          if (a === 'research' && researchVote === 'VETO') stance = 'NEUTRAL';
          this.setOpinion(a, stance, rb.data.confidence);
          const { disagreement } = this.score();
          const target = rb.data.target !== 'none' && rb.data.target !== a ? (rb.data.target as AgentId) : null;
          const fighting = disagreement >= this.cfg.debate.fightThreshold && !!target && this.agents[target].stance !== null && val(this.agents[target].stance!) * val(stance) < 0;
          if (fighting && target) {
            const intensity = Math.min(1, disagreement);
            this.setStatus(a, 'fighting'); this.setStatus(target, 'fighting');
            this.emit('fight', { from: a, to: target, intensity, punches: 1 + Math.round(intensity * 3) });
            this.addLog({ kind: 'fight', agent: a, text: `${ROLES[a].name} throws a punch at ${ROLES[target].name} (disagreement ${disagreement.toFixed(2)})` });
          }
          await this.say(a, rb.data.rebuttal, rb.example, fighting ? 'fighting' : 'arguing'); note(ROLES[a].name, `[${stance}] ${rb.data.rebuttal}`);
          if (fighting && target) this.setStatus(target, 'arguing');
        }
      }

      // 5. Desk Lead proposal
      this.setPhase('verdict');
      const { weighted, disagreement, camps } = this.score();
      const pos = this.book.positions.find((p) => p.symbol === symbol);
      const cautious = this.agents.lead.mood < 0;
      this.setStatus('lead', 'thinking'); this.changed();
      const ld = await this.run('lead', 'lead', {
        instruction: `Close the ${symbol} debate. Pick one action.`,
        data: { symbol, votes: DEBATERS.map((a) => ({ agent: a, stance: this.agents[a].stance, confidence: this.agents[a].confidence })), weightedScore: weighted, disagreement, researchVote, openPosition: pos ? { side: pos.side, entry: pos.entry, stop: pos.stop, unrealizedPnl: pos.unrealizedPnl } : null, freeSlots: this.book.n - this.book.positions.length, journal },
        context: { weighted, disagreement, researchVote, hasPosition: !!pos, positionSide: pos?.side, unrealizedPnl: pos?.unrealizedPnl ?? 0, slotsFree: this.book.positions.length < this.book.n, cautious, strategyInvalidated: pos ? this.invalidated(pos.side, rule) : false, liveFeed: !snap.example }
      });
      let action: Action = ld.data.action;
      let flipNote = '';
      if (action === 'CLOSE' && !pos) action = 'HOLD';
      // An opposite signal on an open position closes it. Re-entry the other way waits for the next cycle.
      if ((action === 'OPEN_LONG' && pos?.side === 'SHORT') || (action === 'OPEN_SHORT' && pos?.side === 'LONG')) { action = 'CLOSE'; flipNote = ' Opposite signal, closing first.'; }
      if ((action === 'OPEN_LONG' || action === 'OPEN_SHORT') && pos) action = 'HOLD';
      if (researchVote === 'VETO' && action.startsWith('OPEN')) action = 'HOLD';
      await this.say('lead', `${action.replace('_', ' ')}. ${ld.data.reason}${flipNote}`, ld.example, 'idle'); note('Desk Lead', `${action}. ${ld.data.reason}`);

      // 6. Risk gate
      this.setPhase('risk gate');
      this.setStatus('risk', 'thinking'); this.changed();
      const rk = await this.run('risk', 'risk', {
        instruction: `Gate this proposal from the Desk Lead: ${action} ${symbol}. Caps: max leverage ${this.cfg.risk.maxLeverage}x, stop at most ${this.cfg.risk.defaultStopPct}%, max loss per trade ${this.cfg.risk.maxLossPerTradePct}% of balance.`,
        data: { symbol, action, disagreement, researchVote, strategy: { side: rule.side, invalidation: rule.invalidation }, paper: moneySplit({ balance: this.book.balance, safetyNet: this.book.safetyNet, n: this.book.n }), openPositions: this.book.positions.length },
        context: { action, disagreement, researchVote, strategySide: rule.side, maxLeverage: this.cfg.risk.maxLeverage, defaultStopPct: this.cfg.risk.defaultStopPct, temperament: this.agents.risk.mood }
      });
      const gate = applyRiskGate(rk.data, this.cfg.risk, this.agents.risk.mood);
      this.scorecard.verdict();
      if (action !== 'HOLD') this.scorecard.riskDecision(gate.decision);
      const riskLine = `${gate.decision}. ${rk.data.reason}${gate.notes.length ? ' ' + gate.notes.join(' ') : ''}`;
      await this.say('risk', riskLine, rk.example, 'idle'); note('Risk Manager', riskLine);

      // 7. Verdict and paper execution
      const verdict: Verdict = { id, symbol, action, riskDecision: action === 'HOLD' ? 'N/A' : gate.decision, executed: false, reason: ld.data.reason, disagreement, camps, example: mk.example || ld.example || rk.example || snap.example, at: Date.now() };
      if (action === 'OPEN_LONG' || action === 'OPEN_SHORT') {
        if (gate.decision === 'REJECT') { verdict.reason = `Risk rejected: ${rk.data.reason}`; this.note('skipped', symbol, verdict.reason); }
        else {
          const side = action === 'OPEN_LONG' ? 'LONG' : 'SHORT';
          const price = roundPrice(side === 'LONG' ? (snap.ask ?? snap.last) : (snap.bid ?? snap.last));
          const res = await this.executeOpen(symbol, side, price, gate, snap.example);
          if (res.ok) this.scorecard.opened(symbol, { side, stances: Object.fromEntries(DEBATERS.map((a) => [a, this.agents[a].stance])), riskDecision: gate.decision });
          verdict.executed = res.ok;
          if (res.order) verdict.order = res.order;
          if (!res.ok) verdict.reason = res.reason;
          note('Execution Trader', res.line);
        }
      } else if (action === 'CLOSE' && pos) {
        const t = await this.executeClose(symbol, snap.last, flipNote ? 'opposite signal' : 'desk verdict CLOSE');
        verdict.executed = t.length > 0;
        note('Execution Trader', t.map((x) => `Closed ${x.side} ${x.symbol} at ${x.exit}, PnL ${x.realizedPnl} USDT.`).join(' ') || 'nothing closed');
      }
      if (action === 'HOLD') this.note('skipped', symbol, `HOLD: ${ld.data.reason}`);
      this.verdicts.unshift(verdict); this.verdicts = this.verdicts.slice(0, 50);
      this.addLog({ kind: 'verdict', text: `VERDICT ${symbol}: ${action} (risk ${verdict.riskDecision}, disagreement ${disagreement.toFixed(2)})${verdict.executed ? (this.opts.executor ? ', LIVE filled' : ', paper filled') : ''}`, example: verdict.example });
      this.emit('verdict', verdict);
      transcript.push('', `**Verdict:** ${action}, risk ${verdict.riskDecision}, executed ${verdict.executed}. ${verdict.reason}`);
      this.writeReport(id, transcript.join('\n'));
      void sendToGrokBot(this.cfg, 'verdict', { ...verdict }, this.opts.outboxPath);
      return verdict;
    } finally {
      this.debate = null;
      this.setAll('idle');
      this.emit('debate', { id, symbol, phase: 'done' });
    }
  }

  /** The only way an order is opened, paper or live. Risk gate result in, money split and caps applied here. */
  async executeOpen(symbol: string, side: 'LONG' | 'SHORT', price: number, gate: { sizeFactor: number; leverage: number; stopPct: number; tp?: number | null; stop?: number | null }, example = false): Promise<{ ok: boolean; line: string; reason: string; order?: Verdict['order'] }> {
    const live = this.opts.executor;
    const no = async (reason: string) => { this.scorecard.fill(false); this.note('skipped', symbol, `${side}: ${reason}`); await this.say('execution', `No fill. ${reason}`, false, 'idle'); return { ok: false, line: `No fill. ${reason}`, reason }; };
    if (this.killed) return no('Kill switch is on.');
    if (this.checkDay()) return no(`Daily loss stop is on (${this.cfg.risk.dailyLossLimitPct}% for today).`);
    if (live && example) return no('Refusing an exchange order on sample data.');
    // Lot step, min qty, tick, min notional and taker fee come from the exchange (LIVE/TESTNET: the adapter, cached 5 min).
    let rules: InstrumentRules | null = null;
    try {
      rules = live ? await adapterRules(live.adapter, symbol) : await publicRules(this.cfg.marketSource, symbol, 'mainnet');
    } catch (e) {
      if (live) return no(`Could not read the exchange instrument rules for ${symbol} (${safe((e as Error).message)}). Not sizing on guesses.`);
      rules = null; // paper: guessed lot step, the plan says so
    }
    if (live && rules?.status && rules.status !== 'TRADING') return no(`${symbol} is ${rules.status} on the exchange, not TRADING.`);
    const plan = planOrder({
      balance: this.book.balance, equity: round2(this.book.balance + this.book.unrealized), safetyNet: this.book.safetyNet, n: this.book.n, openPositions: this.book.positions.length, usedMargin: this.book.usedMargin,
      price, side, sizeFactor: gate.sizeFactor, leverage: gate.leverage,
      // A given stop (Strategist / Grok Bot ticket) is used exactly. Only the internal debate falls back to stopPct.
      stop: gate.stop ?? null, stopPct: gate.stopPct, minStopPct: this.cfg.risk.minStopPct, maxStopPct: this.cfg.risk.defaultStopPct,
      minOrderUsdt: this.cfg.risk.minOrderUsdt, maxLossPerTradePct: this.cfg.risk.maxLossPerTradePct, takerFee: this.cfg.risk.takerFee, rules, takeProfitR: this.cfg.risk.takeProfitR
    });
    if (!plan.ok) return no(`${plan.reason}${plan.suggestion ? ' ' + plan.suggestion : ''}`);
    // A take profit from a Grok Bot agent is accepted only on the right side of the entry (the adapter rounds it to the tick). The stop is never theirs to widen.
    if (gate.tp && Number.isFinite(gate.tp) && (side === 'LONG' ? gate.tp > price : gate.tp < price)) plan.tp = rules?.tickSize ? gate.tp : roundPrice(gate.tp);
    this.setStatus('execution', 'executing'); this.changed();
    let entry = price, qty = plan.qty, tag = 'Paper fill';
    if (live) {
      const fill = await live.open({ symbol, side, qty: plan.qty, stop: plan.stop, tp: plan.tp, leverage: plan.leverage });
      this.addLog({ kind: 'trade', agent: 'execution', text: `LIVE ${symbol} ${side}: ${fill.note}` });
      if (!fill.ok) { this.recordError('exchange', `${symbol} ${side} not filled: ${fill.note}`); return no(`LIVE order not filled. ${fill.note}`); }
      entry = roundPrice(fill.avgPrice ?? price); qty = fill.qty; tag = 'LIVE fill';
    }
    const p = this.book.open({ symbol, side, qty, entry, stop: plan.stop, tp: plan.tp, margin: plan.margin, leverage: plan.leverage });
    this.recordEquity();
    const line = `${tag}: ${side} ${p.qty} ${symbol} at ${p.entry}, stop ${p.stop}${p.tp ? `, take profit ${p.tp}` : ''}, margin ${p.margin} USDT at ${p.leverage}x.${plan.notes.length ? ' ' + plan.notes.join(' ') : ''}`;
    this.addLog({ kind: 'trade', agent: 'execution', text: line });
    this.scorecard.fill(true);
    this.note('opened', symbol, `${side} ${p.qty} at ${p.entry}, SL ${p.stop}${p.tp ? `, TP ${p.tp}` : ''}, margin ${p.margin} USDT at ${p.leverage}x`);
    await this.say('execution', line, false, 'idle', false); // already logged above as a trade line
    return { ok: true, line, reason: '', order: { side, qty: p.qty, entry: p.entry, stop: p.stop, tp: p.tp, margin: p.margin, leverage: p.leverage } };
  }

  /** Closes every position on a symbol. LIVE: one reduce-only send each, reconciled from the exchange record. */
  async executeClose(symbol: string, price: number, reason: string): Promise<ClosedTrade[]> {
    const live = this.opts.executor;
    this.setStatus('execution', 'executing'); this.changed();
    const out: ClosedTrade[] = [];
    for (const p of this.book.positions.filter((x) => x.symbol === symbol)) {
      let px = price;
      if (live) {
        const f = await live.close(symbol, p.side, p.qty);
        this.addLog({ kind: 'trade', agent: 'execution', text: `LIVE close ${symbol}: ${f.note}` });
        if (!f.ok) { this.recordError('exchange', `${symbol} close not filled: ${f.note}`); continue; }
        px = f.avgPrice ?? price;
      }
      const t = this.book.close(p.id, px, reason);
      if (t) { out.push(t); this.note('closed', t.symbol, `${t.side} at ${t.exit}, PnL ${t.realizedPnl} USDT (${reason})`); }
    }
    const line = out.map((x) => `Closed ${x.side} ${x.symbol} at ${x.exit}, PnL ${x.realizedPnl} USDT.`).join(' ');
    if (line) { this.addLog({ kind: 'trade', agent: 'execution', text: line }); await this.say('execution', line, false, 'idle', false); }
    this.setStatus('execution', 'idle');
    this.recordEquity();
    for (const x of out) void this.review(x);
    this.changed();
    return out;
  }

  /** Closes positions held longer than MAX_HOLD_HOURS (0 = off). Runs every auto cycle. */
  async closeStale(): Promise<number> {
    const h = this.cfg.auto.maxHoldHours;
    if (!(h > 0)) return 0;
    const stale = [...new Set(this.book.positions.filter((p) => Date.now() - p.openedAt >= h * 3_600_000).map((p) => p.symbol))];
    let n = 0;
    for (const sym of stale) n += (await this.executeClose(sym, this.tickers[sym]?.last ?? this.book.positions.find((p) => p.symbol === sym)!.mark, `max holding time ${h}h`)).length;
    return n;
  }

  /** Kill switch: stop debating, cancel and flatten everything. Persisted: stays on across restarts until `npm run unkill -- --yes`. */
  async kill(): Promise<string[]> {
    this.killed = true; this.paused = true; this.stopFlag = true; this.autoState.on = false;
    if (!this.killedAt) this.killedAt = Date.now();
    try { writeKill(this.killFilePath, { at: this.killedAt, reason: 'kill switch' }); } catch (e) { this.addLog({ kind: 'warn', text: `Kill switch is on but could not be saved to disk (${safe((e as Error).message)}); it will reset on restart.` }); }
    let notes: string[] = [];
    if (this.opts.executor) {
      notes = await this.opts.executor.killAll(this.book.positions.map((p) => p.symbol));
      const prices = Object.fromEntries(Object.values(this.tickers).map((t) => [t.symbol, t.last]));
      this.book.closeAll(prices, 'kill switch');
    } else {
      const prices = Object.fromEntries(Object.values(this.tickers).map((t) => [t.symbol, t.last]));
      notes = this.book.closeAll(prices, 'kill switch').map((c) => `${c.symbol} closed, ${c.realizedPnl} USDT`);
    }
    this.addLog({ kind: 'warn', text: `KILL SWITCH. ${notes.join('; ') || 'nothing open'}. To trade again: npm run unkill -- --yes on this machine, then restart.` });
    void sendToGrokBot(this.cfg, 'command', { command: 'kill', notes }, this.opts.outboxPath);
    this.changed();
    return notes;
  }

  /** Release kill switch from the office or command, clearing persisted kill state */
  unkill(): boolean {
    if (this.killFilePath) clearKill(this.killFilePath);
    this.killed = false;
    this.killedAt = 0;
    this.paused = false;
    this.stopFlag = false;
    this.addLog({ kind: 'info', text: 'Kill switch released. Trading resumed and buttons re-enabled.' });
    this.changed();
    return true;
  }

  /** Reload runtime configuration in-place from .env without dropping connections */
  reloadRuntimeConfig(env: Record<string, string | undefined>) {
    if (env.PAPER_BALANCE && Number(env.PAPER_BALANCE) > 0 && this.book.positions.length === 0) {
      this.book.balance = Number(env.PAPER_BALANCE);
    }
    if (env.SAFETY_NET && Number(env.SAFETY_NET) >= 0) {
      this.book.safetyNet = Number(env.SAFETY_NET);
    }
    if (env.OPEN_ORDERS_N && [1, 2, 3, 4].includes(Number(env.OPEN_ORDERS_N))) {
      this.book.n = Number(env.OPEN_ORDERS_N) as 1 | 2 | 3 | 4;
      this.cfg.paper.n = Number(env.OPEN_ORDERS_N) as 1 | 2 | 3 | 4;
    }
    if (env.TRADING_MODE) {
      this.cfg.tradingMode = env.TRADING_MODE.toUpperCase() as never;
    }
    if (env.EXCHANGE) {
      this.cfg.exchange.name = env.EXCHANGE as never;
    }
    if (env.AUTO_TRADING) {
      this.cfg.auto.on = env.AUTO_TRADING === 'on';
      this.autoState.on = env.AUTO_TRADING === 'on';
    }
    if (env.DEBATE_INTERVAL_MIN && Number(env.DEBATE_INTERVAL_MIN) > 0) {
      this.cfg.auto.intervalMin = Number(env.DEBATE_INTERVAL_MIN);
      this.autoState.intervalMin = this.cfg.auto.intervalMin;
    }
    if (env.AUTO_SYMBOLS) {
      const syms = env.AUTO_SYMBOLS.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
      if (syms.length) this.cfg.auto.symbols = syms;
    }
    const k = readKill(this.killFilePath);
    if (!k) {
      this.killed = false;
      this.paused = false;
      this.stopFlag = false;
      this.killedAt = 0;
    } else {
      this.killed = true;
      this.paused = true;
      this.stopFlag = true;
      this.killedAt = k.at;
    }
    this.addLog({ kind: 'info', text: 'Office settings reloaded and synchronized in-place.' });
    void this.refreshTickers();
    this.changed();
  }

  /** TradingView alert. Treated as an untrusted hint: it only starts a normal debate, and Risk still gates. */
  async onSignal(sig: ExternalSignal): Promise<{ ok: boolean; reply: string }> {
    this.signals.unshift(sig); this.signals = this.signals.slice(0, 20);
    this.addLog({ kind: 'info', text: `TradingView alert on ${sig.symbol}: ${sig.action}${sig.price ? ` @ ${sig.price}` : ''}. Sent to the table for debate, not executed.` });
    this.changed();
    if (this.killed || this.paused) return { ok: false, reply: 'desk is paused or killed, alert logged only' };
    if (this.debate) return { ok: false, reply: `busy with ${this.debate.symbol}, alert logged only` };
    void this.runDebate(sig.symbol, sig).catch((e) => this.addLog({ kind: 'warn', text: `Debate failed: ${safe((e as Error).message)}` }));
    return { ok: true, reply: `debate started on ${sig.symbol}` };
  }

  /** Grok Bot mode: an agent's turn arrives from the user's own Grok Bot team. */
  async onAgentEvent(ev: AgentEvent): Promise<{ ok: boolean; reply: string }> {
    const a = ev.agent;
    if (ev.kind === 'status' && ev.status) { this.setStatus(a, ev.status); this.changed(); return { ok: true, reply: 'status set' }; }
    if (ev.kind === 'say') {
      if (ev.stance) this.setOpinion(a, ev.stance, ev.confidence ?? 0.5);
      const { disagreement } = this.score();
      const t = ev.target && ev.target !== a ? ev.target : null;
      const fight = !!t && !!ev.stance && !!this.agents[t].stance && val(this.agents[t].stance!) * val(ev.stance) < 0 && disagreement >= this.cfg.debate.fightThreshold;
      if (fight && t) { this.setStatus(a, 'fighting'); this.emit('fight', { from: a, to: t, intensity: Math.min(1, disagreement), punches: 2 }); }
      await this.say(a, ev.text ?? '', false, fight ? 'fighting' : 'arguing');
      return { ok: true, reply: 'said' };
    }
    if (ev.kind === 'proposal') {
      // A Grok Bot Desk Lead can propose; the code caps, money split, daily stop and kill switch still decide.
      if (a !== 'lead') return { ok: false, reply: 'only the Desk Lead can send a proposal' };
      const symbol = normSymbol(ev.symbol ?? '');
      if (!symbol || !ev.action) return { ok: false, reply: 'symbol and action are required' };
      if (ev.text) await this.say('lead', ev.text, false, 'idle');
      if (ev.action === 'HOLD') { this.note('skipped', symbol, `HOLD: ${ev.text ?? 'Grok Bot Desk Lead'}`); return { ok: true, reply: 'hold noted' }; }
      if (ev.action === 'CLOSE') { const r = await this.gbClose(symbol, 'Grok Bot Desk Lead CLOSE'); return { ok: r.ok, reply: r.reply }; }
      // An open proposal needs the Strategist stop price; gbOpen refuses it without one.
      const r = await this.gbOpen({ symbol, side: ev.action === 'OPEN_LONG' ? 'LONG' : 'SHORT', stop: ev.stop ?? null, tp: ev.tp ?? null });
      return { ok: r.ok, reply: r.reply };
    }
    return { ok: false, reply: 'unknown event' };
  }

  /**
   * Keyless agent path (npm run gb -- open, Grok Bot Desk Lead). Same single execution path as the
   * internal debate: risk gate code caps, money split, stop loss, daily loss stop, kill switch.
   * A given stop is used exactly (tick-rounded toward the entry) and never moved. A stop wider than DEFAULT_STOP_PCT
   * or closer than MIN_STOP_PCT is refused; otherwise qty shrinks to fit the loss cap including round-trip fees, or the ticket is refused.
   * A ticket without a stop price is refused (the Strategist's stop is required); leverage is capped.
   */
  async gbOpen(o: { symbol: string; side: 'LONG' | 'SHORT'; stop?: number | null; tp?: number | null; leverage?: number | null; agent?: AgentId }): Promise<{ ok: boolean; reply: string; order?: Verdict['order']; notes: string[] }> {
    const symbol = normSymbol(o.symbol);
    if (!symbol) return { ok: false, reply: 'unknown symbol', notes: [] };
    if (this.killed) return { ok: false, reply: 'kill switch is on', notes: [] };
    if (this.paused) return { ok: false, reply: 'desk is paused', notes: [] };
    if (o.stop == null || !Number.isFinite(o.stop) || !(o.stop > 0)) return { ok: false, reply: 'no stop: every ticket needs the Strategist stop price (--stop P). Not opening without one.', notes: [] };
    if (this.book.positions.some((p) => p.symbol === symbol)) return { ok: false, reply: `already have a ${symbol} position`, notes: [] };
    const snap = await getSnapshot(symbol, this.cfg.marketSource);
    this.updateTicker(snap);
    // Entry is the live ask (LONG) or bid (SHORT), not rounded: the stop distance and size are measured from it.
    const price = o.side === 'LONG' ? (snap.ask ?? snap.last) : (snap.bid ?? snap.last);
    if (o.stop != null && (!(o.stop > 0) || (o.side === 'LONG' ? o.stop >= price : o.stop <= price))) return { ok: false, reply: `stop ${o.stop} is on the wrong side of the entry ${price}`, notes: [] };
    // The gate caps leverage and size factor. The given stop is NOT moved: it goes to the planner exactly,
    // which refuses it if it is wider than DEFAULT_STOP_PCT or closer than MIN_STOP_PCT, and otherwise shrinks
    // qty to fit the loss cap (fees included) or refuses. A missing stop was refused above.
    const gate = applyRiskGate({ decision: 'APPROVE', reason: 'Grok Bot ticket, code caps only', sizeFactor: 1, leverage: o.leverage ?? this.cfg.risk.maxLeverage, stopPct: this.cfg.risk.defaultStopPct } as never, this.cfg.risk, this.agents.risk.mood);
    this.scorecard.verdict(); this.scorecard.riskDecision(gate.decision);
    await this.say('risk', `${gate.decision}. Ticket ${o.side} ${symbol} checked against the code caps.${gate.notes.length ? ' ' + gate.notes.join(' ') : ''}`, false, 'idle');
    if (gate.decision === 'REJECT') { this.note('skipped', symbol, 'Risk rejected the ticket'); return { ok: false, reply: 'risk rejected', notes: gate.notes }; }
    const res = await this.executeOpen(symbol, o.side, price, { ...gate, tp: o.tp ?? null, stop: o.stop ?? null }, snap.example);
    if (res.ok) this.scorecard.opened(symbol, { side: o.side, stances: Object.fromEntries(DEBATERS.map((a) => [a, this.agents[a].stance])), riskDecision: gate.decision });
    this.verdicts.unshift({ id: `gb-${Date.now().toString(36)}`, symbol, action: o.side === 'LONG' ? 'OPEN_LONG' : 'OPEN_SHORT', riskDecision: gate.decision, executed: res.ok, reason: res.ok ? 'Grok Bot ticket' : res.reason, disagreement: this.score().disagreement, camps: this.score().camps, example: snap.example, at: Date.now(), ...(res.order ? { order: res.order } : {}) });
    this.verdicts = this.verdicts.slice(0, 50);
    this.changed();
    return { ok: res.ok, reply: res.ok ? res.line : res.reason, order: res.order, notes: gate.notes };
  }

  async gbClose(target: string, reason = 'Grok Bot close'): Promise<{ ok: boolean; reply: string; closed: ClosedTrade[] }> {
    const symbols = /^all$/i.test(target) ? [...new Set(this.book.positions.map((p) => p.symbol))] : [normSymbol(target)].filter(Boolean);
    const closed: ClosedTrade[] = [];
    for (const sym of symbols) {
      const snap = await getSnapshot(sym, this.cfg.marketSource);
      this.updateTicker(snap);
      closed.push(...await this.executeClose(sym, snap.last, reason));
    }
    return { ok: closed.length > 0, reply: closed.length ? closed.map((t) => `Closed ${t.side} ${t.symbol} at ${t.exit}, PnL ${t.realizedPnl} USDT.`).join(' ') : 'nothing open', closed };
  }

  private invalidated(side: 'LONG' | 'SHORT', rule: ReturnType<typeof strategyVote>) {
    if (!Number.isFinite(rule.ema9)) return false;
    return side === 'LONG' ? rule.close < rule.ema9 : rule.close > rule.ema9;
  }
  private setPhase(phase: string, round = this.debate?.round ?? 0) {
    if (this.debate) { this.debate.phase = phase; this.debate.round = round; }
    this.emit('debate', { ...this.debate });
    this.changed();
  }
  private setOpinion(a: AgentId, stance: Stance, confidence: number) {
    this.agents[a].stance = stance; this.agents[a].confidence = Math.round(confidence * 100) / 100;
    const s = this.score();
    if (this.debate) { this.debate.disagreement = s.disagreement; this.debate.weighted = s.weighted; this.debate.camps = s.camps; }
    this.emit('meter', s);
  }
  score() {
    let bull = 0, bear = 0, neutral = 0, sum = 0;
    const camps: Verdict['camps'] = { bull: [], bear: [], neutral: [] };
    for (const a of DEBATERS) {
      const st = this.agents[a].stance; const c = this.agents[a].confidence ?? 0;
      if (!st) continue;
      if (st === 'LONG') { bull += c; camps.bull.push(a); } else if (st === 'SHORT') { bear += c; camps.bear.push(a); } else { neutral += c; camps.neutral.push(a); }
      sum += val(st) * c;
    }
    const weighted = Math.round((sum / DEBATERS.length) * 100) / 100;
    const total = bull + bear;
    const disagreement = total > 0 ? Math.round(((2 * Math.min(bull, bear)) / total) * (total / (total + neutral * 0.5)) * 100) / 100 : 0;
    return { weighted, disagreement, camps };
  }

  /** Desk Lead journal: grade every closed trade, score the team, and learn from losses and stops. */
  private async review(t: import('./types.js').ClosedTrade) {
    this.setStatus('lead', 'journaling'); this.changed();
    let rv: { grade: string; lesson: string }, example = false;
    if (this.grokbot) rv = codeReview({ trade: t }); // no model calls in Grok Bot mode
    else { const r = await this.run('lead', 'review', { instruction: 'Grade this closed trade and write one lesson.', data: { trade: t }, context: { trade: t } }); rv = r.data; example = r.example; }
    await this.say('lead', `Journal: grade ${rv.grade}. ${rv.lesson}`, example, 'idle');
    this.scorecard.journaled();
    this.journal({ at: Date.now(), trade: t, grade: rv.grade, lesson: rv.lesson });
    const wrong = this.scorecard.closed(t.symbol, t.side, t.realizedPnl);
    const stop = /stop/i.test(t.reason);
    if (t.realizedPnl < 0 || stop) {
      const kind = stop ? 'stop' : 'loss';
      const happened = `${t.symbol} ${t.side} closed at ${t.exit} (${t.reason}), PnL ${t.realizedPnl} USDT.`;
      this.learn({ role: 'lead', kind, symbol: t.symbol, happened, rootCause: stop ? 'price hit the stop loss' : 'the trade went against the desk', lesson: rv.lesson });
      for (const role of wrong) this.learn({ role, kind, symbol: t.symbol, happened, rootCause: `${ROLES[role].name} backed the losing side at entry`, lesson: `On ${t.symbol}, my ${t.side === 'LONG' ? 'long' : 'short'} call lost; wait for stronger confirmation before backing that side again.` });
    }
    this.changed();
  }

  private writeReport(id: string, md: string) {
    if (!this.opts.reportsDir) return;
    try {
      const dir = path.join(this.opts.reportsDir, new Date().toISOString().slice(0, 10));
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `${id}.md`), safe(md) + '\n');
    } catch (e) { log('[report]', e); }
  }
  private journal(entry: Record<string, unknown>) {
    if (!this.opts.reportsDir) return;
    try { mkdirSync(this.opts.reportsDir, { recursive: true }); appendFileSync(path.join(this.opts.reportsDir, 'journal.jsonl'), safe(entry) + '\n'); } catch (e) { log('[journal]', e); }
  }

  // ---------- commands & chat ----------
  async command(text: string, agent?: AgentId): Promise<{ ok: boolean; reply: string; command: Command['type'] }> {
    const cmd = parseCommand(text);
    const who: AgentId = agent ?? 'lead';
    const userLine: ChatLine = { from: 'user', text: safe(text).slice(0, 500), at: Date.now() };
    if (agent) this.chats[agent].push(userLine);
    this.addLog({ kind: 'command', text: `${agent ? `to ${ROLES[agent].name}: ` : ''}${text.slice(0, 200)}` });
    let reply = '';
    let ok = true;
    try {
      switch (cmd.type) {
        case 'debate':
          if (this.debate) { ok = false; reply = `Busy with ${this.debate.symbol}. One fight at a time.`; break; }
          if (this.paused) { ok = false; reply = 'Desk is paused. Say "resume" first.'; break; }
          void this.runDebate(cmd.symbol).catch((e) => this.addLog({ kind: 'warn', text: `Debate failed: ${(e as Error).message}` }));
          reply = `On it. Calling the desk to the table for ${cmd.symbol}.`; break;
        case 'pause': this.paused = true; this.stopFlag = true; reply = 'Paused. Current debate stops after the speaker finishes. No new debates.'; break;
        case 'resume': this.paused = false; reply = 'Back on. Waiting for the next symbol.'; break;
        case 'set_n':
          if (![1, 2, 3, 4].includes(cmd.n)) { ok = false; reply = 'N has to be 1, 2, 3 or 4.'; break; }
          this.book.n = cmd.n; reply = `N set to ${cmd.n}. ${this.book.split().note}.`; break;
        case 'set_safety':
          if (cmd.value < 0) { ok = false; reply = 'Safety net cannot be negative.'; break; }
          if (this.cfg.tradingMode !== 'PAPER' && !(cmd.value > 0)) { ok = false; reply = 'Outside PAPER the safety net must stay above zero.'; break; }
          this.book.safetyNet = cmd.value; reply = `Safety net set to ${cmd.value} USDT. ${this.book.split().note}.`; break;
        case 'set_balance':
          if (this.book.positions.length) { ok = false; reply = 'Close open paper positions before resetting the balance.'; break; }
          this.book.balance = cmd.value; reply = `Paper balance set to ${cmd.value} USDT. ${this.book.split().note}.`; break;
        case 'close_all': {
          const closed: ClosedTrade[] = [];
          for (const sym of [...new Set(this.book.positions.map((p) => p.symbol))]) {
            closed.push(...await this.executeClose(sym, this.tickers[sym]?.last ?? this.book.positions.find((p) => p.symbol === sym)!.mark, 'owner command: close all'));
          }
          reply = closed.length ? `Closed ${closed.length} position(s): ${closed.map((c) => `${c.symbol} ${c.realizedPnl} USDT`).join(', ')}.` : 'Nothing open.';
          break;
        }
        case 'close': {
          const px = this.tickers[cmd.symbol]?.last ?? this.book.positions.find((p) => p.symbol === cmd.symbol)?.mark;
          const closed = px ? await this.executeClose(cmd.symbol, px, 'owner command') : [];
          reply = closed.length ? `Closed ${cmd.symbol}: ${closed.map((c) => `${c.realizedPnl} USDT`).join(', ')}.` : `No open ${cmd.symbol} position.`;
          break;
        }
        case 'mood': {
          const targets = agent ? [agent] : AGENT_IDS;
          for (const t of targets) this.agents[t].mood = cmd.delta === 'reset' ? 0 : Math.max(-2, Math.min(1, this.agents[t].mood + cmd.delta));
          const m = this.agents[who].mood;
          reply = cmd.delta === 'reset' ? 'Mood back to normal.' : m < 0 ? `Understood, more cautious (level ${m}). Risk caps stay the same or tighter.` : `More aggressive (level ${m}). The code caps do not move, so size and leverage limits still apply.`;
          break;
        }
        case 'status': { const s = this.book.split(); reply = `Balance ${s.balance}, safety net ${s.safetyNet}, Money Trade ${s.moneyTrade}, N ${s.n}, ${s.perOrder} per order. Open: ${this.book.positions.length}.`; break; }
        case 'help': reply = HELP; break;
        case 'chat': {
          const target = agent ?? 'lead';
          // self-improving: an owner correction becomes a lesson (refused if it would loosen a guard)
          if (/\b(wrong|salah|don'?t|do not|jangan|stop doing|bad call|mistake|keliru|should have|harusnya|never again)\b/i.test(cmd.text)) {
            const l = this.learn({ role: target, kind: 'correction', happened: `Owner corrected ${ROLES[target].name}: "${cmd.text.slice(0, 160)}"`, rootCause: 'owner feedback from the office chat', lesson: cmd.text.slice(0, 200), source: 'owner' });
            if (!l && this.cfg.learning.on) this.addLog({ kind: 'warn', text: `Correction for ${ROLES[target].name} not stored as a lesson: lessons can never loosen a guard.` });
          }
          if (this.grokbot) { reply = `I am played by your Grok Bot agent in the "Trading Agent Mpu Gandring" group chat. Talk to me there. This office only shows what we post.`; break; }
          this.setStatus(target, 'typing'); this.changed();
          const res = await this.run(target, 'chat', {
            instruction: `The desk owner wrote to you directly (below). Answer briefly in character. Mode is ${this.cfg.tradingMode}. Orders only happen through a debate and the risk gate, never from chat. If they ask for something only a command can do, tell them the command.`,
            data: { ownerMessage: cmd.text.slice(0, 500), yourStance: this.agents[target].stance, paper: this.book.split(), commands: HELP },
            context: { message: cmd.text, paper: this.book.split(), maxLossPct: this.cfg.risk.maxLossPerTradePct, maxLeverage: this.cfg.risk.maxLeverage, openPositions: this.book.positions.map((p) => ({ symbol: p.symbol, side: p.side, entry: p.entry, stop: p.stop, qty: p.qty })), stance: this.agents[target].stance, summary: this.agents[target].lastLine ? `Last thing I said: "${this.agents[target].lastLine.slice(0, 90)}"` : '' }
          });
          this.setStatus(target, 'idle');
          reply = res.data.reply; break;
        }
      }
    } catch (e) { ok = false; reply = `Could not do that: ${(e as Error).message}`; }
    reply = safe(reply);
    if (agent) this.chats[agent].push({ from: who, text: reply, at: Date.now() });
    if (agent && this.chats[agent].length > 60) this.chats[agent].splice(0, this.chats[agent].length - 60);
    this.addLog({ kind: 'info', agent: who, text: reply });
    if (cmd.type !== 'chat' && cmd.type !== 'help' && cmd.type !== 'status') void sendToGrokBot(this.cfg, 'command', { command: cmd.type, text: text.slice(0, 200), agent: agent ?? null, ok, reply }, this.opts.outboxPath);
    this.changed();
    return { ok, reply, command: cmd.type };
  }
}
