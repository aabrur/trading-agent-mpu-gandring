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

  const auto = state.auto;
  const [autoMin, setAutoMin] = useState(String(auto?.intervalMin || 15));
  const [autoSyms, setAutoSyms] = useState((auto?.symbols ?? state.watchlist).join(', '));
  const [autoN, setAutoN] = useState<1 | 2 | 3 | 4>((state.paper?.n ?? 4) as 1 | 2 | 3 | 4);
  const [autoBusy, setAutoBusy] = useState(false);

  useEffect(() => {
    if (auto?.intervalMin) setAutoMin(String(auto.intervalMin));
  }, [auto?.intervalMin]);
  useEffect(() => {
    if (auto?.symbols?.length) setAutoSyms(auto.symbols.join(', '));
  }, [auto?.symbols]);
  useEffect(() => {
    if (state.paper?.n) setAutoN(state.paper.n);
  }, [state.paper?.n]);

  useEffect(() => { fetch('/api/ops/kill').then((r) => r.json()).then(setKill).catch(() => {}); }, [state.killed]);
  const show = (ok: boolean, text: string) => setOut({ ok, text });

  const parseSyms = (raw = autoSyms) => raw.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  const selectedSyms = parseSyms();

  const updateAuto = async (patch: { on?: boolean; runNow?: boolean; n?: 1 | 2 | 3 | 4; symbolsOverride?: string[] }) => {
    setAutoBusy(true);
    try {
      const syms = patch.symbolsOverride ?? parseSyms();
      const mins = Math.max(1, Math.min(1440, Number(autoMin) || 15));
      const nextN = patch.n ?? autoN;
      const r = await post('/api/ops/auto', {
        on: patch.on,
        runNow: patch.runNow,
        intervalMin: mins,
        n: nextN,
        symbols: syms.length ? syms : state.watchlist
      }).catch(() => null);
      if (r?.ok) {
        const modeTxt = r.auto?.on ? `Auto Trade ON (every ${r.auto.intervalMin}m · max ${nextN} pos)` : `Auto Trade saved (max ${nextN} pos)`;
        show(true, patch.runNow ? `${modeTxt} · cycle started` : modeTxt);
      } else {
        show(false, r?.error ?? 'office not reachable');
      }
    } finally {
      setAutoBusy(false);
    }
  };

  const toggleTokenChip = (sym: string) => {
    const current = parseSyms();
    const exists = current.includes(sym);
    const next = exists
      ? (current.length > 1 ? current.filter((x) => x !== sym) : current)
      : [...current, sym];
    const nextStr = next.join(', ');
    setAutoSyms(nextStr);
    void updateAuto({ symbolsOverride: next });
  };

  const pickMaxN = (nVal: 1 | 2 | 3 | 4) => {
    setAutoN(nVal);
    void updateAuto({ n: nVal });
  };

  const size = async () => { const r = await post('/api/ops/size', { symbol, side, entry: num(entry), stop: num(stop), leverage: num(lev) }).catch(() => null); show(!!r?.ok, r?.text ?? 'office not reachable'); };
  const open = async () => {
    if (!(Number(stop) > 0)) return show(false, 'no stop: every ticket needs a stop price. Not opening without one.');
    if (!window.confirm(`${state.mode}: open ${side} ${symbol} with stop ${stop}?`)) return;
    const r = await post('/api/ops/open', { symbol, side, stop: Number(stop), tp: num(tp), leverage: num(lev) }).catch(() => null); show(!!r?.ok, r?.reply ?? 'office not reachable');
  };
  const close = async (target: string) => { if (!window.confirm(`Close ${target}?`)) return; const r = await post('/api/ops/close', { symbol: target }).catch(() => null); show(!!r?.ok, r?.reply ?? 'office not reachable'); };
  const scan = async () => { const r = await post('/api/ops/scan', {}).catch(() => null); show(!!r?.ok, r?.findings?.length ? r.findings.map((f: { level: string; text: string }) => `${f.level}: ${f.text}`).join(' | ') : 'scan: all clear'); };
  const addLesson = async () => { const r = await post('/api/ops/lessons', { role: 'desk', lesson, kind: 'note' }).catch(() => null); show(!!r?.ok, r?.ok ? 'lesson saved' : r?.error ?? 'office not reachable'); if (r?.ok) setLesson(''); };

  const isAutoOn = !!auto?.on;
  const QuickTokens = POPULAR_SYMBOLS.slice(0, 10);

  return (
    <div className="panel desk-ops">
      <div className="panel-head"><h2>{t('deskOpsTitle')}</h2><span className="badge">{t('deskOpsSub')}</span></div>

      <div className={`auto-setup-box ${isAutoOn ? 'is-on' : 'is-off'}`}>
        <div className="auto-setup-head">
          <div className="auto-setup-title">
            <i className={`auto-dot ${isAutoOn ? 'on' : 'off'} ${auto?.running ? 'pulse' : ''}`} />
            <strong>{t('autoTradeTitle')}</strong>
            <span className={`auto-status-pill ${isAutoOn ? 'on' : 'off'}`}>
              {isAutoOn ? t('autoTradeOn') : t('autoTradeOff')}
            </span>
            <span className="auto-slots-pill" title="Open positions vs max allowed open positions (N)">
              Slots {state.paper.positions.length}/{state.paper.n} · ${state.paper.perOrder}/ord
            </span>
            <small className="auto-cycle-meta">
              {auto?.cycles ?? 0} {t('autoCyclesLabel')}{auto?.running ? ' · busy' : ''}
            </small>
          </div>
          <div className="seg auto-toggle-seg" role="group" aria-label="Auto Trade toggle">
            <button
              type="button"
              className={isAutoOn ? 'on auto-on-btn' : ''}
              disabled={autoBusy || state.killed}
              onClick={() => void updateAuto({ on: true })}
            >
              {t('autoStartBtn')}
            </button>
            <button
              type="button"
              className={!isAutoOn ? 'on auto-off-btn' : ''}
              disabled={autoBusy}
              onClick={() => void updateAuto({ on: false })}
            >
              {t('autoStopBtn')}
            </button>
          </div>
        </div>
        <div className="auto-setup-controls">
          <label className="auto-min-field" title="Debate interval in minutes">
            <span>{t('autoIntervalMin')}</span>
            <input
              type="number"
              min={1}
              max={1440}
              aria-label="auto interval minutes"
              value={autoMin}
              onChange={(e) => setAutoMin(e.target.value)}
            />
          </label>
          <div className="auto-n-field" title="Max concurrent open positions (N = 1..4)">
            <span>Max Pos (N)</span>
            <div className="seg auto-n-seg" role="group" aria-label="Max open positions">
              {([1, 2, 3, 4] as const).map((nVal) => (
                <button
                  key={nVal}
                  type="button"
                  className={autoN === nVal ? 'on' : ''}
                  disabled={autoBusy}
                  onClick={() => pickMaxN(nVal)}
                >
                  {nVal}
                </button>
              ))}
            </div>
          </div>
          <input
            className="auto-syms-input"
            aria-label="auto symbols"
            placeholder="BTCUSDT, ETHUSDT, SOLUSDT"
            title={t('autoSymbolsLabel')}
            value={autoSyms}
            onChange={(e) => setAutoSyms(e.target.value.toUpperCase())}
          />
          <button type="button" className="mini" disabled={autoBusy} onClick={() => void updateAuto({})}>
            {t('autoSaveBtn')}
          </button>
          <button
            type="button"
            className="mini auto-run-btn"
            disabled={autoBusy || state.killed || !!auto?.running}
            onClick={() => void updateAuto({ runNow: true })}
          >
            ▶ {t('autoRunNowBtn')}
          </button>
        </div>
        <div className="auto-token-bar">
          <span className="auto-token-label" title="Click tokens for agents to debate and autonomously Buy/Long, Sell/Short, Close, or Hold">
            Tokens (Buy/Sell/Hold):
          </span>
          <div className="auto-token-chips">
            {QuickTokens.map((sym) => {
              const active = selectedSyms.includes(sym);
              const hasPos = state.paper.positions.find((p) => p.symbol === sym);
              return (
                <button
                  key={sym}
                  type="button"
                  className={`token-chip ${active ? 'on' : ''} ${hasPos ? `pos-${hasPos.side.toLowerCase()}` : ''}`}
                  disabled={autoBusy}
                  onClick={() => toggleTokenChip(sym)}
                  title={`${sym}${hasPos ? ` (${hasPos.side} open)` : ''} - click to toggle in Auto Trade`}
                >
                  {sym.replace('USDT', '')}
                  {hasPos && <b className="chip-pos-tag">{hasPos.side === 'LONG' ? 'L' : 'S'}</b>}
                </button>
              );
            })}
          </div>
        </div>
      </div>

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
      <div className="ops-row ops-actions-row">
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
