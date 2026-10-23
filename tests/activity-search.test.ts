import { describe, expect, it } from 'vitest';
import { activityEntries, activityForView, filterActivity, type ActivityFilter } from '../web/src/activityLog.js';
import { loadConfig } from '../server/config.js';
import { Desk } from '../server/desk.js';
import { makeCaller } from '../server/providers/index.js';
import type { DeskState, LogLine } from '../web/src/types.js';

function fixture() {
  const cfg = loadConfig({ DEFAULT_PROVIDER: 'mock', TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample' });
  const desk = new Desk(cfg, makeCaller(cfg), { reportsDir: null, learningsPath: null, killFile: null });
  return { desk, state: desk.snapshot() as DeskState };
}

describe('Log and History search', () => {
  it.each(['tool', 'mcp', 'plugin', 'process', 'frontend', 'backend'] as ActivityFilter[])('isolates the %s category', category => {
    const { state } = fixture();
    const entries: LogLine[] = ['tool', 'mcp', 'plugin', 'process', 'frontend', 'backend'].map((kind, at) => ({ kind, at, text: 'Same searchable message', source: 'fixture' }));
    expect(filterActivity(entries, category, 'SEARCHABLE', state.agents).map(line => line.kind)).toEqual([category]);
  });

  it('finds records by participant, model/tool source, status, date and duration before display slicing', () => {
    const { state } = fixture();
    const at = Date.UTC(2026, 9, 23, 8, 15);
    const entries: LogLine[] = [
      { id: 'old-match', at, kind: 'mcp', source: 'codex:market_news', agent: 'research', text: 'Failed to fetch announcements', status: 'failed', level: 'error', durationMs: 125 },
      ...Array.from({ length: 250 }, (_, index) => ({ at: at + index + 1, kind: 'process', source: 'server', text: 'heartbeat' }))
    ];
    for (const query of ['Research Analyst failed', 'codex:market_news', '2026-10-23', '125', 'old-match', 'announcements error']) {
      expect(filterActivity(entries, 'all', query, state.agents).map(line => line.id)).toContain('old-match');
    }
    expect(filterActivity(entries, 'all', 'Processes', state.agents)).toHaveLength(250);
    expect(filterActivity(entries, 'all', 'no-such-event', state.agents)).toEqual([]);
  });

  it('includes complete retained chat messages once, preserves repeated messages, and separates system events', () => {
    const { desk, state } = fixture();
    const first = desk.addRoomMessage({ from: 'owner', to: 'risk', text: 'Explain the risk cap in full' });
    const second = desk.addRoomMessage({ from: 'owner', to: 'risk', text: 'Explain the risk cap in full' });
    const reply = desk.addRoomMessage({ from: 'risk', to: 'owner', text: 'Keep a protective stop.' });
    state.logs = desk.snapshot().logs;
    state.roomHistory = [first, second, reply];
    state.chats.risk = [{ from: 'user', at: first.at, text: first.text }, { from: 'risk', at: reply.at, text: reply.text }, { from: 'user', at: first.at - 20000, text: 'Older retained session message' }];
    state.logs.push({ at: Date.now(), kind: 'backend', source: 'http', text: 'HTTP failure', level: 'error' });
    const all = activityEntries(state);
    const history = activityForView(all, 'history');
    const system = activityForView(all, 'log');
    expect(history.filter(line => line.text === first.text)).toHaveLength(2);
    expect(history.filter(line => line.text === reply.text)).toHaveLength(1);
    expect(filterActivity(history, 'chat', 'Boss Risk Manager protective', state.agents)).toHaveLength(1);
    expect(filterActivity(history, 'chat', 'Older retained session', state.agents)).toHaveLength(1);
    expect(system.map(line => line.text)).toEqual(['HTTP failure']);
    expect(history.some(line => line.text === 'HTTP failure')).toBe(false);
    expect(filterActivity(history, 'chat', 'Explain the risk cap in full', state.agents)).toHaveLength(2);
  });
});
