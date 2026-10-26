export type SessionEventPageItem = { sessionId: string; sequence: number };
export type SessionListItem = { sessionId: string };

export function sessionEventsUrl(sessionId: string, filters: { level?: string; source?: string; query?: string; correlationId?: string; cursor?: string }, limit = 100): string {
  const params = new URLSearchParams({ limit: String(limit) });
  if (filters.level) params.set('level', filters.level);
  if (filters.source?.trim()) params.set('source', filters.source.trim());
  if (filters.query?.trim()) params.set('q', filters.query.trim());
  if (filters.correlationId) params.set('correlationId', filters.correlationId);
  if (filters.cursor) params.set('cursor', filters.cursor);
  return `/api/logs/sessions/${encodeURIComponent(sessionId)}/events?${params}`;
}

export function mergeOlderSessionEvents<T extends SessionEventPageItem>(older: T[], current: T[], maximum = 500): T[] {
  return [...older, ...current].slice(0, maximum);
}

export function mergeOlderSessions<T extends SessionListItem>(current: T[], older: T[], maximum = 500): T[] {
  return [...current, ...older].slice(-maximum);
}
