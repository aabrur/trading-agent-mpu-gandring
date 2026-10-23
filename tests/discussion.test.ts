import { describe, expect, it } from 'vitest';
import { discussionMessages } from '../web/src/discussion.js';

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
});
