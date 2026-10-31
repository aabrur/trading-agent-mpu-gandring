import { describe, expect, it } from 'vitest';
import { JevClient } from '../../server/v2/agents/jev.js';
import { RoleRunner } from '../../server/v2/agents/runner.js';
import { CycleRunner } from '../../server/v2/decision/cycle.js';

describe('T08 six-role deliberation sequence, Jev visibility, consensus options and honest incomplete status', () => {
  it('runs observe -> challenge -> risk/execution -> lead with Jev review preserved and no double-voting', async () => {
    const seenPrompts: Array<{ role: string; phase: string; user: string }> = [];

    const runner = new RoleRunner({
      providerCaller: async (req) => {
        seenPrompts.push({ role: req.role, phase: req.phase, user: req.user });
        if (req.role === 'risk') {
          return JSON.stringify({
            stance: 'LONG',
            decision: 'APPROVE',
            claimRefs: ['ev-mkt-1'],
            contraryRefs: ['ev-1m-pullback'],
            reasoning: 'Stop geometry and Owner risk caps respected.',
            confidence: { value: 0.8, scale: 'probability_0_1' }
          });
        }
        if (req.role === 'lead') {
          return JSON.stringify({
            stance: 'LONG',
            claimRefs: ['ev-mkt-1', 'ev-jev-claim'],
            contraryRefs: ['ev-1m-pullback'],
            reasoning: 'Aligned 4h/1h bullish structure with Risk approval.',
            confidence: { value: 0.76, scale: 'probability_0_1' },
            proposedStop: '67500',
            proposedTp: '71500',
            proposedOrderType: 'MARKET',
            invalidationPredicate: {
              kind: 'PRICE_BELOW',
              level: '67500',
              timeframe: '15m',
              description: 'Invalidate LONG below 67500 structural low'
            }
          });
        }
        return JSON.stringify({
          stance: req.role === 'research' ? 'HOLD' : 'LONG',
          claimRefs: ['ev-mkt-1'],
          contraryRefs: [],
          reasoning: `${req.role} ${req.phase} analysis`,
          confidence:
            req.role === 'strategist'
              ? { value: 82, scale: 'score_0_100' }
              : { value: 4, scale: 'ordinal_1_5' },
          proposedStop: '67500',
          proposedTp: '71500'
        });
      },
      resolveAssignment: (role) => ({
        provider: 'openai',
        model: `gpt-5-${role}`,
        apiKey: 'test-key'
      })
    });

    const jev = new JevClient({
      enabled: true,
      apiKey: 'jev-test-key',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            reviewId: 'jev-review-99',
            claimRefs: ['ev-jev-claim'],
            contraryRefs: ['ev-1m-pullback'],
            reason: 'Confirmed 4h structure; watch 1m pullback.'
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    });

    const cycleRunner = new CycleRunner({ roleRunner: runner, jevClient: jev });
    const out = await cycleRunner.run({
      cycleId: 'cycle-debate-1',
      reason: 'schedule',
      accountRef: 'paper:default',
      symbol: 'BTCUSDT',
      evidenceId: 'ev-mkt-1',
      configVersion: 3,
      policy: {
        minEntryConfidencePct: 70,
        requireTwoOfThreeAnalysts: false
      },
      marketSummary: { last: '68500', venue: 'bybit', category: 'linear' }
    });

    expect(out.status).toBe('completed');
    expect(out.jevReviewId).toBe('jev-review-99');
    expect(out.jevReview?.claimRefs).toEqual(['ev-jev-claim']);
    expect(out.verdict?.action).toBe('OPEN_LONG');
    expect(out.verdict?.thesis?.stop).toBe('67500');

    // Lead final prompt received both challenge results and Jev review ID (not null placeholder).
    const leadFinalPrompt = seenPrompts.find((p) => p.role === 'lead' && p.phase === 'final');
    expect(leadFinalPrompt?.user).toContain('jev-review-99');

    // Distinct role count participating is strictly <= 6 (observe + challenge phases are not double votes).
    const uniqueRoles = new Set(out.roleResults.map((r) => r.role));
    expect(uniqueRoles.size).toBe(6);
  });

  it('does not fabricate HOLD success when an authoritative role provider fails', async () => {
    const runner = new RoleRunner({
      providerCaller: async (req) => {
        if (req.role === 'risk') {
          throw new Error('Provider HTTP 503');
        }
        return JSON.stringify({
          stance: 'LONG',
          claimRefs: ['ev-1'],
          contraryRefs: [],
          reasoning: 'Bullish setup',
          confidence: { value: 0.85, scale: 'probability_0_1' },
          proposedStop: '67000'
        });
      },
      resolveAssignment: () => ({
        provider: 'openai',
        model: 'gpt-5',
        apiKey: 'test-key'
      })
    });

    const cycleRunner = new CycleRunner({ roleRunner: runner });
    const out = await cycleRunner.run({
      cycleId: 'cycle-incomplete-1',
      reason: 'schedule',
      accountRef: 'paper:default',
      symbol: 'BTCUSDT',
      evidenceId: 'ev-1',
      configVersion: 1,
      policy: {
        minEntryConfidencePct: 60,
        requireTwoOfThreeAnalysts: false
      },
      marketSummary: { last: '68500' }
    });

    expect(out.status).toBe('incomplete');
    expect(out.verdict).toBeNull();
  });

  it('applies 2-of-3 analyst consensus gate only when explicitly selected by Owner policy', async () => {
    const runner = new RoleRunner({
      providerCaller: async (req) => {
        if (req.role === 'risk') {
          return JSON.stringify({
            stance: 'LONG',
            decision: 'APPROVE',
            claimRefs: ['ev-1'],
            contraryRefs: [],
            reasoning: 'Risk approved',
            confidence: { value: 0.75, scale: 'probability_0_1' }
          });
        }
        if (req.role === 'lead') {
          return JSON.stringify({
            stance: 'LONG',
            claimRefs: ['ev-1'],
            contraryRefs: [],
            reasoning: 'Lead wants LONG',
            confidence: { value: 0.8, scale: 'probability_0_1' },
            proposedStop: '67000',
            invalidationPredicate: {
              kind: 'PRICE_BELOW',
              level: '67000',
              description: 'Below 67000'
            }
          });
        }
        // Only market says LONG; research and strategist say HOLD (1 of 3 analysts).
        const stance = req.role === 'market' ? 'LONG' : 'HOLD';
        return JSON.stringify({
          stance,
          claimRefs: ['ev-1'],
          contraryRefs: [],
          reasoning: `${req.role} says ${stance}`,
          confidence: { value: 3, scale: 'ordinal_1_5' }
        });
      },
      resolveAssignment: () => ({
        provider: 'openai',
        model: 'gpt-5',
        apiKey: 'test-key'
      })
    });

    const cycleRunner = new CycleRunner({ roleRunner: runner });

    const withoutGate = await cycleRunner.run({
      cycleId: 'cycle-cons-off',
      reason: 'schedule',
      accountRef: 'paper:default',
      symbol: 'BTCUSDT',
      evidenceId: 'ev-1',
      configVersion: 1,
      policy: {
        minEntryConfidencePct: 65,
        requireTwoOfThreeAnalysts: false
      },
      marketSummary: { last: '68500' }
    });
    expect(withoutGate.verdict?.action).toBe('OPEN_LONG');

    const withGate = await cycleRunner.run({
      cycleId: 'cycle-cons-on',
      reason: 'schedule',
      accountRef: 'paper:default',
      symbol: 'BTCUSDT',
      evidenceId: 'ev-1',
      configVersion: 2,
      policy: {
        minEntryConfidencePct: 65,
        requireTwoOfThreeAnalysts: true
      },
      marketSummary: { last: '68500' }
    });
    expect(withGate.verdict?.action).toBe('HOLD');
    expect(withGate.verdict?.rejectionReason).toMatch(/2-of-3/i);
  });
});
