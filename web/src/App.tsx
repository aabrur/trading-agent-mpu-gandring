import { useEffect, useState } from 'react';
import { useDesk } from './useDesk';
import type { AgentId, CandleData } from './types';
import { Office } from './components/Office';
import { AgentPanel } from './components/AgentPanel';
import { CommandBar } from './components/CommandBar';
import { PriceChart } from './components/PriceChart';
import { Reports } from './components/Reports';
import { Lessons } from './components/Lessons';
import { WalletPanel } from './components/Wallet';
import { SetupWizard } from './components/Setup';
import { DeskOps } from './components/DeskOps';
import { TopBar, TickerStrip, FightMeter, Portfolio, Verdicts, TradeLog, Roster } from './components/Panels';

function initialTheme() {
  const saved = localStorage.getItem('mg-theme');
  if (saved === 'day' || saved === 'night') return saved;
  return 'day';
}

export default function App() {
  const { state, connected, speech, fights, meter, reactions, command } = useDesk();
  const [selected, setSelected] = useState<AgentId | null>(null);
  const [theme, setTheme] = useState<string>(initialTheme);
  const [symbol, setSymbol] = useState<string>('');
  const [candles, setCandles] = useState<CandleData | null>(null);
  const [setup, setSetup] = useState<boolean>(() => window.location.hash === '#setup');
  const [venueKeys, setVenueKeys] = useState<boolean>(() => window.location.hash === '#venue-keys');
  useEffect(() => { const h = () => { setSetup(window.location.hash === '#setup'); setVenueKeys(window.location.hash === '#venue-keys'); }; window.addEventListener('hashchange', h); return () => window.removeEventListener('hashchange', h); }, []);
  const closeSetup = () => { setSetup(false); if (window.location.hash === '#setup') history.replaceState(null, '', window.location.pathname); };
  const closeVenueKeys = () => { setVenueKeys(false); history.replaceState(null, '', window.location.pathname); document.getElementById('venue-keys-trigger')?.focus(); };

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
    const t = window.setInterval(load, 30_000);
    return () => { alive = false; window.clearInterval(t); };
  }, [sym]);

  if (!state) {
    return (
      <div className="app">
        <TopBar state={null} connected={connected} />
        <div className="loading"><div className="loader" /><p>Opening the office... is the backend running? (<code>npm run dev</code>)</p></div>
      </div>
    );
  }
  const dis = meter?.disagreement ?? state.debate?.disagreement ?? 0;
  const spark = candles && candles.symbol === sym ? candles.candles.slice(-40).map((c) => c.close) : [];
  return (
    <div className="app">
      <TopBar state={state} connected={connected} theme={theme} onTheme={() => setTheme(theme === 'night' ? 'day' : 'night')} onSetup={() => { window.location.hash = 'setup'; }} onVenueKeys={() => { window.location.hash = 'venue-keys'; }} />
      <TickerStrip state={state} />
      <main className="layout">
        <section className="stage">
          <Office state={state} speech={speech} fights={fights} reactions={reactions} disagreement={dis} selected={selected} spark={spark} onSelect={setSelected} />
          <Roster state={state} onSelect={setSelected} />
          <CommandBar state={state} command={(t) => command(t)} />
          <PriceChart state={state} symbol={sym} onSymbol={setSymbol} data={candles} theme={theme} />
          <TradeLog state={state} />
        </section>
        <aside className="side">
          <FightMeter state={state} meter={meter} />
          <Verdicts state={state} />
          <Portfolio state={state} command={(t) => void command(t)} />
          <DeskOps state={state} />
          <Reports state={state} />
          <Lessons state={state} />
        </aside>
      </main>
      {setup && <SetupWizard state={state} onClose={closeSetup} />}
      {venueKeys && <div className="setup-overlay" role="dialog" aria-modal="true" aria-label="Connect Wallet" onKeyDown={(e) => {
        if (e.key === 'Escape') closeVenueKeys();
        if (e.key === 'Tab') { const elements = e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled),input:not(:disabled),a[href]'); const first = elements[0], last = elements[elements.length - 1]; if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); } }
      }}>
        <div className="panel setup"><div className="panel-head"><h2>Connect Wallet</h2><button autoFocus onClick={closeVenueKeys}>Close</button></div><WalletPanel state={state} embedded /></div>
      </div>}
      {selected && <AgentPanel state={state} id={selected} onClose={() => setSelected(null)} command={command} />}
      <footer className="footer">Paper trading simulation for learning. Not financial advice. No profit promised. Trading Agent Mpu Gandring, MIT license. Charts by <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">TradingView Lightweight Charts</a>.</footer>
    </div>
  );
}
