import { EventEmitter } from 'node:events';
import { safe } from './redact.js';
import type { AgentId } from './types.js';

export interface ActivityEntry {
  kind: 'tool' | 'mcp' | 'plugin' | 'process' | 'frontend' | 'backend' | 'error';
  source: string;
  level: 'info' | 'warn' | 'error';
  text: string;
  status?: string;
  durationMs?: number;
  agent?: AgentId;
  correlationId?: string;
  eventName?: string;
}
const events = new EventEmitter();
export function publishActivity(entry: ActivityEntry) {
  events.emit('activity', { ...entry, source: safe(entry.source).slice(0, 100), text: safe(entry.text).slice(0, 1000) });
}
export function onActivity(listener: (entry: ActivityEntry) => void) {
  events.on('activity', listener);
  return () => { events.off('activity', listener); };
}
