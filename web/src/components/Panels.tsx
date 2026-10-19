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

interface CurrencyOption {
  code: string;
  symbol: string;
  rate: number;
  decimals: number;
  label: string;
}

const CURRENCIES: CurrencyOption[] = [
  { code: 'USDT', symbol: 'USDT', rate: 1, decimals: 2, label: 'USDT ($)' },
  { code: 'IDR', symbol: 'Rp', rate: 16250, decimals: 0, label: 'IDR (Rp)' },
  { code: 'USD', symbol: '$', rate: 1, decimals: 2, label: 'USD ($)' },
  { code: 'EUR', symbol: '€', rate: 0.92, decimals: 2, label: 'EUR (€)' },
  { code: 'GBP', symbol: '£', rate: 0.79, decimals: 2, label: 'GBP (£)' },
  { code: 'SGD', symbol: 'S$', rate: 1.34, decimals: 2, label: 'SGD (S$)' },
  { code: 'MYR', symbol: 'RM', rate: 4.42, decimals: 2, label: 'MYR (RM)' },
  { code: 'JPY', symbol: '¥', rate: 154, decimals: 0, label: 'JPY (¥)' },
  { code: 'KRW', symbol: '₩', rate: 1380, decimals: 0, label: 'KRW (₩)' },
  { code: 'CNY', symbol: '¥', rate: 7.24, decimals: 2, label: 'CNY (¥)' },
  { code: 'INR', symbol: '₹', rate: 84.1, decimals: 2, label: 'INR (₹)' },
  { code: 'AUD', symbol: 'A$', rate: 1.52, decimals: 2, label: 'AUD (A$)' }
];

function formatCurrencyValue(usdtAmount: number, cur: CurrencyOption): string {
  const converted = usdtAmount * cur.rate;
  const formatted = new Intl.NumberFormat(cur.code === 'IDR' ? 'id-ID' : 'en-US', {
    minimumFractionDigits: cur.decimals,
    maximumFractionDigits: cur.decimals
  }).format(converted);
  return cur.code === 'USDT' ? `${formatted} USDT` : `${cur.symbol} ${formatted}`;
}

export function TopBar({
  state,
  connected,
  theme,
  onTheme,
  onSetup,
  onVenueKeys,
  onTour,
  updateInfo,
  onOpenUpdate,
  onOpenTrakteer
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
  onOpenTrakteer?: () => void;
}) {
  const { lang, toggleLang, t } = useI18n();
  const ver = updateInfo?.currentVersion ?? '0.0.0.2.3';
  const hasUpdate = Boolean(updateInfo?.updateAvailable);
  void onOpenTrakteer;

  const [currencyCode, setCurrencyCode] = useState<string>(() => {
    try {
      return localStorage.getItem('mg-currency') || 'USDT';
    } catch {
      return 'USDT';
    }
  });
  const [liveBal, setLiveBal] = useState<{ equityUsdt: number | null; venueLabel: string | null; configured: boolean; observedAt: number } | null>(null);

  const handleCurrencyChange = (code: string) => {
    setCurrencyCode(code);
    try { localStorage.setItem('mg-currency', code); } catch { /* ignore */ }
    window.dispatchEvent(new Event('mg-currency-updated'));
  };

  useEffect(() => {
    const syncCur = () => {
      try { setCurrencyCode(localStorage.getItem('mg-currency') || 'USDT'); } catch { /* ignore */ }
    };
    window.addEventListener('mg-currency-updated', syncCur);
    return () => window.removeEventListener('mg-currency-updated', syncCur);
  }, []);

  const activeVenue = state?.venue?.name ?? state?.live?.exchange ?? '';
  const activeMode = state?.mode ?? 'PAPER';

  useEffect(() => {
    let alive = true;
    const load = () => {
      let savedVenue = '';
      let savedNet = '';
      let savedAddr = '';
      try {
        savedVenue = localStorage.getItem('mg-wallet-venue') || '';
        savedNet = localStorage.getItem('mg-wallet-network') || '';
        savedAddr = localStorage.getItem('mg-wallet-address') || '';
      } catch { /* ignore */ }
      const targetVenue = savedVenue || activeVenue || 'bybit';
      const net = savedNet === 'mainnet' || savedNet === 'testnet' ? savedNet : (activeMode === 'LIVE' ? 'mainnet' : 'testnet');
      const qs = new URLSearchParams({ venue: targetVenue, network: net });
      if (savedAddr) qs.set('address', savedAddr);
      fetch(`/api/wallet/balance?${qs.toString()}`)
        .then((r) => r.json())
        .then((d: VenueBalance) => {
          if (!alive) return;
          if (d && typeof d.equityUsdt === 'number' && Number.isFinite(d.equityUsdt)) {
            setLiveBal({ equityUsdt: d.equityUsdt ?? 0, venueLabel: d.label || targetVenue.toUpperCase(), configured: Boolean(d.configured), observedAt: Date.now() });
          } else {
            setLiveBal(null);
          }
        })
        .catch(() => { if (alive) setLiveBal(null); });
    };
    load();
    const timer = window.setInterval(load, 20_000);
    window.addEventListener('mg-wallet-updated', load);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener('mg-wallet-updated', load);
    };
  }, [activeVenue, activeMode]);

  const curOpt = CURRENCIES.find((c) => c.code === currencyCode) ?? CURRENCIES[0];
  const account = state?.mode !== 'PAPER' ? state?.venueAccount : null;
  const hasVenueLiveBal = state?.mode !== 'PAPER' && (account != null || liveBal?.equityUsdt != null);
  const rawUsdt = state?.mode === 'PAPER' ? (state.paper.equity ?? 0) : account?.equity ?? liveBal?.equityUsdt ?? state?.paper?.equity ?? 0;



  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark"><img src="/mpu-gandring-logo.webp" alt="Trading Agent Mpu Gandring logo" width={72} height={45} /></div>
        <div className="brand-copy">
          <div className="brand-title-row">
            <h1>
              Trading Agent <span>Mpu Gandring</span>
              {hasUpdate && onOpenUpdate && (
                <button
                  className="badge setup-btn version-btn update-avail-badge new-update-badge"
                  onClick={onOpenUpdate}
                  title={`${t('updateAvailable')}: v${updateInfo?.latestVersion}`}
                >
                  <i className="update-notif-dot" aria-hidden="true" />
                  New Update
                </button>
              )}
            </h1>
            <p>{t('subtitle')}</p>
          </div>
          <div className="brand-meta">
            {state?.mode === 'LIVE'
              ? <span className="badge live-badge" title="Real orders on the exchange, full auto">LIVE · {state.venue?.label ?? state.live?.exchange}</span>
              : state?.mode === 'TESTNET'
                ? <span className="badge testnet-badge" title="Exchange testnet, test funds">TESTNET · {state.venue?.label ?? state.live?.exchange}</span>
                : <span className="badge paper" title="Simulated trades only">{t('paperMode')}</span>}
            {state?.auto?.on && <span className="badge auto-badge" title="Agents trade on their own, no approval step">AUTO · {state.auto.intervalMin}m</span>}
            {state?.appMode === 'grokbot' && <span className="badge">Grok Bot team</span>}
            {state?.killed && <span className="badge warn">{t('killSwitchOn')}</span>}
            {state?.dailyLoss?.hit && <span className="badge warn">{t('dailyLossStop')}</span>}
            {state?.venue && state.mode !== 'LIVE' && state.mode !== 'TESTNET' && (
              <span className="badge venue-badge" title={`Venue: ${state.venue.label}, ${state.venue.kind}. Stops rest on the exchange.`}>{state.venue.kind} · {state.venue.label}</span>
            )}
            {state && <span className="badge">{t('dataPrefix')} {state.marketSource}</span>}
          </div>
        </div>
      </div>
      <div className="topbar-center">
        {state && (
          <div className={`topbar-balance-pill ${hasVenueLiveBal ? 'is-live-bal' : 'is-paper-bal'}`} title={`${t('topBalanceLabel')}: ${fmt(rawUsdt)} USDT${!hasVenueLiveBal && state.mode !== 'PAPER' ? ' (local book estimate)' : ''}${curOpt.code !== 'USDT' ? ' / static FX estimate' : ''}`}>
            <strong className="tb-bal-val">{formatCurrencyValue(rawUsdt, curOpt)}</strong>
            <select
              className="tb-cur-select"
              aria-label={t('topCurrencyLabel')}
              value={currencyCode}
              onChange={(e) => handleCurrencyChange(e.target.value)}
            >
              {CURRENCIES.map((c) => (
                <option key={c.code} value={c.code}>{c.label}</option>
              ))}
            </select>
          </div>
        )}
      </div>
      <div className="badges">
        <a
          href="https://trakteer.id/aabrur/tip"
          target="_blank"
          rel="noopener noreferrer"
          title={t('trakteerBtn')}
          className="trakteer-btn"
        >
          <img
            src="https://edge-cdn.trakteer.id/images/embed/trbtn-icon.png?v=14-05-2025"
            alt="Trakteer"
            className="trbtn-mini-img"
          />
          <span>{t('trakteerBtn')}</span>
        </a>
        {onVenueKeys && <button id="venue-keys-trigger" className="badge setup-btn connect-wallet-btn" onClick={onVenueKeys} title="Connect browser wallet for DEX venues">{t('connectWallet')}</button>}
        {onSetup && <button id="setup-trigger" className="badge setup-btn" onClick={onSetup} title="Setup wizard: venue, mode, keys, doctor">{t('setup')}</button>}
        {onTour && <button className="badge setup-btn tour-trigger-btn" onClick={onTour} title="Interactive UI guide">? {t('tutorial')}</button>}
        {state?.bridgeEnabled && <span className="badge">Grok Bot bridge on</span>}
        {state?.paused && <span className="badge warn">{t('paused')}</span>}
        {!connected && <span className="badge warn" role="status">{t('reconnecting')}</span>}
        <button className="badge setup-btn lang-toggle-btn" onClick={toggleLang} aria-label="switch language" title="Switch language">
          {lang === 'en' ? 'EN ▾ ID' : 'ID ▾ EN'}
        </button>
        {onTheme && <button className="badge theme-toggle" onClick={onTheme} aria-label="toggle day or night">{theme === 'night' ? t('nightMode') : t('dayMode')}</button>}
      </div>
    </header>
  );
}

export function TrakteerPopup({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const embedUrl = `https://trakteer.id/v1/aabrur/tip/embed/modal?embedId=0&ref=${encodeURIComponent(window.location.href)}`;

  useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      if (ev.data && typeof ev.data === 'object' && ev.data.type === 'embed.modalClosed') {
        onClose();
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [onClose]);

  return (
    <div
      className="setup-overlay trakteer-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t('trakteerTitle')}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="panel trakteer-popup-card">
        <div className="panel-head trakteer-head">
          <h2>{t('trakteerTitle')}</h2>
          <button className="trakteer-close-x" onClick={onClose} aria-label={t('closeModal')} title={t('closeModal')}>✕</button>
        </div>
        <div className="trakteer-iframe-wrap">
          <iframe
            src={embedUrl}
            title="Dukung Saya di Trakteer"
            className="trakteer-iframe"
            onLoad={(e) => {
              try {
                e.currentTarget.contentWindow?.postMessage({ type: 'embed.openModal' }, '*');
              } catch { /* ignore */ }
            }}
          />
        </div>
        <div className="trakteer-popup-actions">
          <button className="badge setup-btn trakteer-later-btn" onClick={onClose}>{t('trakteerDismiss')}</button>
        </div>
      </div>
    </div>
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

export function FightMeter({ state, meter, fighting = false }: { state: DeskState; meter: { weighted: number; disagreement: number } | null; fighting?: boolean }) {
  const { t } = useI18n();
  const d = state.debate;
  const dis = meter?.disagreement ?? d?.disagreement ?? 0;
  const w = meter?.weighted ?? d?.weighted ?? 0;
  const camps = d?.camps ?? { bull: [], bear: [], neutral: [] };
  const opposing = camps.bull.length > 0 && camps.bear.length > 0;
  const rawKey = fighting ? 'full-brawl' : !d ? 'quiet' : dis >= state.fightThreshold && opposing ? 'fists-out' : dis > 0.25 ? 'heated' : 'mostly-agree';
  const label = rawKey === 'full-brawl' ? t('fullBrawl') : rawKey === 'fists-out' ? 'Heated opposing views' : rawKey === 'heated' ? (opposing ? 'Opposing views' : 'General tension') : rawKey === 'mostly-agree' ? t('mostlyAgree') : t('quiet');
  return (
    <section className="panel meter">
      <div className="panel-head"><h2>{t('fightMeter')}</h2><span className={`heat-label h-${rawKey}`}>{label}</span></div>
      <div className="meter-bar">
        <div className="meter-fill" style={{ width: `${Math.max(3, Math.round(dis * 100))}%` }} />
        <div className="meter-pin" style={{ left: `${Math.round(dis * 100)}%` }} title={`${Math.round(dis * 100)}% disagreement`} />
        <div className="meter-threshold" style={{ left: `${state.fightThreshold * 100}%` }} title="Configured debate escalation threshold" />
      </div>
      <div className="meter-scale"><span>{t('consensus')}</span><span className="meter-reading-full">{Math.round(dis * 100)}{t('disagreementSuffix')}</span><span className="meter-reading-short" aria-hidden="true">{Math.round(dis * 100)}%</span><span>{t('brawl')}</span></div>
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

const ALL_VENUES: { venue: string; label: string; depositUrl: string }[] = [
  { venue: 'bybit', label: 'Bybit · CEX', depositUrl: 'https://www.bybit.com/user/assets/deposit' },
  { venue: 'binance', label: 'Binance · CEX', depositUrl: 'https://www.binance.com/en/my/wallet/account/main/deposit/crypto' },
  { venue: 'okx', label: 'OKX · CEX', depositUrl: 'https://www.okx.com/balance/recharge' },
  { venue: 'hyperliquid', label: 'Hyperliquid · DEX', depositUrl: 'https://app.hyperliquid.xyz/portfolio' },
  { venue: 'aster', label: 'Aster · DEX', depositUrl: 'https://app.asterdex.com/deposit' },
  { venue: 'dydx', label: 'dYdX v4 · DEX', depositUrl: 'https://dydx.exchange/portfolio' },
  { venue: 'paradex', label: 'Paradex · DEX', depositUrl: 'https://app.paradex.trade/portfolio' },
  { venue: 'orderly', label: 'Orderly · DEX', depositUrl: 'https://app.orderly.network/deposit' }
];

export function Portfolio({ state, command }: { state: DeskState; command: (t: string) => void }) {
  const { t } = useI18n();
  const p = state.paper;
  const [safety, setSafety] = useState(String(p.safetyNet));
  const [balance, setBalance] = useState(String(p.balance));
  const [selectedVenue, setSelectedVenue] = useState<string>(() => {
    try {
      return localStorage.getItem('mg-wallet-venue') || state.venue?.name || state.live?.exchange || 'bybit';
    } catch {
      return state.venue?.name ?? state.live?.exchange ?? 'bybit';
    }
  });
  const [venueBal, setVenueBal] = useState<VenueBalance | null>(null);
  const [balBusy, setBalBusy] = useState(false);
  const [currencyCode, setCurrencyCode] = useState<string>(() => {
    try { return localStorage.getItem('mg-currency') || 'USDT'; } catch { return 'USDT'; }
  });

  useEffect(() => {
    const syncCur = () => {
      try { setCurrencyCode(localStorage.getItem('mg-currency') || 'USDT'); } catch { /* ignore */ }
    };
    window.addEventListener('mg-currency-updated', syncCur);
    return () => window.removeEventListener('mg-currency-updated', syncCur);
  }, []);

  useEffect(() => setSafety(String(p.safetyNet)), [p.safetyNet]);
  useEffect(() => setBalance(String(p.balance)), [p.balance]);
  useEffect(() => {
    if (state.venue?.name) setSelectedVenue(state.venue.name);
  }, [state.venue?.name]);

  const fetchVenueBal = useCallback((vName: string) => {
    setBalBusy(true);
    let savedNet = '';
    let savedAddr = '';
    try {
      savedNet = localStorage.getItem('mg-wallet-network') || '';
      savedAddr = localStorage.getItem('mg-wallet-address') || '';
    } catch { /* ignore */ }
    const net = savedNet === 'mainnet' || savedNet === 'testnet' ? savedNet : (state.mode === 'LIVE' ? 'mainnet' : 'testnet');
    const qs = new URLSearchParams({ venue: vName, network: net });
    if (savedAddr) qs.set('address', savedAddr);
    fetch(`/api/wallet/balance?${qs.toString()}`)
      .then((r) => r.json())
      .then((d: VenueBalance) => setVenueBal(d))
      .catch(() => {})
      .finally(() => setBalBusy(false));
  }, [state.mode]);

  useEffect(() => {
    fetchVenueBal(selectedVenue);
    const onWalletUpdate = () => {
      let v = selectedVenue;
      try {
        const savedV = localStorage.getItem('mg-wallet-venue');
        if (savedV) { v = savedV; setSelectedVenue(savedV); }
      } catch { /* ignore */ }
      fetchVenueBal(v);
    };
    window.addEventListener('mg-wallet-updated', onWalletUpdate);
    return () => window.removeEventListener('mg-wallet-updated', onWalletUpdate);
  }, [selectedVenue, fetchVenueBal]);

  const curOpt = CURRENCIES.find((c) => c.code === currencyCode) ?? CURRENCIES[0];
  const bookTitle = state.mode === 'PAPER' ? t('paperBook') : state.mode === 'LIVE' ? t('liveBook') : t('testnetBook');
  const currentVenue = ALL_VENUES.find((v) => v.venue === selectedVenue) ?? ALL_VENUES[0];
  const activeDepositUrl = venueBal?.depositUrl || currentVenue.depositUrl;
  const isVenueConnected = Boolean(venueBal && venueBal.equityUsdt != null && Number.isFinite(venueBal.equityUsdt));

  return (
    <section className="panel portfolio">
      <div className="panel-head"><h2>{bookTitle}</h2><span className={`pnl ${p.unrealized >= 0 ? 'up' : 'down'}`}>uPnL {p.unrealized >= 0 ? '+' : ''}{fmt(p.unrealized)}</span></div>
      <p className="account-note">{state.mode === 'PAPER' ? 'Paper book' : state.venueAccount ? `Exchange account ${state.venueAccount.status} / ${time(state.venueAccount.at)} / available ${fmt(state.venueAccount.available)} USDT` : 'Local book; venue balance unverified'}{curOpt.code !== 'USDT' ? '. Currency conversions use static estimates.' : ''}</p>
      {!!state.venueAccount?.pendingSymbols?.length && <p className="account-note" role="status">Fill reconciliation pending. Last venue observation: {state.venueAccount.positions?.map((p) => `${p.symbol} ${p.side} ${p.qty}`).join(', ') || 'flat'}. Local quantities are awaiting venue confirmation.</p>}
      <div className="stats">
        <label className="stat"><small>{t('totalBalance')}</small>
          <span className="inline-edit"><input value={balance} onChange={(e) => setBalance(e.target.value)} onBlur={() => balance !== String(p.balance) && command(`set balance ${balance}`)} inputMode="decimal" aria-label="paper balance" /> USDT</span>
          {curOpt.code !== 'USDT' && <small className="stat-fiat">{formatCurrencyValue(p.balance, curOpt)}</small>}
        </label>
        <label className="stat"><small>{t('safetyNet')}</small>
          <span className="inline-edit"><input value={safety} onChange={(e) => setSafety(e.target.value)} onBlur={() => safety !== String(p.safetyNet) && command(`set safety ${safety}`)} inputMode="decimal" aria-label="safety net" /> USDT</span>
          {curOpt.code !== 'USDT' && <small className="stat-fiat">{formatCurrencyValue(p.safetyNet, curOpt)}</small>}
        </label>
        <div className="stat hi"><small>{t('moneyTrade')}</small><b>{fmt(p.moneyTrade)}</b>{curOpt.code !== 'USDT' && <small className="stat-fiat">{formatCurrencyValue(p.moneyTrade, curOpt)}</small>}</div>
        <div className="stat"><small>{t('perOrder')}</small><b>{fmt(p.perOrder)}</b>{curOpt.code !== 'USDT' && <small className="stat-fiat">{formatCurrencyValue(p.perOrder, curOpt)}</small>}</div>
      </div>

      <div className="venue-balance-box">
        <div className="venue-balance-controls">
          <select
            className="venue-balance-select"
            aria-label="select venue balance"
            value={selectedVenue}
            onChange={(e) => {
              const v = e.target.value;
              setSelectedVenue(v);
              try { localStorage.setItem('mg-wallet-venue', v); } catch { /* ignore */ }
              window.dispatchEvent(new Event('mg-wallet-updated'));
            }}
          >
            {ALL_VENUES.map((v) => <option key={v.venue} value={v.venue}>{v.label}</option>)}
          </select>
          <button
            className={`mini venue-refresh-btn ${balBusy ? 'busy' : ''}`}
            disabled={balBusy}
            onClick={() => fetchVenueBal(selectedVenue)}
            title={t('refreshBalance')}
          >
            {t('refreshBalance')}
          </button>
        </div>
        <div className="venue-balance-deposit-row">
          <a className="badge deposit-link-btn" href={activeDepositUrl} target="_blank" rel="noreferrer">
            {t('depositOfficial')} ↗
          </a>
          {isVenueConnected && venueBal && (
            <span className="badge venue-conn-pill">
              ● {venueBal.network.toUpperCase()} {venueBal.address ? `${venueBal.address.slice(0, 6)}...${venueBal.address.slice(-4)}` : 'Connected'}
            </span>
          )}
        </div>
        <div className="venue-balance-status-row">
          {isVenueConnected && venueBal ? (
            <div className="venue-balance-stats">
              <span>{t('equityUsdt')}: <b>{fmt(venueBal.equityUsdt ?? 0)} USDT</b>{curOpt.code !== 'USDT' ? ` (${formatCurrencyValue(venueBal.equityUsdt ?? 0, curOpt)})` : ''}</span>
              <span>{t('availableUsdt')}: <b>{venueBal.availableUsdt == null ? 'unavailable' : fmt(venueBal.availableUsdt)} USDT</b></span>
              {(venueBal.equityUsdt ?? 0) > 0 && Math.abs((venueBal.equityUsdt ?? 0) - p.balance) > 0.01 && (
                <button type="button" className="mini" onClick={() => command(`set balance ${venueBal.equityUsdt}`)}>
                  Sync to book
                </button>
              )}
            </div>
          ) : (
            <p className="wallet-note small">{venueBal?.error || venueBal?.note || t('notConnectedBalance')}</p>
          )}
        </div>
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
            <b>{x.side} {x.symbol}{x.ownership === 'external' ? <small> external / ownership unknown</small> : x.ownership === 'recovered' ? <small> recovered</small> : null}</b>
            <span>{x.qty} @ {fmtPx(x.entry)}</span>
            <span className="sl">SL {x.stop > 0 ? fmtPx(x.stop) : 'unavailable'}{x.protectionStatus ? ` (${x.protectionStatus})` : ''}{x.tp ? <em className="tp"> TP {fmtPx(x.tp)}</em> : null}</span>
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
              <span>{v.executed ? `${state.mode === 'PAPER' ? 'Paper' : state.mode} ${v.executionStatus ?? v.order?.status ?? 'execution recorded'}` : t('noFill')}</span>
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
            <Bot id={id} size={20} pose="idle" />
            <span>{a.name}</span>
            <small>{a.provider === 'mock' ? 'mock' : a.provider}</small>
          </button>
        );
      })}
      <span className="roster-hint">{t('rosterHint')}</span>
    </div>
  );
}
