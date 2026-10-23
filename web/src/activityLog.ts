import type { AgentId, DeskState, LogLine } from './types';

export type ActivityFilter = 'all' | 'trades' | 'chat' | 'discussion' | 'command' | 'tool' | 'mcp' | 'plugin' | 'process' | 'frontend' | 'backend' | 'errors';
export type ActivityView = 'log' | 'history';

export function activityForView(entries: LogLine[], view: ActivityView): LogLine[] {
  return entries.filter(line => {
    const history = ['trade', 'chat', 'speech', 'fight', 'verdict', 'command'].includes(line.kind) || line.source === 'command';
    return view === 'history' ? history : !history;
  });
}

export function activityParticipants(line: LogLine, agents: DeskState['agents']): string {
  const label = (id: NonNullable<LogLine['from'] | LogLine['to']>) => id === 'owner' ? 'Boss' : id === 'all' ? 'All agents' : agents[id]?.name || id;
  return line.from ? `${label(line.from)}${line.to ? ` → ${label(line.to)}` : ''}` : '';
}

/** Search retained chat and trade records alongside live events, before applying the display limit. */
export function activityEntries(state: Pick<DeskState, 'logs' | 'roomHistory' | 'chats' | 'paper'>): LogLine[] {
  const entries = [...state.logs];
  const ids = new Set(entries.flatMap(line => line.id ? [line.id] : []));
  for (const message of state.roomHistory || []) {
    const id = `room:${message.id}`;
    if (ids.has(id)) continue;
    entries.push({ ...message, id, kind: 'chat', source: 'discussion', level: 'info' });
    ids.add(id);
  }
  const roomEntries = entries.filter(line => line.kind === 'chat');
  for (const [recipient, messages] of Object.entries(state.chats)) {
    const agent = recipient as AgentId;
    messages.forEach((message, index) => {
      const from = message.from === 'user' ? 'owner' : message.from === 'system' ? undefined : message.from;
      const to = message.from === 'user' ? agent : 'owner';
      const copiedRoomMessage = roomEntries.some(line => line.from === from && line.text === message.text && Math.abs(line.at - message.at) < 10_000 && (line.to === to || line.to === 'all'));
      if (copiedRoomMessage) return;
      entries.push({ id: `chat:${agent}:${message.at}:${index}`, at: message.at, kind: 'chat', source: `chat:${agent}`, agent, from, to,
        text: message.from === 'system' ? `System: ${message.text}` : message.text, level: 'info' });
    });
  }
  for (const trade of state.paper.closed) entries.push({ id: `trade:${trade.id}`, at: trade.closedAt, kind: 'trade', source: 'trade history', level: 'info', status: trade.pnlStatus || 'recorded', text: `${trade.symbol} ${trade.side} · qty ${trade.qty} · entry ${trade.entry} · exit ${trade.exit} · PnL ${trade.pnlStatus === 'unknown' ? 'unavailable' : `${trade.realizedPnl} USDT`} · ${trade.reason}` });
  return entries.sort((a, b) => a.at - b.at);
}

export function filterActivity(entries: LogLine[], filter: ActivityFilter, query: string, agents: DeskState['agents']): LogLine[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const categoryTerms: Record<string, string> = { tool: 'tools alat', mcp: 'MCP', plugin: 'plugins', process: 'processes proses', chat: 'chat sessions sesi chat', trade: 'trade history riwayat trading', speech: 'agent discussions diskusi agen', fight: 'agent discussions diskusi agen', verdict: 'agent discussions trade history', command: 'commands perintah', error: 'errors kesalahan', warn: 'warnings peringatan' };
  return entries.filter(line => {
    const matchesCategory = filter === 'all' || (filter === 'trades' ? ['trade', 'verdict'].includes(line.kind)
      : filter === 'discussion' ? ['speech', 'fight', 'verdict'].includes(line.kind)
      : filter === 'command' ? line.kind === 'command' || line.source === 'command'
      : filter === 'errors' ? line.level === 'error' || line.level === 'warn' || ['error', 'warn'].includes(line.kind)
      : line.kind === filter);
    if (!matchesCategory) return false;
    const agent = line.agent ? agents[line.agent] : undefined;
    const date = new Date(line.at);
    const searchable = [line.id, line.text, line.source, line.kind, categoryTerms[line.kind], line.status, line.level, line.durationMs,
      line.agent, agent?.name, agent?.title, line.from, line.to, activityParticipants(line, agents),
      date.toISOString(), date.toLocaleString(), line.at].join(' ').toLocaleLowerCase();
    return terms.every(term => searchable.includes(term));
  });
}
