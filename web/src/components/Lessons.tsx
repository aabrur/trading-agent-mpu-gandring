import type { DeskState } from '../types';
import { clock } from './format';
import { useI18n } from '../i18n';

// self-improving + proaktif-agent, visible: latest scan, standing rules, recent lessons.
export function Lessons({ state }: { state: DeskState }) {
  const { t } = useI18n();
  const scan = state.scan?.findings ?? [];
  const rules = state.standingRules ?? [];
  const lessons = (state.lessons ?? []).filter((l) => l.status !== 'promoted').slice(0, 6);
  return (
    <section className="panel lessons">
      <div className="panel-head">
        <h2>{t('lessonsTitle')}</h2>
        <span className="muted small">{state.learning?.on ? `${t('learningOn')} · promote after ${state.learning.promoteAfter}` : t('learningOff')}</span>
      </div>
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
