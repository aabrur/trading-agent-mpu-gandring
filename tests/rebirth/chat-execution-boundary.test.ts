import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createReplacementRuntime } from '../../server/v2/runtime.js';

describe('Task 6: Chat Execution Boundary and Direct Command Routing', () => {
  it('routes direct close commands to execution dispatcher even if agent is selected', async () => {
    const runtime = createReplacementRuntime();

    // Setup an active paper position for BNB
    runtime.updateState((draft) => {
      draft.paper.positions.push({
        symbol: 'BNB',
        side: 'LONG',
        qty: 1,
        entry: 710,
        mark: 703,
        unrealizedPnl: -7,
        stop: 696,
        tp: 730
      });
    });

    expect(runtime.snapshot().paper.positions.length).toBe(1);

    // Call handleCommand with an agent selected (like chatting with Desk Lead)
    const res = await runtime.handleCommand({
      text: '/close BNB',
      agent: 'lead'
    });

    expect(res.ok).toBe(true);
    expect(res.command).toBe('close');
    expect(runtime.snapshot().paper.positions.length).toBe(0);
  });

  it('normalizes Indonesian command phrases like tutup to close', async () => {
    const runtime = createReplacementRuntime();

    runtime.updateState((draft) => {
      draft.paper.positions.push({
        symbol: 'BNB',
        side: 'LONG',
        qty: 1,
        entry: 710,
        mark: 703,
        unrealizedPnl: -7,
        stop: 696,
        tp: 730
      });
    });

    const res = await runtime.handleCommand({
      text: 'tutup BNB',
      agent: 'lead'
    });

    expect(res.ok).toBe(true);
    expect(res.command).toBe('close');
    expect(runtime.snapshot().paper.positions.length).toBe(0);
  });

  it('verifies lead role prompt contains advisory-only boundary instructions', () => {
    const roleMd = readFileSync(
      path.join(process.cwd(), 'server/v2/agents/personas/lead/role.md'),
      'utf-8'
    );
    expect(roleMd).toContain('Conversational chat is strictly analytical advisory');
    expect(roleMd).toContain('/close <symbol>');
  });
});
