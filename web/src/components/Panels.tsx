import { useEffect, useRef, useState } from 'react';
import type { AgentId, DeskState, Verdict } from '../types';
import { AGENT_ORDER } from '../types';
import { Keris, PamorPattern } from './Keris';

export const fmt = (v: number, d = 2) => (Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '-');
export const fmtPx = (v: number) => (v >= 1000 ? fmt(v, 1) : v >= 1 ? fmt(v, 3) : v.toPrecision(4));
const SHORT: Record<AgentId, string> = { lead: 'Lead', market: 'Market', research: 'Research', strategist: 'Strategist', risk: 'Risk', execution: 'Exec', reviewer: 'Reviewer' };
const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function TopBar({ state, connected }: { state: DeskState | null; connected: boolean }) {
  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark"><Keris className="brand-keris" height={34} /></div>
        <div>
          <h1>Trading Agent <span>Mpu Gandring</span></h1>
          <p>seven agents, one paper book, zero chill</p>
        </div>
      </div>
      <div className="badges">
        <span className="badge paper" title="This build only simulates trades">PAPER MODE</span>
        {state && <span className="badge">data: {state.marketSource}</span>}
        {state?.bridgeEnabled && <span className="badge">Grok Bot bridge on</span>}
        {state?.paused && <span className="badge warn">paused</span>}
        <span className={`badge conn ${connected ? 'on' : 'off'}`}><i />{connected ? 'live' : 'reconnecting'}</span>
      </div>
    </header>
  );
}

export function TickerStrip({ state }: { state: DeskState }) {
  const items = Object.values(state.tickers);
  if (!items.length) return <div className="ticker"><span className="muted">waiting for prices...</span></div>;
  const row = [...items, ...items, ...items];
  return (
    <div className="ticker" aria-label="prices">
      <div className="ticker-track">
        {row.map((t, i) => (
          <span key={i} className="tick">
            <b>{t.symbol}</b>
            <span>{fmtPx(t.last)}</span>
            <em className={t.change24hPct >= 0 ? 'up' : 'down'}>{t.change24hPct >= 0 ? '▲' : '▼'} {fmt(Math.abs(t.change24hPct))}%</em>
            <small>{t.example ? 'sample · EXAMPLE' : t.source}</small>
          </span>
        ))}
      </div>
    </div>
  );
}

export function FightMeter({ state, meter }: { state: DeskState; meter: { weighted: number; disagreement: number } | null }) {
  const d = state.debate;
  const dis = meter?.disagreement ?? d?.disagreement ?? 0;
  const w = meter?.weighted ?? d?.weighted ?? 0;
  const camps = d?.camps ?? { bull: [], bear: [], neutral: [] };
  const label = dis >= state.fightThreshold ? (dis > 0.75 ? 'full brawl' : 'fists out') : dis > 0.25 ? 'heated' : d ? 'mostly agree' : 'quiet';
  return (
    <section className="panel meter">
      <div className="panel-head"><h2>Fight meter</h2><span className={`heat-label h-${label.replace(' ', '-')}`}>{label}</span></div>
      <div className="meter-bar"><div className="meter-fill" style={{ width: `${Math.round(dis * 100)}%` }} /><div className="meter-threshold" style={{ left: `${state.fightThreshold * 100}%` }} title="punches start here" /></div>
      <div className="meter-scale"><span>consensus</span><span>{Math.round(dis * 100)}% disagreement</span><span>brawl</span></div>
      <div className="tug">
        <span className="bear-side">BEAR</span>
        <div className="rope"><i style={{ left: `${50 + w * 50}%` }} /></div>
        <span className="bull-side">BULL</span>
      </div>
      <div className="camps">
        <Camp label="Bulls" ids={camps.bull} state={state} cls="bull" />
        <Camp label="Bears" ids={camps.bear} state={state} cls="bear" />
        <Camp label="Fence" ids={camps.neutral} state={state} cls="neutral" />
      </div>
    </section>
  );
}
function Camp({ label, ids, state, cls }: { label: string; ids: AgentId[]; state: DeskState; cls: string }) {
  return (
    <div className={`camp ${cls}`}>
      <small>{label}</small>
      <div>{ids.length ? ids.map((id) => <span key={id} className="chip" style={{ ['--agent' as string]: state.agents[id].color }}>{SHORT[id]}</span>) : <span className="muted">none</span>}</div>
    </div>
  );
}

export function Portfolio({ state, command }: { state: DeskState; command: (t: string) => void }) {
  const p = state.paper;
  const [safety, setSafety] = useState(String(p.safetyNet));
  const [balance, setBalance] = useState(String(p.balance));
  useEffect(() => setSafety(String(p.safetyNet)), [p.safetyNet]);
  useEffect(() => setBalance(String(p.balance)), [p.balance]);
  return (
    <section className="panel portfolio">
      <PamorPattern />
      <div className="panel-head"><h2>Paper book</h2><span className={`pnl ${p.unrealized >= 0 ? 'up' : 'down'}`}>uPnL {p.unrealized >= 0 ? '+' : ''}{fmt(p.unrealized)}</span></div>
      <div className="stats">
        <label className="stat"><small>Total balance</small>
          <span className="inline-edit"><input value={balance} onChange={(e) => setBalance(e.target.value)} onBlur={() => balance !== String(p.balance) && command(`set balance ${balance}`)} inputMode="decimal" aria-label="paper balance" /> USDT</span>
        </label>
        <label className="stat"><small>Safety net</small>
          <span className="inline-edit"><input value={safety} onChange={(e) => setSafety(e.target.value)} onBlur={() => safety !== String(p.safetyNet) && command(`set safety ${safety}`)} inputMode="decimal" aria-label="safety net" /> USDT</span>
        </label>
        <div className="stat hi"><small>Money Trade</small><b>{fmt(p.moneyTrade)}</b></div>
        <div className="stat"><small>Per order</small><b>{fmt(p.perOrder)}</b></div>
      </div>
      <div className="n-picker">
        <small>Open orders N</small>
        {[1, 2, 3, 4].map((n) => <button key={n} className={p.n === n ? 'on' : ''} onClick={() => command(`set n ${n}`)}>{n}</button>)}
        <span className="slots">{p.positions.length}/{p.n} used</span>
      </div>
      <p className="formula">Money Trade = {fmt(p.balance)} - {fmt(p.safetyNet)} = <b>{fmt(p.moneyTrade)}</b> · / {p.n} = <b>{fmt(p.perOrder)}</b> per order{!p.canOpen && <em> · at safety net, no new orders</em>}</p>
      <div className="positions">
        {p.positions.length === 0 && <p className="muted">No open paper positions.</p>}
        {p.positions.map((x) => (
          <div key={x.id} className={`pos ${x.side}`}>
            <b>{x.side} {x.symbol}</b>
            <span>{x.qty} @ {fmtPx(x.entry)}</span>
            <span className="sl">SL {fmtPx(x.stop)}</span>
            <span>{x.leverage}x · {fmt(x.margin)}</span>
            <span className={x.unrealizedPnl >= 0 ? 'up' : 'down'}>{x.unrealizedPnl >= 0 ? '+' : ''}{fmt(x.unrealizedPnl)}</span>
            <button className="mini" onClick={() => command(`close ${x.symbol}`)}>close</button>
          </div>
        ))}
      </div>
      <div className="foot"><span>Equity {fmt(p.equity)}</span><span>Used margin {fmt(p.usedMargin)}</span><span>Closed {p.closed.length}</span></div>
    </section>
  );
}

const ACTION_LABEL: Record<Verdict['action'], string> = { OPEN_LONG: 'OPEN LONG', OPEN_SHORT: 'OPEN SHORT', CLOSE: 'CLOSE', HOLD: 'HOLD' };
export function Verdicts({ state }: { state: DeskState }) {
  return (
    <section className="panel verdicts">
      <div className="panel-head"><h2>Verdicts</h2><small className="muted">Desk Lead signs, Risk gates</small></div>
      {state.verdicts.length === 0 && <p className="muted">No verdict yet. Start a debate.</p>}
      <div className="verdict-list">
        {state.verdicts.slice(0, 6).map((v) => (
          <article key={v.id} className={`verdict a-${v.action}`}>
            <div className="v-top">
              <span className="v-action">{ACTION_LABEL[v.action]}</span>
              <b>{v.symbol}</b>
              {v.example && <em className="tag-example">EXAMPLE</em>}
              <time>{time(v.at)}</time>
            </div>
            <p>{v.reason}</p>
            <div className="v-meta">
              <span>risk {v.riskDecision}</span>
              <span>heat {Math.round(v.disagreement * 100)}%</span>
              <span>{v.executed ? 'paper filled' : 'no fill'}</span>
              {v.order && <span>{v.order.qty} @ {fmtPx(v.order.entry)} · SL {fmtPx(v.order.stop)}</span>}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

export function TradeLog({ state }: { state: DeskState }) {
  const ref = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<'all' | 'trades'>('all');
  const lines = state.logs.filter((l) => filter === 'all' || ['trade', 'verdict'].includes(l.kind));
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight }); }, [lines.length]);
  return (
    <section className="panel log">
      <div className="panel-head"><h2>Desk log</h2>
        <div className="seg"><button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>all</button><button className={filter === 'trades' ? 'on' : ''} onClick={() => setFilter('trades')}>trades</button></div>
      </div>
      <div className="log-body" ref={ref}>
        {lines.map((l, i) => (
          <div key={i} className={`line k-${l.kind}`}>
            <time>{time(l.at)}</time>
            {l.agent && <b style={{ color: state.agents[l.agent]?.color }}>{state.agents[l.agent]?.name}</b>}
            <span>{l.text}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function Roster({ state, onSelect }: { state: DeskState; onSelect: (id: AgentId) => void }) {
  return (
    <div className="roster">
      {AGENT_ORDER.map((id) => {
        const a = state.agents[id];
        return (
          <button key={id} className={`roster-item status-${a.status}`} style={{ ['--agent' as string]: a.color }} onClick={() => onSelect(id)}>
            <i className="dot" />
            <span>{a.name}</span>
            <small>{a.provider === 'mock' ? 'mock' : a.provider}</small>
          </button>
        );
      })}
    </div>
  );
}
