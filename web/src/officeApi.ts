/** Bound Office requests so a stalled backend cannot leave controls disabled indefinitely. */
export async function officeFetch(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  try {
    return await globalThis.fetch(input, { ...init, signal });
  } catch (error) {
    if (controller.signal.aborted && !init.signal?.aborted) throw new Error('Office request timed out. Refresh to confirm the result before trying again.');
    throw error;
  } finally { clearTimeout(timer); }
}

export async function applyAndRestartOffice(): Promise<void> {
  const before = await (await officeFetch('/api/health')).json() as { instanceId?: string };
  const response = await officeFetch('/api/setup/restart', { method: 'POST' });
  const result = await response.json() as { ok?: boolean; restart?: string; detail?: string };
  if (!response.ok || !result.ok) throw new Error(result.detail || 'Saved settings could not be applied.');
  if (result.restart === 'in-place') return;
  const until = Date.now() + 45_000;
  while (Date.now() < until) {
    try {
      const health = await officeFetch('/api/health', {}, 1500);
      const current = await health.json() as { ok?: boolean; instanceId?: string };
      if (health.ok && current.ok && current.instanceId && current.instanceId !== before.instanceId) return;
    } catch { /* The old process may be stopping or the replacement may still be starting. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Restart could not be confirmed. Check the mpu terminal for a startup error.');
}
