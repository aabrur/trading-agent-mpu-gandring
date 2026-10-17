// Desk ops: the office side of `npm run gb`.
// Same backend paths as the CLI: shared sizing module and the desk's one execution path. Localhost only.
import { useEffect, useState } from 'react';
import type { DeskState } from '../types';
import { POPULAR_SYMBOLS } from '../types';
import { useI18n } from '../i18n';

const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const num = (s: string) => (s.trim() === '' ? undefined : Number(s));

export function DeskOps({ state }: { state: DeskState }) {
  const { t } = useI18n();
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
      <div className="panel-head"><h2>{t('deskOpsTitle')}</h2><span className="badge">{t('deskOpsSub')}</span></div>
      <div className="ops-row">
        <select
          className="ops-symbol-select"
          aria-label="select symbol"
          value={symbol}
          onChange={(e) => {
            if (e.target.value === '__custom__') {
              const c = window.prompt(t('customTokenPrompt'));
              if (c) setSymbol(c.trim().toUpperCase());
            } else {
              setSymbol(e.target.value);
            }
          }}
        >
          <optgroup label={t('watchlistGroup')}>
            {state.watchlist.map((s) => <option key={s} value={s}>{s}</option>)}
          </optgroup>
          <optgroup label={t('popularPerpsGroup')}>
            {POPULAR_SYMBOLS.filter((s) => !state.watchlist.includes(s)).map((s) => <option key={s} value={s}>{s}</option>)}
          </optgroup>
          <option value="__custom__">{t('customTokenOpt')}</option>
        </select>
        <input aria-label="symbol" title="Type or edit token symbol" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} />
        <div className="seg" role="group" aria-label="side">{(['LONG', 'SHORT'] as const).map((s) => <button key={s} className={side === s ? 'on' : ''} onClick={() => setSide(s)}>{s}</button>)}</div>
      </div>
      <div className="ops-row">
        <input aria-label="entry" placeholder={t('entryPlaceholder')} value={entry} onChange={(e) => setEntry(e.target.value)} />
        <input aria-label="stop" placeholder={t('stopPlaceholder')} value={stop} onChange={(e) => setStop(e.target.value)} />
        <input aria-label="take profit" placeholder={t('tpPlaceholder')} value={tp} onChange={(e) => setTp(e.target.value)} />
        <input aria-label="leverage" placeholder={t('levPlaceholder')} value={lev} onChange={(e) => setLev(e.target.value)} />
      </div>
      <div className="ops-row">
        <button onClick={size}>{t('sizeTicket')}</button>
        <button onClick={open} disabled={state.killed || !(Number(stop) > 0)}>{t('openWithStop')}</button>
        <button onClick={() => close(symbol)}>{t('closeSymbolPrefix')} {symbol}</button>
        <button onClick={() => close('all')}>{t('closeAll')}</button>
        <button onClick={scan}>{t('proaktifScan')}</button>
      </div>
      <div className="ops-row">
        <input aria-label="lesson" placeholder={t('lessonPlaceholder')} value={lesson} onChange={(e) => setLesson(e.target.value)} />
        <button disabled={lesson.trim().length < 8} onClick={addLesson}>{t('addLessonBtn')}</button>
      </div>
      {out && <p className={`wallet-msg ${out.ok ? 'ok' : 'bad'}`}>{out.text}</p>}
      <p className="wallet-note small">{t('killSwitch')}: {kill?.killed ? <>ON. {kill.release}</> : <>off. Releasing it is terminal-only: <code>{kill?.unkillCommand ?? 'npm run unkill -- --yes'}</code></>}</p>
    </div>
  );
}
