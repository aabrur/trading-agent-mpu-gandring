import type { AgentId, DeskState } from './types';
import type { Pose, Face } from './components/Bot';

export interface Point { x: number; y: number }
export interface SceneEvent { id: string; kind: 'execution' | 'report' | 'verdict'; status?: string; at: number }
export interface Activity { pose: Pose; face: Face; label: string; destination?: Point }
export const SEATS: Record<AgentId, Point> = {
  lead: { x: 50, y: 55 }, market: { x: 31, y: 63 }, research: { x: 69, y: 63 },
  strategist: { x: 31, y: 84 }, risk: { x: 69, y: 84 }, execution: { x: 50, y: 94 }
};
const destinations = { coffee: { x: 88, y: 37 }, bookshelf: { x: 12, y: 37 }, analysis: { x: 59, y: 52 }, window: { x: 36, y: 37 } };
const routines: Record<AgentId, Activity[]> = {
  lead: [{ pose: 'read', face: 'normal', label: 'checking the journal' }, { pose: 'observe', face: 'normal', label: 'visiting analysis', destination: destinations.analysis }, { pose: 'drink', face: 'happy', label: 'coffee break', destination: destinations.coffee }],
  market: [{ pose: 'point', face: 'normal', label: 'checking the chart' }, { pose: 'observe', face: 'normal', label: 'looking out the window', destination: destinations.window }, { pose: 'stretch', face: 'normal', label: 'stretching' }],
  research: [{ pose: 'read', face: 'normal', label: 'checking a reference', destination: destinations.bookshelf }, { pose: 'read', face: 'normal', label: 'reading reports' }, { pose: 'drink', face: 'happy', label: 'coffee break', destination: destinations.coffee }],
  strategist: [{ pose: 'point', face: 'normal', label: 'studying the analysis board', destination: destinations.analysis }, { pose: 'think', face: 'normal', label: 'checking patterns' }, { pose: 'stretch', face: 'normal', label: 'stretching' }],
  risk: [{ pose: 'read', face: 'normal', label: 'reviewing tickets' }, { pose: 'stretch', face: 'normal', label: 'stretching' }, { pose: 'drink', face: 'happy', label: 'coffee break', destination: destinations.coffee }],
  execution: [{ pose: 'type', face: 'normal', label: 'checking the terminal' }, { pose: 'drink', face: 'happy', label: 'coffee break', destination: destinations.coffee }, { pose: 'read', face: 'normal', label: 'organizing tickets' }]
};
export function ambientActivity(id: AgentId, slot: number): Activity {
  return routines[id][Math.abs(slot + id.length) % routines[id].length];
}
export function eventActivity(event: SceneEvent): Activity {
  if (event.kind === 'report') return { pose: 'read', face: 'normal', label: 'checking the report' };
  if (event.kind === 'verdict') return { pose: 'point', face: 'normal', label: 'delivering the verdict' };
  if (event.status === 'filled' || event.status === 'closed') return { pose: 'cheer', face: 'happy', label: event.status === 'closed' ? 'close confirmed' : 'fill confirmed' };
  if (event.status === 'failed') return { pose: 'think', face: 'worried', label: 'checking an execution issue' };
  return { pose: 'type', face: 'normal', label: event.status === 'partial' ? 'tracking a partial fill' : event.status === 'reconciled' ? 'reconciling the book' : 'tracking the order' };
}
export function activityFor(state: DeskState, id: AgentId, slot: number, visitor: AgentId | null, event?: SceneEvent): Activity {
  if (event && (event.kind === 'execution' ? id === 'execution' : id === 'lead')) return eventActivity(event);
  const status = state.agents[id].status;
  const busy: Partial<Record<typeof status, Activity>> = {
    reading: { pose: 'read', face: 'normal', label: id === 'research' ? 'checking sources' : 'reading charts' },
    thinking: { pose: 'think', face: 'normal', label: 'thinking' }, typing: { pose: 'type', face: 'normal', label: 'typing' },
    arguing: { pose: 'argue', face: 'normal', label: 'challenging the evidence' }, fighting: { pose: 'argue', face: 'angry', label: 'heated disagreement' },
    executing: { pose: 'type', face: 'normal', label: 'tracking execution' }, journaling: { pose: 'read', face: 'normal', label: 'writing the journal' }
  };
  if (busy[status]) return busy[status]!;
  if (state.debate) return { pose: 'sit', face: 'normal', label: 'listening' };
  if (id === visitor) return ambientActivity(id, slot);
  return { pose: id === 'market' || id === 'execution' ? 'sit' : 'idle', face: 'normal', label: 'at workstation' };
}

export function blocked(p: Point, desks: Point[]) {
  if (p.x < 8 || p.x > 92 || p.y < 34 || p.y > 97) return true;
  if (p.x > 36 && p.x < 64 && p.y > 61 && p.y < 81) return true;
  return desks.some((d) => Math.abs(p.x - d.x) < 6.5 && p.y > d.y - 5 && p.y < d.y + 2);
}
const clear = (a: Point, b: Point, desks: Point[]) => {
  const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y));
  for (let i = 1; i < n; i++) if (blocked({ x: a.x + (b.x - a.x) * i / n, y: a.y + (b.y - a.y) * i / n }, desks)) return false;
  return true;
};
/** Small visibility graph. Furniture is fixed; no physics loop or per-frame React state. */
export function route(from: Point, to: Point, desks: Point[]): Point[] {
  if (clear(from, to, desks)) return [from, to];
  const nodes = [from, to];
  for (let y = 35; y <= 95; y += 5) for (let x = 8; x <= 92; x += 6) if (!blocked({ x, y }, desks)) nodes.push({ x, y });
  const costs = nodes.map(() => Infinity), prev = nodes.map(() => -1), visited = new Set<number>();
  costs[0] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < nodes.length; i++) if (!visited.has(i) && (u < 0 || costs[i] < costs[u])) u = i;
    if (u < 0 || !Number.isFinite(costs[u])) return [from];
    if (u === 1) break;
    visited.add(u);
    for (let v = 1; v < nodes.length; v++) {
      if (visited.has(v)) continue;
      const distance = Math.hypot(nodes[v].x - nodes[u].x, nodes[v].y - nodes[u].y);
      if (costs[u] + distance >= costs[v] || !clear(nodes[u], nodes[v], desks)) continue;
      costs[v] = costs[u] + distance; prev[v] = u;
    }
  }
  const path = [to];
  for (let i = prev[1]; i >= 0; i = prev[i]) path.unshift(nodes[i]);
  return path;
}
