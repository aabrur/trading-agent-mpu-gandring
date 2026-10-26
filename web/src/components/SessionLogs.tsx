import { useCallback, useEffect, useRef, useState } from 'react';
import { mergeOlderSessionEvents, mergeOlderSessions, sessionEventsUrl } from '../sessionLogsData';

type SessionOutcome = 'CLEAN_SHUTDOWN' | 'STARTUP_FAILURE' | 'RUNTIME_ERROR' | 'INTERRUPTED' | 'UNCLEAN_TERMINATION';
type SessionSummary = {
  sessionId: string;
  parentSessionId: string | null;
  startedAt: string;
  endedAt: string | null;
  version: string;
  gitRevision: string | null;
  pid: number;
  entrypoint: string;
  mode: string;
  appMode: string;
  exchange: string | null;
  outcome: SessionOutcome | null;
  exitReason: string | null;
  durationMs: number | null;
  lastSequence: number;
  storageErrors: number;
  unclean?: { inferred: boolean; detectedAt: string; reason: string };
};
type SessionEvent = {
  timestamp: string;
  sessionId: string;
  sequence: number;
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  category: string;
  source: string;
  eventName: string;
  status: string;
  message: string;
  correlationId: string | null;
  durationMs?: number;
  details: Record<string, unknown>;
};

const PAGE_SIZE = 100;
const MAX_EVENTS = 500;
const MAX_SESSIONS = 500;
const levels = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const;
const localTime = (value: string) => new Date(value).toLocaleString();
const duration = (value: number | null, lang: 'en' | 'id') => value === null ? (lang === 'id' ? 'tidak diketahui' : 'unknown') : `${Math.round(value / 1000)}s`;

export function SessionLogs({ lang = 'en' }: { lang?: 'en' | 'id' }) {
  const id = lang === 'id';
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionsCursor, setSessionsCursor] = useState<string | null>(null);
  const [sessionsBusy, setSessionsBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [level, setLevel] = useState('');
  const [source, setSource] = useState('');
  const [query, setQuery] = useState('');
  const [correlationId, setCorrelationId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const eventRequestId = useRef(0);
  const eventController = useRef<AbortController | null>(null);
  const sessionsRequestId = useRef(0);
  const sessionsController = useRef<AbortController | null>(null);
  const olderSessionsRequestId = useRef(0);
  const olderSessionsController = useRef<AbortController | null>(null);

  const invalidateEvents = (clearEvents = false) => {
    eventRequestId.current++;
    eventController.current?.abort();
    eventController.current = null;
    setLoading(false);
    setCursor(null);
    setHasMore(false);
    // Re-selecting the same session/correlation still needs a replacement request.
    setRefreshKey(key => key + 1);
    if (clearEvents) setEvents([]);
  };

  const refreshSessions = useCallback(async () => {
    sessionsController.current?.abort();
    olderSessionsController.current?.abort();
    olderSessionsRequestId.current++;
    const controller = new AbortController();
    sessionsController.current = controller;
    const requestId = ++sessionsRequestId.current;
    setSessionsBusy(true);
    setError('');
    try {
      const response = await fetch('/api/logs/sessions', { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { activeSessionId: string | null; sessions: SessionSummary[]; nextCursor: string | null };
      let page = data.sessions.slice(0, MAX_SESSIONS);
      if (data.activeSessionId && !page.some(session => session.sessionId === data.activeSessionId)) {
        try {
          const activeResponse = await fetch(`/api/logs/sessions/${encodeURIComponent(data.activeSessionId)}`, { signal: controller.signal });
          if (activeResponse.ok) {
            const activeData = await activeResponse.json() as { session: SessionSummary };
            page = [activeData.session, ...page].slice(0, MAX_SESSIONS);
          }
        } catch { if (controller.signal.aborted) return; }
      }
      if (controller.signal.aborted || requestId !== sessionsRequestId.current) return;
      setSessions(page);
      setActiveSessionId(data.activeSessionId);
      setSessionsCursor(data.nextCursor);
      setSelected(current => data.activeSessionId && page.some(session => session.sessionId === data.activeSessionId)
        ? data.activeSessionId
        : current && page.some(session => session.sessionId === current) ? current : page[0]?.sessionId ?? null);
      setRefreshKey(key => key + 1);
    } catch (reason) {
      if (!controller.signal.aborted && requestId === sessionsRequestId.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!controller.signal.aborted && requestId === sessionsRequestId.current) {
        setSessionsBusy(false);
        sessionsController.current = null;
      }
    }
  }, []);

  useEffect(() => {
    void refreshSessions();
    return () => {
      sessionsRequestId.current++;
      sessionsController.current?.abort();
      olderSessionsRequestId.current++;
      olderSessionsController.current?.abort();
    };
  }, [refreshSessions]);

  useEffect(() => {
    if (!selected) { setEvents([]); setCursor(null); setHasMore(false); return; }
    const controller = new AbortController();
    eventController.current?.abort();
    eventController.current = controller;
    const requestId = ++eventRequestId.current;
    setLoading(true);
    setError('');
    const url = sessionEventsUrl(selected, { level, source, query, correlationId }, PAGE_SIZE);
    fetch(url, { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<{ events: SessionEvent[]; nextCursor: string | null }>;
      })
      .then(data => {
        if (controller.signal.aborted || requestId !== eventRequestId.current) return;
        setEvents(data.events);
        setCursor(data.nextCursor);
        setHasMore(Boolean(data.nextCursor));
      })
      .catch(reason => {
        if (!controller.signal.aborted && requestId === eventRequestId.current) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted && requestId === eventRequestId.current) {
          setLoading(false);
          eventController.current = null;
        }
      });
    return () => {
      controller.abort();
      eventController.current?.abort();
      eventController.current = null;
      if (requestId === eventRequestId.current) eventRequestId.current++;
    };
  }, [selected, level, source, query, correlationId, refreshKey]);

  const loadOlder = async () => {
    if (!selected || !cursor || loading) return;
    eventController.current?.abort();
    const controller = new AbortController();
    eventController.current = controller;
    const requestId = ++eventRequestId.current;
    const requestedSession = selected;
    setLoading(true);
    setError('');
    try {
      const response = await fetch(sessionEventsUrl(requestedSession, { level, source, query, correlationId, cursor }, PAGE_SIZE), { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { events: SessionEvent[]; nextCursor: string | null };
      if (controller.signal.aborted || requestId !== eventRequestId.current || requestedSession !== selected) return;
      setEvents(current => mergeOlderSessionEvents(data.events, current, MAX_EVENTS));
      setCursor(data.nextCursor);
      setHasMore(Boolean(data.nextCursor));
    } catch (reason) {
      if (!controller.signal.aborted && requestId === eventRequestId.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!controller.signal.aborted && requestId === eventRequestId.current) {
        setLoading(false);
        eventController.current = null;
      }
    }
  };

  const loadOlderSessions = async () => {
    if (!sessionsCursor || sessionsBusy) return;
    olderSessionsController.current?.abort();
    const controller = new AbortController();
    olderSessionsController.current = controller;
    const requestId = ++olderSessionsRequestId.current;
    setSessionsBusy(true);
    try {
      const response = await fetch(`/api/logs/sessions?cursor=${encodeURIComponent(sessionsCursor)}`, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { activeSessionId?: string | null; sessions: SessionSummary[]; nextCursor: string | null };
      if (controller.signal.aborted || requestId !== olderSessionsRequestId.current) return;
      const mergedSessions = mergeOlderSessions(sessions, data.sessions, MAX_SESSIONS);
      setSessions(mergedSessions);
      if (selected && !mergedSessions.some(session => session.sessionId === selected)) {
        invalidateEvents(true);
        setSelected(mergedSessions[0]?.sessionId ?? null);
      }
      if (data.activeSessionId !== undefined) setActiveSessionId(data.activeSessionId);
      setSessionsCursor(data.nextCursor);
    } catch (reason) {
      if (!controller.signal.aborted && requestId === olderSessionsRequestId.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!controller.signal.aborted && requestId === olderSessionsRequestId.current) {
        setSessionsBusy(false);
        olderSessionsController.current = null;
      }
    }
  };

  const active = sessions.find(session => session.sessionId === selected);
  return <div className="session-archive">
    <div className="session-archive-top">
      <label>{id ? 'Sesi' : 'Session'}
        <select aria-label={id ? 'Pilih sesi arsip' : 'Choose archived session'} value={selected ?? ''} onChange={event => { invalidateEvents(true); setSelected(event.target.value || null); }}>
          {!sessions.length && <option value="">{sessionsBusy ? (id ? 'Memuat…' : 'Loading…') : (id ? 'Tidak ada sesi' : 'No sessions')}</option>}
          {sessions.map(session => <option key={session.sessionId} value={session.sessionId}>{session.sessionId === activeSessionId ? (id ? 'SESI AKTIF · ' : 'ACTIVE · ') : ''}{localTime(session.startedAt)} · {session.outcome ?? (session.endedAt ? 'ENDED' : 'RUNNING')} · {session.sessionId.slice(-8)}</option>)}
        </select>
      </label>
      <button type="button" onClick={() => { invalidateEvents(); void refreshSessions(); }} disabled={sessionsBusy}>{sessionsBusy ? (id ? 'Memuat…' : 'Refreshing…') : (id ? 'Perbarui sesi' : 'Refresh sessions')}</button>
      <div className="session-downloads" aria-label={id ? 'Unduh log sesi' : 'Download session logs'}>
        {(['console', 'errors', 'events', 'session'] as const).map(file => <a key={file} href={selected ? `/api/logs/sessions/${encodeURIComponent(selected)}/download?file=${file}` : undefined} aria-disabled={!selected}>{file}</a>)}
      </div>
    </div>
    {active && <div className="session-summary">
      <span>{active.mode} · {active.appMode}{active.exchange ? ` · ${active.exchange}` : ''}</span>
      <span>{active.outcome ?? (active.endedAt ? 'ENDED' : 'RUNNING')}{active.exitReason ? ` · ${active.exitReason}` : ''}</span>
      <span>{active.version} · {active.gitRevision ? active.gitRevision.slice(0, 8) : (id ? 'revisi tidak tersedia' : 'revision unavailable')} · PID {active.pid}</span>
      <span>{duration(active.durationMs, lang)} · {active.lastSequence} {id ? 'catatan' : 'events'} · {active.storageErrors} {id ? 'kesalahan penyimpanan' : 'storage errors'}</span>
      {active.unclean?.inferred && <strong role="status">{id ? 'Terminasi tidak bersih terdeteksi' : 'Unclean termination inferred'} · {active.unclean.reason}</strong>}
    </div>}
    <div className="session-filters">
      <label>Level<select value={level} onChange={event => { invalidateEvents(); setLevel(event.target.value); }}><option value="">{id ? 'Semua' : 'All'}</option>{levels.map(item => <option key={item}>{item}</option>)}</select></label>
      <label>{id ? 'Sumber' : 'Source'}<input value={source} onChange={event => { invalidateEvents(); setSource(event.target.value); }} placeholder={id ? 'Filter sumber' : 'Filter source'} /></label>
      <label>{id ? 'Cari pesan' : 'Search message'}<input type="search" value={query} onChange={event => { invalidateEvents(); setQuery(event.target.value); }} placeholder={id ? 'Cari pesan atau detail' : 'Search message or details'} /></label>
      <label>{id ? 'ID korelasi' : 'Correlation ID'}<input value={correlationId} onChange={event => { invalidateEvents(); setCorrelationId(event.target.value); }} placeholder={id ? 'Klik ID di bawah' : 'Click an ID below'} /></label>
    </div>
    {error && <p className="session-error" role="alert">{id ? 'Log sesi gagal dimuat' : 'Could not load session logs'}: {error}</p>}
    <div className="session-event-list" role="region" aria-label={id ? 'Peristiwa sesi' : 'Session events'} aria-busy={loading}>
      {events.map(event => <article className={`session-event level-${event.level.toLowerCase()}`} key={`${event.sessionId}:${event.sequence}`}>
        <time dateTime={event.timestamp}>{localTime(event.timestamp)}</time>
        <b>{event.level}</b><b>{event.source}</b><span>{event.category} · {event.eventName}{event.status ? ` · ${event.status}` : ''}</span>
        <p>{event.message}</p>
        {event.correlationId && <button className="session-correlation" type="button" onClick={() => { invalidateEvents(); setCorrelationId(event.correlationId!); }} title={id ? 'Filter dengan ID korelasi ini' : 'Filter by this correlation ID'}>{event.correlationId}</button>}
        {event.durationMs !== undefined && <small>{event.durationMs}ms</small>}
        {Object.keys(event.details).length > 0 && <details className="session-event-details"><summary>{id ? 'Detail' : 'Details'}</summary><pre>{JSON.stringify(event.details, null, 2)}</pre></details>}
      </article>)}
      {!loading && !error && !events.length && <p className="muted">{id ? 'Tidak ada peristiwa yang cocok.' : 'No matching session events.'}</p>}
      {loading && <p role="status">{id ? 'Memuat peristiwa…' : 'Loading events…'}</p>}
    </div>
    <div className="session-archive-actions">
      {hasMore && <button type="button" onClick={loadOlder} disabled={loading}>{id ? 'Peristiwa lebih lama' : 'Older events'}</button>}
      {sessionsCursor && <button type="button" onClick={loadOlderSessions} disabled={sessionsBusy}>{id ? 'Sesi lebih lama' : 'Older sessions'}</button>}
    </div>
  </div>;
}
