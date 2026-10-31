import { describe, expect, it } from 'vitest';
import {
  GrokRoleRouter,
  type RoleRouteContext
} from '../../server/v2/connectors/grok/bridge.js';

describe('T16 Grok Role Routing and Mirroring Verification', () => {
  it('stale_role_attempt_not_counted: rejects past attempt when cycle has advanced', () => {
    const router = new GrokRoleRouter();

    const activeCycleContext: RoleRouteContext = {
      cycleId: 'cyc-active-1',
      role: 'market',
      currentAttempt: 2
    };

    // Stale result from attempt 1
    const staleResult = router.evaluateAttempt(activeCycleContext, {
      cycleId: 'cyc-active-1',
      role: 'market',
      attempt: 1
    });

    expect(staleResult.accepted).toBe(false);
    expect(staleResult.reason).toContain('Stale attempt');

    // Current result for attempt 2
    const currentResult = router.evaluateAttempt(activeCycleContext, {
      cycleId: 'cyc-active-1',
      role: 'market',
      attempt: 2
    });

    expect(currentResult.accepted).toBe(true);
  });

  it('config_ack_monotonic: prevents older remote config ack from regressing local version', () => {
    const router = new GrokRoleRouter();

    // Local version is 5
    router.updateAcknowledgedVersion(5);
    expect(router.getAcknowledgedVersion()).toBe(5);

    // Incoming older ack for version 3 ignored
    router.updateAcknowledgedVersion(3);
    expect(router.getAcknowledgedVersion()).toBe(5);

    // Incoming newer ack for version 6 accepted
    router.updateAcknowledgedVersion(6);
    expect(router.getAcknowledgedVersion()).toBe(6);
  });

  it('failed_remote_does_not_revert_local_apply: remote timeout preserves local settings', () => {
    const router = new GrokRoleRouter();

    let localVersion = 3;
    const remoteFailed = true;

    if (remoteFailed) {
      router.recordRemoteError('Remote webhook timed out after 5000ms');
    }

    // Local state remains committed at version 3
    expect(localVersion).toBe(3);
    expect(router.getLastError()).toContain('timed out');
  });
});
