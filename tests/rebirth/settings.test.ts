import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeStore } from '../../server/v2/store/database.js';
import {
  resolveTradingPresetValues,
  OwnerSettingsSchema
} from '../../server/v2/settings/schema.js';
import { SecretStore } from '../../server/v2/settings/secrets.js';
import { SettingsService } from '../../server/v2/settings/service.js';

const tempDirs: string[] = [];

function makeFixturePaths() {
  const root = mkdtempSync(path.join(tmpdir(), 'mpu-rebirth-settings-'));
  tempDirs.push(root);
  return {
    root,
    dbFile: path.join(root, '.mpu-gandring', 'rebirth', 'runtime.sqlite'),
    envFile: path.join(root, 'fixture.env')
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // Ignore delayed handle cleanup on Windows.
    }
  }
});

describe('T03 versioned settings and secrets coordinator', () => {
  it('imports_legacy_env_without_replacing_capital_fields_and_preserves_presets', async () => {
    const { dbFile, envFile } = makeFixturePaths();
    const rawSecret = 'xai-super-secret-token-998877665544';
    writeFileSync(
      envFile,
      [
        'TRADING_MODE=PAPER',
        'APP_MODE=local',
        'PAPER_BALANCE=1500',
        'SAFETY_NET=275',
        'OPEN_ORDERS_N=3',
        'MIN_ORDER_USDT=25',
        'MAX_ORDER_USDT=400',
        'DAILY_LOSS_LIMIT_PCT=8',
        'MAX_LOSS_PER_TRADE_PCT=15',
        'MIN_ENTRY_CONFIDENCE_PCT=65',
        'MAX_LEVERAGE=6',
        'DEFAULT_STOP_PCT=18',
        'MIN_STOP_PCT=1.5',
        'TAKE_PROFIT_PCT=54',
        'TAKE_PROFIT_R=3',
        `XAI_API_KEY=${rawSecret}`,
        'DEFAULT_PROVIDER=xai',
        'XAI_MODEL=grok-4'
      ].join('\n') + '\n',
      'utf8'
    );
    const originalEnvContent = readFileSync(envFile, 'utf8');

    const store = await RuntimeStore.open(dbFile);
    const secrets = new SecretStore({ envFile, allowWrite: false });
    const beforeSnapshot = SettingsService.parseLegacyEnv(secrets.readEnvMap());
    const service = await SettingsService.initialize(store, secrets);
    const before = { effective: beforeSnapshot, activeVersion: 1 };
    const after = service.current();

    expect(after.effective.trading).toEqual(before.effective.trading); // migration import
    expect(after.activeVersion).toBe(1);
    expect(after.savedVersion).toBe(1);

    // Preset resolution preserves account-specific capital fields (safetyNet, minOrderUsdt, maxOrderUsdt)
    const savedBase = after.effective.trading;
    const profile = resolveTradingPresetValues('aggressive', savedBase);
    expect(profile.safetyNet).toBe(savedBase.safetyNet); // preset resolution
    expect(profile.minOrderUsdt).toBe(savedBase.minOrderUsdt);
    expect(profile.maxOrderUsdt).toBe(savedBase.maxOrderUsdt);
    expect(profile.maxLeverage).toBe(20);

    // No secrets appear in current snapshot or persisted events
    expect(JSON.stringify(after)).not.toContain(rawSecret);
    const eventRows = await store.execute('SELECT payload_json FROM events');
    expect(JSON.stringify(eventRows.rows)).not.toContain(rawSecret);

    // Read-only import does not mutate .env
    expect(readFileSync(envFile, 'utf8')).toBe(originalEnvContent);

    await store.close();
  });

  it('enforces_prepare_activate_optimistic_concurrency_and_n_bounds_1_to_4', async () => {
    const { dbFile, envFile } = makeFixturePaths();
    writeFileSync(envFile, 'TRADING_MODE=PAPER\nOPEN_ORDERS_N=3\nSAFETY_NET=200\n', 'utf8');

    const store = await RuntimeStore.open(dbFile);
    const secrets = new SecretStore({ envFile, allowWrite: false });

    let failSubsystem = false;
    const service = await SettingsService.initialize(store, secrets, {
      prepareHook: async () => {
        if (failSubsystem) {
          throw new Error('Bybit subscription validation failed');
        }
        return { marketHub: 'ready', roleClients: 'ready' };
      }
    });

    const before = service.current();

    // N=0 rejected; valid N 1..4 round-trips cleanly
    expect(() =>
      OwnerSettingsSchema.parse({
        ...before.effective,
        trading: { ...before.effective.trading, maxPositions: 0 }
      })
    ).toThrow();

    const nZeroResult = await service.apply(
      { trading: { maxPositions: 0 } },
      before.activeVersion
    );
    expect(nZeroResult.applyStatus).toBe('failed');
    expect(service.current().activeVersion).toBe(before.activeVersion);

    let expectedVer = before.activeVersion;
    for (const validN of [1, 2, 3, 4] as const) {
      const res = await service.apply({ trading: { maxPositions: validN } }, expectedVer);
      expect(res.applyStatus).toBe('applied');
      expect(service.current().effective.trading.maxPositions).toBe(validN);
      expectedVer = res.activeVersion;
    }

    // Prepare failure keeps previous activeVersion intact while recording failed candidate
    const prior = service.current();
    failSubsystem = true;
    const failed = await service.apply(
      { auto: { intervalMin: 30 } },
      prior.activeVersion
    );
    expect(failed.applyStatus).toBe('failed');
    expect(failed.activeVersion).toBe(prior.activeVersion);
    expect(service.current().activeVersion).toBe(prior.activeVersion);
    failSubsystem = false;

    // Stale expectedActiveVersion returns conflict without mutating active settings
    const conflict = await service.apply(
      { auto: { intervalMin: 20 } },
      prior.activeVersion - 1
    );
    expect(conflict.applyStatus).toBe('conflict');
    expect(service.current().activeVersion).toBe(prior.activeVersion);

    await store.close();
  });

  it('handles_queued_intent_invalidation_post_commit_crash_recovery_and_monotonic_remote_ack', async () => {
    const { dbFile, envFile } = makeFixturePaths();
    writeFileSync(envFile, 'TRADING_MODE=PAPER\nSAFETY_NET=200\n', 'utf8');

    const store = await RuntimeStore.open(dbFile);
    const secrets = new SecretStore({ envFile, allowWrite: false });
    let crashBeforeMemoryPublish = false;

    const service = await SettingsService.initialize(store, secrets, {
      afterCommitBeforePublishHook: () => {
        if (crashBeforeMemoryPublish) {
          throw new Error('simulated crash after SQLite commit before in-memory publish');
        }
      }
    });

    const initial = service.current();
    const queuedIntentPolicyVersion = service.tradingPolicyVersion();

    // UI-only change does NOT invalidate queued trading intents
    const uiRes = await service.apply(
      { preferences: { tradingviewWidget: true } },
      initial.activeVersion
    );
    expect(uiRes.applyStatus).toBe('applied');
    expect(service.requiresIntentReevaluation(queuedIntentPolicyVersion)).toBe(false);

    // Trading-critical change DOES invalidate queued trading intents from prior policy
    const tradeRes = await service.apply(
      { trading: { maxLeverage: 3 } },
      uiRes.activeVersion
    );
    expect(tradeRes.applyStatus).toBe('applied');
    expect(service.requiresIntentReevaluation(queuedIntentPolicyVersion)).toBe(true);

    // Simulate crash right after DB active_config commit before in-memory publish, then recover
    crashBeforeMemoryPublish = true;
    await expect(
      service.apply({ trading: { maxLeverage: 4 } }, tradeRes.activeVersion)
    ).rejects.toThrow(/before in-memory publish/);
    crashBeforeMemoryPublish = false;

    await service.recover();
    expect(service.current().effective.trading.maxLeverage).toBe(4);
    const committedVer = service.current().activeVersion;

    // Monotonic remote config ack: older remote callback never downgrades active or acked version
    await service.recordRemoteConfigAck(committedVer);
    await service.recordRemoteConfigAck(1);
    expect(service.lastAcknowledgedRemoteVersion()).toBe(committedVer);
    expect(service.current().activeVersion).toBe(committedVer);

    await store.close();
  });
});
