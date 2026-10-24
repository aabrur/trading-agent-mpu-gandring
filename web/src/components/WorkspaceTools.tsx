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
  { id: 'log', label: 'Log', path: 'M6 3h12v18H6zM9 8h6m-6 4h6m-6 4h4' },
  { id: 'history', label: 'History', path: 'M3 11a9 9 0 1 1 2.6 7M3 4v7h7m2-5v6l4 2' }
] as const;

export function WorkspaceTools({ state, command, onActiveChange }: { state: DeskState; command: (text: string) => void; onActiveChange?: (active: string | null) => void }) {
  const { lang } = useI18n();
  const [active, setActive] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const setTool = (id: string | null) => {
    setActive(id);
    onActiveChange?.(id);
  };

  useEffect(() => {
    if (!active) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setTool(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setTool(null); document.getElementById(`tool-${active}`)?.focus(); } };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [active]);
  return <div className="workspace-tools" ref={root}>
    <nav className="tool-bubbles" aria-label={lang === 'id' ? 'Menu meja trading' : 'Desk tools'}>
      {TOOLS.map((tool) => <button id={`tool-${tool.id}`} key={tool.id} className={active === tool.id ? 'is-active' : ''} aria-expanded={active === tool.id} aria-controls={`pane-${tool.id}`} onClick={() => setTool(active === tool.id ? null : tool.id)}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d={tool.path} /></svg>
        <span>{tool.label}</span>
      </button>)}
    </nav>
    <div className={`tool-flyout${active === 'log' || active === 'history' ? ' is-log' : ''}`} hidden={!active}>
      <button className="tool-close" onClick={() => { document.getElementById(`tool-${active}`)?.focus(); setTool(null); }} aria-label={lang === 'id' ? 'Tutup panel' : 'Close tool panel'}>×</button>
      <div className="tool-pane" id="pane-ops" hidden={active !== 'ops'}><DeskOps state={state} /></div>
      <div className="tool-pane" id="pane-book" hidden={active !== 'book'}><Portfolio state={state} command={command} /></div>
      <div className="tool-pane" id="pane-lessons" hidden={active !== 'lessons'}><Lessons state={state} /></div>
      <div className="tool-pane" id="pane-log" hidden={active !== 'log'}><TradeLog state={state} active={active === 'log'} /></div>
      <div className="tool-pane" id="pane-history" hidden={active !== 'history'}><TradeLog state={state} active={active === 'history'} view="history" /></div>
    </div>
  </div>;
}
