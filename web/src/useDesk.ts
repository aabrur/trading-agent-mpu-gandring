import { useCallback, useEffect, useRef, useState } from 'react';
import type { SceneEvent } from './sceneDirector';
import type { AgentId, DeskState, Fight, Reaction, Speech, Verdict } from './types';

export function useDesk() {
  const [state, setState] = useState<DeskState | null>(null);
  const [connected, setConnected] = useState(false);
  const [speech, setSpeech] = useState<Partial<Record<AgentId, Speech>>>({});
  const [fights, setFights] = useState<Fight[]>([]);
  const [meter, setMeter] = useState<{ weighted: number; disagreement: number } | null>(null);
  const [reactions, setReactions] = useState<Partial<Record<AgentId, Reaction>>>({});
  const fightId = useRef(0);
  const [sceneEvents, setSceneEvents] = useState<SceneEvent[]>([]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: number | undefined;
    let alive = true;
    const timers = new Set<number>();
    let reactionTimer: number | undefined;
    const later = (fn: () => void, ms: number) => { const id = window.setTimeout(() => { timers.delete(id); if (alive) fn(); }, ms); timers.add(id); return id; };
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => setConnected(true);
      ws.onclose = () => { setConnected(false); if (alive) retry = window.setTimeout(connect, 1500); };
      ws.onmessage = (ev) => {
        const { type, payload } = JSON.parse(ev.data);
        if (!alive) return;
        if (type === 'execution' || type === 'report' || type === 'verdict') {
          const event: SceneEvent = { id: String(payload.id ?? `${type}:${payload.at}`), kind: type, status: payload.status, at: typeof payload.at === 'number' ? payload.at : Date.now() };
          setSceneEvents((events) => events.some((e) => e.id === event.id) ? events : [...events.slice(-11), event]);
        }
        if (type === 'state') { setState(payload); if (!payload.debate) setMeter(null); }
        else if (type === 'speech') setSpeech((s) => ({ ...s, [payload.agent]: { ...payload, at: Date.now() } }));
        else if (type === 'meter') setMeter(payload);
        else if (type === 'fight') {
          const f: Fight = { ...payload, id: ++fightId.current, at: Date.now() };
          setFights((xs) => [...xs.slice(-4), f]);
          later(() => setFights((xs) => xs.filter((x) => x.id !== f.id)), 2600);
        } else if (type === 'verdict') {
          const v = payload as Verdict;
          const r: Partial<Record<AgentId, Reaction>> = {};
          if (v.executed && v.order) {
            const winners = v.order.side === 'LONG' ? v.camps.bull : v.camps.bear;
            for (const a of [...winners, 'lead', 'execution'] as AgentId[]) r[a] = 'cheer';
          } else if (v.riskDecision === 'REJECT') {
            for (const a of ['lead', ...(v.action === 'OPEN_LONG' ? v.camps.bull : v.camps.bear)] as AgentId[]) r[a] = 'worried';
            r.risk = 'worried';
          }
          setReactions(r);
          if (reactionTimer) { window.clearTimeout(reactionTimer); timers.delete(reactionTimer); }
          reactionTimer = later(() => setReactions({}), 4500);
        } else if (type === 'debate' && payload?.phase === 'opening') { setSpeech({}); setFights([]); setReactions({}); }
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
    const res = await fetch('/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, agent }) });
    return (await res.json()) as { ok: boolean; reply: string; command: string };
  }, []);

  return { state, connected, speech, fights, meter, reactions, sceneEvents, command };
}
