import { describe, it, expect } from 'vitest';
import { ambientActivity, eventActivity, route, blocked, directScene, verdictReactions } from '../web/src/sceneDirector';
import { AGENT_ORDER } from '../web/src/types';
import type { DeskState, Verdict } from '../web/src/types';
import { Desk } from '../server/desk';
import { loadConfig } from '../server/config';
import { makeCaller } from '../server/providers/index';

function sceneFixture() {
  const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEFAULT_PROVIDER: 'mock', DEBATE_PACE_MS: '0' });
  const state = new Desk(cfg, makeCaller(cfg)).snapshot() as unknown as DeskState;
  return { state, tick: 0, now: 10000, events: [{ id: 'speech-1', kind: 'speech' as const, agent: 'research' as const, at: 9000 }], hidden: false, reducedMotion: false };
}

describe('office director', () => {
  it('never lets a partial or unknown verdict override execution tracking with cheers', () => {
    const verdict: Verdict = { id: 'v', symbol: 'BTCUSDT', action: 'OPEN_LONG', riskDecision: 'APPROVE', executed: true, reason: 'test', disagreement: 0, camps: { bull: ['market'], bear: [], neutral: [] }, order: { status: 'partial', side: 'LONG', qty: 1, entry: 100, stop: 98, tp: null, margin: 50, leverage: 2 }, example: true, at: 1000 };
    expect(Object.values(verdictReactions(verdict))).not.toContain('cheer');
    delete verdict.order!.status;
    expect(Object.values(verdictReactions(verdict))).not.toContain('cheer');
    verdict.order!.status = 'filled';
    expect(verdictReactions(verdict).execution).toBe('cheer');
  });
  it('stages authentic report sharing deterministically and releases old events', () => {
    const input = sceneFixture(), frame = directScene(input);
    expect(frame.research.partner).toBe('lead');
    expect(frame.research.destination).not.toEqual(frame.lead.destination);
    const desks = AGENT_ORDER.map((id) => input.state.agents[id].desk);
    for (const id of ['research', 'lead'] as const) {
      const destination = frame[id].destination!;
      const desk = input.state.agents[id].desk;
      const from = { x: desk.x + (desk.x <= 50 ? 7.8 : -7.8), y: desk.y + 5.5 };
      expect(route(from, destination, desks).at(-1)).toEqual(destination);
    }
    expect(directScene(input)).toEqual(frame);
    expect(directScene({ ...input, now: 17000 }).research.partner).toBeUndefined();
    expect(directScene({ ...input, now: 8000 }).research.partner).toBeUndefined();
  });
  it('reduced motion and hidden tabs release every movement destination', () => {
    for (const flags of [{ reducedMotion: true }, { hidden: true }]) {
      expect(Object.values(directScene({ ...sceneFixture(), ...flags })).every((a) => !a.destination)).toBe(true);
    }
  });
  it('execution work preempts a cosmetic pair', () => {
    const input = sceneFixture(); input.events = [{ id: 'risk-1', kind: 'speech', agent: 'risk', at: 9000 }];
    input.state.agents.execution.status = 'executing';
    expect(directScene(input).execution.partner).toBeUndefined();
    expect(directScene(input).execution.destination).toBeUndefined();
  });
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
