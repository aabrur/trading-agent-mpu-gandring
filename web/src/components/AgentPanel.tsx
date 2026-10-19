import { useEffect, useRef, useState } from 'react';
import type { AgentId, DeskState } from '../types';
import { Bot } from './Bot';

const QUICK: Record<AgentId, string[]> = {
  lead: ['analyze ETHUSDT', 'What did we learn so far?', 'be more cautious', 'status'],
  market: ['analyze SOLUSDT', 'What is the tape saying?', 'be more aggressive'],
  research: ['Anything that would make you veto?', 'be more cautious'],
  strategist: ['Explain your rule in one line', 'analyze ETHUSDT'],
  risk: ['be more cautious', 'calm down', 'close all'],
  execution: ['close all', 'status']
};

export function AgentPanel({ state, id, onClose, command }: { state: DeskState; id: AgentId; onClose: () => void; command: (t: string, a?: AgentId) => Promise<unknown> }) {
  const a = state.agents[id];
  const chat = state.chats[id] ?? [];
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { body.current?.scrollTo({ top: body.current.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }, [chat.length]);
  const send = async (t: string) => {
    if (!t.trim() || busy) return;
    setBusy(true); setText('');
    try { await command(t, id); } finally { setBusy(false); }
  };
  return (
    <aside className="agent-panel" style={{ ['--agent' as string]: a.color }} aria-label={`${a.name} panel`}>
      <button className="close" onClick={onClose} aria-label="close">×</button>
      <div className="ap-head">
        <div className="ap-avatar"><Bot id={id} size={78} pose={busy ? 'type' : 'idle'} talking={busy} /></div>
        <div>
          <h3>{a.name}</h3>
          <p>{a.title}</p>
          <div className="ap-tags">
            <span className="chip">{a.provider}/{a.model}</span>
            {a.fellBackToMock && <span className="chip warn" title="Mapped provider has no key in .env">no key, using mock</span>}
            <span className="chip">mood {a.mood > 0 ? `+${a.mood}` : a.mood}</span>
            {a.stance && <span className={`stance s-${a.stance}`}>{a.stance}</span>}
          </div>
        </div>
      </div>
      <div className="ap-chat" ref={body}>
        {a.lastLine && <section className="ap-desk-speech"><small>Latest desk speech{a.provider === 'mock' || a.fellBackToMock ? ' · EXAMPLE' : ''}</small><p>{a.lastLine}</p></section>}
        {chat.length === 0 && <p className="muted">Say something, or give an order. Try a quick command below.</p>}
        {chat.map((c, i) => (
          <div key={i} className={`msg ${c.from === 'user' ? 'me' : 'them'}`}><span>{c.text}</span></div>
        ))}
        {busy && <div className="msg them typing"><span><i /><i /><i /></span></div>}
      </div>
      <div className="ap-quick">{QUICK[id].map((q) => <button key={q} onClick={() => send(q)}>{q}</button>)}</div>
      <form className="ap-input" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={`Message ${a.name}...`} maxLength={500} />
        <button type="submit" disabled={busy}>Send</button>
      </form>
    </aside>
  );
}
