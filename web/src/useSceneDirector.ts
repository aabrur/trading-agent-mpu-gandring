import { useEffect, useState } from 'react';
import type { DeskState } from './types';
import { directScene, type SceneEvent } from './sceneDirector';

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
  return directScene({ state, events, tick: clock.tick, now: clock.now, reducedMotion: clock.reduced, hidden: clock.hidden });
}
