import type { ModelRequest } from './index.js';
import { hashStr } from '../market/sample.js';

// Offline, deterministic stand-in for a model. No key, no network.
// Output is driven by the structured context only, never by free text in the
// prompt, so it doubles as a reference for how a well-behaved agent should act.
// Everything it produces is flagged example=true by the caller.

const NAMES: Record<string, string> = { lead: 'Desk Lead', market: 'Market Analyst', research: 'Research Analyst', strategist: 'Strategist', risk: 'Risk Manager', execution: 'Execution Trader', reviewer: 'Trade Reviewer' };
const pick = <T,>(arr: T[], seed: string): T => arr[hashStr(seed) % arr.length];
const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const r2 = (v: number) => Math.round(v * 100) / 100;
type Ctx = Record<string, any>;

function market(c: Ctx) {
  const ch = Number(c.change24hPct ?? 0);
  const fund = c.fundingRate == null ? null : Number(c.fundingRate);
  const ch2 = Number(c.change2hPct ?? 0);
  const temper = Number(c.temperament ?? 0);
  const score = ch / 1.5 + ch2 / 0.4; // day trend plus the last two hours of closed bars
  let stance: 'LONG' | 'SHORT' | 'NEUTRAL' = score > 0.6 ? 'LONG' : score < -0.6 ? 'SHORT' : 'NEUTRAL';
  let confidence = clamp(0.35 + Math.min(Math.abs(score), 3) / 6 + temper * 0.08);
  if (fund != null && Math.abs(fund) > 0.0003) {
    confidence = clamp(confidence - 0.1);
  }
  if (temper <= -2 && confidence < 0.55) stance = 'NEUTRAL';
  const fundTxt = fund == null ? 'no funding read' : `funding ${(fund * 100).toFixed(4)}%`;
  const lines = {
    LONG: [`${c.symbol}: ${ch.toFixed(2)}% on the day, ${ch2.toFixed(2)}% in the last two hours, ${fundTxt}. Buyers keep lifting offers, I lean long.`, `Tape on ${c.symbol} is green where it matters: ${ch2.toFixed(2)}% in two hours, ${ch.toFixed(2)}% in 24h, ${fundTxt}. Long bias.`],
    SHORT: [`${c.symbol}: ${ch.toFixed(2)}% in 24h and ${ch2.toFixed(2)}% in the last two hours, ${fundTxt}. Every bounce gets sold. I lean short.`, `Sellers own ${c.symbol}: ${ch2.toFixed(2)}% in two hours, ${ch.toFixed(2)}% on the day, ${fundTxt}. Short bias until that changes.`],
    NEUTRAL: [`${c.symbol} moved ${ch.toFixed(2)}% in 24h and ${ch2.toFixed(2)}% in two hours, ${fundTxt}. That is chop, not a trend. I sit flat.`, `Nothing clean on ${c.symbol}. ${ch.toFixed(2)}% on the day, ${ch2.toFixed(2)}% in two hours, ${fundTxt}. Flat for me.`]
  };
  return { stance, confidence: r2(confidence), argument: pick(lines[stance], `${c.symbol}m`) };
}

function research(c: Ctx) {
  const news: { id: string; sentiment: string; source: string; flagged?: boolean }[] = c.news ?? [];
  const severe = news.find((n) => n.sentiment === 'severe');
  const flagged = news.filter((n) => n.flagged);
  const flagTxt = flagged.length ? ` One item (${flagged.map((f) => f.id).join(', ')}) had instruction-like text, I threw that part out.` : '';
  if (severe) return { vote: 'VETO', confidence: 0.9, argument: `Severe item ${severe.id} from ${severe.source}. I veto until it is cleared.${flagTxt}`, sources: [severe.id] };
  const score = news.reduce((s, n) => s + (n.sentiment === 'bullish' ? 1 : n.sentiment === 'bearish' ? -1 : 0), 0);
  const ids = news.map((n) => n.id);
  if (score > 0) return { vote: 'LONG', confidence: r2(clamp(0.4 + score * 0.15)), argument: `Catalysts on ${c.symbol} lean positive (${ids.join(', ')}). Sourced, not huge.${flagTxt}`, sources: ids };
  if (score < 0) return { vote: 'SHORT', confidence: r2(clamp(0.4 + Math.abs(score) * 0.15)), argument: `Flow and headlines on ${c.symbol} lean negative (${ids.join(', ')}). Claims only, not verified.${flagTxt}`, sources: ids };
  return { vote: 'ABSTAIN', confidence: 0.3, argument: `Nothing material on ${c.symbol}. ABSTAIN is not a vote either way.${flagTxt}`, sources: ids };
}

function strategist(c: Ctx) {
  const v = c.rule ?? {};
  const side = v.side === 'ABSTAIN' ? 'NEUTRAL' : v.side;
  const inv = v.invalidation ? Number(v.invalidation).toPrecision(6) : 'n/a';
  const conf = side === 'NEUTRAL' ? 0.3 : clamp(0.5 + Math.min(Math.abs(Number(v.change5Pct ?? 0)), 2) / 6);
  const txt = side === 'NEUTRAL'
    ? `Rule says ABSTAIN. ${v.reason ?? ''} I do not vote on feelings.`
    : `Closed bars say ${side}. ${v.reason} Invalidation at EMA9 ${inv}. Below that I am out.`.replace('Below', side === 'SHORT' ? 'Above' : 'Below');
  return { stance: side, confidence: r2(conf), argument: txt.trim() };
}

function rebuttal(c: Ctx) {
  const me = String(c.agent);
  const others: { agent: string; stance: string; confidence: number }[] = c.others ?? [];
  let stance: string = c.myStance ?? 'NEUTRAL';
  let confidence = Number(c.myConfidence ?? 0.4);
  const bull = others.filter((o) => o.stance === 'LONG').reduce((s, o) => s + o.confidence, 0);
  const bear = others.filter((o) => o.stance === 'SHORT').reduce((s, o) => s + o.confidence, 0);
  const majority = bull > bear + 0.2 ? 'LONG' : bear > bull + 0.2 ? 'SHORT' : 'NEUTRAL';
  if (me === 'strategist') {
    confidence = clamp(confidence + 0.02); // the rule does not change mid debate
  } else if (me === 'reviewer') {
    // Devil's advocate: argues against a crowded side, from the journal.
    if (majority !== 'NEUTRAL') { stance = majority === 'LONG' ? 'SHORT' : 'LONG'; confidence = 0.45 + (hashStr(`${c.symbol}${c.round}`) % 20) / 100; }
  } else if (Number(c.round) > 1 && stance !== majority && confidence < 0.5 && majority !== 'NEUTRAL') {
    stance = 'NEUTRAL'; confidence = clamp(confidence - 0.1);
  } else {
    confidence = clamp(confidence + (stance === majority ? 0.05 : -0.03));
  }
  if (Number(c.temperament ?? 0) <= -1) confidence = clamp(confidence - 0.1);
  const opp = others.filter((o) => o.stance !== stance && o.stance !== 'NEUTRAL').sort((a, b) => b.confidence - a.confidence)[0];
  const target = opp?.agent ?? 'none';
  const tname = NAMES[target] ?? 'everyone';
  const lines: Record<string, string[]> = {
    market: [`${tname}, price is the only thing that pays. The tape says ${stance}, your story does not.`, `I hear you, ${tname}, but bids do not care about your narrative. ${stance}.`],
    research: [`${tname}, you are trading a chart while the catalysts say ${stance}. Read the sources.`, `Candles lag news, ${tname}. My read stays ${stance}.`],
    strategist: [`${tname}, the rule fired on a closed bar. Opinions are not signals. ${stance}.`, `Show me a closed bar that breaks my level, ${tname}. Until then, ${stance}.`],
    reviewer: [`${tname}, my journal says calls this crowded go wrong more often than you think. I take the other side: ${stance}.`, `Crowded trade, ${tname}. My journal says fade it. ${stance}.`],
    lead: [`Enough. ${tname}, make your point in one line.`]
  };
  const journalCount = Number(c.journalCount ?? 0);
  if (me === 'reviewer' && journalCount === 0) {
    lines.reviewer = [`${tname}, my journal is empty, so nobody here has earned this much confidence yet. I take the other side: ${stance}.`, `Crowded room, ${tname}. Somebody has to argue ${stance}, so it is me.`];
  }
  const agree: Record<string, string[]> = {
    market: [`Same page for once. The tape still says ${stance}.`, `Nobody is fighting me on this. ${stance}, and I want to see volume confirm it.`],
    research: [`No one is arguing with the sources. ${stance}, still only sourced claims.`],
    strategist: [`The rule and the room agree. ${stance}. That does not make it more true.`],
    reviewer: [`Too quiet in here. I stay ${stance} and I am watching for the trap.`],
    lead: ['Go on.']
  };
  const pool = target === 'none' ? (agree[me] ?? [`${stance}.`]) : (lines[me] ?? [`${stance}.`]);
  return { stance, confidence: r2(confidence), target, rebuttal: pick(pool, `${c.symbol}${me}${c.round}`) };
}

function lead(c: Ctx) {
  const w = Number(c.weighted ?? 0);
  const dis = Number(c.disagreement ?? 0);
  if (c.researchVote === 'VETO') return { action: c.hasPosition ? 'CLOSE' : 'HOLD', confidence: 0.85, reason: 'Research vetoed. We do not argue with a halt or an exploit.' };
  if (c.hasPosition) {
    const against = (c.positionSide === 'LONG' && w < -0.2) || (c.positionSide === 'SHORT' && w > 0.2);
    if (against || c.strategyInvalidated) return { action: 'CLOSE', confidence: 0.7, reason: `The room turned against our ${c.positionSide}. Close it and reset.` };
    return { action: 'HOLD', confidence: 0.6, reason: `Our ${c.positionSide} still has support. Hold and let the stop do its job.` };
  }
  if (!c.slotsFree) return { action: 'HOLD', confidence: 0.8, reason: 'All N order slots are taken. Nothing new today.' };
  const bar = 0.15 + (c.cautious ? 0.12 : 0);
  if (dis > 0.75) return { action: 'HOLD', confidence: 0.55, reason: 'This room is split down the middle. A split desk does not get my money.' };
  if (w > bar) return { action: 'OPEN_LONG', confidence: r2(clamp(0.5 + w / 2)), reason: `Bulls carried it with a weighted score of ${w.toFixed(2)}. Long, with a stop.` };
  if (w < -bar) return { action: 'OPEN_SHORT', confidence: r2(clamp(0.5 + Math.abs(w) / 2)), reason: `Bears carried it with a weighted score of ${w.toFixed(2)}. Short, with a stop.` };
  return { action: 'HOLD', confidence: 0.5, reason: `Score ${w.toFixed(2)} is too weak. Idle cash is not a reason to trade.` };
}

function risk(c: Ctx) {
  const dis = Number(c.disagreement ?? 0);
  const temper = Number(c.temperament ?? 0);
  const lev = Number(c.maxLeverage ?? 3);
  const stop = Number(c.defaultStopPct ?? 1.5);
  if (c.action === 'HOLD' || c.action === 'CLOSE') return { decision: 'APPROVE', sizeFactor: 1, leverage: 1, stopPct: stop, reason: c.action === 'CLOSE' ? 'Closing reduces risk. Approved.' : 'Nothing to size. Fine by me.' };
  if (c.researchVote === 'VETO') return { decision: 'REJECT', sizeFactor: 0, leverage: 1, stopPct: stop, reason: 'Research vetoed. Rejected.' };
  const strategyAgrees = (c.action === 'OPEN_LONG' && c.strategySide === 'LONG') || (c.action === 'OPEN_SHORT' && c.strategySide === 'SHORT');
  if (!strategyAgrees && dis > 0.5) return { decision: 'REJECT', sizeFactor: 0, leverage: 1, stopPct: stop, reason: 'The rule does not back this and the room is split. Rejected.' };
  if (dis > 0.35 || !strategyAgrees || temper < 0) {
    return { decision: 'REDUCE', sizeFactor: r2(clamp(0.5 + temper * 0.1, 0.2, 0.6)), leverage: Math.max(1, lev - 1), stopPct: r2(stop * 0.8), reason: `Disagreement ${dis.toFixed(2)}. Half size, lower leverage, tighter stop.` };
  }
  return { decision: 'APPROVE', sizeFactor: 1, leverage: lev, stopPct: stop, reason: 'Rule, tape and lead line up. Approved at standard size.' };
}

function review(c: Ctx) {
  const t = c.trade ?? {};
  const pnl = Number(t.realizedPnl ?? 0);
  if (pnl > 0) return { lesson: `${t.symbol} ${t.side} paid ${pnl.toFixed(2)} USDT. Note the setup, do not get cocky.`, grade: 'B' };
  if (String(t.reason ?? '').includes('stop')) return { lesson: `${t.symbol} ${t.side} hit its stop for ${pnl.toFixed(2)}. The stop worked as designed.`, grade: 'C' };
  return { lesson: `${t.symbol} ${t.side} closed at ${pnl.toFixed(2)}. Check if we closed on fear or on a rule.`, grade: 'C' };
}

function chat(c: Ctx) {
  const agent = String(c.agent);
  const msg = String(c.message ?? '').toLowerCase();
  const paper = c.paper ?? {};
  const pos: { symbol: string; side: string; entry: number; stop: number; qty: number }[] = c.openPositions ?? [];
  const posTxt = pos.length ? pos.map((p) => `${p.side} ${p.symbol} from ${p.entry}, stop ${p.stop}`).join('; ') : 'nothing open right now';
  const riskAtStop = pos.reduce((s, p) => s + Math.abs(p.entry - p.stop) * p.qty, 0);
  const asks = (...w: string[]) => w.some((x) => msg.includes(x));
  if (agent === 'risk') {
    if (asks('stop', 'lose', 'loss', 'rugi')) return { reply: pos.length ? `If every stop hits, we give back about ${r2(riskAtStop)} USDT plus fees. Each trade is capped at ${c.maxLossPct}% of the balance, so the worst single hit is ${r2((paper.balance ?? 0) * (c.maxLossPct ?? 1) / 100)} USDT.` : `Nothing open, so nothing to lose right now. When we do trade, a stop hit costs at most ${c.maxLossPct}% of the balance. That cap is in code.` };
    return { reply: `My job is saying no politely. Leverage tops out at ${c.maxLeverage}x and the safety net of ${paper.safetyNet} USDT never moves. I can shrink a trade or kill it, never grow it.` };
  }
  if (agent === 'lead') return { reply: asks('why', 'kenapa') ? `I only sign what survives the argument and the risk gate. HOLD is a perfectly good answer.` : `Give me a symbol and I will call the table. Positions: ${posTxt}.` };
  if (agent === 'market') return { reply: `I read public prices and closed candles, nothing else. Ask me after a debate and I will tell you what the tape said.` };
  if (agent === 'research') return { reply: asks('veto') ? 'Delisting, halt, exploit or chain outage. Any of those and I veto, no debate.' : 'I trust sources, not vibes. Every claim gets a label: verified, reported or claimed.' };
  if (agent === 'strategist') return { reply: 'EMA9, EMA21 and EMA50 on closed 15 minute bars. Above all three is long, below all three is short, otherwise I abstain.' };
  if (agent === 'execution') return { reply: `Paper fills only. Every order goes in with a stop and a take profit. Open now: ${posTxt}.` };
  if (agent === 'reviewer') return { reply: 'I keep the journal and I argue with whoever sounds too sure. Ask me again after a few closed trades.' };
  return { reply: 'Noted.' };
}

export async function mockReply(req: ModelRequest): Promise<string> {
  const c = { ...req.context, agent: req.agent };
  let out: unknown;
  switch (req.task) {
    case 'opinion': out = req.agent === 'strategist' ? strategist(c) : market(c); break;
    case 'research': out = research(c); break;
    case 'rebuttal': out = rebuttal(c); break;
    case 'lead': out = lead(c); break;
    case 'risk': out = risk(c); break;
    case 'review': out = review(c); break;
    case 'chat': out = chat(c); break;
  }
  return JSON.stringify(out);
}
