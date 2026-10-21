import { useEffect, useRef, useState } from 'react';
import type { DeskState } from '../types';
import { DeskOps } from './DeskOps';
import { Lessons } from './Lessons';
import { Portfolio, TradeLog } from './Panels';
import { useI18n } from '../i18n';

const TOOLS = [
  { id: 'ops', label: 'Ops', path: 'M4 7h16M7 4v6m10 4v6M4 17h16' },
  { id: 'book', label: 'Portfolio', path: 'M4 5h7l1 2 1-2h7v15h-7l-1 1-1-1H4zM12 7v14' },
  { id: 'lessons', label: 'Lessons', path: 'm4 8 8-4 8 4-8 4zM7 10v6l5 3 5-3v-6' },
  { id: 'log', label: 'Log', path: 'M6 3h12v18H6zM9 8h6m-6 4h6m-6 4h4' }
] as const;

export function WorkspaceTools({ state, command }: { state: DeskState; command: (text: string) => void }) {
  const { lang } = useI18n();
  const [active, setActive] = useState<string | null>(null);
  const [insidePanel, setInsidePanel] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active || !insidePanel) return;
    const bodyOverflow = document.body.style.overflow;
    const htmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = bodyOverflow;
      document.documentElement.style.overflow = htmlOverflow;
    };
  }, [active, insidePanel]);
  useEffect(() => {
    if (!active) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setActive(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setActive(null); document.getElementById(`tool-${active}`)?.focus(); } };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [active]);
  return <div className="workspace-tools" ref={root}>
    <nav className="tool-bubbles" aria-label={lang === 'id' ? 'Menu meja trading' : 'Desk tools'}>
      {TOOLS.map((tool) => <button id={`tool-${tool.id}`} key={tool.id} className={active === tool.id ? 'is-active' : ''} aria-expanded={active === tool.id} aria-controls={`pane-${tool.id}`} onClick={() => { setInsidePanel(false); setActive(active === tool.id ? null : tool.id); }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d={tool.path} /></svg>
        <span>{tool.label}</span>
      </button>)}
    </nav>
    <div className="tool-flyout" hidden={!active} onPointerEnter={() => setInsidePanel(true)} onPointerLeave={() => setInsidePanel(false)}>
      <button className="tool-close" onClick={() => { document.getElementById(`tool-${active}`)?.focus(); setActive(null); }} aria-label={lang === 'id' ? 'Tutup panel' : 'Close tool panel'}>×</button>
      <div className="tool-pane" id="pane-ops" hidden={active !== 'ops'}><DeskOps state={state} /></div>
      <div className="tool-pane" id="pane-book" hidden={active !== 'book'}><Portfolio state={state} command={command} /></div>
      <div className="tool-pane" id="pane-lessons" hidden={active !== 'lessons'}><Lessons state={state} /></div>
      <div className="tool-pane" id="pane-log" hidden={active !== 'log'}><TradeLog state={state} /></div>
    </div>
  </div>;
}
