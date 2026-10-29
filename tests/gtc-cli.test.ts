import { describe, expect, it, vi } from 'vitest';
import { gb } from '../cli/gb.js';
import { AgentOpenSchema } from '../server/schemas.js';

function transport() {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(JSON.stringify({ ok: true, reply: 'Resting entry recorded' }));
  });
  return { requests, fetchImpl, env: { APP_MODE: 'grokbot', AGENT_EVENT_SECRET: 'fixture-gtc-command-secret' } };
}

describe('explicit GTC command selection', () => {
  it('sends a discriminated LIMIT only from an explicit CLI flag', async () => {
    const t = transport();
    expect((await gb(['open', 'BTCUSDT', 'LONG', '--limit', '100.09', '--client-id', 'owner-limit-1'], t)).ok).toBe(true);
    expect(t.requests[0].body).toMatchObject({ entry: { type: 'LIMIT_GTC', price: 100.09 }, clientId: 'owner-limit-1' });
    expect(t.requests[0].body.entry).not.toHaveProperty('expireAt');
  });
  it('keeps legacy MARKET payloads unchanged, including a limit mentioned in reason text', async () => {
    const t = transport();
    await gb(['open', 'BTCUSDT', 'LONG', '--reason', 'consider --limit 99 later'], t);
    expect(t.requests[0].body).not.toHaveProperty('entry');
    expect(t.requests[0].body).not.toHaveProperty('clientId');
  });
  it.each([['--ttl-min', '15'], ['--limit', 'NaN'], ['--limit', '-1'], ['--limit', '100', '--ttl-min', '0'], ['--client-id', 'orphan']])('rejects malformed selection %j before any HTTP', async (...flags) => {
    const t = transport();
    expect((await gb(['open', 'BTCUSDT', 'LONG', ...flags], t)).ok).toBe(false);
    expect(t.fetchImpl).not.toHaveBeenCalled();
  });
  it('uses Owner-selected TTL only and routes entry cancellation explicitly', async () => {
    const t = transport(), started = Date.now();
    await gb(['open', 'BTCUSDT', 'LONG', '--limit', '100', '--ttl-min', '10'], t);
    expect((t.requests[0].body.entry as { expireAt: number }).expireAt).toBeGreaterThanOrEqual(started + 600000);
    await gb(['cancel-entry', 'owner-limit-1'], t);
    expect(t.requests[1]).toMatchObject({ url: expect.stringContaining('/api/gb/cancel-entry'), body: { clientId: 'owner-limit-1' } });
  });
  it('validates mutually exclusive entry shapes through the normal agent admission schema', () => {
    const ticket = { symbol: 'BTCUSDT', side: 'LONG', confidence: .6, riskApproval: 'APPROVE', reason: 'Owner explicitly selected this limit' };
    expect(AgentOpenSchema.safeParse({ ...ticket, entry: { type: 'LIMIT_GTC', price: 100 } }).success).toBe(true);
    expect(AgentOpenSchema.safeParse({ ...ticket, entry: { type: 'MARKET', price: 100 } }).success).toBe(false);
    expect(AgentOpenSchema.safeParse({ ...ticket, entry: { type: 'LIMIT_GTC' } }).success).toBe(false);
  });
});
