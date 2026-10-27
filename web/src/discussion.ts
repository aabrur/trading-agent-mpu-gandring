import type { DeskState, RoomMessage, Speech } from './types';

/** Reconnect delivery updates an existing event rather than appending another copy. */
export function appendEvent<T extends { id?: string }>(events: T[], event: T, limit: number): T[] {
  const index = event.id ? events.findIndex(item => item.id === event.id) : -1;
  const next = [...events];
  if (index < 0) next.push(event);
  else next[index] = event;
  return next.slice(-limit);
}

/** Late partials and reconnect replay must not replace a completed speech event. */
export function mergeSpeech(current: Speech | undefined, incoming: Speech): Speech {
  if (current && (current.at > incoming.at || (current.id && current.id === incoming.id && (current.done || current.text.length > incoming.text.length)))) return current;
  return incoming;
}

/** Keep room chat and debate speech in one chronological transcript. */
export function discussionMessages(state: Pick<DeskState, 'roomHistory' | 'logs'>, latest?: Speech, conversationId?: string): RoomMessage[] {
  const selected = conversationId || 'office';
  const allRoom = state.roomHistory || [];
  const room = allRoom.filter(m => (m.conversationId ?? 'office') === selected);
  const messages = new Map(room.map(message => [message.id, message]));
  for (const line of state.logs) {
    if (line.kind !== 'speech' || !line.agent || (line.conversationId ?? 'office') !== selected) continue;
    if (!line.id && room.some(message => message.from === line.agent && message.text === line.text && Math.abs(message.at - line.at) < 10_000)) continue;
    const id = line.id ?? `speech-log-${line.agent}-${line.at}-${line.text}`;
    if (!messages.has(id)) messages.set(id, { id, at: line.at, from: line.agent, text: line.text, example: line.example, conversationId: line.conversationId ?? 'office' });
  }
  if (latest && (latest.conversationId ?? 'office') === selected) {
    const id = latest.id ?? `latest-${latest.agent}-${latest.at}`;
    const duplicate = messages.has(id) || (!latest.id && [...messages.values()].some(message =>
      message.from === latest.agent && message.text.startsWith(latest.text) && Math.abs(message.at - latest.at) < 10_000));
    if (!duplicate) messages.set(id, { id, at: latest.at, from: latest.agent, text: latest.text, example: latest.example, conversationId: latest.conversationId ?? 'office' });
  }
  return [...messages.values()].sort((a, b) => a.at - b.at).slice(-50);
}
