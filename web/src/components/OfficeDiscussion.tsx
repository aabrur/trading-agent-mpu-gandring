import { useRef, useState } from 'react';
import type { DeskState, Speech } from '../types';
import { useI18n } from '../i18n';

export function OfficeDiscussion({ state, latest, onSelect }: { state: DeskState; latest?: Speech; onSelect: (id: Speech['agent']) => void }) {
  const { lang } = useI18n();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const history = state.logs.filter((line) => line.kind === 'speech' && line.agent).slice(-20);
  const showLatest = latest && history.at(-1)?.text !== latest.text;
  return <div className="office-discussion" onKeyDown={(event) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } }}>
    <button ref={trigger} className="discussion-bubble" aria-expanded={open} aria-controls="office-transcript" onClick={() => setOpen(!open)}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M4 4h16v12H9l-5 4zM8 8h8m-8 4h5" /></svg>
      {lang === 'id' ? 'Diskusi' : 'Desk chat'}
      {latest && <i aria-label={lang === 'id' ? 'Percakapan terbaru' : 'Recent speech'} />}
    </button>
    {open && <section id="office-transcript" className="discussion-popover" aria-label={lang === 'id' ? 'Diskusi kantor' : 'Office discussion'}>
      <div className="discussion-head"><b>{lang === 'id' ? 'Diskusi kantor' : 'Office discussion'}</b><button onClick={() => { setOpen(false); trigger.current?.focus(); }} aria-label="Close discussion">×</button></div>
      <div className="discussion-lines" role="log">
        {!history.length && !latest && <p className="muted">{lang === 'id' ? 'Percakapan muncul saat agen berdiskusi.' : 'Agent conversations appear here during a debate.'}</p>}
        {history.map((line, i) => <button key={`${line.at}-${i}`} onClick={() => line.agent && onSelect(line.agent)}><b>{line.agent ? state.agents[line.agent].name : ''}</b><span>{line.text}</span>{line.example && <small>EXAMPLE</small>}</button>)}
        {showLatest && <button onClick={() => onSelect(latest.agent)}><b>{state.agents[latest.agent].name}</b><span>{latest.text}</span>{latest.example && <small>EXAMPLE</small>}</button>}
      </div>
    </section>}
  </div>;
}
