import { describe, expect, it } from 'vitest';
import { AgentWorkQueue } from '../server/providers/work-queue.js';

describe('bounded independent local reasoning', () => {
  it('starts independent work together and preserves the process bound', async () => {
    const queue = new AgentWorkQueue(2);
    const releaseA = await queue.acquire();
    const releaseB = await queue.acquire();
    let started = false;
    const third = queue.acquire().then(release => { started = true; return release; });
    await Promise.resolve();
    expect(started).toBe(false);
    releaseA();
    const releaseC = await third;
    expect(started).toBe(true);
    releaseB(); releaseC();
  });
  it('cancels queued work without launching it and reuses capacity', async () => {
    const queue = new AgentWorkQueue(1);
    const release = await queue.acquire();
    const ctrl = new AbortController();
    const waiting = queue.acquire(ctrl.signal);
    ctrl.abort();
    await expect(waiting).rejects.toThrow(/cancelled/i);
    release();
    (await queue.acquire())();
  });
});
