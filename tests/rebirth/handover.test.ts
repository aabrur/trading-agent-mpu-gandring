import { describe, expect, it } from 'vitest';
import {
  authorizeHandover,
  type HandoverEvidence
} from '../../server/v2/connectors/grok/commands.js';

describe('T17 Execution Authority Handover Verification', () => {
  it('stale_authority_epoch_blocked: handover rejected if expected version does not match active', async () => {
    const staleEvidence: HandoverEvidence = {
      accountRef: 'bybit:mainnet:default',
      targetAuthority: 'grok_agent',
      currentActiveVersion: 5,
      expectedActiveVersion: 4, // Stale!
      unreconciledPositions: 0,
      externalKeyRevoked: true
    };

    const result = await authorizeHandover(staleEvidence);
    expect(result.authorized).toBe(false);
    expect(result.reason).toContain('Epoch mismatch');
  });

  it('external_key_not_revoked_is_conflict: handover rejected if external key revocation is unverified', async () => {
    const conflictingEvidence: HandoverEvidence = {
      accountRef: 'bybit:mainnet:default',
      targetAuthority: 'grok_agent',
      currentActiveVersion: 5,
      expectedActiveVersion: 5,
      unreconciledPositions: 0,
      externalKeyRevoked: false // Conflict!
    };

    const result = await authorizeHandover(conflictingEvidence);
    expect(result.authorized).toBe(false);
    expect(result.reason).toContain('External key not revoked');
  });
});
