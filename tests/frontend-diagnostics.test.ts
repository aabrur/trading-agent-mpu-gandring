import { afterEach, expect, it, vi } from 'vitest';
import { installDiagnostics } from '../web/src/diagnostics.js';

afterEach(() => vi.unstubAllGlobals());
it('reports API failures without query, body or headers, avoids report loops and removes listeners on cleanup', async () => {
  const requests = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: String(input).startsWith('/api/logs/client') ? 200 : 503 }));
  const target = Object.assign(new EventTarget(), { fetch: requests });
  vi.stubGlobal('window', target);
  vi.stubGlobal('location', { href: 'http://localhost:5173/', origin: 'http://localhost:5173' });
  const uninstall = installDiagnostics();
  try {
    const response = await target.fetch('/api/state?token=private-query', { headers: { authorization: 'private-header' }, body: 'private-body' });
    expect(response.status).toBe(503);
    expect(requests).toHaveBeenCalledTimes(2);
    const diagnostic = requests.mock.calls[1];
    expect(diagnostic[0]).toBe('/api/logs/client');
    expect(JSON.parse(String(diagnostic[1]?.body))).toMatchObject({ event: 'request', message: '/api/state: HTTP 503' });
    expect(JSON.stringify(diagnostic)).not.toContain('private-');
    await target.fetch('/api/logs/client');
    expect(requests).toHaveBeenCalledTimes(3);
    target.dispatchEvent(Object.assign(new Event('error'), { message: 'Render failed' }));
    expect(requests).toHaveBeenCalledTimes(4);
  } finally { uninstall(); }
  expect(target.fetch).toBe(requests);
  target.dispatchEvent(Object.assign(new Event('error'), { message: 'After cleanup' }));
  expect(requests).toHaveBeenCalledTimes(4);
});
