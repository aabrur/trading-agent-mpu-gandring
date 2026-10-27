import { afterEach, expect, it, vi } from 'vitest';
import { requestNewConversation } from '../web/src/useDesk.js';

afterEach(() => vi.unstubAllGlobals());

it('uses only the durable conversation ID returned by the server', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, conversationId: 'conv-durable' })));
  vi.stubGlobal('fetch', fetcher);
  expect(await requestNewConversation()).toBe('conv-durable');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe('/api/conversations/new');
  expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'POST' });
});

it.each([
  { status: 500, body: { ok: false, error: 'Conversation could not be saved.' } },
  { status: 200, body: { ok: true } }
])('rejects failed or incomplete creation instead of inventing a local ID', async ({ status, body }) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })));
  await expect(requestNewConversation()).rejects.toThrow(/conversation could not be/i);
});

it('propagates an unavailable backend instead of creating an unsaved conversation', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Backend unavailable')));
  await expect(requestNewConversation()).rejects.toThrow('Backend unavailable');
});
