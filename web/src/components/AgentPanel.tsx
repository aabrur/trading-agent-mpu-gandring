import { useEffect, useRef, useState } from 'react';
import type { AgentId, DeskState } from '../types';
import { Bot } from './Bot';
import { officeFetch } from '../officeApi';
import type { ChatLine } from '../types';
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

export function AgentPanel({ state, id, onClose, command, conversationId }: { state: DeskState; id: AgentId; onClose: () => void; command: (t: string, a?: AgentId, clientRequestId?: string) => Promise<unknown>; conversationId?: string }) {
  const { t, lang } = useI18n();
  const a = state.agents[id];
  const allChat = state.chats[id] ?? [];
  const activeChat = conversationId && conversationId !== 'office'
    ? allChat.filter(c => (c.conversationId ?? 'office') === conversationId)
    : allChat.filter(c => (c.conversationId ?? 'office') === 'office' || !c.conversationId);
  type Archive = { id: string; startedAt: number; endedAt: number | null; legacy: boolean; recovered: boolean; messageCount: number; preview: string };
  const [archiveOffset, setArchiveOffset] = useState<number | null>(null);
  const [archives, setArchives] = useState<Archive[] | null>(null);
  const [selected, setSelected] = useState<Archive | null>(null);
  const [historical, setHistorical] = useState<ChatLine[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const historyGeneration = useRef(0);
  const panelGeneration = useRef(0);
  const sending = useRef(false);
  const [retry, setRetry] = useState<{ text: string; id: string; newSend?: boolean } | null>(null);
  const chat = selected ? historical : activeChat;
  const pending = [...activeChat].reverse().find(c => c.from === 'user' && c.status && ['pending', 'model_working', 'waiting_on_venue', 'consulting'].includes(c.status));
  const busyRemote = !!pending;
  const historyButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { historyGeneration.current++; panelGeneration.current++; setSelected(null); setArchives(null); setHistorical([]); setHistoryBusy(false); setError(''); setRetry(null); setBusy(false); sending.current = false; }, [id, state.operationalChat?.id]);
  useEffect(() => () => { historyGeneration.current++; panelGeneration.current++; }, []);
  const loadArchives = async (offset = 0) => {
    const generation = ++historyGeneration.current;
    setHistoryBusy(true); setError('');
    try {
      const response = await officeFetch(`/api/chat/history/${id}?offset=${offset}&limit=50`);
      const data = await response.json() as { sessions?: Archive[]; nextOffset?: number | null; error?: string };
      if (!response.ok) throw new Error(data.error || 'History unavailable');
      if (generation === historyGeneration.current) { setArchives(current => offset ? [...(current ?? []), ...(data.sessions ?? [])] : data.sessions ?? []); setArchiveOffset(data.nextOffset ?? null); }
    } catch (e) { if (generation === historyGeneration.current) setError((e as Error).message); }
    finally { if (generation === historyGeneration.current) setHistoryBusy(false); }
  };
  const openArchive = async (archive: Archive, offset = 0) => {
    const generation = ++historyGeneration.current;
    setHistoryBusy(true); setError('');
    try {
      const response = await officeFetch(`/api/chat/history/${id}/${archive.id}?offset=${offset}&limit=50`);
      const data = await response.json() as { messages: ChatLine[]; nextOffset: number | null; error?: string };
      if (!response.ok) throw new Error(data.error || 'History unavailable');
      if (generation === historyGeneration.current) { setSelected(archive); setHistorical(current => offset ? [...current, ...data.messages] : data.messages); setNextOffset(data.nextOffset); }
    } catch (e) { if (generation === historyGeneration.current) setError((e as Error).message); }
    finally { if (generation === historyGeneration.current) setHistoryBusy(false); }
  };
  const deleteArchive = async (archive: Archive) => {
    if (!window.confirm(lang === 'id' ? 'Hapus permanen riwayat chat agen ini? Catatan trading tetap disimpan.' : 'Permanently delete this agent chat? Trading records remain saved.')) return;
    const generation = ++historyGeneration.current;
    setHistoryBusy(true);
    try {
      const response = await officeFetch(`/api/chat/history/${id}/${archive.id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
      if (!response.ok) throw new Error('History could not be deleted');
      if (generation !== historyGeneration.current) return;
      setSelected(null); setHistorical([]); await loadArchives();
      if (historyGeneration.current === generation + 1) historyButton.current?.focus();
    } catch (e) { if (generation === historyGeneration.current) setError((e as Error).message); }
    finally { if (generation === historyGeneration.current) setHistoryBusy(false); }
  };
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { body.current?.scrollTo({ top: body.current.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }, [chat.length]);
  const send = async (t: string, requestId: string = crypto.randomUUID()) => {
    const trimmed = t.trim();
    if (!trimmed || sending.current || busyRemote || selected) return;
    const generation = panelGeneration.current;
    sending.current = true;
    setText('');
    setBusy(true); setError('');
    try {
      const result = await command(trimmed, id, requestId) as { ok?: boolean; reply?: string };
      if (generation !== panelGeneration.current) return;
      if (result?.ok === false) { setError(result.reply || 'Message could not be sent'); setRetry({ text: trimmed, id: crypto.randomUUID(), newSend: true }); } else setRetry(null);
    } catch (reason) {
      if (generation !== panelGeneration.current) return;
      setError(reason instanceof Error ? reason.message : 'Office not reachable');
      setRetry({ text: trimmed, id: requestId });
    } finally {
      if (generation === panelGeneration.current) { setBusy(false); sending.current = false; }
    }
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
      <div className="ap-history-controls">
        <button ref={historyButton} aria-expanded={archives !== null} disabled={historyBusy} onClick={() => { if (archives) { historyGeneration.current++; setArchives(null); setSelected(null); } else void loadArchives(); }}>{lang === 'id' ? 'Riwayat sesi' : 'Session history'}</button>
        {selected && <button onClick={() => { historyGeneration.current++; setSelected(null); setHistorical([]); setHistoryBusy(false); }}>{lang === 'id' ? 'Kembali ke chat aktif' : 'Back to active chat'}</button>}
        {selected && <button disabled={historyBusy} onClick={() => void deleteArchive(selected)}>{lang === 'id' ? 'Hapus sesi' : 'Delete session'}</button>}
      </div>
      {state.operationalChat?.recovered && !selected && <small role="status">{lang === 'id' ? 'Sesi dipulihkan setelah penghentian tak bersih.' : 'Session recovered after an unclean shutdown.'}</small>}
      <div className="ap-chat" ref={body} aria-live="polite" aria-busy={historyBusy}>
        {archives && !selected ? <>
          <p>{lang === 'id' ? 'Riwayat chat pribadi' : 'Private chat history'}</p>
          {!archives.length && <p className="muted">{lang === 'id' ? 'Belum ada arsip.' : 'No archived sessions.'}</p>}
          {archives.map(archive => <button className="ap-history-entry" key={archive.id} onClick={() => void openArchive(archive)}>
            <strong>{archive.legacy ? 'Legacy history' : new Date(archive.startedAt).toLocaleString()}</strong>
            <small>{a.title}, {archive.messageCount} {lang === 'id' ? 'pesan' : 'messages'}{archive.endedAt ? `, ${new Date(archive.endedAt).toLocaleString()}` : ''}</small>
            <span>{archive.preview}</span>
          </button>)}
          {archiveOffset !== null && <button disabled={historyBusy} onClick={() => void loadArchives(archiveOffset)}>Load more sessions</button>}
          <button onClick={() => { historyGeneration.current++; setArchives(null); setHistoryBusy(false); }}>{lang === 'id' ? 'Kembali ke chat aktif' : 'Back to active chat'}</button>
        </> : <>
          {selected && <p className="muted">{lang === 'id' ? 'Arsip hanya baca' : 'Read-only archive'}</p>}
          {chat.length === 0 && <p className="muted">{t('apSaySomething')}</p>}
          {chat.map(c => <div key={c.id} className={`msg ${c.from === 'user' ? 'me' : 'them'}`}>
            <span>{c.text}</span>
            <small><time dateTime={new Date(c.at).toISOString()}>{new Date(c.at).toLocaleTimeString()}</time>{c.from !== 'user' && c.status && c.status !== 'completed' ? `, ${c.status}` : ''}</small>
          </div>)}
          {selected && nextOffset !== null && <button disabled={historyBusy} onClick={() => void openArchive(selected, nextOffset)}>{lang === 'id' ? 'Muat lagi' : 'Load more'}</button>}
          {!selected && (busy || busyRemote) && <div className="msg them" role="status"><span>{pending?.status === 'waiting_on_venue' ? 'Waiting on venue…' : pending?.status === 'consulting' ? 'Consulting teammates…' : pending?.status === 'model_working' ? 'Model working…' : 'Request pending…'}</span>
            {pending?.clientRequestId && <button onClick={() => void officeFetch(`/api/chat/cancel/${pending.clientRequestId}`, { method: 'POST' }).catch(e => setError((e as Error).message))}>Cancel</button>}
          </div>}
        </>}
      </div>
      <div className="ap-quick" hidden={!!selected || archives !== null}>{quickList.map((q) => <button key={q} disabled={busy || busyRemote} onClick={() => void send(q)}>{q}</button>)}</div>
      <form className="ap-input" hidden={!!selected || archives !== null} onSubmit={(e) => { e.preventDefault(); void send(text); }}>
        <textarea rows={3} disabled={busy || busyRemote || !!selected} name="agent-message" aria-describedby={error ? 'agent-message-error' : undefined} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(text); }
        }} aria-label={`Message ${a.name}`} placeholder={`${t('apMsgPlaceholder')} ${a.name}...`} maxLength={32000} />
        <button type="submit" disabled={busy || busyRemote || !!selected} aria-busy={busy}>{t('apSendBtn')}</button>
        {retry && <button type="button" disabled={busy || busyRemote} onClick={() => void send(retry.text, retry.id)}>{retry.newSend ? 'Retry message' : 'Check or retry request'}</button>}
        {error && <p id="agent-message-error" role="alert">{error}</p>}
      </form>
      {(selected || archives !== null) && error && <p role="alert">{error}</p>}
    </aside>
  );
}
