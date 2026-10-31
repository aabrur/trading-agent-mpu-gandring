import { describe, expect, it } from 'vitest';
import {
  OwnerCommandService,
  type OwnerCommandProposal,
  type VerifiedOwnerGrant
} from '../../server/v2/connectors/grok/commands.js';

describe('T17 Grok Owner Command Proposals and Authority Scope Verification', () => {
  it('bot_cannot_promote_itself_to_owner: remote peer cannot claim Owner authority without independent grant', async () => {
    const service = new OwnerCommandService();

    const ungrantedProposal: OwnerCommandProposal = {
      proposalId: 'prop-bot-1',
      command: 'close BTCUSDT',
      accountRef: 'bybit:mainnet:default',
      expectedActiveVersion: 1,
      expiresAt: Date.now() + 60000,
      sourcePeer: 'grok-bot-untrusted'
    };

    const receipt = await service.propose(ungrantedProposal);
    expect(receipt.status).toBe('NEEDS_OWNER_PROOF');
    expect(receipt.reason).toContain('Independent Owner grant required');
  });

  it('one_time_grant_bound_to_exact_command: grant cannot be reused for a different command', async () => {
    const service = new OwnerCommandService();

    const grant: VerifiedOwnerGrant = service.createGrant({
      command: 'close BTCUSDT',
      accountRef: 'bybit:mainnet:default',
      expectedActiveVersion: 1,
      ttlMs: 60000
    });

    // Submitting with different command text must fail
    const mismatchedProposal: OwnerCommandProposal = {
      proposalId: 'prop-mismatch-1',
      command: 'open ETHUSDT LONG --stop 2500',
      accountRef: 'bybit:mainnet:default',
      expectedActiveVersion: 1,
      expiresAt: Date.now() + 60000,
      sourcePeer: 'grok-peer-1',
      grantId: grant.grantId
    };

    const receipt = await service.propose(mismatchedProposal);
    expect(receipt.status).toBe('REJECTED');
    expect(receipt.reason).toContain('Command digest mismatch');
  });

  it('expired_grant_not_reused: consumed or expired grant cannot be reused', async () => {
    const service = new OwnerCommandService();

    const grant = service.createGrant({
      command: 'close BTCUSDT',
      accountRef: 'bybit:mainnet:default',
      expectedActiveVersion: 1,
      ttlMs: 60000
    });

    const validProposal: OwnerCommandProposal = {
      proposalId: 'prop-valid-1',
      command: 'close BTCUSDT',
      accountRef: 'bybit:mainnet:default',
      expectedActiveVersion: 1,
      expiresAt: Date.now() + 60000,
      sourcePeer: 'grok-peer-1',
      grantId: grant.grantId
    };

    // First use succeeds
    const receipt1 = await service.propose(validProposal);
    expect(receipt1.status).toBe('APPLIED');

    // Second use rejected (consumed)
    const receipt2 = await service.propose({
      ...validProposal,
      proposalId: 'prop-replay-2'
    });
    expect(receipt2.status).toBe('REJECTED');
    expect(receipt2.reason).toContain('Grant already consumed or expired');
  });

  it('remote_unkill_keys_and_live_refused: sensitive operations rejected from remote proposals', async () => {
    const service = new OwnerCommandService();

    const unkillProposal: OwnerCommandProposal = {
      proposalId: 'prop-unkill-1',
      command: 'unkill',
      accountRef: 'bybit:mainnet:default',
      expectedActiveVersion: 1,
      expiresAt: Date.now() + 60000,
      sourcePeer: 'grok-peer-1'
    };

    const receipt = await service.propose(unkillProposal);
    expect(receipt.status).toBe('REJECTED');
    expect(receipt.reason).toContain('Remote unkill, key changes, and LIVE activation are refused');
  });
});
