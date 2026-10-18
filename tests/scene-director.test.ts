import { describe, it, expect } from 'vitest';
import { ambientActivity, eventActivity, route, blocked } from '../web/src/sceneDirector';
import { AGENT_ORDER } from '../web/src/types';

describe('office director', () => {
  it('repeats the same seeded ambient schedule and varies roles', () => {
    expect(ambientActivity('research', 3)).toEqual(ambientActivity('research', 3));
    expect(new Set(AGENT_ORDER.map((id) => ambientActivity(id, 4).pose)).size).toBeGreaterThan(1);
  });
  it('maps partial execution to tracking rather than a celebration', () => {
    expect(eventActivity({ id: 'one', kind: 'execution', status: 'partial', at: 1 }).pose).not.toBe('cheer');
    expect(eventActivity({ id: 'two', kind: 'execution', status: 'filled', at: 2 }).pose).toBe('cheer');
  });
  it('routes around the debate table', () => {
    const path = route({ x: 31, y: 63 }, { x: 69, y: 84 }, []);
    expect(path.length).toBeGreaterThan(2);
    for (let i = 1; i < path.length; i++) {
      for (let step = 1; step < 20; step++) {
        const t = step / 20;
        expect(blocked({ x: path[i - 1].x + (path[i].x - path[i - 1].x) * t, y: path[i - 1].y + (path[i].y - path[i - 1].y) * t }, [])).toBe(false);
      }
    }
  });
});
