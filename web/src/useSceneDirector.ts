import { useEffect, useState } from 'react';
import { AGENT_ORDER, type DeskState } from './types';
import { activityFor, type SceneEvent } from './sceneDirector';

export function useSceneDirector(state: DeskState, events: SceneEvent[]) {
  const [clock, setClock] = useState({ tick: 0, now: 0, reduced: false, hidden: false });
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setClock((c) => ({ tick: c.tick + (document.hidden || media.matches ? 0 : 1), now: Date.now(), reduced: media.matches, hidden: document.hidden }));
    update();
    const timer = window.setInterval(update, 1000);
    document.addEventListener('visibilitychange', update); media.addEventListener('change', update);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', update); media.removeEventListener('change', update); };
  }, []);
  const slot = Math.floor(clock.tick / 15);
  // A single visitor reserves the shared destinations. Return home before the next visitor leaves.
  const visitor = clock.tick % 15 < 11 && !clock.hidden && !clock.reduced && !state.debate && !state.killed ? AGENT_ORDER[slot % AGENT_ORDER.length] : null;
  const recent = events.filter((e) => e.at > clock.now - 7000);
  const event = [...recent].filter((e) => e.kind === 'execution').sort((a, b) => b.at - a.at)[0] ?? [...recent].sort((a, b) => b.at - a.at)[0];
  return Object.fromEntries(AGENT_ORDER.map((id) => [id, activityFor(state, id, slot, event ? null : visitor, event)])) as Record<typeof AGENT_ORDER[number], ReturnType<typeof activityFor>>;
}
