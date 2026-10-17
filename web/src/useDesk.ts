import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentId, DeskState, Fight, Speech } from './types';

export function useDesk() {
  const [state, setState] = useState<DeskState | null>(null);
  const [connected, setConnected] = useState(false);
  const [speech, setSpeech] = useState<Partial<Record<AgentId, Speech>>>({});
  const [fights, setFights] = useState<Fight[]>([]);
  const [meter, setMeter] = useState<{ weighted: number; disagreement: number } | null>(null);
  const fightId = useRef(0);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: number | undefined;
    let alive = true;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => setConnected(true);
      ws.onclose = () => { setConnected(false); if (alive) retry = window.setTimeout(connect, 1500); };
      ws.onmessage = (ev) => {
        const { type, payload } = JSON.parse(ev.data);
        if (type === 'state') { setState(payload); if (!payload.debate) setMeter(null); }
        else if (type === 'speech') setSpeech((s) => ({ ...s, [payload.agent]: { ...payload, at: Date.now() } }));
        else if (type === 'meter') setMeter(payload);
        else if (type === 'fight') {
          const f: Fight = { ...payload, id: ++fightId.current, at: Date.now() };
          setFights((xs) => [...xs.slice(-4), f]);
          window.setTimeout(() => setFights((xs) => xs.filter((x) => x.id !== f.id)), 2600);
        } else if (type === 'debate' && payload?.phase === 'opening') { setSpeech({}); setFights([]); }
        else if (type === 'status') setState((s) => (s ? { ...s, agents: { ...s.agents, [payload.agent]: { ...s.agents[payload.agent as AgentId], status: payload.status } } } : s));
      };
    };
    connect();
    return () => { alive = false; window.clearTimeout(retry); ws?.close(); };
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

  return { state, connected, speech, fights, meter, command };
}
