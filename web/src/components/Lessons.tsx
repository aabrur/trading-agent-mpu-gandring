import { useState } from 'react';
import type { DeskState } from '../types';
import { clock } from './format';
import { useI18n } from '../i18n';

// self-improving + proaktif-agent, visible: latest scan, standing rules, recent lessons.
export function Lessons({ state }: { state: DeskState }) {
  const { t, lang } = useI18n();
  const [lesson, setLesson] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const maintain = async (action: 'lessons' | 'scan' | 'restart') => {
    if (busy) return;
    if (action === 'restart' && !window.confirm(lang === 'id' ? 'Restart Office sekarang? Ini menghentikan proses yang sedang berjalan.' : 'Restart Office now? This interrupts the running process.')) return;
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch(action === 'restart' ? '/api/setup/restart' : `/api/ops/${action}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(action === 'lessons' ? { role: 'desk', lesson: lesson.trim(), kind: 'note' } : {})
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || result.detail || 'Request failed. Retry.');
      setFeedback({ ok: true, text: action === 'scan' ? (result.findings ?? []).map((f: { level: string; text: string }) => `${f.level}: ${f.text}`).join(' | ') || 'Scan: all clear.' : action === 'lessons' ? (lang === 'id' ? 'Lesson tersimpan.' : 'Lesson saved.') : result.detail || 'Restart requested.' });
      if (action === 'lessons') setLesson('');
    } catch (error) { setFeedback({ ok: false, text: error instanceof Error ? error.message : 'Office not reachable. Retry.' }); }
    finally { setBusy(false); }
  };
  const scan = state.scan?.findings ?? [];
  const rules = state.standingRules ?? [];
  const lessons = (state.lessons ?? []).filter((l) => l.status !== 'promoted').slice(0, 6);
  return (
    <section className="panel lessons">
      <div className="panel-head">
        <h2>{t('lessonsTitle')}</h2>
        <span className="muted small">{state.learning?.on ? `${t('learningOn')} · promote after ${state.learning.promoteAfter}` : t('learningOff')}</span>
      </div>
      <details className="ops-details lesson-maintenance" open>
        <summary>{t('opsMaintenanceTitle')}</summary>
        <form className="ops-lesson-row" onSubmit={(e) => { e.preventDefault(); void maintain('lessons'); }}>
          <label>{t('opsDeskLessonLabel')}<textarea value={lesson} maxLength={300} rows={2} onChange={(e) => setLesson(e.target.value)} placeholder={t('opsAddLessonPlaceholder')} /></label>
          <button disabled={busy || lesson.trim().length < 2}>{t('addLessonBtn')}</button>
        </form>
        <div className="ops-maintenance-actions"><button disabled={busy} onClick={() => void maintain('scan')}>{t('proaktifScan')}</button><button disabled={busy} onClick={() => void maintain('restart')}>{t('restartOfficeBtn')}</button></div>
        {busy && <p role="status">{t('loading')}</p>}
        {feedback && <p role="status" className={`wallet-msg ${feedback.ok ? 'ok' : 'bad'}`}>{feedback.text}</p>}
      </details>
      {state.scan && <div className="scan">
        <div className="scan-head">{t('proactiveScanTitle')} <span className="muted">{clock(state.scan.at)}</span></div>
        <ul>{scan.slice(0, 4).map((f, i) => <li key={i} className={`lv-${f.level}`}><b>{f.level}</b> {f.text}</li>)}</ul>
      </div>}
      {rules.length > 0 && <div className="rules">
        <div className="scan-head">{t('standingRulesTitle')}</div>
        <ul>{rules.slice(0, 4).map((l) => <li key={l.id}><span className="tag promoted">rule</span> <b>{l.role}</b> {l.lesson}</li>)}</ul>
      </div>}
      {lessons.length ? <ul className="lesson-list">{lessons.map((l) => {
        const titleParts = [
          `What happened: ${l.happened}`,
          `Root cause: ${l.rootCause}`,
          l.condition ? `Condition: ${l.condition}` : '',
          l.accountScope ? `Scope: ${l.accountScope}` : '',
          l.sourceTradeIds?.length ? `Sources: ${l.sourceTradeIds.join(', ')}` : '',
          l.sourceDecisionIds?.length ? `Decisions: ${l.sourceDecisionIds.join(', ')}` : ''
        ].filter(Boolean).join('\n');
        return (
          <li key={l.id} title={titleParts}>
            <span className={`tag ${l.status}`}>{l.status}{l.count > 1 ? ` x${l.count}` : ''}</span>
            {l.evaluationStatus && <span className={`tag eval-${l.evaluationStatus}`} style={{ marginLeft: 3, opacity: 0.85 }}>{l.evaluationStatus}</span>}
            {' '}<b>{l.role}</b>{l.symbol ? ` ${l.symbol}` : ''}: {l.lesson}
            {l.sourceTradeIds && l.sourceTradeIds.length > 0 && (
              <span className="muted" style={{ marginLeft: 4, fontSize: '0.9em' }}>
                [trade:{l.sourceTradeIds[0].slice(-6)}]
              </span>
            )}
          </li>
        );
      })}</ul>
        : !rules.length && <p className="muted small">{t('lessonsEmpty')}</p>}
      {state.lessonsRefused > 0 && <p className="muted small">{state.lessonsRefused} {t('lessonsRefusedText')}</p>}
    </section>
  );
}
