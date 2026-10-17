// Desk ops: the office side of `npm run gb` (size, open with a required stop, close, proaktif scan, lessons, kill switch status).
// Same backend paths as the CLI: shared sizing module and the desk's one execution path. Localhost only.
import { useEffect, useState } from 'react';
import type { DeskState } from '../types';

const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const num = (s: string) => (s.trim() === '' ? undefined : Number(s));

export function DeskOps({ state }: { state: DeskState }) {
  const [symbol, setSymbol] = useState(state.watchlist[0] ?? 'BTCUSDT');
  const [side, setSide] = useState<'LONG' | 'SHORT'>('LONG');
  const [entry, setEntry] = useState(''); const [stop, setStop] = useState(''); const [tp, setTp] = useState(''); const [lev, setLev] = useState('');
  const [out, setOut] = useState<{ ok: boolean; text: string } | null>(null);
  const [lesson, setLesson] = useState('');
  const [kill, setKill] = useState<{ killed: boolean; release: string | null; unkillCommand: string } | null>(null);
  useEffect(() => { fetch('/api/ops/kill').then((r) => r.json()).then(setKill).catch(() => {}); }, [state.killed]);
  const show = (ok: boolean, text: string) => setOut({ ok, text });

  const size = async () => { const r = await post('/api/ops/size', { symbol, side, entry: num(entry), stop: num(stop), leverage: num(lev) }).catch(() => null); show(!!r?.ok, r?.text ?? 'office not reachable'); };
  const open = async () => {
    if (!(Number(stop) > 0)) return show(false, 'no stop: every ticket needs a stop price. Not opening without one.');
    if (!window.confirm(`${state.mode}: open ${side} ${symbol} with stop ${stop}?`)) return;
    const r = await post('/api/ops/open', { symbol, side, stop: Number(stop), tp: num(tp), leverage: num(lev) }).catch(() => null); show(!!r?.ok, r?.reply ?? 'office not reachable');
  };
  const close = async (target: string) => { if (!window.confirm(`Close ${target}?`)) return; const r = await post('/api/ops/close', { symbol: target }).catch(() => null); show(!!r?.ok, r?.reply ?? 'office not reachable'); };
  const scan = async () => { const r = await post('/api/ops/scan', {}).catch(() => null); show(!!r?.ok, r?.findings?.length ? r.findings.map((f: { level: string; text: string }) => `${f.level}: ${f.text}`).join(' | ') : 'scan: all clear'); };
  const addLesson = async () => { const r = await post('/api/ops/lessons', { role: 'desk', lesson, kind: 'note' }).catch(() => null); show(!!r?.ok, r?.ok ? 'lesson saved' : r?.error ?? 'office not reachable'); if (r?.ok) setLesson(''); };

  return (
    <div className="panel desk-ops">
      <div className="panel-head"><h2>Desk ops</h2><span className="badge">same as npm run gb</span></div>
      <div className="ops-row">
        <input aria-label="symbol" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} />
        <div className="seg" role="group" aria-label="side">{(['LONG', 'SHORT'] as const).map((s) => <button key={s} className={side === s ? 'on' : ''} onClick={() => setSide(s)}>{s}</button>)}</div>
      </div>
      <div className="ops-row">
        <input aria-label="entry" placeholder="entry, blank for live" value={entry} onChange={(e) => setEntry(e.target.value)} />
        <input aria-label="stop" placeholder="stop, required" value={stop} onChange={(e) => setStop(e.target.value)} />
        <input aria-label="take profit" placeholder="tp" value={tp} onChange={(e) => setTp(e.target.value)} />
        <input aria-label="leverage" placeholder="lev" value={lev} onChange={(e) => setLev(e.target.value)} />
      </div>
      <div className="ops-row">
        <button onClick={size}>Size ticket</button>
        <button onClick={open} disabled={state.killed || !(Number(stop) > 0)}>Open with stop</button>
        <button onClick={() => close(symbol)}>Close {symbol}</button>
        <button onClick={() => close('all')}>Close all</button>
        <button onClick={scan}>Proaktif scan</button>
      </div>
      <div className="ops-row">
        <input aria-label="lesson" placeholder="add a lesson, cannot loosen a guard" value={lesson} onChange={(e) => setLesson(e.target.value)} />
        <button disabled={lesson.trim().length < 8} onClick={addLesson}>Add lesson</button>
      </div>
      {out && <p className={`wallet-msg ${out.ok ? 'ok' : 'bad'}`}>{out.text}</p>}
      <p className="wallet-note small">Kill switch: {kill?.killed ? <>ON. {kill.release}</> : <>off. The Kill button is in the command bar. Releasing it is terminal-only: <code>{kill?.unkillCommand ?? 'npm run unkill -- --yes'}</code></>}</p>
    </div>
  );
}
