import { useCallback, useEffect, useRef, useState } from 'react';
import { installDiagnostics } from './diagnostics';
import { verdictReactions, type SceneEvent } from './sceneDirector';
import type { AgentId, CendolEvent, DeskState, Fight, Reaction, Speech, Verdict } from './types';

declare global {
  interface Window {
    TrakteerWS?: {
      register: (channelId: string) => void;
      onNewTipSuccess: (data: Record<string, unknown>) => void;
      onStreamTest: (data: Record<string, unknown>) => void;
    };
  }
}

const CONV_STORAGE_KEY = 'mpu_gandring_active_conversation_id';

function getSavedConversationId(): string {
  try {
    const saved = localStorage.getItem(CONV_STORAGE_KEY);
    if (saved && saved.trim()) return saved.trim();
  } catch {}
  return 'office';
}

export function useDesk() {
  const [activeConversationId, setActiveConversationId] = useState<string>(getSavedConversationId);
  const conversationId = useRef(activeConversationId);
  conversationId.current = activeConversationId;

  const selectConversation = useCallback((id: string) => {
    const next = id || 'office';
    setActiveConversationId(next);
    try { localStorage.setItem(CONV_STORAGE_KEY, next); } catch {}
  }, []);

  const newConversation = useCallback(async () => {
    let freshId = '';
    try {
      const res = await fetch('/api/conversations/new', { method: 'POST' });
      if (res.ok) {
        const body = await res.json() as { ok: boolean; conversationId?: string };
        if (body.ok && body.conversationId) freshId = body.conversationId;
      }
    } catch {}
    if (!freshId) {
      freshId = 'conv-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    }
    setActiveConversationId(freshId);
    try { localStorage.setItem(CONV_STORAGE_KEY, freshId); } catch {}
    return freshId;
  }, []);
  useEffect(installDiagnostics, []);
  const [state, setState] = useState<DeskState | null>(null);
  const [connected, setConnected] = useState(false);
  const [speech, setSpeech] = useState<Partial<Record<AgentId, Speech>>>({});
  const [fights, setFights] = useState<Fight[]>([]);
  const [meter, setMeter] = useState<{ weighted: number; disagreement: number } | null>(null);
  const [reactions, setReactions] = useState<Partial<Record<AgentId, Reaction>>>({});
  const [cendolBanner, setCendolBanner] = useState<CendolEvent | null>(null);
  const fightId = useRef(0);
  const [sceneEvents, setSceneEvents] = useState<SceneEvent[]>([]);

  const dismissCendolBanner = useCallback(() => setCendolBanner(null), []);

  const triggerCendolTip = useCallback(async (opts?: { supporter?: string; quantity?: number; message?: string }) => {
    try {
      await fetch('/api/trakteer/tip', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          supporter_name: opts?.supporter || 'Supporter',
          quantity: opts?.quantity || 1,
          support_message: opts?.message || ''
        })
      });
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/trakteer/config')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { ok?: boolean; channelId?: string } | null) => {
        if (cancelled || !d?.ok || !d.channelId) return;
        const channelId = d.channelId;
        const bind = () => {
          if (cancelled || !window.TrakteerWS) return;
          try {
            window.TrakteerWS.register(channelId);
            const onTip = (data: Record<string, unknown>) => {
              void fetch('/api/trakteer/tip', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(data || {})
              }).catch(() => {});
            };
            window.TrakteerWS.onNewTipSuccess = onTip;
            window.TrakteerWS.onStreamTest = onTip;
          } catch { /* ignore */ }
        };
        if (window.TrakteerWS) {
          bind();
          return;
        }
        const existing = document.querySelector<HTMLScriptElement>('script[data-trakteer-ws="1"]');
        if (existing) {
          existing.addEventListener('load', bind, { once: true });
          return;
        }
        const script = document.createElement('script');
        script.src = 'https://assets.trakteer.id/js/trws.min.js';
        script.async = true;
        script.dataset.trakteerWs = '1';
        script.onload = bind;
        document.head.appendChild(script);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: number | undefined;
    let alive = true;
    let socketFailureReported = false;
    const timers = new Set<number>();
    let reactionTimer: number | undefined;
    const later = (fn: () => void, ms: number) => { const id = window.setTimeout(() => { timers.delete(id); if (alive) fn(); }, ms); timers.add(id); return id; };
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => { socketFailureReported = false; setConnected(true); };
      ws.onerror = () => {
        if (!alive || socketFailureReported) return;
        socketFailureReported = true;
        void fetch('/api/logs/client', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'websocket', message: 'Office live connection failed; reconnecting.', level: 'warn' }) }).catch(() => {});
      };
      ws.onclose = () => { setConnected(false); if (alive) retry = window.setTimeout(connect, 1500); };
      ws.onmessage = (ev) => {
        const { type, payload } = JSON.parse(ev.data);
        if (!alive) return;
        if (type === 'execution' || type === 'report' || type === 'verdict') {
          const event: SceneEvent = { id: String(payload.id ?? `${type}:${payload.at}`), kind: type, status: payload.status, at: typeof payload.at === 'number' ? payload.at : Date.now() };
          setSceneEvents((events) => events.some((e) => e.id === event.id) ? events : [...events.slice(-11), event]);
        }
        if (type === 'state') { setState(payload); if (!payload.debate) setMeter(null); }
        else if (type === 'log') setState(current => current ? { ...current, logs: [...current.logs, payload].slice(-2000) } : current);
        else if (type === 'room') setState(current => current ? { ...current, roomHistory: [...(current.roomHistory || []), payload].slice(-100) } : current);
        else if (type === 'speech') {
          const at = typeof payload.at === 'number' ? payload.at : Date.now();
          setSpeech((s) => ({ ...s, [payload.agent]: { ...payload, at } }));
          const id = String(payload.id ?? 'speech:' + payload.agent + ':' + payload.text);
          if (payload.done) setSceneEvents((events) => events.some((e) => e.id === id) ? events : [...events.slice(-11), { id, kind: 'speech', agent: payload.agent, at }]);
        }
        else if (type === 'meter') setMeter(payload);
        else if (type === 'fight') {
          const f: Fight = { ...payload, id: ++fightId.current, at: Date.now() };
          setFights((xs) => [...xs.slice(-4), f]);
          later(() => setFights((xs) => xs.filter((x) => x.id !== f.id)), 2600);
        } else if (type === 'verdict') {
          const v = payload as Verdict;
          setReactions(verdictReactions(v));
          if (reactionTimer) { window.clearTimeout(reactionTimer); timers.delete(reactionTimer); }
          reactionTimer = later(() => setReactions({}), 4500);
        } else if (type === 'cendol') {
          const evPayload = payload as CendolEvent;
          setCendolBanner(evPayload);
          setReactions({ lead: 'cheer', market: 'cheer', research: 'cheer', strategist: 'cheer', risk: 'cheer', execution: 'cheer' });
          if (reactionTimer) { window.clearTimeout(reactionTimer); timers.delete(reactionTimer); }
          reactionTimer = later(() => setReactions({}), 6500);
          later(() => setCendolBanner((cur) => (cur?.id === evPayload.id ? null : cur)), 9000);
        } else if (type === 'debate' && payload?.phase === 'opening') { setSpeech({}); setFights([]); setReactions({}); setSceneEvents([]); }
        else if (type === 'status') setState((s) => (s ? { ...s, agents: { ...s.agents, [payload.agent]: { ...s.agents[payload.agent as AgentId], status: payload.status } } } : s));
      };
    };
    connect();
    return () => { alive = false; for (const t of timers) window.clearTimeout(t); window.clearTimeout(retry); ws?.close(); };
  }, []);

  // fade old bubbles
  useEffect(() => {
    const t = window.setInterval(() => {
      setSpeech((s) => {
        const now = Date.now();
        let changed = false;
        const next = { ...s };
        for (const k of Object.keys(next) as AgentId[]) {
          const sp = next[k];
          if (sp && sp.done && now - sp.at > 7000) { delete next[k]; changed = true; }
        }
        return changed ? next : s;
      });
    }, 1000);
    return () => window.clearInterval(t);
  }, []);

  const command = useCallback(async (text: string, agent?: AgentId) => {
    const res = await fetch('/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, agent, conversationId: conversationId.current }) });
    const result = await res.json() as { ok: boolean; reply?: string; error?: string; command?: string };
    return { ok: res.ok && result.ok, reply: result.reply || result.error || 'Office request failed.', command: result.command || 'invalid' };
  }, []);

  return { state, connected, speech, fights, meter, reactions, cendolBanner, dismissCendolBanner, triggerCendolTip, sceneEvents, command, activeConversationId, selectConversation, newConversation };
}
