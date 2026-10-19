// Desk ops: the office side of `npm run gb`.
// Same backend paths as the CLI: shared sizing module and the desk's one execution path. Localhost only.
import { useEffect, useRef, useState } from 'react';
import type { DeskState } from '../types';
import { POPULAR_SYMBOLS } from '../types';
import { useI18n } from '../i18n';
import { TRADING_PRESETS, TRADING_PRESET_IDS, type TradingPresetId, type TradingNetwork } from '../../../server/trading-settings';

const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const num = (s: string) => (s.trim() === '' ? undefined : Number(s));

export function DeskOps({ state }: { state: DeskState }) {
  const { t, lang } = useI18n();
  const [symbol, setSymbol] = useState(state.watchlist[0] ?? 'BTCUSDT');
  const [side, setSide] = useState<'LONG' | 'SHORT'>('LONG');
  const [entry, setEntry] = useState(''); const [stop, setStop] = useState(''); const [tp, setTp] = useState(''); const [lev, setLev] = useState('');
  const [ticketBusy, setTicketBusy] = useState(false);
  const ticketSelection = useRef('');
  ticketSelection.current = `${symbol}:${side}:${entry}:${lev}`;
  const [out, setOut] = useState<{ ok: boolean; text: string } | null>(null);
  const [lesson, setLesson] = useState('');
  const [kill, setKill] = useState<{ killed: boolean; release: string | null; unkillCommand: string } | null>(null);

  const auto = state.auto;
  const savedSymbols = auto?.symbols?.join(', ');
  const [autoMin, setAutoMin] = useState(String(auto?.intervalMin || 15));
  const [autoSyms, setAutoSyms] = useState((auto?.symbols ?? state.watchlist).join(', '));
  const [autoN, setAutoN] = useState<1 | 2 | 3 | 4>((state.paper?.n ?? 4) as 1 | 2 | 3 | 4);
  const [autoBusy, setAutoBusy] = useState(false);
  const [presetBusy, setPresetBusy] = useState(false);
  const [paperConfirmedPreset, setPaperConfirmedPreset] = useState<TradingPresetId | null>(null);

  useEffect(() => {
    if (state.mode === 'PAPER') {
      fetch('/api/setup/trading')
        .then((r) => r.json())
        .then((d) => {
          if (d?.ok && d.networks?.testnet?.profile && (TRADING_PRESET_IDS as readonly string[]).includes(d.networks.testnet.profile)) {
            setPaperConfirmedPreset(d.networks.testnet.profile as TradingPresetId);
          }
        })
        .catch(() => {});
    }
  }, [state.mode]);

  const runningPreset = state.trading?.profile && (TRADING_PRESET_IDS as readonly string[]).includes(state.trading.profile)
    ? (state.trading.profile as TradingPresetId)
    : null;
  const activePreset = (state.mode === 'PAPER' ? (paperConfirmedPreset ?? runningPreset) : runningPreset) ?? '';

  const handlePresetChange = async (newPreset: TradingPresetId) => {
    if (presetBusy || autoBusy) return;
    const targetNetwork: TradingNetwork = state.mode === 'LIVE' ? 'mainnet' : 'testnet';

    if (state.mode === 'LIVE') {
      const runningLeverage = state.trading?.values?.maxLeverage ?? state.paper?.maxLeverage ?? 3;
      const runningDailyLoss = state.trading?.values?.dailyLossLimitPct ?? state.dailyLoss?.limitPct ?? 3;
      const targetPresetValues = TRADING_PRESETS[newPreset].values;
      const increasesLeverage = targetPresetValues.maxLeverage > runningLeverage;
      const increasesDailyLoss = targetPresetValues.dailyLossLimitPct > runningDailyLoss;
      const isHighRisk = newPreset === 'high_risk';

      if (isHighRisk || increasesLeverage || increasesDailyLoss) {
        const confirmed = window.confirm(
          lang === 'id'
            ? `Ganti mode LIVE ke ${TRADING_PRESETS[newPreset].name}? Tindakan ini meningkatkan batas risiko (leverage maks ${targetPresetValues.maxLeverage}x, batas rugi harian ${targetPresetValues.dailyLossLimitPct}%).`
            : `Switch LIVE to ${TRADING_PRESETS[newPreset].name}? This increases risk limits (max leverage ${targetPresetValues.maxLeverage}x, daily loss ${targetPresetValues.dailyLossLimitPct}%).`
        );
        if (!confirmed) return;
      }
    }

    setPresetBusy(true);
    try {
      const r = await post('/api/setup/trading', { network: targetNetwork, profile: newPreset }).catch(() => null);
      if (r?.ok) {
        if (state.mode === 'PAPER') setPaperConfirmedPreset(newPreset);
        show(true, r.detail || `${t('opsPresetUpdated')} ${TRADING_PRESETS[newPreset].name}.`);
      } else {
        show(false, r?.detail || t('opsPresetFailed'));
      }
    } finally {
      setPresetBusy(false);
    }
  };

  useEffect(() => {
    if (auto?.intervalMin) setAutoMin(String(auto.intervalMin));
  }, [auto?.intervalMin]);
  useEffect(() => {
    if (savedSymbols) setAutoSyms(savedSymbols);
  }, [savedSymbols]);
  useEffect(() => {
    if (state.paper?.n) setAutoN(Math.min(4, Math.max(1, state.paper.n)) as 1 | 2 | 3 | 4);
  }, [state.paper?.n]);

  useEffect(() => { fetch('/api/ops/kill').then((r) => r.json()).then(setKill).catch(() => {}); }, [state.killed]);
  const show = (ok: boolean, text: string) => setOut({ ok, text });

  const parseSyms = (raw = autoSyms) => raw.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  const selectedSyms = parseSyms();

  const updateAuto = async (patch: { on?: boolean; runNow?: boolean; n?: 1 | 2 | 3 | 4; symbolsOverride?: string[] }) => {
    setAutoBusy(true);
    try {
      if (patch.on && state.killed) {
        if (window.confirm('Kill switch is currently ON. Release kill switch and enable Auto Trade?')) {
          await post('/api/ops/kill', { on: false }).catch(() => null);
        } else {
          setAutoBusy(false);
          return;
        }
      }
      const syms = patch.symbolsOverride ?? parseSyms();
      const mins = Math.max(1, Math.min(1440, Number(autoMin) || 15));
      const nextN = patch.n ?? autoN;
      const schedule = patch.on !== undefined ? { on: patch.on } : patch.runNow ? { runNow: true } : {
        on: patch.on,
        runNow: patch.runNow,
        intervalMin: mins,
        n: nextN,
        symbols: syms.length ? syms : state.watchlist
      };
      const r = await post('/api/ops/auto', schedule).catch(() => null);
      if (r?.ok) {
        const modeTxt = r.auto?.on ? `Auto Trade scheduled every ${r.auto.intervalMin}m` : 'Auto scheduler off';
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

  };

  const pickMaxN = (nVal: 1 | 2 | 3 | 4) => {
    setAutoN(nVal);

  };

  const toggleKillSwitch = async (turnOn: boolean) => {
    if (turnOn) {
      if (!window.confirm(t('opsKillOnConfirm'))) return;
    }
    const r = await post('/api/ops/kill', { on: turnOn }).catch(() => null);
    if (r?.ok) {
      setKill((prev) => (prev ? { ...prev, killed: r.killed } : null));
      show(true, r.killed ? t('opsKillNowOn') : t('opsKillReleased'));
    } else {
      show(false, r?.error ?? t('cbKillFailedMsg'));
    }
  };

  const restartOffice = async () => {
    show(true, t('opsRestartingOffice'));
    const r = await post('/api/setup/restart', {}).catch(() => null);
    if (r?.ok) {
      show(true, r.detail || (lang === 'id' ? 'Meja trading berhasil direstart.' : 'Office restarted successfully.'));
    } else {
      show(false, r?.detail ?? (lang === 'id' ? 'Gagal merequest restart' : 'Restart request failed'));
    }
  };

  const preview = async (useGivenStop = true) => {
    const selection = ticketSelection.current;
    const r = await post('/api/ops/size', { symbol, side, entry: num(entry), stop: useGivenStop ? num(stop) : undefined, leverage: num(lev) }).catch(() => null);
    if (selection !== ticketSelection.current) return null;
    if (r?.ok && r.data) {
      setStop(String(r.data.stop));
      setTp(r.data.tp == null ? '' : String(r.data.tp));
    }
    show(!!r?.ok, r ? `${r.text}${r.source ? ` Price source: ${r.source}.` : ''}` : 'Office not reachable.');
    return r;
  };
  const autoFillStop = async () => {
    setTicketBusy(true);
    try { await preview(false); } finally { setTicketBusy(false); }
  };
  const size = async () => {
    setTicketBusy(true);
    try { await preview(); } finally { setTicketBusy(false); }
  };
  const open = async () => {
    setTicketBusy(true);
    try {
      let stopVal = num(stop);
      let tpVal = num(tp);
      if (!(stopVal && stopVal > 0)) {
        const r = await preview(false);
        if (!r?.ok) return;
        stopVal = r.data.stop; tpVal = r.data.tp ?? undefined;
      }
      const r = await post('/api/ops/open', { symbol, side, stop: stopVal, tp: tpVal, leverage: num(lev) }).catch(() => null);
      show(!!r?.ok, r?.reply ?? 'Office not reachable.');
    } finally { setTicketBusy(false); }
  };

  const close = async (target: string) => {
    const r = await post('/api/ops/close', { symbol: target }).catch(() => null);
    show(!!r?.ok, r?.reply ?? 'office not reachable');
  };
  const scan = async () => { const r = await post('/api/ops/scan', {}).catch(() => null); show(!!r?.ok, r?.findings?.length ? r.findings.map((f: { level: string; text: string }) => `${f.level}: ${f.text}`).join(' | ') : 'scan: all clear'); };
  const addLesson = async () => { const r = await post('/api/ops/lessons', { role: 'desk', lesson, kind: 'note' }).catch(() => null); show(!!r?.ok, r?.ok ? 'lesson saved' : r?.error ?? 'office not reachable'); if (r?.ok) setLesson(''); };

  const isAutoOn = !!auto?.on;
  const QuickTokens = POPULAR_SYMBOLS.slice(0, 10);

  return (
    <section className="panel desk-ops" aria-label="Desk operations">
      <div className="panel-head"><h2>{t('deskOpsTitle')}</h2><span className="badge">{state.mode} · {state.venue?.label ?? state.marketSource}</span></div>
      <div className="ops-trading-profile">
        <div><strong>{lang === 'id' ? 'Pengaturan trading' : 'Trading settings'}</strong><small>{state.trading?.network ?? 'Testnet / mainnet'} · {state.trading?.profile === 'current' || !state.trading ? (lang === 'id' ? 'pengaturan tersimpan' : 'existing settings') : state.trading.profile}</small></div>
        <div className="setup-nav"><button onClick={() => { window.location.hash = 'setup-trading-default'; }}>{t('opsPresetDefault')}</button><button onClick={() => { window.location.hash = 'setup-trading-manual'; }}>{t('tradingProfileManual')}</button></div>
      </div>
      <div className={`ops-kill-bar ${state.killed ? 'is-killed' : 'is-active'}`}>
        <div className="kill-status-wrap"><span className="kill-indicator" /><span className="kill-status-label">{state.killed ? t('killSwitchOnLocked') : t('killSwitchOffReady')}</span></div>
        <button type="button" className={`kill-toggle-btn ${state.killed ? 'release-btn' : 'engage-btn'}`} onClick={() => toggleKillSwitch(!state.killed)} title={state.killed ? t('cbKillReleaseTitle') : t('cbKillEngageTitle')}>{state.killed ? t('unlockKillBtn') : t('engageKillBtn')}</button>
      </div>
      <section className="auto-setup-box" aria-label="Jev decision monitor">
        <div className="auto-setup-title"><h3>{t('jevMonitorTitle')}</h3><span className="auto-status-pill">{state.jev?.health ?? t('jevNotConfigured')}</span></div>
        <small className="auto-cycle-meta">{state.jev ? `${state.jev.mode} · ${state.jev.provider} · ${state.jev.model}` : t('jevNotConfigured')}{state.jev?.allowLive ? ' · LIVE ASSIST authorized' : ''}</small>
        <dl className="setup-summary">
          <div><dt>{t('jevRegime')}</dt><dd>{String((state.jev?.lastDecision as { interpretation?: { marketRegime?: string } } | undefined)?.interpretation?.marketRegime ?? (state.jev?.lastDecision as { pre?: { interpretation?: { marketRegime?: string } } } | undefined)?.pre?.interpretation?.marketRegime ?? t('jevNotYetEvaluated'))}</dd></div>
          <div><dt>{t('jevLatency')}</dt><dd>{state.jev?.metrics?.lastLatencyMs == null ? t('jevUnavailable') : `${state.jev.metrics.lastLatencyMs} ms`}</dd></div>
          <div><dt>{t('jevCost')}</dt><dd>{state.jev?.metrics?.lastCost == null ? t('jevUnavailable') : String(state.jev.metrics.lastCost)}</dd></div>
          <div><dt>{t('jevAffected')}</dt><dd>{state.jev?.affectedContext ? t('jevYes') : t('jevNo')}</dd></div>
        </dl>
      </section>
      <section className={`auto-setup-box ${isAutoOn ? 'is-on' : 'is-off'}`} aria-labelledby="ops-auto-title">
        <div className="auto-setup-title">
          <i className={`auto-dot ${isAutoOn ? 'on' : 'off'} ${auto?.running ? 'pulse' : ''}`} /><h3 id="ops-auto-title">{t('autoTradeTitle')}</h3>
          <span className={`auto-status-pill ${isAutoOn ? 'on' : 'off'}`}>{auto?.running ? (lang === 'id' ? 'Siklus aktif' : 'Cycle active') : isAutoOn ? (lang === 'id' ? 'Terjadwal' : 'Scheduled') : (lang === 'id' ? 'Mati' : 'Off')}</span>
          <span className="auto-slots-pill">{lang === 'id' ? 'Slot' : 'Slots'} {state.paper.positions.length}/{state.paper.n} · ${state.paper.perOrder}/ord</span>
        </div>
        <small className="auto-cycle-meta">{auto?.running ? (auto.trigger === 'manual' ? (lang === 'id' ? 'Siklus manual berjalan' : 'Manual cycle running') : (lang === 'id' ? 'Siklus terjadwal berjalan' : 'Scheduled cycle running')) : auto?.on ? (lang === 'id' ? 'Menunggu siklus berikutnya' : 'Waiting for next cycle') : (lang === 'id' ? 'Penjadwal mati' : 'Scheduler off')}{auto?.stopping ? (lang === 'id' ? ' · berhenti setelah simbol saat ini' : ' · stopping after current symbol') : ''}</small>
        <div className="auto-quick-actions">
          <div className="seg auto-toggle-seg" role="group" aria-label="Decision mode">
            <span className="field-help">{t('opsDebateMode')}</span>
            <button type="button" className={state.debateMode !== 'fast' ? 'on' : ''} disabled={autoBusy || presetBusy} onClick={() => void post('/api/ops/auto', { debateMode: 'normal' })}>{t('opsDebateNormal')}</button>
            <button type="button" className={state.debateMode === 'fast' ? 'on' : ''} disabled={autoBusy || presetBusy} onClick={() => void post('/api/ops/auto', { debateMode: 'fast' })}>{t('opsDebateFast')}</button>
          </div>
        </div>
        <dl className="setup-summary">
          <div><dt>{t('opsCycleStage')}</dt><dd>{state.debate?.phase ?? state.lastCycle?.stage ?? 'idle'}</dd></div>
          <div><dt>{t('opsLastCycle')}</dt><dd>{state.lastCycle?.durationMs == null ? '—' : `${state.lastCycle.durationMs} ms`}{state.lastCycle?.symbol ? ` · ${state.lastCycle.symbol}` : ''}</dd></div>
          <div><dt>{t('opsLastVerdict')}</dt><dd>{state.lastCycle?.verdict ?? state.verdicts[0]?.action ?? '—'}</dd></div>
          <div><dt>{t('opsNoTradeReason')}</dt><dd>{state.lastCycle?.noTradeReason ?? '—'}</dd></div>
          <div><dt>{t('opsLastExecution')}</dt><dd>{state.lastCycle?.outcome ?? state.lastCycle?.executionStatus ?? '—'}</dd></div>
        </dl>
        <div className="auto-quick-actions">
          <div className="seg auto-toggle-seg" role="group" aria-label="Auto Trade toggle">
            <button type="button" className={isAutoOn ? 'on auto-on-btn' : ''} disabled={autoBusy || presetBusy} onClick={() => void updateAuto({ on: true })}>{t('autoStartBtn')}</button>
            <button type="button" className={!isAutoOn ? 'on auto-off-btn' : ''} disabled={autoBusy || presetBusy} onClick={() => void updateAuto({ on: false })}>{t('autoStopBtn')}</button>
          </div>
          <div className="auto-run-group">
            <div className="auto-preset-selector">
              <select
                className="auto-preset-select"
                aria-label="Trading risk preset"
                disabled={presetBusy || autoBusy}
                value={activePreset}
                onChange={(e) => void handlePresetChange(e.target.value as TradingPresetId)}
              >
                {!activePreset && <option value="" disabled hidden>{t('opsPresetCustom')}</option>}
                <option value="default">{t('opsPresetDefault')}</option>
                <option value="balance">{t('opsPresetBalance')}</option>
                <option value="profit">{t('opsPresetProfit')}</option>
                <option value="high_risk">{t('opsPresetHighRisk')}</option>
              </select>
              <span className="auto-preset-chevron" aria-hidden="true">▾</span>
            </div>
            <button type="button" className="mini auto-run-btn" disabled={autoBusy || presetBusy || state.killed || !!auto?.running} onClick={() => void updateAuto({ runNow: true })}>{t('autoRunNowBtn')}</button>
          </div>
        </div>
        <div className="auto-setup-controls">
          <label className="auto-min-field"><span>{t('opsEveryLabel')}</span><input type="number" min={1} max={1440} aria-label="auto interval minutes" value={autoMin} onChange={(e) => setAutoMin(e.target.value)} /><span>{t('opsMinUnit')}</span></label>
          <div className="auto-n-field"><span>{t('opsMaxNLabel')}</span><div className="seg auto-n-seg" role="group" aria-label="Max open positions">{([1, 2, 3, 4] as const).map((nVal) => <button key={nVal} type="button" className={autoN === nVal ? 'on' : ''} disabled={autoBusy} onClick={() => pickMaxN(nVal)}>{nVal}</button>)}</div></div>
          <button type="button" className="mini" disabled={autoBusy} onClick={() => void updateAuto({})}>{t('autoSaveBtn')}</button>
        </div>
        <label className="ops-symbols-field">{t('opsSymbolsLabel')}<input className="auto-syms-input" aria-label="auto symbols" placeholder="BTCUSDT, ETHUSDT, SOLUSDT" value={autoSyms} onChange={(e) => setAutoSyms(e.target.value.toUpperCase())} /></label>
        <div className="auto-token-bar" role="group" aria-label="Quick symbol selection">{QuickTokens.map((sym) => {
          const active = selectedSyms.includes(sym), hasPos = state.paper.positions.find((p) => p.symbol === sym);
          return <button key={sym} type="button" className={`token-chip ${active ? 'on' : ''} ${hasPos ? `pos-${hasPos.side.toLowerCase()}` : ''}`} aria-pressed={active} disabled={autoBusy} onClick={() => toggleTokenChip(sym)} title={`${sym}${hasPos ? ` (${hasPos.side} open)` : ''} - edit selection, then Save`}>
            {sym.replace('USDT', '')}{hasPos && <b className="chip-pos-tag">{hasPos.side === 'LONG' ? 'L' : 'S'}</b>}
          </button>;
        })}</div>
        <p className="ops-help">{t('opsAutoHelpText')}</p>
      </section>
      <div className="ops-position-actions"><strong>{t('opsPositionsTitle')} {state.paper.positions.length}/{state.paper.n}</strong>{[...new Set(state.paper.positions.map((p) => p.symbol))].map((sym) => <button key={sym} onClick={() => close(sym)}>{t('opsCloseBtn')} {sym.replace('USDT', '')}</button>)}<button disabled={!state.paper.positions.length} onClick={() => close('all')}>{t('closeAll')}</button></div>
      <section className="ops-section" aria-labelledby="ops-ticket-title">
        <div className="ops-section-heading"><h3 id="ops-ticket-title">{t('opsManualTicketTitle')}</h3><small>{t('opsPreviewOpenSub')}</small></div>
        <div className="ops-market-row">
          <label>{t('opsSymbolLabel')}<input aria-label="symbol" list="ops-ticket-symbols" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} /></label>
          <datalist id="ops-ticket-symbols">{[...new Set([...state.watchlist, ...POPULAR_SYMBOLS])].map((s) => <option key={s} value={s} />)}</datalist>
          <div className="ops-side-field"><span>{t('opsSideLabel')}</span><div className="seg" role="group" aria-label="side">{(['LONG', 'SHORT'] as const).map((s) => <button key={s} className={side === s ? 'on' : ''} aria-pressed={side === s} onClick={() => setSide(s)}>{s}</button>)}</div></div>
        </div>
        <p className="ops-help">{t('opsExecutionPrefix')} {state.venue?.label ?? state.mode} · {t('opsAnalysisPrefix')} {state.marketSource}. {t('opsPricesMayDiffer')}</p>
        <div className="ticket-inputs">
          <label>{t('opsEntryLabel')}<input aria-label="entry" placeholder={t('opsLiveQuotePlaceholder')} value={entry} onChange={(e) => setEntry(e.target.value)} /></label>
          <label>{t('opsStopLossLabel')}<input aria-label="stop" placeholder={t('opsStopPricePlaceholder')} value={stop} onChange={(e) => setStop(e.target.value)} /></label>
          <label>{t('opsTakeProfitLabel')}<input aria-label="take profit" placeholder={t('opsTpPricePlaceholder')} value={tp} onChange={(e) => setTp(e.target.value)} /></label>
          <label>{t('opsLeverageLabel')}<input aria-label="leverage" placeholder={`≤ ${state.paper.maxLeverage}x`} value={lev} onChange={(e) => setLev(e.target.value)} /></label>
        </div>
        <p className="ops-help">{t('opsAutoStopHelpText')}</p>
        <div className="ops-ticket-actions">
          <button type="button" className="auto-stop-pill-btn" onClick={() => void autoFillStop()} disabled={ticketBusy}>{t('calcAutoStopBtn')}</button>
          <button onClick={() => void size()} disabled={ticketBusy}>{t('sizeTicket')}</button>
          <button onClick={() => void open()} disabled={state.killed || ticketBusy}>{t('openWithStop')}</button>
        </div>
      </section>
      <section className="ops-section" aria-labelledby="ops-maintenance-title">
        <div className="ops-section-heading"><h3 id="ops-maintenance-title">{t('opsMaintenanceTitle')}</h3><small>{t('opsJournalOfficeSub')}</small></div>
        <div className="ops-lesson-row"><label>{t('opsDeskLessonLabel')}<input aria-label="lesson" placeholder={t('opsAddLessonPlaceholder')} value={lesson} onChange={(e) => setLesson(e.target.value)} /></label><button disabled={lesson.trim().length < 2} onClick={addLesson}>{t('addLessonBtn')}</button></div>
        <div className="ops-maintenance-actions"><button onClick={scan}>{t('proaktifScan')}</button><button onClick={restartOffice}>{t('restartOfficeBtn')}</button></div>
      </section>
      {out && <p role="status" className={`wallet-msg ${out.ok ? 'ok' : 'bad'}`}>{out.text}</p>}
    </section>
  );
}
