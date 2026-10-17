import { useEffect, useState } from 'react';
import { useDesk } from './useDesk';
import type { AgentId, CandleData } from './types';
import { Office } from './components/Office';
import { AgentPanel } from './components/AgentPanel';
import { CommandBar } from './components/CommandBar';
import { PriceChart } from './components/PriceChart';
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
      <TopBar state={state} connected={connected} theme={theme} onTheme={() => setTheme(theme === 'night' ? 'day' : 'night')} />
      <TickerStrip state={state} />
      <main className="layout">
        <section className="stage">
          <Office state={state} speech={speech} fights={fights} reactions={reactions} disagreement={dis} selected={selected} spark={spark} onSelect={setSelected} />
          <Roster state={state} onSelect={setSelected} />
          <CommandBar state={state} command={(t) => command(t)} />
          <PriceChart state={state} symbol={sym} onSymbol={setSymbol} data={candles} theme={theme} />
        </section>
        <aside className="side">
          <FightMeter state={state} meter={meter} />
          <Verdicts state={state} />
          <Portfolio state={state} command={(t) => void command(t)} />
        </aside>
        <section className="bottom">
          <TradeLog state={state} />
        </section>
      </main>
      {selected && <AgentPanel state={state} id={selected} onClose={() => setSelected(null)} command={command} />}
      <footer className="footer">Paper trading simulation for learning. Not financial advice. No profit promised. Trading Agent Mpu Gandring, MIT license. Charts by <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">TradingView Lightweight Charts</a>.</footer>
    </div>
  );
}
