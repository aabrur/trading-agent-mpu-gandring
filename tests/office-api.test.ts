import { afterEach, expect, it, vi } from 'vitest';
import { officeFetch, applyAndRestartOffice } from '../web/src/officeApi.js';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('releases a stalled control request with an actionable timeout instead of loading forever', async () => {
  vi.useFakeTimers();
  vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  }));
  const pending = officeFetch('/api/ops/auto', { method: 'POST' }, 100).then(() => null, (error: unknown) => error);
  await vi.advanceTimersByTimeAsync(101);
  expect(String(await pending)).toMatch(/timed out.*confirm.*before trying again/i);
});

it('does not confuse the still-running old server with a completed restart', async () => {
  vi.useFakeTimers();
  const json = (value: unknown) => new Response(JSON.stringify(value));
  const fetcher = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(json({ ok: true, instanceId: 'old' }))
    .mockResolvedValueOnce(json({ ok: true, restart: 'process' }))
    .mockResolvedValueOnce(json({ ok: true, instanceId: 'old' }))
    .mockResolvedValueOnce(json({ ok: true, instanceId: 'new' }));
  let completed = false;
  const pending = applyAndRestartOffice().then(() => { completed = true; });
  await vi.advanceTimersByTimeAsync(0);
  expect(completed).toBe(false);
  await vi.advanceTimersByTimeAsync(300);
  await pending;
  expect(fetcher).toHaveBeenCalledTimes(4);
});

it('surfaces a rejected settings apply without polling or claiming a restart', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response('{"ok":true,"instanceId":"old"}'))
    .mockResolvedValueOnce(new Response('{"ok":false,"detail":"Invalid saved settings"}', { status: 400 }));
  await expect(applyAndRestartOffice()).rejects.toThrow('Invalid saved settings');
  expect(fetcher).toHaveBeenCalledTimes(2);
});
