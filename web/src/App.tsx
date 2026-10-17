import { useState } from 'react';
import { useDesk } from './useDesk';
import type { AgentId } from './types';
import { Office } from './components/Office';
import { AgentPanel } from './components/AgentPanel';
import { CommandBar } from './components/CommandBar';
import { TopBar, TickerStrip, FightMeter, Portfolio, Verdicts, TradeLog, Roster } from './components/Panels';

export default function App() {
  const { state, connected, speech, fights, meter, command } = useDesk();
  const [selected, setSelected] = useState<AgentId | null>(null);

  if (!state) {
    return (
      <div className="app">
        <TopBar state={null} connected={connected} />
        <div className="loading"><div className="loader" /><p>Opening the office... is the backend running? (<code>npm run dev</code>)</p></div>
      </div>
    );
  }
  const dis = meter?.disagreement ?? state.debate?.disagreement ?? 0;
  return (
    <div className="app">
      <TopBar state={state} connected={connected} />
      <TickerStrip state={state} />
      <main className="layout">
        <section className="stage">
          <Office state={state} speech={speech} fights={fights} disagreement={dis} selected={selected} onSelect={setSelected} />
          <Roster state={state} onSelect={setSelected} />
          <CommandBar state={state} command={(t) => command(t)} />
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
      <footer className="footer">Paper trading simulation for learning. Not financial advice. No profit promised. Trading Agent Mpu Gandring, MIT license.</footer>
    </div>
  );
}
