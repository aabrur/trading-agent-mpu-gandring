import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentId, DeskState, Verdict } from '../types';
import { AGENT_ORDER } from '../types';
import { PamorPattern } from './Keris';
import { Bot } from './Bot';
import { EquityChart, AllocationBars } from './MiniCharts';
import { fmt, fmtPx } from './format';
import { useI18n } from '../i18n';
import type { UpdateInfo } from './UpdateModal';
export { fmt, fmtPx };

const SHORT: Record<AgentId, string> = { lead: 'Lead', market: 'Market', research: 'Research', strategist: 'Strategist', risk: 'Risk', execution: 'Exec' };
const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
void PamorPattern;

export function TopBar({
  state,
  connected,
  theme,
  onTheme,
  onSetup,
  onVenueKeys,
  onTour,
  updateInfo,
  onOpenUpdate
}: {
  state: DeskState | null;
  connected: boolean;
  theme?: string;
  onTheme?: () => void;
  onSetup?: () => void;
  onVenueKeys?: () => void;
  onTour?: () => void;
  updateInfo?: UpdateInfo | null;
  onOpenUpdate?: () => void;
}) {
  const { lang, toggleLang, t } = useI18n();
  const ver = updateInfo?.currentVersion ?? '0.0.0.2.0';
  const hasUpdate = Boolean(updateInfo?.updateAvailable);

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark"><img src="/mpu-gandring-logo.webp" alt="Trading Agent Mpu Gandring logo" width={72} height={45} /></div>
        <div className="brand-copy">
          <div className="brand-title-row">
            <h1>Trading Agent <span>Mpu Gandring</span></h1>
            <p>{t('subtitle')}</p>
          </div>
          <div className="brand-meta">
            {state?.mode === 'LIVE'
              ? <span className="badge live-badge" title="Real orders on the exchange, full auto">LIVE · {state.venue?.label ?? state.live?.exchange}{state.live?.experimental ? ' experimental' : ''}</span>
              : state?.mode === 'TESTNET'
                ? <span className="badge testnet-badge" title="Exchange testnet, test funds">TESTNET · {state.venue?.label ?? state.live?.exchange}</span>
                : <span className="badge paper" title="Simulated trades only">{t('paperMode')}</span>}
            {state?.auto?.on && <span className="badge auto-badge" title="Agents trade on their own, no approval step">AUTO · {state.auto.intervalMin}m</span>}
            {state?.appMode === 'grokbot' && <span className="badge">Grok Bot team</span>}
            {state?.killed && <span className="badge warn">{t('killSwitchOn')}</span>}
            {state?.dailyLoss?.hit && <span className="badge warn">{t('dailyLossStop')}</span>}
            {state?.venue && <span className="badge venue-badge" title={`Venue: ${state.venue.label}, ${state.venue.kind}${state.venue.experimental ? ', experimental adapter' : ''}. Stops rest on the exchange.`}>{state.venue.kind} · {state.venue.label}{state.venue.experimental ? ' exp' : ''}</span>}
            {state && <span className="badge">{t('dataPrefix')} {state.marketSource}</span>}
            {onOpenUpdate && (
              <button
                className={`badge setup-btn version-btn ${hasUpdate ? 'update-avail-badge' : ''}`}
                onClick={onOpenUpdate}
                title={hasUpdate ? `${t('updateAvailable')}: v${updateInfo?.latestVersion}` : `v${ver} · ${t('upToDate')}`}
              >
                v{ver}{hasUpdate ? ` · ${t('updateAvailable')} ↑` : ''}
              </button>
            )}
            <button className="badge setup-btn lang-toggle-btn" onClick={toggleLang} aria-label="switch language">
              {lang === 'en' ? 'EN ▾ ID' : 'ID ▾ EN'}
            </button>
          </div>
        </div>
      </div>
      <div className="badges">
        {onVenueKeys && <button id="venue-keys-trigger" className="badge setup-btn connect-wallet-btn" onClick={onVenueKeys} title="Connect browser wallet for DEX venues">{t('connectWallet')}</button>}
        {onSetup && <button id="setup-trigger" className="badge setup-btn" onClick={onSetup} title="Setup wizard: venue, mode, keys, doctor">{t('setup')}</button>}
        {onTour && <button className="badge setup-btn tour-trigger-btn" onClick={onTour} title="Interactive UI guide">? {t('tutorial')}</button>}
        {state?.bridgeEnabled && <span className="badge">Grok Bot bridge on</span>}
        {state?.paused && <span className="badge warn">{t('paused')}</span>}
        <span className={`badge conn ${connected ? 'on' : 'off'}`}><i />{connected ? t('liveConn') : t('reconnecting')}</span>
        {onTheme && <button className="badge theme-toggle" onClick={onTheme} aria-label="toggle day or night">{theme === 'night' ? t('nightMode') : t('dayMode')}</button>}
      </div>
    </header>
  );
}

export function TickerStrip({ state }: { state: DeskState }) {
  const { t } = useI18n();
  const items = Object.values(state.tickers);
  if (!items.length) return <div className="ticker"><span className="muted">{t('waitingPrices')}</span></div>;
  const row = [...items, ...items, ...items];
  return (
    <div className="ticker" aria-label="prices">
      <div className="ticker-track">
        {row.map((tk, i) => (
          <span key={i} className="tick">
            <b>{tk.symbol}</b>
            <span>{fmtPx(tk.last)}</span>
            <em className={tk.change24hPct >= 0 ? 'up' : 'down'}>{tk.change24hPct >= 0 ? '▲' : '▼'} {fmt(Math.abs(tk.change24hPct))}%</em>
            <small>{tk.example ? 'sample · EXAMPLE' : tk.source}</small>
          </span>
        ))}
      </div>
    </div>
  );
}

export function FightMeter({ state, meter }: { state: DeskState; meter: { weighted: number; disagreement: number } | null }) {
  const { t } = useI18n();
  const d = state.debate;
  const dis = meter?.disagreement ?? d?.disagreement ?? 0;
  const w = meter?.weighted ?? d?.weighted ?? 0;
  const camps = d?.camps ?? { bull: [], bear: [], neutral: [] };
  const rawKey = dis >= state.fightThreshold ? (dis > 0.75 ? 'full-brawl' : 'fists-out') : dis > 0.25 ? 'heated' : d ? 'mostly-agree' : 'quiet';
  const label = rawKey === 'full-brawl' ? t('fullBrawl') : rawKey === 'fists-out' ? t('fistsOut') : rawKey === 'heated' ? t('heated') : rawKey === 'mostly-agree' ? t('mostlyAgree') : t('quiet');
  return (
    <section className="panel meter">
      <div className="panel-head"><h2>{t('fightMeter')}</h2><span className={`heat-label h-${rawKey}`}>{label}</span></div>
      <div className="meter-bar"><div className="meter-fill" style={{ width: `${Math.round(dis * 100)}%` }} /><div className="meter-threshold" style={{ left: `${state.fightThreshold * 100}%` }} title="punches start here" /></div>
      <div className="meter-scale"><span>{t('consensus')}</span><span>{Math.round(dis * 100)}{t('disagreementSuffix')}</span><span>{t('brawl')}</span></div>
      <div className="tug">
        <span className="bear-side">BEAR</span>
        <div className="rope"><i style={{ left: `${50 + w * 50}%` }} /></div>
        <span className="bull-side">BULL</span>
      </div>
      <div className="camps">
        <Camp label={t('bulls')} ids={camps.bull} state={state} cls="bull" noneLabel={t('none')} />
        <Camp label={t('bears')} ids={camps.bear} state={state} cls="bear" noneLabel={t('none')} />
        <Camp label={t('fence')} ids={camps.neutral} state={state} cls="neutral" noneLabel={t('none')} />
      </div>
    </section>
  );
}
function Camp({ label, ids, state, cls, noneLabel }: { label: string; ids: AgentId[]; state: DeskState; cls: string; noneLabel: string }) {
  return (
    <div className={`camp ${cls}`}>
      <small>{label}</small>
      <div>{ids.length ? ids.map((id) => <span key={id} className="chip" style={{ ['--agent' as string]: state.agents[id].color }}>{SHORT[id]}</span>) : <span className="muted">{noneLabel}</span>}</div>
    </div>
  );
}

interface VenueBalance {
  ok: boolean;
  venue: string;
  label: string;
  kind: 'CEX' | 'DEX';
  network: string;
  configured: boolean;
  address: string | null;
  equityUsdt: number | null;
  availableUsdt: number | null;
  depositUrl: string;
  note?: string;
  error?: string;
}

const ALL_VENUES = [
  { venue: 'bybit', label: 'Bybit · CEX' },
  { venue: 'binance', label: 'Binance · CEX' },
  { venue: 'okx', label: 'OKX · CEX' },
  { venue: 'hyperliquid', label: 'Hyperliquid · DEX' },
  { venue: 'aster', label: 'Aster · DEX' },
  { venue: 'dydx', label: 'dYdX v4 · DEX' },
  { venue: 'paradex', label: 'Paradex · DEX' },
  { venue: 'orderly', label: 'Orderly · DEX' }
];

export function Portfolio({ state, command }: { state: DeskState; command: (t: string) => void }) {
  const { t } = useI18n();
  const p = state.paper;
  const [safety, setSafety] = useState(String(p.safetyNet));
  const [balance, setBalance] = useState(String(p.balance));
  const [selectedVenue, setSelectedVenue] = useState<string>(state.venue?.name ?? state.live?.exchange ?? 'bybit');
  const [venueBal, setVenueBal] = useState<VenueBalance | null>(null);
  const [balBusy, setBalBusy] = useState(false);

  useEffect(() => setSafety(String(p.safetyNet)), [p.safetyNet]);
  useEffect(() => setBalance(String(p.balance)), [p.balance]);
  useEffect(() => {
    if (state.venue?.name) setSelectedVenue(state.venue.name);
  }, [state.venue?.name]);

  const fetchVenueBal = useCallback((vName: string) => {
    setBalBusy(true);
    const net = state.mode === 'LIVE' ? 'mainnet' : 'testnet';
    fetch(`/api/wallet/balance?venue=${encodeURIComponent(vName)}&network=${net}`)
      .then((r) => r.json())
      .then((d: VenueBalance) => setVenueBal(d))
      .catch(() => {})
      .finally(() => setBalBusy(false));
  }, [state.mode]);

  useEffect(() => {
    fetchVenueBal(selectedVenue);
  }, [selectedVenue, fetchVenueBal]);

  const bookTitle = state.mode === 'PAPER' ? t('paperBook') : state.mode === 'LIVE' ? t('liveBook') : t('testnetBook');

  return (
    <section className="panel portfolio">
      <div className="panel-head"><h2>{bookTitle}</h2><span className={`pnl ${p.unrealized >= 0 ? 'up' : 'down'}`}>uPnL {p.unrealized >= 0 ? '+' : ''}{fmt(p.unrealized)}</span></div>
      <div className="stats">
        <label className="stat"><small>{t('totalBalance')}</small>
          <span className="inline-edit"><input value={balance} onChange={(e) => setBalance(e.target.value)} onBlur={() => balance !== String(p.balance) && command(`set balance ${balance}`)} inputMode="decimal" aria-label="paper balance" /> USDT</span>
        </label>
        <label className="stat"><small>{t('safetyNet')}</small>
          <span className="inline-edit"><input value={safety} onChange={(e) => setSafety(e.target.value)} onBlur={() => safety !== String(p.safetyNet) && command(`set safety ${safety}`)} inputMode="decimal" aria-label="safety net" /> USDT</span>
        </label>
        <div className="stat hi"><small>{t('moneyTrade')}</small><b>{fmt(p.moneyTrade)}</b></div>
        <div className="stat"><small>{t('perOrder')}</small><b>{fmt(p.perOrder)}</b></div>
      </div>

      <div className="venue-balance-box">
        <div className="venue-balance-head">
          <select
            className="venue-balance-select"
            aria-label="select venue balance"
            value={selectedVenue}
            onChange={(e) => setSelectedVenue(e.target.value)}
          >
            {ALL_VENUES.map((v) => <option key={v.venue} value={v.venue}>{v.label}</option>)}
          </select>
          <button className="mini" disabled={balBusy} onClick={() => fetchVenueBal(selectedVenue)}>
            {balBusy ? '...' : t('refreshBalance')}
          </button>
          {venueBal?.depositUrl && (
            <a className="badge deposit-link-btn" href={venueBal.depositUrl} target="_blank" rel="noreferrer">
              {t('depositOfficial')} ↗
            </a>
          )}
        </div>
        {venueBal && venueBal.equityUsdt !== null ? (
          <div className="venue-balance-stats">
            <span>{t('equityUsdt')}: <b>{fmt(venueBal.equityUsdt)} USDT</b></span>
            <span>{t('availableUsdt')}: <b>{fmt(venueBal.availableUsdt ?? 0)} USDT</b></span>
          </div>
        ) : (
          <p className="wallet-note small">{venueBal?.error ? venueBal.error : t('notConnectedBalance')}</p>
        )}
      </div>

      <div className="n-picker">
        <small>{t('openOrdersN')}</small>
        {[1, 2, 3, 4].map((n) => <button key={n} className={p.n === n ? 'on' : ''} onClick={() => command(`set n ${n}`)}>{n}</button>)}
        <span className="slots">{p.positions.length}/{p.n} {t('usedSuffix')}</span>
      </div>
      <div className="mini-charts"><AllocationBars state={state} /><EquityChart state={state} /></div>
      <p className="formula">{t('moneyTrade')} = {fmt(p.balance)} - {fmt(p.safetyNet)} = <b>{fmt(p.moneyTrade)}</b> · / {p.n} = <b>{fmt(p.perOrder)}</b> {t('perOrder').toLowerCase()}{!p.canOpen && <em> · {t('atSafetyNet')}</em>}</p>
      <div className="positions">
        {p.positions.length === 0 && <p className="muted">{t('noOpenPositions')}</p>}
        {p.positions.map((x) => (
          <div key={x.id} className={`pos ${x.side}`}>
            <b>{x.side} {x.symbol}</b>
            <span>{x.qty} @ {fmtPx(x.entry)}</span>
            <span className="sl">SL {fmtPx(x.stop)}{x.tp ? <em className="tp"> TP {fmtPx(x.tp)}</em> : null}</span>
            <span>{x.leverage}x · {fmt(x.margin)}</span>
            <span className={x.unrealizedPnl >= 0 ? 'up' : 'down'}>{x.unrealizedPnl >= 0 ? '+' : ''}{fmt(x.unrealizedPnl)}</span>
            <button className="mini" onClick={() => command(`close ${x.symbol}`)}>{t('closeBtn')}</button>
          </div>
        ))}
      </div>
      <div className="foot"><span>{t('equityLabel')} {fmt(p.equity)}</span><span>{t('usedMarginLabel')} {fmt(p.usedMargin)}</span><span>{t('closedLabel')} {p.closed.length}</span></div>
    </section>
  );
}

const ACTION_LABEL: Record<Verdict['action'], string> = { OPEN_LONG: 'OPEN LONG', OPEN_SHORT: 'OPEN SHORT', CLOSE: 'CLOSE', HOLD: 'HOLD' };
export function Verdicts({ state }: { state: DeskState }) {
  const { t } = useI18n();
  return (
    <section className="panel verdicts">
      <div className="panel-head"><h2>{t('verdictsTitle')}</h2><small className="muted">{t('verdictsSub')}</small></div>
      {state.verdicts.length === 0 && <p className="muted">{t('noVerdictYet')}</p>}
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
              <span>{v.executed ? t('paperFilled') : t('noFill')}</span>
              {v.order && <span>{v.order.qty} @ {fmtPx(v.order.entry)} · SL {fmtPx(v.order.stop)}{v.order.tp ? ` · TP ${fmtPx(v.order.tp)}` : ''}</span>}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

export function TradeLog({ state }: { state: DeskState }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<'all' | 'trades'>('all');
  const lines = state.logs.filter((l) => filter === 'all' || ['trade', 'verdict'].includes(l.kind));
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight }); }, [lines.length]);
  return (
    <section className="panel log">
      <div className="panel-head"><h2>{t('deskLog')}</h2>
        <div className="seg"><button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>{t('allFilter')}</button><button className={filter === 'trades' ? 'on' : ''} onClick={() => setFilter('trades')}>{t('tradesFilter')}</button></div>
      </div>
      <div className="log-body" ref={ref}>
        {!lines.length && <p className="muted">{filter === 'trades' ? t('noTradesYet') : t('noDeskActivity')}</p>}
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
  const { t } = useI18n();
  return (
    <div className="roster">
      {AGENT_ORDER.map((id) => {
        const a = state.agents[id];
        return (
          <button key={id} className={`roster-item status-${a.status}`} style={{ ['--agent' as string]: a.color }} onClick={() => onSelect(id)}>
            <Bot id={id} size={26} pose="idle" />
            <span>{a.name}</span>
            <small>{a.provider === 'mock' ? 'mock' : a.provider}</small>
          </button>
        );
      })}
      <span className="roster-hint">{t('rosterHint')}</span>
    </div>
  );
}
