import path from 'node:path';
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { collectRuntimeBoundary } from '../../scripts/check-runtime-boundary.mjs';
import { unavailableFinancialField } from '../../server/v2/contracts.js';
import { createReplacementRuntime } from '../../server/v2/runtime.js';
import { createReplacementApp } from '../../server/v2/app.js';

const ROOT = path.resolve(import.meta.dirname, '../..');

describe('T01 fresh startup, shared wire contract and import boundary', () => {
  it('excludes_legacy_desk_app_and_mock_provider_from_runtime_import_closure', () => {
    const report = collectRuntimeBoundary(ROOT);
    const importClosure = report.sourceClosure;

    expect(importClosure).not.toContain('server/desk.ts');
    expect(importClosure).not.toContain('server/app.ts');
    expect(importClosure).not.toContain('server/runtime.ts');
    expect(importClosure.some((p: string) => p.includes('providers/mock'))).toBe(false);
    expect(report.violations).toEqual([]);
  });

  it('starts_with_explicit_unavailable_state_and_no_fabricated_verdicts_or_mock_agents', async () => {
    const runtime = createReplacementRuntime();
    const state = runtime.snapshot();
    const unavailableField = unavailableFinancialField();

    expect(state.lastVerdict).toBeNull();
    expect(unavailableField).toEqual({ value: null, availability: 'UNAVAILABLE' });
    expect(state.financial.balance).toEqual({ value: null, availability: 'UNAVAILABLE' });
    expect(state.financial.equity).toEqual({ value: null, availability: 'UNAVAILABLE' });
    expect(state.verdicts).toEqual([]);

    for (const role of ['lead', 'market', 'research', 'strategist', 'risk', 'execution'] as const) {
      expect(state.agents[role].fellBackToMock).toBe(false);
      expect(state.agents[role].provider).not.toBe('mock');
    }

    const reply = await runtime.dispatch({
      kind: 'debate',
      symbol: 'BTCUSDT',
      actor: 'local_owner'
    });
    expect(reply.ok).toBe(false);
    expect(reply.code).toBe('SERVICE_UNAVAILABLE');
    expect(runtime.snapshot().lastVerdict).toBeNull();
  });

  it('serves_state_and_health_from_fresh_replacement_app_on_loopback', async () => {
    const runtime = createReplacementRuntime();
    const app = createReplacementApp(runtime);
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const port = (server.address() as { port: number }).port;
      const healthRes = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(healthRes.status).toBe(200);
      const health = (await healthRes.json()) as Record<string, unknown>;
      expect(health.ok).toBe(true);
      expect(health.runtimeGeneration).toBe('v2');

      const stateRes = await fetch(`http://127.0.0.1:${port}/api/state`);
      expect(stateRes.status).toBe(200);
      const state = (await stateRes.json()) as Record<string, unknown>;
      expect(state.lastVerdict).toBeNull();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
