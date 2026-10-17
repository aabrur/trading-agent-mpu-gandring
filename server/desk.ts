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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DEBATERS: AgentId[] = ['market', 'research', 'strategist', 'reviewer'];
const val = (s: Stance) => (s === 'LONG' ? 1 : s === 'SHORT' ? -1 : 0);

export interface AgentView {
  id: AgentId; name: string; title: string; color: string; desk: { x: number; y: number };
  provider: string; model: string; fellBackToMock: boolean;
  status: AgentStatus; mood: number; stance: Stance | null; confidence: number | null; lastLine: string;
}
export interface Ticker { symbol: string; last: number; change24hPct: number; source: string; example: boolean; at: number }
export interface LogLine { at: number; kind: 'info' | 'speech' | 'fight' | 'verdict' | 'trade' | 'command' | 'warn'; agent?: AgentId; text: string; example?: boolean }

export interface DeskOptions { reportsDir?: string | null; outboxPath?: string }

export class Desk extends EventEmitter {
  agents: Record<AgentId, AgentView>;
  tickers: Record<string, Ticker> = {};
  book: PaperBook;
  verdicts: Verdict[] = [];
  logs: LogLine[] = [];
  chats: Record<AgentId, ChatLine[]>;
  debate: null | { id: string; symbol: string; phase: string; round: number; disagreement: number; weighted: number; camps: Verdict['camps'] } = null;
  paused = false;
  private stopFlag = false;
  private liveBackoffUntil = 0;
  private timers: NodeJS.Timeout[] = [];

  constructor(public cfg: AppConfig, private call: ModelCaller, private opts: DeskOptions = {}) {
    super();
    this.setMaxListeners(50);
    this.book = new PaperBook(cfg.paper.balance, cfg.paper.safetyNet, cfg.paper.n, cfg.risk.takerFee);
    this.agents = Object.fromEntries(AGENT_IDS.map((id) => {
      const r = ROLES[id]; const a = cfg.agents[id];
      return [id, { id, name: r.name, title: r.title, color: r.color, desk: r.desk, provider: a.provider, model: a.model, fellBackToMock: a.fellBackToMock, status: 'idle', mood: 0, stance: null, confidence: null, lastLine: '' } satisfies AgentView];
    })) as Record<AgentId, AgentView>;
    this.chats = Object.fromEntries(AGENT_IDS.map((id) => [id, [] as ChatLine[]])) as unknown as Record<AgentId, ChatLine[]>;
  }

  // ---------- state ----------
  snapshot() {
    const split = this.book.split();
    return {
      app: 'Trading Agent Mpu Gandring', mode: 'PAPER' as const,
      marketSource: this.cfg.marketSource, bridgeEnabled: this.cfg.bridge.enabled, paused: this.paused,
      agents: this.agents, tickers: this.tickers, debate: this.debate,
      paper: {
        balance: this.book.balance, safetyNet: this.book.safetyNet, n: this.book.n, moneyTrade: split.moneyTrade, perOrder: split.perOrder,
        canOpen: split.canOpen, usedMargin: this.book.usedMargin, unrealized: this.book.unrealized,
        equity: round2(this.book.balance + this.book.unrealized), positions: this.book.positions, closed: this.book.closed.slice(0, 20),
        minOrderUsdt: this.cfg.risk.minOrderUsdt, maxLeverage: this.cfg.risk.maxLeverage
      },
      verdicts: this.verdicts.slice(0, 20), logs: this.logs.slice(-120), chats: this.chats,
      watchlist: this.cfg.watchlist, fightThreshold: this.cfg.debate.fightThreshold
    };
  }
  private changed() { this.emit('state', this.snapshot()); }
  private addLog(l: Omit<LogLine, 'at'>) {
    const line = { ...l, text: safe(l.text), at: Date.now() };
    this.logs.push(line); if (this.logs.length > 400) this.logs.splice(0, this.logs.length - 400);
    this.emit('log', line);
  }
  private setStatus(id: AgentId, status: AgentStatus) { this.agents[id].status = status; this.emit('status', { agent: id, status }); }
  private setAll(status: AgentStatus) { for (const id of AGENT_IDS) this.agents[id].status = status; this.changed(); }

  private async say(agent: AgentId, text: string, example: boolean, after: AgentStatus = 'arguing') {
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
    this.addLog({ kind: 'speech', agent, text: clean, example });
    this.changed();
    if (pace) await sleep(pace / 2);
  }

  // ---------- market ----------
  async refreshTickers() {
    const live = Date.now() >= this.liveBackoffUntil ? this.cfg.marketSource : 'sample';
    let allSample = true;
    await Promise.all(this.cfg.watchlist.map(async (s) => {
      const snap = await getSnapshot(s, live);
      if (snap.source !== 'sample') allSample = false;
      this.updateTicker(snap);
    }));
    if (live !== 'sample' && allSample) this.liveBackoffUntil = Date.now() + 5 * 60_000;
    this.changed();
  }
  private updateTicker(snap: MarketSnapshot) {
    this.tickers[snap.symbol] = { symbol: snap.symbol, last: snap.last, change24hPct: snap.change24hPct, source: snap.source, example: snap.example, at: snap.fetchedAt };
    for (const t of this.book.mark(snap.symbol, snap.last)) {
      this.addLog({ kind: 'trade', text: `STOP: ${t.symbol} ${t.side} closed at ${t.exit}, PnL ${t.realizedPnl} USDT` });
      void this.review(t);
    }
  }

  start() {
    void this.refreshTickers();
    this.timers.push(setInterval(() => void this.refreshTickers(), this.cfg.tickerRefreshSeconds * 1000));
    if (this.cfg.debate.autoMinutes > 0) {
      let i = 0;
      this.timers.push(setInterval(() => {
        if (this.paused || this.debate) return;
        const sym = this.cfg.watchlist[i++ % this.cfg.watchlist.length];
        void this.runDebate(sym).catch((e) => log('[auto]', e));
      }, this.cfg.debate.autoMinutes * 60_000));
    }
  }
  stop() { this.timers.forEach(clearInterval); this.timers = []; }

  // ---------- debate ----------
  async runDebate(symbolIn: string): Promise<Verdict> {
    const symbol = normSymbol(symbolIn);
    if (!symbol) throw new Error('no symbol');
    if (this.paused) throw new Error('desk is paused, send "resume" first');
    if (this.debate) throw new Error(`a debate on ${this.debate.symbol} is already running`);
    this.stopFlag = false;
    const id = `deb-${Date.now().toString(36)}`;
    this.debate = { id, symbol, phase: 'opening', round: 0, disagreement: 0, weighted: 0, camps: { bull: [], bear: [], neutral: [] } };
    this.emit('debate', { id, symbol, phase: 'opening' });
    const transcript: string[] = [`# Debate ${id} on ${symbol}`, `Mode: PAPER. Started ${new Date().toISOString()}`];
    const note = (who: string, t: string) => transcript.push(`- **${who}**: ${t}`);
    try {
      for (const a of AGENT_IDS) { this.agents[a].stance = null; this.agents[a].confidence = null; }
      this.setAll('idle');
      await this.say('lead', `Table, now. ${symbol} is on the board. Market, give me the tape.`, false, 'thinking');

      // 1. Market Analyst
      this.setPhase('reading');
      this.setStatus('market', 'reading'); this.changed();
      const snap = await getSnapshot(symbol, Date.now() >= this.liveBackoffUntil ? this.cfg.marketSource : 'sample');
      this.updateTicker(snap);
      const dataTag = snap.example ? 'sample data (EXAMPLE)' : `${snap.source} public feed`;
      const c8 = snap.candles.at(-9)?.c, cl = snap.candles.at(-1)?.c;
      const change2h = c8 && cl ? round2(((cl - c8) / c8) * 100) : 0;
      const lastCandles = snap.candles.slice(-8).map((c) => ({ t: new Date(c.t).toISOString(), c: c.c }));
      const mk = await runAgent(this.cfg, this.call, 'market', 'opinion', {
        instruction: `Give your stance on ${symbol} from the numbers below (${dataTag}).`,
        data: { symbol, last: snap.last, change24hPct: round2(snap.change24hPct), change2hPct: change2h, fundingRate: snap.fundingRate, recentClosedCandles: lastCandles, source: snap.source },
        context: { symbol, last: snap.last, change24hPct: snap.change24hPct, change2hPct: change2h, fundingRate: snap.fundingRate, temperament: this.agents.market.mood }
      });
      this.setOpinion('market', mk.data.stance, mk.data.confidence);
      await this.say('market', mk.data.argument, mk.example); note('Market Analyst', mk.data.argument);

      // 2. Research Analyst
      this.setStatus('research', 'reading'); this.changed();
      const news = getNews(symbol);
      const rs = await runAgent(this.cfg, this.call, 'research', 'research', {
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
      const st = await runAgent(this.cfg, this.call, 'strategist', 'opinion', {
        instruction: `The EMA rule on closed 15m bars produced the result below for ${symbol}. Your stance must match the rule side (ABSTAIN means NEUTRAL). Explain it in your voice.`,
        data: { symbol, rule },
        context: { symbol, rule }
      });
      const ruleStance: Stance = rule.side === 'ABSTAIN' ? 'NEUTRAL' : rule.side;
      // The rule wins over the model if they disagree.
      this.setOpinion('strategist', ruleStance, st.data.stance === ruleStance ? st.data.confidence : 0.5);
      await this.say('strategist', st.data.argument, st.example); note('Strategist', st.data.argument);

      this.agents.reviewer.stance = 'NEUTRAL'; this.agents.reviewer.confidence = 0.3;
      const journal = this.book.closed.slice(0, 5).map((t) => ({ symbol: t.symbol, side: t.side, pnl: t.realizedPnl, reason: t.reason }));

      // 4. Rebuttal rounds
      for (let round = 1; round <= this.cfg.debate.rounds; round++) {
        if (this.stopFlag) break;
        this.setPhase(`round ${round}`, round);
        for (const a of DEBATERS) {
          if (this.stopFlag) break;
          const others = DEBATERS.filter((o) => o !== a).map((o) => ({ agent: o, stance: this.agents[o].stance ?? 'NEUTRAL', confidence: this.agents[o].confidence ?? 0, lastLine: this.agents[o].lastLine }));
          this.setStatus(a, 'thinking'); this.changed();
          const rb = await runAgent(this.cfg, this.call, a, 'rebuttal', {
            instruction: `Round ${round} of the ${symbol} debate. Answer the strongest view you disagree with. You may change your stance if the evidence is better.`,
            data: { symbol, round, you: { stance: this.agents[a].stance, confidence: this.agents[a].confidence }, others, journal: a === 'reviewer' ? journal : undefined },
            context: { symbol, round, myStance: this.agents[a].stance, myConfidence: this.agents[a].confidence, others, temperament: this.agents[a].mood, journalCount: journal.length }
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
      const ld = await runAgent(this.cfg, this.call, 'lead', 'lead', {
        instruction: `Close the ${symbol} debate. Pick one action.`,
        data: { symbol, votes: DEBATERS.map((a) => ({ agent: a, stance: this.agents[a].stance, confidence: this.agents[a].confidence })), weightedScore: weighted, disagreement, researchVote, openPosition: pos ? { side: pos.side, entry: pos.entry, stop: pos.stop } : null, freeSlots: this.book.n - this.book.positions.length },
        context: { weighted, disagreement, researchVote, hasPosition: !!pos, positionSide: pos?.side, slotsFree: this.book.positions.length < this.book.n, cautious, strategyInvalidated: pos ? this.invalidated(pos.side, rule) : false }
      });
      let action: Action = ld.data.action;
      if (action === 'CLOSE' && !pos) action = 'HOLD';
      if ((action === 'OPEN_LONG' || action === 'OPEN_SHORT') && pos) action = 'HOLD';
      if (researchVote === 'VETO' && action.startsWith('OPEN')) action = 'HOLD';
      await this.say('lead', `${action.replace('_', ' ')}. ${ld.data.reason}`, ld.example, 'idle'); note('Desk Lead', `${action}. ${ld.data.reason}`);

      // 6. Risk gate
      this.setPhase('risk gate');
      this.setStatus('risk', 'thinking'); this.changed();
      const rk = await runAgent(this.cfg, this.call, 'risk', 'risk', {
        instruction: `Gate this proposal from the Desk Lead: ${action} ${symbol}. Caps: max leverage ${this.cfg.risk.maxLeverage}x, stop at most ${this.cfg.risk.defaultStopPct}%, max loss per trade ${this.cfg.risk.maxLossPerTradePct}% of balance.`,
        data: { symbol, action, disagreement, researchVote, strategy: { side: rule.side, invalidation: rule.invalidation }, paper: moneySplit({ balance: this.book.balance, safetyNet: this.book.safetyNet, n: this.book.n }), openPositions: this.book.positions.length },
        context: { action, disagreement, researchVote, strategySide: rule.side, maxLeverage: this.cfg.risk.maxLeverage, defaultStopPct: this.cfg.risk.defaultStopPct, temperament: this.agents.risk.mood }
      });
      const gate = applyRiskGate(rk.data, this.cfg.risk, this.agents.risk.mood);
      const riskLine = `${gate.decision}. ${rk.data.reason}${gate.notes.length ? ' ' + gate.notes.join(' ') : ''}`;
      await this.say('risk', riskLine, rk.example, 'idle'); note('Risk Manager', riskLine);

      // 7. Verdict and paper execution
      const verdict: Verdict = { id, symbol, action, riskDecision: action === 'HOLD' ? 'N/A' : gate.decision, executed: false, reason: ld.data.reason, disagreement, camps, example: mk.example || ld.example || rk.example || snap.example, at: Date.now() };
      if (action === 'OPEN_LONG' || action === 'OPEN_SHORT') {
        if (gate.decision === 'REJECT') verdict.reason = `Risk rejected: ${rk.data.reason}`;
        else {
          const side = action === 'OPEN_LONG' ? 'LONG' : 'SHORT';
          const price = roundPrice(side === 'LONG' ? (snap.ask ?? snap.last) : (snap.bid ?? snap.last));
          const plan = planOrder({
            balance: this.book.balance, safetyNet: this.book.safetyNet, n: this.book.n, openPositions: this.book.positions.length, usedMargin: this.book.usedMargin,
            price, side, sizeFactor: gate.sizeFactor, leverage: gate.leverage, stopPct: gate.stopPct, minOrderUsdt: this.cfg.risk.minOrderUsdt, maxLossPerTradePct: this.cfg.risk.maxLossPerTradePct
          });
          this.setStatus('execution', 'executing'); this.changed();
          if (plan.ok) {
            const p = this.book.open({ symbol, side, qty: plan.qty, entry: price, stop: plan.stop, margin: plan.margin, leverage: plan.leverage });
            verdict.executed = true;
            verdict.order = { side, qty: p.qty, entry: p.entry, stop: p.stop, margin: p.margin, leverage: p.leverage };
            const line = `Paper fill: ${side} ${p.qty} ${symbol} at ${p.entry}, stop ${p.stop}, margin ${p.margin} USDT at ${p.leverage}x.${plan.notes.length ? ' ' + plan.notes.join(' ') : ''}`;
            this.addLog({ kind: 'trade', agent: 'execution', text: line });
            await this.say('execution', line, false, 'idle'); note('Execution Trader', line);
          } else {
            verdict.reason = `${plan.reason}${plan.suggestion ? ' ' + plan.suggestion : ''}`;
            await this.say('execution', `No fill. ${verdict.reason}`, false, 'idle'); note('Execution Trader', `No fill. ${verdict.reason}`);
          }
        }
      } else if (action === 'CLOSE' && pos) {
        this.setStatus('execution', 'executing'); this.changed();
        const t = this.book.closeSymbol(symbol, snap.last, 'desk verdict CLOSE');
        verdict.executed = t.length > 0;
        const line = t.map((x) => `Closed ${x.side} ${x.symbol} at ${x.exit}, PnL ${x.realizedPnl} USDT.`).join(' ');
        this.addLog({ kind: 'trade', agent: 'execution', text: line });
        await this.say('execution', line, false, 'idle'); note('Execution Trader', line);
        for (const x of t) await this.review(x);
      }
      this.verdicts.unshift(verdict); this.verdicts = this.verdicts.slice(0, 50);
      this.addLog({ kind: 'verdict', text: `VERDICT ${symbol}: ${action} (risk ${verdict.riskDecision}, disagreement ${disagreement.toFixed(2)})${verdict.executed ? ', paper filled' : ''}`, example: verdict.example });
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

  private async review(t: import('./types.js').ClosedTrade) {
    this.setStatus('reviewer', 'journaling'); this.changed();
    const rv = await runAgent(this.cfg, this.call, 'reviewer', 'review', {
      instruction: 'Grade this closed paper trade and write one lesson.',
      data: { trade: t }, context: { trade: t }
    });
    await this.say('reviewer', `Grade ${rv.data.grade}. ${rv.data.lesson}`, rv.example, 'idle');
    this.journal({ at: Date.now(), trade: t, grade: rv.data.grade, lesson: rv.data.lesson });
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
          this.book.safetyNet = cmd.value; reply = `Safety net set to ${cmd.value} USDT. ${this.book.split().note}.`; break;
        case 'set_balance':
          if (this.book.positions.length) { ok = false; reply = 'Close open paper positions before resetting the balance.'; break; }
          this.book.balance = cmd.value; reply = `Paper balance set to ${cmd.value} USDT. ${this.book.split().note}.`; break;
        case 'close_all': {
          const prices = Object.fromEntries(Object.values(this.tickers).map((t) => [t.symbol, t.last]));
          const closed = this.book.closeAll(prices, 'owner command: close all');
          reply = closed.length ? `Closed ${closed.length} paper position(s): ${closed.map((c) => `${c.symbol} ${c.realizedPnl} USDT`).join(', ')}.` : 'Nothing open.';
          for (const c of closed) void this.review(c);
          break;
        }
        case 'close': {
          const px = this.tickers[cmd.symbol]?.last ?? this.book.positions.find((p) => p.symbol === cmd.symbol)?.mark;
          const closed = px ? this.book.closeSymbol(cmd.symbol, px, 'owner command') : [];
          reply = closed.length ? `Closed ${cmd.symbol}: ${closed.map((c) => `${c.realizedPnl} USDT`).join(', ')}.` : `No open ${cmd.symbol} position.`;
          for (const c of closed) void this.review(c);
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
          this.setStatus(target, 'typing'); this.changed();
          const res = await runAgent(this.cfg, this.call, target, 'chat', {
            instruction: 'The desk owner wrote to you directly (below). Answer briefly in character. You cannot place real trades. If they ask for something only a command can do, tell them the command.',
            data: { ownerMessage: cmd.text.slice(0, 500), yourStance: this.agents[target].stance, paper: this.book.split(), commands: HELP },
            context: { message: cmd.text, summary: this.agents[target].lastLine ? `Last thing I said: "${this.agents[target].lastLine.slice(0, 90)}"` : '' }
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
