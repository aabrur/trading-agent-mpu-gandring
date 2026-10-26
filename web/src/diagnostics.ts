/** Report failure metadata only; never send request bodies, headers or URL queries. */
export function installDiagnostics() {
  const originalFetch = window.fetch;
  const report = (event: 'error' | 'unhandledrejection' | 'request', message: string) => {
    void originalFetch('/api/logs/client', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event, message: message.slice(0, 1000), level: 'error' }) }).catch(() => {});
  };
  const onError = (event: ErrorEvent) => report('error', event.message || 'Browser script or resource failed');
  const onRejection = (event: PromiseRejectionEvent) => report('unhandledrejection', event.reason instanceof Error ? event.reason.message : 'Unhandled browser promise rejection');
  const instrumentedFetch: typeof fetch = async (input, init) => {
    let path = '';
    try { const url = new URL(input instanceof Request ? input.url : String(input), location.href); if (url.origin === location.origin && url.pathname.startsWith('/api/')) path = url.pathname; } catch { /* Non-URL requests are handled by fetch. */ }
    try {
      const response = await originalFetch(input, init);
      if (path && path !== '/api/logs/client' && !response.ok) report('request', `${path}: HTTP ${response.status}`);
      return response;
    } catch (error) {
      if (path && path !== '/api/logs/client' && !init?.signal?.aborted && !(error instanceof Error && error.name === 'AbortError')) report('request', `${path}: network request failed`);
      throw error;
    }
  };
  window.fetch = instrumentedFetch;
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    if (window.fetch === instrumentedFetch) window.fetch = originalFetch;
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
