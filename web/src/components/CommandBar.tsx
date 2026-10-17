import { useState } from 'react';
import type { DeskState } from '../types';

export function CommandBar({ state, command }: { state: DeskState; command: (t: string) => Promise<{ ok: boolean; reply: string }> }) {
  const [text, setText] = useState('');
  const [symbol, setSymbol] = useState(state.watchlist[0] ?? 'BTCUSDT');
  const [reply, setReply] = useState<{ ok: boolean; reply: string } | null>(null);
  const run = async (t: string) => { if (!t.trim()) return; setReply(await command(t)); };
  return (
    <div className="commandbar">
      <div className="cb-row">
        <div className="cb-debate">
          <select value={symbol} onChange={(e) => setSymbol(e.target.value)} aria-label="symbol">
            {state.watchlist.map((s) => <option key={s}>{s}</option>)}
          </select>
          <button className="primary" disabled={!!state.debate || state.paused} onClick={() => run(`analyze ${symbol}`)}>
            {state.debate ? `Debating ${state.debate.symbol}...` : 'Start debate'}
          </button>
          <button onClick={() => run(state.paused ? 'resume' : 'pause')}>{state.paused ? 'Resume' : 'Pause'}</button>
          <button className="danger" onClick={() => run('close all')}>Close all</button>
          <button className={`kill ${state.mode === 'LIVE' ? 'is-live' : ''}`} disabled={state.killed} title="Cancel everything, flatten every position, pause the desk until restart"
            onClick={async () => {
              if (!window.confirm(`Kill switch: cancel all orders, close every ${state.mode === 'LIVE' ? 'LIVE' : 'paper'} position and stop the desk until restart?`)) return;
              const r = await fetch('/api/kill', { method: 'POST' }).then((x) => x.json()).catch(() => null);
              setReply({ ok: !!r?.ok, reply: r?.ok ? `Kill switch on. ${(r.notes ?? []).join('; ') || 'Nothing was open.'}` : 'Kill switch request failed' });
            }}>{state.killed ? 'Killed' : 'Kill switch'}</button>
        </div>
        <form className="cb-input" onSubmit={(e) => { e.preventDefault(); void run(text); setText(''); }}>
          <span className="prompt">&gt;</span>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="analyze ETHUSDT · set n 3 · set safety 150 · be more cautious · help" maxLength={500} aria-label="command" />
          <button type="submit">Run</button>
        </form>
      </div>
      {reply && <div className={`cb-reply ${reply.ok ? '' : 'err'}`} onClick={() => setReply(null)}>{reply.reply}</div>}
    </div>
  );
}
