import { AGENT_ORDER, type AgentId, type DeskState, type Verdict, type Reaction, type Fight } from './types';
import type { Pose, Face } from './components/Bot';

export interface Point { x: number; y: number }
export interface SceneEvent { id: string; kind: 'execution' | 'report' | 'verdict' | 'speech'; status?: string; agent?: AgentId; target?: AgentId; at: number }
export interface Activity { pose: Pose; face: Face; label: string; destination?: Point; facing?: 'left' | 'right'; partner?: AgentId }
// Presentation geometry stays separate from venue configuration and trading decisions.
export const WORKSTATIONS: Record<AgentId, Point> = {
  lead: { x: 18, y: 43 }, market: { x: 82, y: 43 }, research: { x: 18, y: 66 },
  strategist: { x: 82, y: 66 }, risk: { x: 18, y: 89 }, execution: { x: 82, y: 89 }
};
export const FIGHT_STAGE = { from: { x: 43, y: 65 }, to: { x: 57, y: 65 } };
export const SPECTATORS: Record<AgentId, Point> = {
  lead: { x: 50, y: 41 }, market: { x: 27, y: 57 }, research: { x: 73, y: 57 },
  strategist: { x: 27, y: 80 }, risk: { x: 73, y: 80 }, execution: { x: 50, y: 92 }
};

/** Repeat cartoon sparring only while an actual opposing debate meets the configured heat threshold. */
export function heatedDebateFight(state: DeskState, now: number): Fight | null {
  const debate = state.debate;
  if (!debate || state.killed || state.paused || !/^round \d+$/.test(debate.phase) || debate.disagreement < Math.max(0.25, state.fightThreshold)) return null;
  const bulls = debate.camps.bull.filter((id) => state.agents[id]?.stance === 'LONG');
  const bears = debate.camps.bear.filter((id) => state.agents[id]?.stance === 'SHORT');
  if (!bulls.length || !bears.length || now % 4800 >= 2400) return null;
  const slot = Math.floor(now / 4800);
  const pair = [bulls[slot % bulls.length], bears[slot % bears.length]];
  return { id: -slot - 1, from: pair[slot % 2], to: pair[(slot + 1) % 2], intensity: Math.min(1, debate.disagreement), punches: 2, at: slot * 4800 };
}

export function officePnl(state: DeskState) {
  const account = state.mode === 'PAPER' ? null : state.venueAccount;
  const value = account ? account.unrealized : state.paper.unrealized;
  const source = state.mode === 'PAPER' ? 'Paper' : account ? (account.status === 'confirmed' ? 'Exchange' : 'Exchange · stale') : 'Local estimate';
  return { value: Number.isFinite(value) ? value : null, source };
}
export function verdictReactions(v: Verdict): Partial<Record<AgentId, Reaction>> {
  const reactions: Partial<Record<AgentId, Reaction>> = {};
  if (v.executed && v.order && (v.executionStatus ?? v.order.status) === 'filled' && v.order.status !== 'partial') {
    const winners = v.order.side === 'LONG' ? v.camps.bull : v.camps.bear;
    for (const id of [...winners, 'lead', 'execution'] as AgentId[]) reactions[id] = 'cheer';
  } else if (v.riskDecision === 'REJECT') {
    for (const id of ['lead', ...(v.action === 'OPEN_LONG' ? v.camps.bull : v.camps.bear)] as AgentId[]) reactions[id] = 'worried';
    reactions.risk = 'worried';
  }
  return reactions;
}
export const SEATS: Record<AgentId, Point> = {
  lead: { x: 50, y: 41 }, market: { x: 27, y: 57 }, research: { x: 73, y: 57 },
  strategist: { x: 27, y: 80 }, risk: { x: 73, y: 80 }, execution: { x: 50, y: 92 }
};
const destinations = { coffee: { x: 88, y: 37 }, bookshelf: { x: 12, y: 37 }, analysis: { x: 66, y: 43 }, window: { x: 36, y: 37 } };
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

export function directScene(input: { state: DeskState; events: SceneEvent[]; tick: number; now: number; hidden: boolean; reducedMotion: boolean }): Record<AgentId, Activity> {
  const { state, events, tick, now, hidden, reducedMotion } = input;
  const slot = Math.floor(tick / 15);
  const recent = events.filter((e) => e.at <= now && now - e.at < 7000).sort((a, b) => b.at - a.at);
  const important = recent.find((e) => e.kind === 'execution') ?? recent.find((e) => e.kind !== 'speech');
  const visitor = tick % 15 < 11 && !hidden && !reducedMotion && !state.debate && !state.killed && !recent.length ? AGENT_ORDER[slot % AGENT_ORDER.length] : null;
  const frame = Object.fromEntries(AGENT_ORDER.map((id) => [id, activityFor(state, id, slot, visitor, important)])) as Record<AgentId, Activity>;
  const speech = recent.find((e) => e.kind === 'speech' && (e.agent === 'research' || e.agent === 'risk'));
  if (!hidden && !reducedMotion && !state.killed && !state.debate && !important && speech?.agent) {
    const from = speech.agent, to = from === 'risk' ? 'execution' : 'lead';
    const available = [from, to].every((id) => !['executing', 'fighting'].includes(state.agents[id as AgentId].status));
    if (available) {
      frame[from] = { pose: 'pass', face: 'normal', label: 'sharing a report', destination: { x: 43, y: 43 }, facing: 'right', partner: to };
      frame[to] = { pose: 'read', face: 'normal', label: 'reviewing a report', destination: { x: 57, y: 43 }, facing: 'left', partner: from };
    }
  }
  if (hidden || reducedMotion) for (const a of Object.values(frame)) { delete a.destination; delete a.partner; }
  return frame;
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
  if (p.x > 36 && p.x < 64 && p.y > 53 && p.y < 76) return true;
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
