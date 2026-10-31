import { describe, expect, it } from 'vitest';
import { JevClient } from '../../server/v2/agents/jev.js';
import { ROLE_DEFINITIONS } from '../../server/v2/agents/roles.js';

describe('T07 Jev optional evidence review without seventh vote or permission fields', () => {
  it('jev_off_does_not_remove_role and makes zero network requests when disabled', async () => {
    let networkRequests = 0;
    const client = new JevClient({
      enabled: false,
      apiKey: 'or-key-should-not-be-sent',
      fetchImpl: async () => {
        networkRequests += 1;
        return new Response('{}', { status: 200 });
      }
    });

    const review = await client.review({
      cycleId: 'cycle-jev-off',
      symbol: 'BTCUSDT',
      evidenceId: 'ev-jev-1',
      state: {
        last: '68900',
        BYBIT_API_SECRET: 'must-never-leak'
      }
    });

    expect(networkRequests).toBe(0);
    expect(review.status).toBe('disabled');
    expect(Object.keys(ROLE_DEFINITIONS)).toHaveLength(6);
    expect('approved' in review).toBe(false);
    expect('veto' in review).toBe(false);
    expect('allowEntry' in review).toBe(false);
  });

  it('preserves returned JevReview with claimRefs/contraryRefs, strips secrets and never adds permission fields', async () => {
    let sentBody = '';
    const secretApiKey = 'sk-or-jev-secret-123456';

    const client = new JevClient({
      enabled: true,
      apiKey: secretApiKey,
      model: 'openai/gpt-5-mini',
      endpoint: 'https://openrouter.example/api/v1/jev',
      fetchImpl: async (_url, init) => {
        sentBody = String(init?.body ?? '');
        return new Response(
          JSON.stringify({
            reviewId: 'jev-rev-42',
            claimRefs: ['ev-trend-4h', 'ev-book-imb'],
            contraryRefs: ['ev-1m-divergence'],
            reason: '4h structure aligns while 1m divergence warrants tight invalidation watch.',
            approved: true,
            veto: false
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
    });

    const review = await client.review({
      cycleId: 'cycle-jev-on',
      symbol: 'BTCUSDT',
      evidenceId: 'ev-jev-2',
      state: {
        symbol: 'BTCUSDT',
        apiSecret: 'hidden-exchange-secret',
        privateKey: '0x1234567890',
        opposingFacts: ['ev-1m-divergence']
      }
    });

    expect(sentBody).not.toContain('hidden-exchange-secret');
    expect(sentBody).not.toContain('0x1234567890');
    expect(sentBody).not.toContain(secretApiKey);

    expect(review).toEqual({
      status: 'completed',
      reviewId: 'jev-rev-42',
      claimRefs: ['ev-trend-4h', 'ev-book-imb'],
      contraryRefs: ['ev-1m-divergence'],
      reason: '4h structure aligns while 1m divergence warrants tight invalidation watch.'
    });
    expect(Object.keys(review).sort()).toEqual([
      'claimRefs',
      'contraryRefs',
      'reason',
      'reviewId',
      'status'
    ]);
  });
});
