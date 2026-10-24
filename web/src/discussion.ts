import type { DeskState, RoomMessage, Speech } from './types';

/** Keep room chat and debate speech in one chronological transcript. */
export function discussionMessages(state: Pick<DeskState, 'roomHistory' | 'logs'>, latest?: Speech, conversationId?: string): RoomMessage[] {
  const allRoom = state.roomHistory || [];
  const room = conversationId && conversationId !== 'office'
    ? allRoom.filter(m => (m.conversationId ?? 'office') === conversationId)
    : allRoom.filter(m => (m.conversationId ?? 'office') === 'office' || !m.conversationId);
  const messages = [...room];
  if (!conversationId || conversationId === 'office') {
    for (const [index, line] of state.logs.entries()) {
      if (line.kind !== 'speech' || !line.agent) continue;
      if (room.some(message => message.from === line.agent && message.text === line.text && Math.abs(message.at - line.at) < 10_000)) continue;
      messages.push({ id: `speech-log-${line.at}-${index}`, at: line.at, from: line.agent, text: line.text, example: line.example, conversationId: 'office' });
    }
  }
  if (latest && !messages.some(message => message.from === latest.agent && message.text.startsWith(latest.text) && Math.abs(message.at - latest.at) < 10_000)) {
    messages.push({ id: `latest-${latest.agent}-${latest.at}`, at: latest.at, from: latest.agent, text: latest.text, example: latest.example, conversationId: conversationId || 'office' });
  }
  return messages.sort((a, b) => a.at - b.at).slice(-50);
}
