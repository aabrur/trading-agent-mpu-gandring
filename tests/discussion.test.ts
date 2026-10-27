import { describe, expect, it } from 'vitest';
import { appendEvent, discussionMessages, mergeSpeech } from '../web/src/discussion.js';
import type { Speech } from '../web/src/types.js';

describe('Office discussion transcript', () => {
  it('preserves Owner chat and subsequent debate speech, with no duplicate room reply', () => {
    const messages = discussionMessages({ roomHistory: [
      { id: 'owner', at: 100, from: 'owner', to: 'all', text: 'Hello team' },
      { id: 'reply', at: 200, from: 'lead', to: 'owner', text: 'Hello Boss' }
    ], logs: [
      { at: 201, kind: 'speech', agent: 'lead', text: 'Hello Boss' },
      { at: 300, kind: 'speech', agent: 'market', text: 'Current market view' },
      { at: 400, kind: 'mcp', text: 'internal activity belongs in Log' }
    ] }, { agent: 'market', text: 'Current market view', at: 300, done: true, example: true });
    expect(messages.map(message => message.text)).toEqual(['Hello team', 'Hello Boss', 'Current market view']);
    expect(messages.at(-1)?.from).toBe('market');
  });

  it('keeps later repeated replies and limits the transcript to the newest 50 messages', () => {
    const messages = discussionMessages({ roomHistory: [{ id: 'old', at: 0, from: 'lead', text: 'Same view' }], logs: Array.from({ length: 70 }, (_, index) => ({ at: 20000 + index, kind: 'speech', agent: 'lead' as const, text: index === 69 ? 'Same view' : `view ${index}` })) });
    expect(messages).toHaveLength(50);
    expect(messages[0].text).toBe('view 20');
    expect(messages.at(-1)?.text).toBe('Same view');
  });

  it('keeps direct chat and huddle speech in their originating conversation', () => {
    const state = { roomHistory: [
      { id: 'direct', at: 100, from: 'lead' as const, text: 'Direct answer', conversationId: 'private' },
      { id: 'huddle', at: 200, from: 'market' as const, text: 'Huddle answer', conversationId: 'group' }
    ], logs: [
      { id: 'direct', at: 100, kind: 'speech', agent: 'lead' as const, text: 'Direct answer', conversationId: 'private' },
      { id: 'huddle', at: 200, kind: 'speech', agent: 'market' as const, text: 'Huddle answer', conversationId: 'group' },
      { id: 'auto', at: 300, kind: 'speech', agent: 'lead' as const, text: 'Autonomous activity', conversationId: 'office' }
    ] };
    const latest: Speech = { id: 'huddle', at: 200, agent: 'market', text: 'Huddle answer', conversationId: 'group', done: true, example: false };
    expect(discussionMessages(state, latest, 'private').map(message => message.id)).toEqual(['direct']);
    expect(discussionMessages(state, latest, 'group').map(message => message.id)).toEqual(['huddle']);
    expect(discussionMessages(state, latest, 'office').map(message => message.id)).toEqual(['auto']);
  });

  it('deduplicates stable IDs across replay, room, log and final speech without removing repeated authored replies', () => {
    const first = { id: 'first', at: 100, from: 'lead' as const, text: 'Same reply', conversationId: 'a' };
    const replayed = appendEvent([first], { ...first }, 100);
    expect(replayed).toHaveLength(1);
    const messages = discussionMessages({ roomHistory: replayed, logs: [
      { id: 'first', at: 101, kind: 'speech', agent: 'lead', text: 'Same reply', conversationId: 'a' },
      { id: 'second', at: 102, kind: 'speech', agent: 'lead', text: 'Same reply', conversationId: 'a' }
    ] }, { id: 'second', at: 102, agent: 'lead', text: 'Same reply', conversationId: 'a', done: true, example: false }, 'a');
    expect(messages.map(message => message.id)).toEqual(['first', 'second']);
  });

  it('retains completed speech when a late partial or duplicate final event arrives', () => {
    const completed: Speech = { id: 'message', at: 100, agent: 'lead', text: 'Complete response', conversationId: 'a', done: true, example: false };
    expect(mergeSpeech(completed, { ...completed, text: 'Complete', done: false })).toBe(completed);
    expect(mergeSpeech(completed, { ...completed })).toBe(completed);
    expect(mergeSpeech(completed, { ...completed, id: 'older', at: 99 })).toBe(completed);
    const next = { ...completed, id: 'next', at: 101, text: 'New response', done: false };
    expect(mergeSpeech(completed, next)).toBe(next);
  });
});
