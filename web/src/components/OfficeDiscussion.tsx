import { useLayoutEffect, useRef, useState } from 'react';
import type { DeskState, Speech } from '../types';
import { useI18n } from '../i18n';
import { discussionMessages } from '../discussion';

export function OfficeDiscussion({
  state,
  latest,
  onSelect,
  command,
  activeConversationId,
  onSelectConversation,
  onNewConversation
}: {
  state: DeskState;
  latest?: Speech;
  onSelect: (id: Speech['agent']) => void;
  command?: (text: string, agent?: Speech['agent']) => Promise<{ ok: boolean; reply?: string }>;
  activeConversationId?: string;
  onSelectConversation?: (id: string) => void;
  onNewConversation?: () => Promise<string>;
}) {
  const { lang } = useI18n();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const [text, setText] = useState('');
  const [target, setTarget] = useState<Speech['agent'] | 'all'>('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const messages = discussionMessages(state, latest, activeConversationId);
  const last = messages.at(-1);

  useLayoutEffect(() => {
    if (open && followLatest.current && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [open, last?.at, last?.text, latest?.text]);

  const send = async () => {
    if (!command || !text.trim() || busy) return;
    setBusy(true); setError(''); followLatest.current = true;
    try {
      const result = await command(target === 'all' ? `@all ${text.trim()}` : text.trim(), target === 'all' ? undefined : target);
      if (!result.ok) throw new Error(result.reply || 'Message could not be sent');
      setText('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Office not reachable'); }
    finally { setBusy(false); }
  };

  return <div className="office-discussion" onKeyDown={(event) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } }}>
    <button ref={trigger} className="discussion-bubble" aria-expanded={open} aria-controls="office-transcript" onClick={() => { followLatest.current = true; setOpen(!open); }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M4 4h16v12H9l-5 4zM8 8h8m-8 4h5" /></svg>
      {lang === 'id' ? 'Diskusi' : 'Desk chat'}
      {latest && <i aria-label={lang === 'id' ? 'Percakapan terbaru' : 'Recent speech'} />}
    </button>
    {open && <section id="office-transcript" className="discussion-popover" aria-label={lang === 'id' ? 'Diskusi kantor' : 'Office discussion'}>
      <div className="discussion-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
          <b>{lang === 'id' ? 'Diskusi kantor' : 'Office discussion'}</b>
          {state.conversations && state.conversations.length > 0 && onSelectConversation && (
            <select
              aria-label="Conversation selector"
              value={activeConversationId || 'office'}
              onChange={e => onSelectConversation(e.target.value)}
              style={{ fontSize: '11px', padding: '2px 4px', borderRadius: '4px', background: 'var(--panel-2, rgba(255,255,255,0.06))', color: 'inherit', border: '1px solid var(--line, rgba(255,255,255,0.15))' }}
            >
              <option value="office">{lang === 'id' ? 'Ruang Utama' : 'Main Office'}</option>
              {state.conversations.filter(c => c.id !== 'office').map(c => (
                <option key={c.id} value={c.id}>{c.title || c.id}</option>
              ))}
            </select>
          )}
          {onNewConversation && (
            <button
              type="button"
              title={lang === 'id' ? 'Mulai percakapan baru' : 'Start new conversation'}
              onClick={() => void onNewConversation()}
              style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '4px', cursor: 'pointer', background: 'var(--panel-3, rgba(255,255,255,0.1))', color: 'inherit', border: '1px solid var(--line, rgba(255,255,255,0.2))' }}
            >
              + New
            </button>
          )}
        </div>
        <button onClick={() => { setOpen(false); trigger.current?.focus(); }} aria-label="Close discussion">×</button>
      </div>
      <div className="discussion-lines" role="log" aria-live="polite" ref={body} onScroll={() => { const element = body.current; if (element) followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40; }}>
        {!messages.length && <p className="muted">{lang === 'id' ? 'Percakapan muncul saat agen berdiskusi.' : 'Agent conversations appear here during a debate.'}</p>}
        {messages.map((msg, i) => {
            const fromName = msg.from === 'owner' ? 'Boss' : (state.agents[msg.from]?.name ?? msg.from);
            const toName = msg.to ? (msg.to === 'owner' ? 'Boss' : msg.to === 'all' ? '@all' : (state.agents[msg.to]?.name ?? msg.to)) : '';
            const targetAgent = msg.from !== 'owner' ? msg.from : (msg.to && msg.to !== 'all' && msg.to !== 'owner' ? msg.to : undefined);
            return (
              <button key={`${msg.id || msg.at}-${i}`} onClick={() => targetAgent && onSelect(targetAgent)}>
                <b>{fromName}{toName ? ` -> ${toName}` : ''}</b>
                <span>{msg.text}</span>
                {msg.example && <small>EXAMPLE</small>}
              </button>
            );
          })}
      </div>
      <form className="discussion-compose" onSubmit={event => { event.preventDefault(); void send(); }}>
        <label>{lang === 'id' ? 'Kirim ke' : 'Send to'} <select aria-label="Discussion recipient" value={target} disabled={busy} onChange={event => setTarget(event.target.value as typeof target)}>
          <option value="all">{lang === 'id' ? 'Semua agen' : 'All agents'}</option>
          {Object.values(state.agents).map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
        </select></label>
        <textarea aria-label="Discussion message" name="discussion-message" placeholder={lang === 'id' ? 'Tulis pesan untuk meja trading…' : 'Message the desk…'} value={text} maxLength={31995} rows={2} disabled={busy} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
        <button type="submit" disabled={!command || busy || !text.trim()} aria-busy={busy}>{busy ? (lang === 'id' ? 'Mengirim…' : 'Sending…') : (lang === 'id' ? 'Kirim' : 'Send')}</button>
        {error && <p role="alert">{error}</p>}
      </form>
    </section>}
  </div>;
}
