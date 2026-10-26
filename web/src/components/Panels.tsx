import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { AgentId, DeskState, Verdict } from '../types';
import { AGENT_ORDER } from '../types';
import { PamorPattern } from './Keris';
import { Bot } from './Bot';
import { EquityChart, AllocationBars } from './MiniCharts';
import { fmt, fmtPx } from './format';
import { useI18n } from '../i18n';
import type { UpdateInfo } from './UpdateModal';
import { WalletMenu } from './WalletMenu';
import { activityEntries, activityForView, activityParticipants, filterActivity, type ActivityFilter, type ActivityView } from '../activityLog';
import { SessionLogs } from './SessionLogs';
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

function cleanVer(v: string): number[] {
  return v.replace(/^v/i, '').trim().split('.').map((x) => Number.parseInt(x, 10) || 0);
}

function compareVer(a: string, b: string): number {
  const pa = cleanVer(a);
  const pb = cleanVer(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

export function TopBar({
  state,
  connected,
  theme,
  onTheme,
  onSetup,
  onVenueKeys,
  walletOpen = false,
  onCloseWallet,
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
  walletOpen?: boolean;
  onCloseWallet?: () => void;
  onTour?: () => void;
  updateInfo?: UpdateInfo | null;
  onOpenUpdate?: () => void;
  onOpenTrakteer?: () => void;
}) {
  const { lang, toggleLang, t } = useI18n();
  const [restarting, setRestarting] = useState(false);
  const [restartReply, setRestartReply] = useState<string | null>(null);
  useEffect(() => {
    if (!restartReply) return;
    const timer = window.setTimeout(() => setRestartReply(null), 6000);
    return () => window.clearTimeout(timer);
  }, [restartReply]);
  const restart = async () => {
    setRestarting(true);
    setRestartReply(null);
    try {
      const response = await fetch('/api/setup/restart', { method: 'POST' });
      const result = await response.json();
      setRestartReply(response.ok && result.ok ? (result.detail || t('cbRestartSuccess')) : (result.detail || (lang === 'id' ? 'Restart gagal.' : 'Restart failed.')));
    } catch {
      setRestartReply(lang === 'id' ? 'Restart gagal. Periksa koneksi ke server.' : 'Restart failed. Check the server connection.');
    } finally { setRestarting(false); }
  };
  const runningVer = state?.version;
  const latestVer = updateInfo?.latestVersion;
  const diskVer = updateInfo?.currentVersion;
  const hasUpdate = Boolean(
    updateInfo?.updateAvailable ||
    (runningVer && latestVer && compareVer(latestVer, runningVer) > 0) ||
    (runningVer && diskVer && compareVer(diskVer, runningVer) > 0)
  );
  const targetVer = (latestVer && runningVer && compareVer(latestVer, runningVer) > 0)
    ? latestVer
    : (diskVer && runningVer && compareVer(diskVer, runningVer) > 0)
      ? diskVer
      : (latestVer ?? diskVer ?? '0.0.0.4.1');
  const ver = diskVer ?? '0.0.0.4.1';

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
      const targetVenue = activeVenue || savedVenue || 'bybit';
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
              {onOpenUpdate && hasUpdate && (
                <button
                  className="badge setup-btn version-btn update-avail-badge new-update-badge"
                  onClick={onOpenUpdate}
                  title={`${t('updateAvailable')}: v${targetVer}`}
                >
                  <i className="update-notif-dot" aria-hidden="true" />
                  {t('newUpdateBadge')} v{targetVer}
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
            {state?.version && (
              <button
                type="button"
                className={`badge version-badge setup-btn ${hasUpdate ? 'warn' : ''}`}
                onClick={onOpenUpdate}
                title={'Trading Agent Mpu Gandring v' + state.version + (hasUpdate ? ` (v${targetVer} ready)` : '')}
                style={{ cursor: onOpenUpdate ? 'pointer' : 'default' }}
              >
                v{state.version}
                {hasUpdate && <span className="update-notif-dot" style={{ marginLeft: 6, display: 'inline-block' }} aria-hidden="true" />}
              </button>
            )}
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
        <button
          type="button"
          onClick={() => onOpenTrakteer?.()}
          title={t('trakteerBtn')}
          aria-label={t('trakteerBtn')}
          className="trakteer-btn"
        >
          <img
            src="https://edge-cdn.trakteer.id/images/embed/trbtn-icon.png?v=14-05-2025"
            alt="Cendol"
            className="trbtn-mini-img"
          />
          <span>Cendol</span>
        </button>
        {state && onVenueKeys && <WalletMenu state={state} open={walletOpen} onOpen={onVenueKeys} onClose={onCloseWallet ?? (() => {})} />}
        {(onSetup || onTour) && <details className="settings-menu">
          <summary id="setup-trigger" className="badge setup-btn" aria-label={lang === 'id' ? 'Menu Setup' : 'Setup menu'}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m9 3-1 3-3 1-2 3 2 2-1 3 3 2 1 3h4l1-3 3-1 3-3-2-2 1-3-3-2-1-3Z"/><circle cx="11" cy="12" r="3"/></svg>
            {t('setup')}
          </summary>
          <div className="settings-popover">
            {onSetup && <button onClick={(e) => { e.currentTarget.closest('details')?.removeAttribute('open'); onSetup(); }}>{t('setup')}</button>}
            <button type="button" className="lang-toggle-btn" onClick={toggleLang} aria-label="switch language" title="Switch language">{lang === 'en' ? 'EN ▾ ID' : 'ID ▾ EN'}</button>
            {onTour && <button className="tour-trigger-btn" onClick={(e) => { e.currentTarget.closest('details')?.removeAttribute('open'); onTour(); }}>{t('tutorial')}</button>}
          </div>
        </details>}
        {state?.bridgeEnabled && <span className="badge">Grok Bot bridge on</span>}
        {state?.paused && <span className="badge warn">{t('paused')}</span>}
        {!connected && <span className="badge warn" role="status">{t('reconnecting')}</span>}
        <button id="header-restart" type="button" className="badge setup-btn" onClick={() => void restart()} disabled={restarting} aria-busy={restarting} title={t('cbRestartTitle')}>
          ↻ {restarting ? (lang === 'id' ? 'Memulai…' : 'Restarting…') : 'Restart'}
        </button>
        {restartReply && <output className="topbar-restart-feedback" role="status">{restartReply}</output>}
        {onTheme && <button className="badge theme-toggle" onClick={onTheme} aria-label="toggle day or night">{theme === 'night' ? t('nightMode') : t('dayMode')}</button>}
      </div>
    </header>
  );
}

const CENDOL_PRESETS = [1, 2, 5, 10, 25] as const;
const CENDOL_UNIT_IDR = 5000;

export function TrakteerPopup({
  onClose,
  onConfirmCendol
}: {
  onClose: () => void;
  onConfirmCendol?: (opts: { supporter?: string; quantity?: number; message?: string }) => Promise<void> | void;
}) {
  const { t, lang } = useI18n();
  const id = lang === 'id';
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [qty, setQty] = useState<number>(1);
  const [supporter, setSupporter] = useState<string>('');
  const [message, setMessage] = useState<string>('');
  const [paying, setPaying] = useState<boolean>(false);

  useEffect(() => {
    const popup = dialog.current;
    if (!popup) return;
    const previous = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement : document.querySelector<HTMLElement>('.trakteer-btn');
    popup.showModal();
    return () => { popup.close(); previous?.focus(); };
  }, []);

  useEffect(() => {
    if (!paying) return;
    const onMsg = (ev: MessageEvent) => {
      if (!ev.data || typeof ev.data !== 'object') return;
      const msgType = (ev.data as { type?: string }).type;
      if (msgType === 'embed.modalClosed') {
        setPaying(false);
      } else if (msgType === 'embed.tipSuccess' || msgType === 'new-tip-success') {
        void onConfirmCendol?.({ supporter: supporter.trim() || 'Supporter', quantity: qty, message: message.trim() });
        onClose();
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [paying, qty, supporter, message, onConfirmCendol, onClose]);

  const totalIdr = qty * CENDOL_UNIT_IDR;

  const openTrakteerWindow = () => {
    if (typeof window === 'undefined') return;
    const checkoutUrl = `https://trakteer.id/aabrur/tip?quantity=${qty}${supporter.trim() ? `&supporter_name=${encodeURIComponent(supporter.trim())}` : ''}${message.trim() ? `&support_message=${encodeURIComponent(message.trim())}` : ''}`;
    const w = 480;
    const h = 720;
    const left = typeof window.screen !== 'undefined' ? Math.max(0, Math.round((window.screen.width - w) / 2)) : 100;
    const top = typeof window.screen !== 'undefined' ? Math.max(0, Math.round((window.screen.height - h) / 2)) : 100;
    const win = window.open(
      checkoutUrl,
      'trakteer_checkout',
      `popup=yes,width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=yes,status=no,toolbar=no,menubar=no`
    );
    if (win) {
      try { win.focus(); } catch { /* ignore */ }
    }
  };

  const handlePayNow = () => {
    setPaying(true);
    openTrakteerWindow();
  };

  const handleCompleteAndCelebrate = async () => {
    await onConfirmCendol?.({
      supporter: supporter.trim() || 'Supporter',
      quantity: qty,
      message: message.trim()
    });
    onClose();
  };

  return (
    <dialog
      ref={dialog}
      className="trakteer-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="panel trakteer-popup-card cendol-menu-card">
        <div className="panel-head trakteer-head">
          <div className="cendol-brand-head">
            <img
              src="https://edge-cdn.trakteer.id/images/embed/trbtn-icon.png?v=14-05-2025"
              alt="Cendol"
              className="cendol-logo-only"
            />
            <div>
              <h2 id={titleId}>{t('trakteerTitle')}</h2>
              <small id={descriptionId} className="cendol-sub">{t('trakteerBody')}</small>
            </div>
          </div>
          <button type="button" className="trakteer-close-x" onClick={onClose} aria-label={t('closeModal')} title={t('closeModal')}>✕</button>
        </div>

        <div className="cendol-picker-section">
          <label className="cendol-section-label">{id ? 'Pilih Jumlah Cendol' : 'Choose Cendol Quantity'}</label>
          <div className="cendol-presets" role="group" aria-label="Cendol presets">
            {CENDOL_PRESETS.map((n) => (
              <button
                key={n}
                type="button"
                className={`cendol-preset-pill ${qty === n ? 'is-active' : ''}`}
                onClick={() => setQty(n)}
              >
                <img src="https://edge-cdn.trakteer.id/images/embed/trbtn-icon.png?v=14-05-2025" alt="" className="cendol-pill-icon" />
                <b>{n}</b>
              </button>
            ))}
          </div>

          <div className="cendol-stepper-row">
            <div className="cendol-stepper">
              <button type="button" onClick={() => setQty((q) => Math.max(1, q - 1))} aria-label="Decrease Cendol">-</button>
              <input
                type="number"
                min={1}
                max={1000}
                value={qty}
                aria-label="Cendol quantity"
                onChange={(e) => setQty(Math.max(1, Math.min(1000, Math.round(Number(e.target.value) || 1))))}
              />
              <button type="button" onClick={() => setQty((q) => Math.min(1000, q + 1))} aria-label="Increase Cendol">+</button>
            </div>
            <div className="cendol-total-badge">
              <span>{qty} Cendol</span>
              <strong>Rp {totalIdr.toLocaleString('id-ID')}</strong>
            </div>
          </div>

          <div className="cendol-inputs-row">
            <input
              type="text"
              className="cendol-text-input"
              placeholder={id ? 'Nama / Alias (opsional)' : 'Name / Alias (optional)'}
              maxLength={60}
              value={supporter}
              onChange={(e) => setSupporter(e.target.value)}
            />
            <input
              type="text"
              className="cendol-text-input"
              placeholder={id ? 'Pesan untuk meja trading (opsional)' : 'Message for the trading desk (optional)'}
              maxLength={160}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </div>
        </div>

        {paying && (
          <div className="cendol-inplace-checkout" data-testid="cendol-inplace-checkout">
            <div className="cendol-checkout-bar">
              <span>{id ? `Pembayaran ${qty} Cendol (Rp ${totalIdr.toLocaleString('id-ID')})` : `Checkout ${qty} Cendol (Rp ${totalIdr.toLocaleString('id-ID')})`}</span>
              <button type="button" className="cendol-back-btn" onClick={() => setPaying(false)}>{id ? 'Ubah jumlah' : 'Edit quantity'}</button>
            </div>
            <div className="cendol-popup-active-card">
              <div className="cendol-status-icon-wrap">
                <img
                  src="https://edge-cdn.trakteer.id/images/embed/trbtn-icon.png?v=14-05-2025"
                  alt=""
                  className="cendol-status-icon"
                />
              </div>
              <div className="cendol-status-info">
                <strong>{id ? 'Jendela Pembayaran Trakteer Terbuka' : 'Trakteer Payment Window Opened'}</strong>
                <p>
                  {id
                    ? 'Selesaikan transaksi di jendela popup (QRIS / E-Wallet). Setelah selesai, klik tombol di bawah untuk mengirim cendol ke meja trading!'
                    : 'Complete your transaction in the popup window (QRIS / E-Wallet). Once finished, click the button below to send cendol to the trading desk!'}
                </p>
              </div>
              <div className="cendol-popup-links">
                <button
                  type="button"
                  className="cendol-reopen-btn"
                  onClick={openTrakteerWindow}
                >
                  {id ? '↗ Buka Ulang Jendela Pembayaran' : '↗ Reopen Payment Window'}
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="trakteer-popup-actions">
          {!paying ? (
            <button type="button" className="trakteer-btn trakteer-pay-btn" onClick={handlePayNow}>
              <img
                src="https://edge-cdn.trakteer.id/images/embed/trbtn-icon.png?v=14-05-2025"
                alt=""
                className="trbtn-mini-img"
              />
              <span>{id ? `Bayar ${qty} Cendol · Rp ${totalIdr.toLocaleString('id-ID')}` : `Pay ${qty} Cendol · Rp ${totalIdr.toLocaleString('id-ID')}`}</span>
            </button>
          ) : (
            <button type="button" className="trakteer-btn trakteer-pay-btn" onClick={() => void handleCompleteAndCelebrate()}>
              <img
                src="https://edge-cdn.trakteer.id/images/embed/trbtn-icon.png?v=14-05-2025"
                alt=""
                className="trbtn-mini-img"
              />
              <span>{id ? 'Selesai Bayar · Kirim Cendol ke Meja' : 'Payment Done · Send Cendol to Desk'}</span>
            </button>
          )}
        </div>
      </div>
    </dialog>
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
  const label = rawKey === 'full-brawl' ? t('fullBrawl') : rawKey === 'fists-out' ? t('meterHeatedViews') : rawKey === 'heated' ? (opposing ? t('meterOpposingViews') : t('meterGeneralTension')) : rawKey === 'mostly-agree' ? t('mostlyAgree') : t('quiet');
  return (
    <section className="panel meter">
      <div className="panel-head"><h2>{t('fightMeter')}</h2><span className={`heat-label h-${rawKey}`}>{label}</span></div>
      <div className="meter-bar">
        <div className="meter-fill" style={{ width: `${Math.min(100, Math.max(0, Math.round(dis * 100)))}%` }} />
        <div className="meter-pin" style={{ left: `clamp(5px, ${Math.round(dis * 100)}%, calc(100% - 5px))` }} title={`${Math.round(dis * 100)}% disagreement`} />
        <div className="meter-threshold" style={{ left: `clamp(0px, ${state.fightThreshold * 100}%, calc(100% - 2px))` }} title="Configured debate escalation threshold" />
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
      return state.venue?.name || state.live?.exchange || localStorage.getItem('mg-wallet-venue') || 'bybit';
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
                  {t('syncToBookBtn')}
                </button>
              )}
            </div>
          ) : (
            <p className="wallet-note small">{venueBal?.error || venueBal?.note || t('notConnectedBalance')}</p>
          )}
        </div>
      </div>
      <OrderDetails state={state} command={command} />
    </section>
  );
}

export function OpenOrders({ state, command }: { state: DeskState; command?: (text: string) => Promise<{ ok: boolean; reply?: string }> | void }) {
  const { t, lang } = useI18n();
  const p = state.paper;
  const [nBusy, setNBusy] = useState(false);
  const [closingBusy, setClosingBusy] = useState(false);
  const [nError, setNError] = useState<string | null>(null);
  const runClose = async (cmd: string) => {
    if (!command || closingBusy) return;
    setClosingBusy(true);
    setNError(null);
    try {
      const res = await command(cmd);
      if (res && !res.ok && res.reply) setNError(res.reply);
    } finally {
      setClosingBusy(false);
    }
  };
  return <section className="office-orders" aria-label={t('openOrdersN')}>
      <div className="order-heading"><strong>{t('openOrdersN')}</strong><span>{p.positions.length}/{p.n} {t('usedSuffix')}</span></div>
      <div className="n-picker" role="group" aria-label={t('openOrdersN')}>
        {[1, 2, 3, 4].map((n) => <button key={n} type="button" className={p.n === n ? 'on' : ''} disabled={nBusy} aria-pressed={p.n === n} onClick={() => void (async () => {
          if (nBusy || p.n === n) return;
          setNBusy(true); setNError(null);
          try {
            const r = await fetch('/api/ops/auto', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ n }) }).then((x) => x.json()).catch(() => null);
            if (!r?.ok) setNError(r?.error ?? (lang === 'id' ? 'Gagal menyimpan Max N.' : 'Could not save Max N.'));
          } finally { setNBusy(false); }
        })()}>{n}</button>)}
      </div>
      {nError && <p className="wallet-msg bad" role="status">{nError}</p>}
      <div className="order-allocation"><span>{t('perOrder')}</span><strong>{fmt(p.perOrder)} <small>USDT</small></strong></div>
      <dl className="order-budget">
        <div><dt>{t('moneyTrade')}</dt><dd>{fmt(p.moneyTrade)}</dd></div>
        <div><dt>{t('safetyNet')}</dt><dd>{fmt(p.safetyNet)}</dd></div>
      </dl>
      {!p.canOpen && <p className="order-warning">{t('atSafetyNet')}</p>}
      <div className="office-open-pos">
        <div className="office-open-head">
          <span>{lang === 'id' ? 'Posisi terbuka' : 'Open positions'}</span>
          <small>{p.positions.length}</small>
        </div>
        {p.positions.length === 0 ? (
          <p className="office-open-empty">{t('noOpenPositions')}</p>
        ) : (
          <div className={`office-open-list${p.positions.length > 2 ? ' is-dense' : ''}`}>
            {p.positions.map((x) => (
              <div
                key={x.id}
                className={`office-open-item ${x.side}`}
                title={`${x.side} ${x.symbol} · ${x.qty} @ ${fmtPx(x.entry)} · SL ${x.stop > 0 ? fmtPx(x.stop) : 'unavailable'}${x.tp ? ` · TP ${fmtPx(x.tp)}` : ''}`}
              >
                <b className="office-pos-sym">
                  <i className={`office-side-pill ${x.side}`}>{x.side === 'LONG' ? 'L' : 'S'}</i>
                  <span>{p.positions.length > 2 ? x.symbol.replace(/USDT$/, '') : x.symbol}</span>
                  {p.positions.length <= 2 && <small>{x.leverage}x</small>}
                </b>
                <span className={`office-pos-pnl ${x.unrealizedPnl >= 0 ? 'up' : 'down'}`}>
                  {x.unrealizedPnl >= 0 ? '+' : ''}{fmt(x.unrealizedPnl)}
                </span>
                {command && (
                  <button
                    type="button"
                    className="office-pos-close"
                    disabled={closingBusy}
                    aria-label={`${t('closeBtn')} ${x.symbol}`}
                    title={`${t('closeBtn')} ${x.symbol}`}
                    onClick={() => void runClose(`close ${x.symbol}`)}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          className="office-close-all-btn"
          disabled={closingBusy || p.positions.length === 0 || !command}
          aria-busy={closingBusy}
          onClick={() => void runClose('close all')}
        >
          {t('closeAll')}
        </button>
      </div>
  </section>;
}

function OrderDetails({ state, command }: { state: DeskState; command: (text: string) => void }) {
  const { t } = useI18n();
  const p = state.paper;
  return <div className="order-details">
      <div className="mini-charts"><AllocationBars state={state} /><EquityChart state={state} /></div>
      <p className="formula">{t('moneyTrade')} = {fmt(p.balance)} - {fmt(p.safetyNet)} = <b>{fmt(p.moneyTrade)}</b> · {p.orderSizePct == null ? `/ ${p.n}` : `× ${p.orderSizePct}%`} = <b>{fmt(p.perOrder)}</b> {t('perOrder').toLowerCase()}{!p.canOpen && <em> · {t('atSafetyNet')}</em>}</p>
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
  </div>;
}

const ACTION_LABEL: Record<Verdict['action'], string> = { OPEN_LONG: 'OPEN LONG', OPEN_SHORT: 'OPEN SHORT', CLOSE: 'CLOSE', HOLD: 'HOLD' };
export function Verdicts({ state, compact = false }: { state: DeskState; compact?: boolean }) {
  const { t } = useI18n();
  const detailId = useId();
  return (
    <section className={`panel verdicts${compact ? ' verdicts-compact' : ''}`}>
      <div className="panel-head"><h2>{t('verdictsTitle')}</h2><small className="muted">{t('verdictsSub')}</small></div>
      {state.verdicts.length === 0 && <p className="muted">{t('noVerdictYet')}</p>}
      <div className="verdict-list">
        {state.verdicts.slice(0, compact ? 3 : 6).map((v, idx) => {
          const popId = idx === 0 ? detailId : `${detailId}-${idx}`;
          return (
          <article key={v.id} className={`verdict a-${v.action}`} title={time(v.at)}>
            <div className="v-top">
              <span className="v-action">{ACTION_LABEL[v.action]}</span>
              <b>{v.symbol}</b>
              {v.example && <em className="tag-example">EXAMPLE</em>}
              <time>{time(v.at)}</time>
            </div>
            {compact ? <>
              <button className="verdict-reason-trigger" type="button" popoverTarget={popId}>{v.reason}</button>
              <div id={popId} popover="auto" className="office-verdict-popover" role="dialog" aria-label={t('verdictsTitle')}>
                <strong>{ACTION_LABEL[v.action]} · {v.symbol}</strong><p>{v.reason}</p>
                <button type="button" popoverTarget={popId} popoverTargetAction="hide">{t('closeBtn')}</button>
              </div>
            </> : <p>{v.reason}</p>}
            <div className="v-meta">
              <span>risk {v.riskDecision}</span>
              <span>heat {Math.round(v.disagreement * 100)}%</span>
              <span>{v.executed ? `${state.mode === 'PAPER' ? 'Paper' : state.mode} ${v.executionStatus ?? v.order?.status ?? 'execution recorded'}` : t('noFill')}</span>
              {!compact && v.order && <span>{v.order.qty} @ {fmtPx(v.order.entry)} · SL {fmtPx(v.order.stop)}{v.order.tp ? ` · TP ${fmtPx(v.order.tp)}` : ''}</span>}
            </div>
          </article>
          );
        })}
      </div>
    </section>
  );
}

export function TradeLog({ state, active = true, view = 'log' }: { state: DeskState; active?: boolean; view?: ActivityView }) {
  const { t, lang } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const entries = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const wasActive = useRef(false);
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(200);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const lines = filterActivity(activityForView(activityEntries(state), view), filter, query, state.agents);
  const isHistory = view === 'history';
  const searchLabel = isHistory ? 'Search history' : 'Search activity log';
  const last = lines.at(-1);
  useLayoutEffect(() => {
    if (!active) { wasActive.current = false; return; }
    if (!wasActive.current) follow.current = true;
    wasActive.current = true;
    if (follow.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [active, last?.at, last?.text, lines.length, filter, query, limit]);
  useLayoutEffect(() => {
    const element = ref.current, content = entries.current;
    if (!active || !element || !content) return;
    const observer = new ResizeObserver(() => { if (follow.current) element.scrollTop = element.scrollHeight; });
    observer.observe(element); observer.observe(content);
    return () => observer.disconnect();
  }, [active]);
  return (
    <section className="panel log">
      <div className="panel-head"><h2>{isHistory ? 'History' : lang === 'id' ? 'Log sistem' : 'System log'}</h2>
        {!isHistory && <div className="session-log-tabs" role="group" aria-label={lang === 'id' ? 'Tampilan log' : 'Log view'}>
          <button type="button" aria-pressed={!archiveOpen} onClick={() => setArchiveOpen(false)}>{lang === 'id' ? 'Langsung' : 'Live'}</button>
          <button type="button" aria-pressed={archiveOpen} onClick={() => setArchiveOpen(true)}>{lang === 'id' ? 'Sesi arsip' : 'Archived sessions'}</button>
        </div>}
        {!archiveOpen && <span>{lines.length} {lang === 'id' ? 'catatan' : 'entries'}</span>}
      </div>
      {archiveOpen && !isHistory ? <SessionLogs lang={lang} /> : <>
      <div className="activity-log-controls">
        <select aria-label={isHistory ? 'History filter' : 'Log filter'} value={filter} onChange={event => { follow.current = true; setFilter(event.target.value as ActivityFilter); }}>
          <option value="all">{t('allFilter')}</option>
          {isHistory ? <>
          <option value="trades">{lang === 'id' ? 'Riwayat trading' : 'Trade history'}</option><option value="chat">{lang === 'id' ? 'Sesi chat' : 'Chat sessions'}</option>
          <option value="discussion">{lang === 'id' ? 'Diskusi agen' : 'Agent discussions'}</option><option value="command">{lang === 'id' ? 'Perintah' : 'Commands'}</option>
          </> : <>
          <option value="tool">Tools</option><option value="mcp">MCP</option><option value="plugin">Plugins</option><option value="process">Processes</option>
          <option value="frontend">Frontend</option><option value="backend">Backend</option>
          <option value="errors">{lang === 'id' ? 'Error dan peringatan' : 'Errors and warnings'}</option>
          </>}
        </select>
        <input type="search" aria-label={searchLabel} placeholder={isHistory ? (lang === 'id' ? 'Cari riwayat…' : 'Search history…') : lang === 'id' ? 'Cari aktivitas…' : 'Search activity…'} value={query} onChange={event => { follow.current = true; setQuery(event.target.value); }} />
        <select aria-label="Visible log entries" value={limit} onChange={event => setLimit(Number(event.target.value))}><option value={200}>200</option><option value={500}>500</option><option value={2000}>2000</option></select>
        <button type="button" onClick={() => { follow.current = true; ref.current?.scrollTo({ top: ref.current.scrollHeight }); }}>{lang === 'id' ? 'Terbaru' : 'Latest'}</button>
      </div>
      <div className="log-body" ref={ref} role="log" aria-live="polite" onScroll={() => { const element = ref.current; if (element) follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40; }}>
        <div className="log-entries" ref={entries}>
        {!lines.length && <p className="muted">{filter === 'trades' ? t('noTradesYet') : t('noDeskActivity')}</p>}
        {lines.slice(-limit).map((l, i) => (
          <div key={l.id || `${l.at}-${i}`} className={`line k-${l.kind} level-${l.level || (l.kind === 'warn' ? 'warn' : 'info')}`}>
            <time dateTime={new Date(l.at).toISOString()}>{new Date(l.at).toLocaleString()}</time>
            <b>{l.source || l.kind}</b>
            {l.from ? <b>{activityParticipants(l, state.agents)}</b> : l.agent && <b style={{ color: state.agents[l.agent]?.color }}>{state.agents[l.agent]?.name}</b>}
            {l.status && <small>{l.status}</small>}
            {'durationMs' in l && l.durationMs !== undefined && <small>{l.durationMs}ms</small>}
            <span>{l.text}</span>
          </div>
        ))}
        </div>
      </div>
      </>}
    </section>
  );
}

export function Roster({ state, onSelect }: { state: DeskState; onSelect: (id: AgentId) => void }) {
  return (
    <div className="roster">
      {AGENT_ORDER.map((id) => {
        const a = state.agents[id];
        return (
          <button key={id} className={`roster-item status-${a.status}`} title={`${a.name} · ${a.provider}`} style={{ ['--agent' as string]: a.color }} onClick={() => onSelect(id)}>
            <Bot id={id} size={20} pose="idle" />
            <span>{a.name}</span>
            <small>{a.provider === 'mock' ? 'mock' : a.provider}</small>
          </button>
        );
      })}
    </div>
  );
}
