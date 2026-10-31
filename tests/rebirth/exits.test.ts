import { describe, expect, it } from 'vitest';
import { EXIT_TRIGGERS, type ExitTrigger } from '../../server/v2/contracts.js';
import { evaluateExits, authorizeOwnerClose } from '../../server/v2/decision/exits.js';

describe('T08 nine independent verified exit triggers, zero duration-only exit and direct Owner close', () => {
  it('evaluates every one of the nine named exit triggers independently of entry confidence, slot occupancy, free margin, Jev or browser outage', () => {
    expect(EXIT_TRIGGERS).toHaveLength(9);

    for (const trigger of EXIT_TRIGGERS) {
      const exits = evaluateExits({
        observedAt: 1_760_100_000_000,
        entryGateState: {
          leadProbability: 0.05,
          occupiedSlots: 4,
          maxPositions: 4,
          freeMarginUsdt: '0',
          jevStatus: 'unavailable',
          browserStatus: 'unavailable'
        },
        positions: [
          {
            positionRef: `pos-${trigger}`,
            accountRef: 'bybit:testnet:LIVE',
            symbol: 'BTCUSDT',
            side: 'LONG',
            openedAt: 1_760_000_000_000,
            verifiedTriggers: [
              {
                trigger: trigger as ExitTrigger,
                evidenceRefs: [`ev-${trigger.toLowerCase()}`],
                reason: `Verified ${trigger} condition`
              }
            ]
          }
        ]
      });

      expect(exits).toHaveLength(1);
      expect(exits[0]).toMatchObject({
        trigger,
        positionRef: `pos-${trigger}`,
        evidenceRefs: [`ev-${trigger.toLowerCase()}`],
        observedAt: 1_760_100_000_000
      });
    }
  });

  it('produces zero autonomous exits from hold duration alone and allows explicit Owner close immediately', () => {
    const durationOnly = evaluateExits({
      observedAt: 1_760_500_000_000,
      entryGateState: {
        leadProbability: 0.9,
        occupiedSlots: 1,
        maxPositions: 4,
        freeMarginUsdt: '800',
        jevStatus: 'completed',
        browserStatus: 'ok'
      },
      positions: [
        {
          positionRef: 'pos-held-7-days',
          accountRef: 'paper:default',
          symbol: 'ETHUSDT',
          side: 'SHORT',
          openedAt: 1_760_500_000_000 - 7 * 24 * 60 * 60 * 1000,
          verifiedTriggers: []
        }
      ]
    });
    expect(durationOnly).toEqual([]);

    const ownerClose = authorizeOwnerClose({
      ownerVerified: true,
      requestId: 'owner-close-1',
      observedAt: 1_760_500_005_000,
      position: {
        positionRef: 'pos-eth-short',
        accountRef: 'paper:default',
        symbol: 'ETHUSDT',
        side: 'SHORT'
      }
    });
    expect(ownerClose.authorized).toBe(true);
    expect(ownerClose.positionRef).toBe('pos-eth-short');
  });
});
