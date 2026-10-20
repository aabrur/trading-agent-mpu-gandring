import { useState } from 'react';
import type { DeskState, Report } from '../types';
import { fmt, fmtPx, clock } from './format';
import { useI18n } from '../i18n';

// Periodic desk reports. The newest is open; older ones fold.
export function Reports({ state }: { state: DeskState }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(5);
  const list = (state.reports ?? []).slice(0, visible);
  const shown = open ?? list[0]?.id ?? null;
  const now = async () => { setBusy(true); await fetch('/api/reports/now', { method: 'POST' }).catch(() => null); setBusy(false); };
  return (
    <section className="panel reports">
      <div className="panel-head">
        <h2><ReportIcon /> {t('reportsTitle')}</h2>
        <span className="muted small">{t('everyMinPrefix')} {state.reportIntervalMin} min</span>
        <button className="mini" onClick={now} disabled={busy}>{busy ? '...' : t('reportNow')}</button>
      </div>
      {state.auto?.on && <div className="auto-line"><i className={state.auto.running ? 'pulse' : ''} />{state.auto.running ? t('reportsAutoCycleRunning') : `${t('reportsNextCyclePrefix')} ${clock(state.auto.nextAt)}`} · {state.auto.cycles} {t('autoCyclesLabel')} · {state.auto.symbols.length} {t('opsSymbolsLabel').toLowerCase()}</div>}
      {list.length === 0 && <p className="muted small">{t('reportsEmptyNotice')} {state.reportIntervalMin} {t('reportsEmptySub')}</p>}
      {list.map((r) => <ReportCard key={r.id} r={r} open={r.id === shown} onToggle={() => setOpen(r.id === shown ? '' : r.id)} />)}
      {state.reports.length > visible && <button className="mini" onClick={() => setVisible(visible + 5)}>Show older reports</button>}
    </section>
  );
}

function ReportCard({ r, open, onToggle }: { r: Report; open: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  return (
    <article className={`report ${open ? 'is-open' : ''}`}>
      <button className="report-head" onClick={onToggle} aria-expanded={open}>
        <b>{clock(r.at)}</b>
        <span className={`tag mode-${r.mode.toLowerCase()}`}>{r.mode}</span>
        <span>{t('equityLabel').toLowerCase()} {fmt(r.equity)}</span>
        <span className={r.realized >= 0 ? 'up' : 'down'}>{r.realized >= 0 ? '+' : ''}{fmt(r.realized)}</span>
        <span className="muted">{r.opened.length} {t('reportsOpenedSummary')} · {r.closed.length} {t('reportsClosedSummary')} · {r.skipped.length} {t('reportsSkippedSummary')}</span>
      </button>
      {open && <div className="report-body">
        <div className="report-snapshot">
          <span><ReportIcon /> {r.monitoring?.current ? `${t('reportsAutoCycleRunning')} · ${r.monitoring.current}` : r.auto.on ? 'Monitoring' : 'Auto off'}</span>
          <p>{r.monitoring?.symbols.join(' · ') || 'Watchlist not recorded'}</p>
          <small>Previous: {r.monitoring?.previous ?? 'No cycle recorded'}</small>
          <p className={r.realized >= 0 ? 'up' : 'down'}>Period PnL {r.realized >= 0 ? '+' : ''}{fmt(r.realized)} USDT <span className="muted">· {r.accounting?.status ?? (r.mode === 'PAPER' ? 'paper' : 'unverified')}</span></p>
          {r.accounting && <small>Confirmed {fmt(r.accounting.confirmedRealized)} · Estimated {fmt(r.accounting.estimatedRealized)} · Unknown exits {r.accounting.unknownExits}</small>}
          <p className={r.dailyLoss.hit || r.monitoring?.killed ? 'down' : ''}>Kill {r.monitoring ? (r.monitoring.killed ? 'ON' : 'off') : 'unknown'} · Daily stop {r.dailyLoss.hit ? 'HIT' : 'not hit'} ({r.dailyLoss.limitPct}%)</p>
          {r.scan?.filter((f) => f.level === 'warn' || f.level === 'alert').slice(0, 3).map((f, i) => <p className="down" key={i}>{f.level}: {f.text}</p>)}
        </div>
        <div className="report-grid">
          <span>{t('topBalanceLabel')} <b>{fmt(r.balance)}</b></span><span>{t('safetyNet')} <b>{fmt(r.safetyNet)}</b></span>
          <span>{t('moneyTrade')} <b>{fmt(r.moneyTrade)}</b></span><span>N <b>{r.n}</b> · {t('perOrder').toLowerCase()} <b>{fmt(r.perOrder)}</b></span>

          <span>{t('reportsUnrealizedLabel')} <b className={r.unrealized >= 0 ? 'up' : 'down'}>{fmt(r.unrealized)}</b></span>
          <span>{t('reportsDailyStopLabel')} <b>{r.dailyLoss.limitPct}%</b>{r.dailyLoss.hit ? <em className="down"> {t('reportsHitLabel')}</em> : ''}</span>
        </div>
        <h4>{t('reportsOpenPositionsTitle')}</h4>

        {r.positions.length ? <ul>{r.positions.map((p) => <li key={p.symbol + p.openedAt}><b className={p.side === 'LONG' ? 'up' : 'down'}>{p.side}</b> {p.qty} {p.symbol} · entry {fmtPx(p.entry)} ({p.entryStatus ?? 'paper'}) / {p.ownership ?? 'managed'} · SL {p.stop > 0 ? fmtPx(p.stop) : 'unavailable'} ({p.protectionStatus ?? 'paper'}){p.tp ? ` · TP ${fmtPx(p.tp)}` : ''} · <span className={p.pnl >= 0 ? 'up' : 'down'}>{p.pnl >= 0 ? '+' : ''}{fmt(p.pnl)}</span></li>)}</ul> : <p className="muted small">{t('reportsNoneText')}</p>}
        <div className="report-period"><ReportIcon /> {r.opened.length} opened · {r.closed.length} closed · {r.skipped.length} skipped</div>
        {r.closed.slice(-2).map((a, i) => <p className="report-recent" key={i}><b>{a.symbol}</b> {a.detail.slice(0, 140)}{a.detail.length > 140 ? '…' : ''}</p>)}
        <details className="report-evidence"><summary>Activity &amp; evidence</summary>
          {r.accounting && <p className="account-note">{r.accounting.source} / {r.accounting.status}. Realized confirmed {fmt(r.accounting.confirmedRealized)}, estimated {fmt(r.accounting.estimatedRealized)}. Unknown exits: {r.accounting.unknownExits}. Account fees {r.accounting.actualFees == null ? 'unknown' : fmt(r.accounting.actualFees)} USDT; funding {r.accounting.funding == null ? 'unknown' : fmt(r.accounting.funding)} USDT. Confirmed managed net {r.accounting.financialEvidence?.confirmedNetRealized == null ? 'unknown' : fmt(r.accounting.financialEvidence.confirmedNetRealized)} USDT ({r.accounting.financialEvidence?.coverage ?? 'unsupported'} history).</p>}
        {r.opportunityReviews && <details><summary>{t('reportsSkippedOppTitle')} · {r.opportunityReviews.observed} {t('reportsObservedLabel')} / {r.opportunityReviews.pending} {t('reportsPendingLabel')} / {r.opportunityReviews.unavailable} {t('reportsUnavailableLabel')}</summary><p className="account-note">{t('reportsObservedPriceNote')}</p><ul>{r.opportunityReviews.items.map((x) => <li key={x.id}>{x.symbol} {x.side} · {x.reasonKind}: {x.reason} · {x.directionalMovePct == null ? x.status : x.directionalMovePct + '% directional movement'} · {x.reference.source}</li>)}</ul></details>}
        {r.scorecard && r.scorecard.length > 0 && <>
          <h4>{t('reportsScorecardTitle')}</h4>
          <ul>{r.scorecard.map((s) => { const n = s.right + s.wrong; return <li key={s.role}><b>{s.name}</b> {n ? `${s.right}/${n} ${t('reportsRightLabel')}` : t('reportsNoScoredCalls')} <span className="muted">· {s.note}</span></li>; })}</ul>
        </>}
        <h4>{t('reportsLessonsPeriodTitle')} {r.lessons?.length ?? 0}</h4>
        {r.lessons?.length ? <ul>{r.lessons.slice(0, 6).map((l, i) => <li key={i}><span className={`tag ${l.status}`}>{l.status}{l.count > 1 ? ` x${l.count}` : ''}</span> <b>{l.role}</b> {l.lesson}</li>)}</ul> : <p className="muted small">{t('reportsNoneText')}</p>}
        {(['opened', 'closed', 'skipped'] as const).map((k) => (
          <div key={k}>
            <h4>{(k === 'opened' ? t('reportsOpenedTitle') : k === 'closed' ? t('reportsClosedTitle') : t('reportsSkippedTitle'))}: {r[k].length}</h4>
            {r[k].length ? <ul>{r[k].slice(-8).map((a, i) => <li key={i}><span className="muted">{clock(a.at)}</span> <b>{a.symbol}</b> {a.detail}</li>)}</ul> : <p className="muted small">{t('reportsNoneText')}</p>}
          </div>
        ))}
        </details>
      </div>}
    </article>
  );
}

function ReportIcon() {
  return <svg className="report-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M4 4h16v16H4zM8 15l3-4 3 2 3-5M8 7h3" /></svg>;
}
