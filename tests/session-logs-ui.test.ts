import { describe, expect, it } from 'vitest';
import { mergeOlderSessionEvents, mergeOlderSessions, sessionEventsUrl } from '../web/src/sessionLogsData';

describe('archived session log UI data', () => {
  it('encodes session IDs and keeps independent filters and opaque older-page cursors', () => {
    const url = new URL(sessionEventsUrl('mpu-session/with spaces', {
      level: 'ERROR', source: ' server ', query: 'stop failed', correlationId: 'corr/one', cursor: 'opaque+cursor/=',
    }), 'http://127.0.0.1');
    expect(url.pathname).toBe('/api/logs/sessions/mpu-session%2Fwith%20spaces/events');
    expect(url.searchParams.get('limit')).toBe('100');
    expect(url.searchParams.get('level')).toBe('ERROR');
    expect(url.searchParams.get('source')).toBe('server');
    expect(url.searchParams.get('q')).toBe('stop failed');
    expect(url.searchParams.get('correlationId')).toBe('corr/one');
    expect(url.searchParams.get('cursor')).toBe('opaque+cursor/=');
  });

  it('prepends older chronological pages and trims newer events at the cap', () => {
    const older = Array.from({ length: 4 }, (_, sequence) => ({ sessionId: 's', sequence }));
    const current = Array.from({ length: 4 }, (_, sequence) => ({ sessionId: 's', sequence: sequence + 4 }));
    expect(mergeOlderSessionEvents(older, current, 6).map(item => item.sequence)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(mergeOlderSessionEvents([{ sessionId: 's', sequence: -2 }, { sessionId: 's', sequence: -1 }], mergeOlderSessionEvents(older, current, 6), 6).map(item => item.sequence)).toEqual([-2, -1, 0, 1, 2, 3]);
  });

  it('respects small event caps while preserving the older page edge', () => {
    const events = [{ sessionId: 's', sequence: 1 }, { sessionId: 's', sequence: 2 }];
    expect(mergeOlderSessionEvents(events, [], 1)).toEqual([events[0]]);
  });

  it('slides the bounded session window toward older pages instead of stopping at the cap', () => {
    const current = Array.from({ length: 3 }, (_, index) => ({ sessionId: `new-${index}` }));
    const older = Array.from({ length: 3 }, (_, index) => ({ sessionId: `old-${index}` }));
    expect(mergeOlderSessions(current, older, 4).map(item => item.sessionId)).toEqual(['new-2', 'old-0', 'old-1', 'old-2']);
    const oldest = [{ sessionId: 'old-3' }, { sessionId: 'old-4' }];
    expect(mergeOlderSessions(mergeOlderSessions(current, older, 4), oldest, 4).map(item => item.sessionId)).toEqual(['old-1', 'old-2', 'old-3', 'old-4']);
  });
});
