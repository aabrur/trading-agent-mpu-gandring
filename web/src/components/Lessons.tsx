import type { DeskState } from '../types';
import { clock } from './format';

// self-improving + proaktif-agent, visible: latest scan, standing rules (promoted lessons), recent lessons.
export function Lessons({ state }: { state: DeskState }) {
  const scan = state.scan?.findings ?? [];
  const rules = state.standingRules ?? [];
  const lessons = (state.lessons ?? []).filter((l) => l.status !== 'promoted').slice(0, 6);
  return (
    <section className="panel lessons">
      <div className="panel-head">
        <h2>Lessons</h2>
        <span className="muted small">{state.learning?.on ? `learning on · promote after ${state.learning.promoteAfter}` : 'learning off'}</span>
      </div>
      {state.scan && <div className="scan">
        <div className="scan-head">Proactive scan <span className="muted">{clock(state.scan.at)}</span></div>
        <ul>{scan.slice(0, 4).map((f, i) => <li key={i} className={`lv-${f.level}`}><b>{f.level}</b> {f.text}</li>)}</ul>
      </div>}
      {rules.length > 0 && <div className="rules">
        <div className="scan-head">Standing rules</div>
        <ul>{rules.slice(0, 4).map((l) => <li key={l.id}><span className="tag promoted">rule</span> <b>{l.role}</b> {l.lesson}</li>)}</ul>
      </div>}
      {lessons.length ? <ul className="lesson-list">{lessons.map((l) => (
        <li key={l.id} title={`What happened: ${l.happened}\nRoot cause: ${l.rootCause}`}>
          <span className={`tag ${l.status}`}>{l.status}{l.count > 1 ? ` x${l.count}` : ''}</span> <b>{l.role}</b>{l.symbol ? ` ${l.symbol}` : ''}: {l.lesson}
        </li>))}</ul>
        : !rules.length && <p className="muted small">No lessons yet. After every cycle, loss, stop, error or correction the desk writes one here. Lessons never loosen a guard.</p>}
      {state.lessonsRefused > 0 && <p className="muted small">{state.lessonsRefused} lesson(s) refused because they would loosen a guard.</p>}
    </section>
  );
}
