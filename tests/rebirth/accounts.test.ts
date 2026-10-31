import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeStore } from '../../server/v2/store/database.js';
import { AccountRegistry } from '../../server/v2/accounts/registry.js';
import { ExecutionAuthorityService } from '../../server/v2/accounts/authority.js';

const tempDirs: string[] = [];

function createDbFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'mpu-rebirth-accounts-'));
  tempDirs.push(dir);
  return path.join(dir, '.mpu-gandring', 'rebirth', 'runtime.sqlite');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore delayed Windows file lock release.
    }
  }
});

describe('T03 account lifecycle registry and execution authority', () => {
  it('retains_draining_accounts_with_open_exposure_when_switching_active_account', async () => {
    const store = await RuntimeStore.open(createDbFile());
    const authority = new ExecutionAuthorityService(store, 'local-runtime-1');
    const registry = await AccountRegistry.open(store, authority);

    await registry.register({
      accountRef: 'account-old',
      venue: 'bybit',
      network: 'testnet',
      mode: 'TESTNET',
      nativeIdentity: 'bybit-uid-1001',
      subaccountRef: null
    });
    await registry.activate('account-old');
    await registry.attachExposure('account-old', {
      positionRefs: ['pos-btc-long-1'],
      pendingIntentIds: ['intent-entry-1']
    });

    await registry.register({
      accountRef: 'account-new',
      venue: 'aster',
      network: 'testnet',
      mode: 'TESTNET',
      nativeIdentity: '0xabc111222333444555666777888999000aaabbbc',
      subaccountRef: null
    });
    await registry.activate('account-new');

    const activeAccount = registry.activeAccountRef();
    const monitoredAccounts = registry
      .contexts()
      .filter((ctx) => ctx.lifecycle === 'ACTIVE' || ctx.lifecycle === 'DRAINING')
      .map((ctx) => ctx.scope.accountRef);

    expect(activeAccount).toBe('account-new');
    expect(monitoredAccounts).toEqual(expect.arrayContaining(['account-old', 'account-new']));

    const oldCtx = registry.contexts().find((c) => c.scope.accountRef === 'account-old')!;
    expect(oldCtx.lifecycle).toBe('DRAINING');
    expect(oldCtx.positionRefs).toEqual(['pos-btc-long-1']);
    expect(oldCtx.pendingIntentIds).toEqual(['intent-entry-1']);

    // Once exposure is settled, old account transitions out of DRAINING cleanly
    await registry.clearExposure('account-old');
    expect(registry.contexts().find((c) => c.scope.accountRef === 'account-old')).toBeUndefined();

    await store.close();
  });

  it('preserves_account_identity_across_key_rotation_and_separates_distinct_accounts_on_same_venue', async () => {
    const store = await RuntimeStore.open(createDbFile());
    const authority = new ExecutionAuthorityService(store, 'local-runtime-1');
    const registry = await AccountRegistry.open(store, authority);

    // Key 1 on Bybit UID 777
    const first = await registry.resolveOrRegister({
      venue: 'bybit',
      network: 'mainnet',
      mode: 'LIVE',
      nativeIdentity: 'bybit-uid-777',
      subaccountRef: 'sub-main'
    });

    // Rotated API key on the SAME Bybit UID 777 + subaccount 'sub-main'
    const rotated = await registry.resolveOrRegister({
      venue: 'bybit',
      network: 'mainnet',
      mode: 'LIVE',
      nativeIdentity: 'bybit-uid-777',
      subaccountRef: 'sub-main'
    });
    expect(rotated.accountRef).toBe(first.accountRef);

    // Different account on the SAME venue (UID 888) gets a distinct accountRef
    const second = await registry.resolveOrRegister({
      venue: 'bybit',
      network: 'mainnet',
      mode: 'LIVE',
      nativeIdentity: 'bybit-uid-888',
      subaccountRef: 'sub-main'
    });
    expect(second.accountRef).not.toBe(first.accountRef);

    // Different subaccount on UID 777 also gets a distinct accountRef
    const third = await registry.resolveOrRegister({
      venue: 'bybit',
      network: 'mainnet',
      mode: 'LIVE',
      nativeIdentity: 'bybit-uid-777',
      subaccountRef: 'sub-hedge'
    });
    expect(third.accountRef).not.toBe(first.accountRef);

    // Epoch increments monotonically on authority claim/handover
    const claim1 = await authority.claim(first.accountRef);
    const claim2 = await authority.bumpEpoch(first.accountRef, 'local-runtime-2');
    expect(claim2.writerEpoch).toBe(claim1.writerEpoch + 1);
    expect(claim2.holderId).toBe('local-runtime-2');

    await store.close();
  });
});
