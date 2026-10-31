import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createReplacementRuntime } from '../../server/v2/runtime.js';
import { createReplacementApp } from '../../server/v2/app.js';
import { RoleRunner } from '../../server/v2/agents/runner.js';
import { CycleRunner } from '../../server/v2/decision/cycle.js';

describe('Cycle Ops and Command Integration Verification', () => {
  async function withTestApp(fn: (baseUrl: string, runtime: any) => Promise<void>) {
    const roleRunner = new RoleRunner({
      providerCaller: async () =>
        JSON.stringify({
          stance: 'LONG',
          decision: 'APPROVE',
          claimRefs: ['ev-test-1'],
          contraryRefs: [],
          reasoning: 'Verified bullish structure test',
          confidence: { value: 0.82, scale: 'probability_0_1' },
          proposedStop: '65000',
          proposedTp: '72000'
        }),
      resolveAssignment: () => ({
        provider: 'openai',
        model: 'gpt-4o-mini',
        apiKey: 'test-key'
      })
    });

    const cycleRunner = new CycleRunner({ roleRunner });
    const runtime = createReplacementRuntime({
      roleRunner,
      cycleRunner
    });

    const app = createReplacementApp(runtime);
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      await fn(baseUrl, runtime);
    } finally {
      await runtime.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it('ops_auto_run_now_triggers_cycle_and_returns_auto_object', async () => {
    await withTestApp(async (baseUrl, runtime) => {
      const res = await fetch(`${baseUrl}/api/ops/auto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runNow: true, symbols: ['BTCUSDT'] })
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.ok).toBe(true);
      expect(data.auto).toBeDefined();
      expect(data.auto.intervalMin).toBeDefined();
      expect(Array.isArray(data.auto.symbols)).toBe(true);

      // Wait for cycle to complete
      await new Promise((resolve) => setTimeout(resolve, 300));
      const state = runtime.snapshot();
      expect(state.verdicts.length).toBeGreaterThan(0);
      expect(state.verdicts[0].action).toBe('OPEN_LONG');
      expect(state.paper.positions.length).toBeGreaterThan(0);
    });
  });

  it('command_analyze_starts_debate_cycle', async () => {
    await withTestApp(async (baseUrl, runtime) => {
      const res = await fetch(`${baseUrl}/api/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'analyze ETHUSDT' })
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.ok).toBe(true);
      expect(data.reply).toContain('ETHUSDT');

      await new Promise((resolve) => setTimeout(resolve, 300));
      const state = runtime.snapshot();
      expect(state.verdicts.some((v: any) => v.symbol === 'ETHUSDT')).toBe(true);
    });
  });

  it('ops_close_all_closes_paper_positions', async () => {
    await withTestApp(async (baseUrl, runtime) => {
      runtime.updateState((draft: any) => {
        draft.paper.positions.push({
          id: 'test-pos-1',
          symbol: 'BTCUSDT',
          side: 'LONG',
          qty: 0.05,
          entry: 65000,
          stop: 63000,
          tp: 70000,
          margin: 100,
          leverage: 5,
          openedAt: Date.now(),
          mark: 66000,
          unrealizedPnl: 50
        });
      });

      expect(runtime.snapshot().paper.positions.length).toBe(1);

      const res = await fetch(`${baseUrl}/api/ops/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: 'all' })
      });

      expect(res.status).toBe(200);
      expect(runtime.snapshot().paper.positions.length).toBe(0);
      expect(runtime.snapshot().paper.closed.length).toBe(1);
    });
  });
});
