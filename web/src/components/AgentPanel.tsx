import { useEffect, useRef, useState } from 'react';
import type { AgentId, DeskState } from '../types';
import { Bot } from './Bot';
import { useI18n } from '../i18n';

const QUICK_EN: Record<AgentId, string[]> = {
  lead: ['analyze ETHUSDT', 'What did we learn so far?', 'be more cautious', 'status'],
  market: ['analyze SOLUSDT', 'What is the tape saying?', 'be more aggressive'],
  research: ['Anything that would make you veto?', 'be more cautious'],
  strategist: ['Explain your rule in one line', 'analyze ETHUSDT'],
  risk: ['be more cautious', 'calm down', 'close all'],
  execution: ['close all', 'status']
};

const QUICK_ID: Record<AgentId, string[]> = {
  lead: ['analyze ETHUSDT', 'Apa yang kita pelajari sejauh ini?', 'lebih hati-hati', 'status'],
  market: ['analyze SOLUSDT', 'Bagaimana kondisi orderbook?', 'lebih agresif'],
  research: ['Ada indikasi yang memicu veto?', 'lebih hati-hati'],
  strategist: ['Jelaskan strategimu dalam satu baris', 'analyze ETHUSDT'],
  risk: ['lebih hati-hati', 'tenang dulu', 'close all'],
  execution: ['close all', 'status']
};

export function AgentPanel({ state, id, onClose, command, conversationId }: { state: DeskState; id: AgentId; onClose: () => void; command: (t: string, a?: AgentId) => Promise<unknown>; conversationId?: string }) {
  const { t, lang } = useI18n();
  const a = state.agents[id];
  const allChat = state.chats[id] ?? [];
  const chat = conversationId && conversationId !== 'office'
    ? allChat.filter(c => (c.conversationId ?? 'office') === conversationId)
    : allChat.filter(c => (c.conversationId ?? 'office') === 'office' || !c.conversationId);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { body.current?.scrollTo({ top: body.current.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }, [chat.length]);
  const send = async (t: string) => {
    if (!t.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const result = await command(t, id) as { ok?: boolean; reply?: string };
      if (result?.ok === false) throw new Error(result.reply || 'Message could not be sent');
      setText('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Office not reachable'); }
    finally { setBusy(false); }
  };
  const quickList = lang === 'id' ? QUICK_ID[id] : QUICK_EN[id];
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
            {a.fellBackToMock && <span className="chip warn" title={lang === 'id' ? 'Provider tidak memiliki key di .env' : 'Mapped provider has no key in .env'}>{t('apNoKeyMock')}</span>}
            <span className="chip">{t('apMoodLabel')} {a.mood > 0 ? `+${a.mood}` : a.mood}</span>
            {a.stance && <span className={`stance s-${a.stance}`}>{a.stance}</span>}
          </div>
        </div>
      </div>
      <div className="ap-chat" ref={body}>
        {a.lastLine && <section className="ap-desk-speech"><small>{t('apLatestDeskSpeech')}{a.provider === 'mock' || a.fellBackToMock ? ' · EXAMPLE' : ''}</small><p>{a.lastLine}</p></section>}
        {chat.length === 0 && <p className="muted">{t('apSaySomething')}</p>}
        {chat.map((c, i) => (
          <div key={i} className={`msg ${c.from === 'user' ? 'me' : 'them'}`}><span>{c.text}</span></div>
        ))}
        {busy && <div className="msg them typing"><span><i /><i /><i /></span></div>}
      </div>
      <div className="ap-quick">{quickList.map((q) => <button key={q} onClick={() => send(q)}>{q}</button>)}</div>
      <form className="ap-input" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
        <textarea rows={3} disabled={busy} name="agent-message" aria-describedby={error ? 'agent-message-error' : undefined} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(text); }
        }} aria-label={`Message ${a.name}`} placeholder={`${t('apMsgPlaceholder')} ${a.name}...`} maxLength={32000} />
        <button type="submit" disabled={busy} aria-busy={busy}>{t('apSendBtn')}</button>
        {error && <p id="agent-message-error" role="alert">{error}</p>}
      </form>
    </aside>
  );
}
