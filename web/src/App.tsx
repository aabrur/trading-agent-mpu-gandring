import { lazy, useCallback, useEffect, useState } from 'react';
import { useDesk } from './useDesk';
import type { AgentId, CandleData } from './types';
import { Office } from './components/Office';
import { DeferredPanel } from './components/DeferredPanel';
import { CommandBar } from './components/CommandBar';
import { Reports } from './components/Reports';
import { WorkspaceTools } from './components/WorkspaceTools';
import { Tour } from './components/Tour';
import { UpdateModal, type UpdateInfo } from './components/UpdateModal';
import { TopBar, TickerStrip, FightMeter, Verdicts, Roster, TrakteerPopup, OpenOrders } from './components/Panels';
import { I18nProvider, useI18n } from './i18n';
import './styles/dashboard-v2.css';

const PriceChart = lazy(() => import('./components/PriceChart').then((m) => ({ default: m.PriceChart })));
const SetupWizard = lazy(() => import('./components/Setup').then((m) => ({ default: m.SetupWizard })));
const AgentPanel = lazy(() => import('./components/AgentPanel').then((m) => ({ default: m.AgentPanel })));

function initialTheme() {
  const saved = localStorage.getItem('mg-theme');
  if (saved === 'day' || saved === 'night') return saved;
  return 'day';
}

function initialTourOpen() {
  return true;
}

function AppInner() {
  const { t, lang } = useI18n();
  const { state, connected, speech, fights, meter, reactions, sceneEvents, command } = useDesk();
  const [selected, setSelected] = useState<AgentId | null>(null);
  const [theme, setTheme] = useState<string>(initialTheme);
  const [symbol, setSymbol] = useState<string>('');
  const [candles, setCandles] = useState<CandleData | null>(null);
  const [setup, setSetup] = useState<boolean>(() => ['#setup', '#setup-trading-default', '#setup-trading-manual'].includes(window.location.hash));
  const [setupEntry, setSetupEntry] = useState(window.location.hash);
  const [venueKeys, setVenueKeys] = useState<boolean>(() => window.location.hash === '#venue-keys');
  const [tourOpen, setTourOpen] = useState<boolean>(initialTourOpen);
  const [updateOpen, setUpdateOpen] = useState<boolean>(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [trakteerOpen, setTrakteerOpen] = useState<boolean>(true);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setTrakteerOpen(true);
    }, 60 * 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const h = () => {
      setSetup(['#setup', '#setup-trading-default', '#setup-trading-manual'].includes(window.location.hash)); setSetupEntry(window.location.hash);
      setVenueKeys(window.location.hash === '#venue-keys');
    };
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);

  const closeSetup = () => { setSetup(false); if (window.location.hash.startsWith('#setup')) history.replaceState(null, '', window.location.pathname); };
  const closeVenueKeys = () => { setVenueKeys(false); history.replaceState(null, '', window.location.pathname); document.getElementById('venue-keys-trigger')?.focus(); };
  const closeTour = () => {
    setTourOpen(false);
    try { localStorage.setItem('mpu_tour_done_v1', '1'); } catch { /* ignore */ }
  };

  const anyModalOpen = Boolean(state) && (setup || updateOpen || tourOpen || trakteerOpen || Boolean(selected));
  useEffect(() => {
    document.documentElement.classList.toggle('modal-open', anyModalOpen);
    document.body.classList.toggle('modal-open', anyModalOpen);
    return () => {
      document.documentElement.classList.remove('modal-open');
      document.body.classList.remove('modal-open');
    };
  }, [anyModalOpen]);

  const refreshUpdate = useCallback(async () => {
    try {
      const d = await fetch('/api/update/status').then((r) => r.json());
      if (d?.ok) setUpdateInfo(d);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void refreshUpdate();
    const timer = window.setInterval(refreshUpdate, 5 * 60_000);
    return () => window.clearInterval(timer);
  }, [refreshUpdate]);

  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('mg-theme', theme); }, [theme]);

  // the chart follows the debate symbol, otherwise the user's pick
  const debating = state?.debate?.symbol;
  useEffect(() => { if (debating) setSymbol(debating); }, [debating]);
  const sym = symbol || state?.watchlist[0] || '';
  useEffect(() => {
    if (!sym) return;
    let alive = true;
    const load = () => fetch(`/api/candles?symbol=${encodeURIComponent(sym)}`).then((r) => r.json()).then((d: CandleData) => { if (alive) setCandles(d); }).catch(() => {});
    load();
    const timer = window.setInterval(load, 30_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [sym]);

  if (!state) {
    return (
      <div className="app dashboard">
        <TopBar state={null} connected={connected} />
        <div className="loading"><div className="loader" /><p>{t('openingOfficeMsg')} <code>npm run dev</code></p></div>
      </div>
    );
  }
  const dis = meter?.disagreement ?? state.debate?.disagreement ?? 0;
  const spark = candles && candles.symbol === sym ? candles.candles.slice(-40).map((c) => c.close) : [];
  const id = lang === 'id';
  return (
    <div className="app dashboard">
      <a className="skip-office" href="#office-workspace">{id ? 'Ke ruang kerja' : 'Skip to workspace'}</a>
      <TopBar
        state={state}
        connected={connected}
        theme={theme}
        onTheme={() => setTheme(theme === 'night' ? 'day' : 'night')}
        onSetup={() => { window.location.hash = 'setup'; }}
        onVenueKeys={() => { window.location.hash = 'venue-keys'; }}
        walletOpen={venueKeys}
        onCloseWallet={closeVenueKeys}
        onTour={() => setTourOpen(true)}
        updateInfo={updateInfo}
        onOpenUpdate={() => setUpdateOpen(true)}
        onOpenTrakteer={() => setTrakteerOpen(true)}
      />
      <TickerStrip state={state} />
      <main className="layout" id="office-workspace" tabIndex={-1}>
        <section className="stage">
          <Office sceneEvents={sceneEvents} state={state} speech={speech} fights={fights} reactions={reactions} disagreement={dis} selected={selected} spark={spark} onSelect={setSelected}>
            <FightMeter state={state} meter={meter} fighting={fights.length > 0} />
            <Verdicts state={state} compact />
            <OpenOrders state={state} command={(cmd) => void command(cmd)} />
          </Office>
          <section className="desk-team" id="desk-team" aria-label={id ? 'Tim agen' : 'Agent team'}><Roster state={state} onSelect={setSelected} /></section>
          <CommandBar state={state} command={(cmd) => command(cmd)} />
          <div className="workspace-section-title market-section-title"><h2>{id ? 'Pasar & catatan meja' : 'Markets & desk notes'}</h2><span>{id ? 'Harga, keputusan, dan laporan' : 'Prices, decisions, and reports'}</span></div>
          <div className="market-workspace" id="market-workspace">
            <DeferredPanel label="Price chart"><PriceChart state={state} symbol={sym} onSymbol={setSymbol} data={candles} theme={theme} /></DeferredPanel>
            <Reports state={state} />
          </div>
        </section>
        <aside className="side">
          <WorkspaceTools state={state} command={(cmd) => void command(cmd)} />
        </aside>
      </main>
      {setup && <DeferredPanel label="Setup"><SetupWizard state={state} onClose={closeSetup} tradingProfile={setupEntry === '#setup-trading-default' ? 'default' : setupEntry === '#setup-trading-manual' ? 'manual' : undefined} /></DeferredPanel>}
      {updateOpen && <UpdateModal info={updateInfo} onRefresh={refreshUpdate} onClose={() => setUpdateOpen(false)} />}
      {trakteerOpen && !tourOpen && !setup && !venueKeys && !updateOpen && <TrakteerPopup onClose={() => setTrakteerOpen(false)} />}
      {selected && <DeferredPanel label="Agent"><AgentPanel state={state} id={selected} onClose={() => setSelected(null)} command={command} /></DeferredPanel>}
      <Tour open={tourOpen && !setup && !venueKeys && !updateOpen} onClose={closeTour} />
      <footer className="footer">{t('footerNote')} Charts by <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">TradingView Lightweight Charts</a>.</footer>
    </div>
  );
}

export default function App() {
  return (
    <I18nProvider>
      <AppInner />
    </I18nProvider>
  );
}
