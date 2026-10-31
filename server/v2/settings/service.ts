import { createHash, randomUUID } from 'node:crypto';
import {
  EXCHANGES,
  ROLE_IDS,
  type AppMode,
  type Network,
  type RoleId,
  type TradingMode,
  type VenueId
} from '../contracts.js';
import type { RuntimeStore } from '../store/database.js';
import {
  API_PROVIDERS,
  DEFAULT_TRADING_SETTINGS,
  MODEL_PROVIDERS,
  OwnerSettingsPatchSchema,
  OwnerSettingsSchema,
  TRADING_PROFILES,
  type ApiProviderId,
  type ModelProviderId,
  type OwnerSettings,
  type OwnerSettingsPatch,
  type TradingProfile,
  type TradingSettings
} from './schema.js';
import { PROVIDER_KEY_ENV, type SecretStore } from './secrets.js';

export interface SettingsSnapshot {
  savedVersion: number;
  activeVersion: number;
  effective: OwnerSettings;
  appliedAt: number | null;
}

export interface ApplyResult {
  savedVersion: number;
  activeVersion: number;
  applyStatus: 'applied' | 'failed' | 'conflict';
  appliedAt: number | null;
  reason: string | null;
  subsystems: Record<string, string>;
}

export interface SettingsCoordinatorHooks {
  prepareHook?: (candidate: OwnerSettings, version: number) => Promise<Record<string, string>>;
  onActivated?: (snapshot: SettingsSnapshot) => void | Promise<void>;
  afterCommitBeforePublishHook?: () => void;
}

const DEFAULT_PROVIDER_MODELS: Record<ModelProviderId, string> = {
  unconfigured: 'unconfigured',
  local: 'codex:default',
  xai: 'grok-3-mini',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-latest',
  gemini: 'gemini-2.0-flash',
  deepseek: 'deepseek-chat',
  openrouter: 'openrouter/auto',
  groq: 'llama-3.3-70b-versatile',
  mistral: 'mistral-large-latest',
  together: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  fireworks: 'accounts/fireworks/models/llama-v3p3-70b-instruct'
};

function numOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolOr(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  const norm = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(norm)) return true;
  if (['0', 'false', 'no', 'off'].includes(norm)) return false;
  return fallback;
}

function computeChecksum(settings: OwnerSettings): string {
  return createHash('sha256').update(JSON.stringify(settings)).digest('hex');
}

function computeTradingPolicyHash(settings: OwnerSettings): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        mode: settings.mode,
        appMode: settings.appMode,
        tradingProfile: settings.tradingProfile,
        trading: settings.trading,
        paper: settings.paper,
        venue: settings.venue,
        auto: {
          on: settings.auto.on,
          symbols: settings.auto.symbols,
          connectedConsensus: settings.auto.connectedConsensus
        },
        agents: settings.agents
      })
    )
    .digest('hex');
}

function mergeSettings(base: OwnerSettings, patch: OwnerSettingsPatch): OwnerSettings {
  const nextAgents = { ...base.agents };
  if (patch.agents) {
    for (const role of ROLE_IDS) {
      const rolePatch = patch.agents[role];
      if (rolePatch) {
        nextAgents[role] = { ...nextAgents[role], ...rolePatch };
      }
    }
  }

  const nextTrading: TradingSettings = {
    ...base.trading,
    ...(patch.trading ?? {})
  };
  const nextPaper = {
    ...base.paper,
    ...(patch.paper ?? {})
  };
  if (patch.trading?.safetyNet !== undefined && patch.paper?.safetyNet === undefined) {
    nextPaper.safetyNet = patch.trading.safetyNet;
  }
  if (patch.trading?.maxPositions !== undefined && patch.paper?.n === undefined) {
    nextPaper.n = patch.trading.maxPositions;
  }
  if (patch.paper?.safetyNet !== undefined && patch.trading?.safetyNet === undefined) {
    nextTrading.safetyNet = patch.paper.safetyNet;
  }
  if (patch.paper?.n !== undefined && patch.trading?.maxPositions === undefined) {
    nextTrading.maxPositions = patch.paper.n;
  }

  const nextNetworkProfiles = { ...base.networkProfiles };
  if (patch.networkProfiles?.testnet) {
    nextNetworkProfiles.testnet = {
      ...(base.networkProfiles.testnet ?? nextTrading),
      ...patch.networkProfiles.testnet
    };
  }
  if (patch.networkProfiles?.mainnet) {
    nextNetworkProfiles.mainnet = {
      ...(base.networkProfiles.mainnet ?? nextTrading),
      ...patch.networkProfiles.mainnet
    };
  }

  return OwnerSettingsSchema.parse({
    mode: patch.mode ?? base.mode,
    appMode: patch.appMode ?? base.appMode,
    tradingProfile: patch.tradingProfile ?? base.tradingProfile,
    trading: nextTrading,
    networkProfiles: nextNetworkProfiles,
    paper: nextPaper,
    venue: {
      ...base.venue,
      ...(patch.venue ?? {})
    },
    watchlist: patch.watchlist ?? base.watchlist,
    auto: {
      ...base.auto,
      ...(patch.auto ?? {})
    },
    agents: nextAgents,
    jev: {
      ...base.jev,
      ...(patch.jev ?? {})
    },
    dataSources: {
      ...base.dataSources,
      ...(patch.dataSources ?? {})
    },
    preferences: {
      ...base.preferences,
      ...(patch.preferences ?? {})
    },
    channels: {
      ...base.channels,
      ...(patch.channels ?? {})
    }
  });
}

export class SettingsService {
  private snapshotState: SettingsSnapshot;
  private remoteAckVersion: number | null = null;
  private activationMutex: Promise<void> = Promise.resolve();

  private constructor(
    private readonly store: RuntimeStore,
    private readonly secrets: SecretStore,
    initial: SettingsSnapshot,
    private readonly hooks: SettingsCoordinatorHooks = {}
  ) {
    this.snapshotState = initial;
  }

  static parseLegacyEnv(env: Record<string, string | undefined>): OwnerSettings {
    const rawMode = (env.TRADING_MODE ?? 'PAPER').trim().toUpperCase();
    const mode: TradingMode =
      rawMode === 'LIVE' || rawMode === 'TESTNET' ? rawMode : 'PAPER';

    const rawAppMode = (env.APP_MODE ?? 'local').trim().toLowerCase();
    const appMode: AppMode = rawAppMode === 'grokbot' ? 'grokbot' : 'local';

    const rawExchange = (env.EXCHANGE ?? '').trim().toLowerCase();
    const exchange: VenueId | null = (EXCHANGES as readonly string[]).includes(rawExchange)
      ? (rawExchange as VenueId)
      : null;
    const network: Network | null =
      mode === 'LIVE' ? 'mainnet' : mode === 'TESTNET' ? 'testnet' : null;

    const safetyNet = numOr(env.SAFETY_NET, 200);
    const maxPositions = Math.min(4, Math.max(1, Math.trunc(numOr(env.OPEN_ORDERS_N, DEFAULT_TRADING_SETTINGS.maxPositions))));
    const paperBalance = numOr(env.PAPER_BALANCE, 1000);

    const trading: TradingSettings = {
      dailyLossLimitPct: Math.min(25, Math.max(0.5, numOr(env.DAILY_LOSS_LIMIT_PCT, DEFAULT_TRADING_SETTINGS.dailyLossLimitPct))),
      maxLossPerTradePct: numOr(env.MAX_LOSS_PER_TRADE_PCT, DEFAULT_TRADING_SETTINGS.maxLossPerTradePct),
      minEntryConfidencePct: numOr(env.MIN_ENTRY_CONFIDENCE_PCT, DEFAULT_TRADING_SETTINGS.minEntryConfidencePct),
      maxLeverage: Math.trunc(numOr(env.MAX_LEVERAGE, DEFAULT_TRADING_SETTINGS.maxLeverage)),
      ...(env.ORDER_SIZE_PCT ? { orderSizePct: numOr(env.ORDER_SIZE_PCT, 10) } : {}),
      defaultStopPct: numOr(env.DEFAULT_STOP_PCT, DEFAULT_TRADING_SETTINGS.defaultStopPct),
      minStopPct: numOr(env.MIN_STOP_PCT, DEFAULT_TRADING_SETTINGS.minStopPct),
      ...(env.TAKE_PROFIT_PCT !== ''
        ? { takeProfitPct: numOr(env.TAKE_PROFIT_PCT, DEFAULT_TRADING_SETTINGS.takeProfitPct ?? 60) }
        : {}),
      takeProfitR: numOr(env.TAKE_PROFIT_R, DEFAULT_TRADING_SETTINGS.takeProfitR),
      maxOrderUsdt: numOr(env.MAX_ORDER_USDT, DEFAULT_TRADING_SETTINGS.maxOrderUsdt),
      minOrderUsdt: numOr(env.MIN_ORDER_USDT, DEFAULT_TRADING_SETTINGS.minOrderUsdt),
      safetyNet,
      maxPositions
    };

    const rawProfile = (env.PAPER_TRADING_PROFILE ?? env.TRADING_PROFILE ?? 'current').trim();
    const tradingProfile: TradingProfile = (TRADING_PROFILES as readonly string[]).includes(rawProfile)
      ? (rawProfile as TradingProfile)
      : 'current';

    const watchlist = (env.WATCHLIST ?? 'BTCUSDT,ETHUSDT,SOLUSDT,ZECUSDT')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length >= 2);

    const rawDefaultProvider = (env.DEFAULT_PROVIDER ?? '').trim().toLowerCase();
    const defaultProvider: ModelProviderId =
      rawDefaultProvider && rawDefaultProvider !== 'mock' && (MODEL_PROVIDERS as readonly string[]).includes(rawDefaultProvider)
        ? (rawDefaultProvider as ModelProviderId)
        : 'unconfigured';

    const resolveRoleConfig = (role: RoleId) => {
      const upper = role.toUpperCase();
      const rawProv = (env[`AGENT_${upper}_PROVIDER`] ?? '').trim().toLowerCase();
      let provider: ModelProviderId =
        rawProv && rawProv !== 'mock' && (MODEL_PROVIDERS as readonly string[]).includes(rawProv)
          ? (rawProv as ModelProviderId)
          : defaultProvider;

      // Never silently convert missing key to a mock provider; mark unconfigured if key absent.
      if ((API_PROVIDERS as readonly string[]).includes(provider)) {
        const keyName = PROVIDER_KEY_ENV[provider as ApiProviderId];
        if (!(env[keyName] ?? '').trim()) {
          provider = 'unconfigured';
        }
      }

      const providerModelEnv = provider !== 'unconfigured' && provider !== 'local'
        ? env[`${provider.toUpperCase()}_MODEL`]
        : provider === 'local'
          ? env.LOCAL_MODEL
          : undefined;
      const model =
        (env[`AGENT_${upper}_MODEL`] ?? '').trim() ||
        (providerModelEnv ?? '').trim() ||
        DEFAULT_PROVIDER_MODELS[provider];

      return {
        provider,
        model,
        route: (appMode === 'grokbot' ? 'GROK' : 'LOCAL') as 'LOCAL' | 'GROK' | 'MIRROR_READ_ONLY'
      };
    };

    return OwnerSettingsSchema.parse({
      mode,
      appMode,
      tradingProfile,
      trading,
      networkProfiles: {},
      paper: {
        balance: paperBalance,
        safetyNet,
        n: maxPositions
      },
      venue: {
        exchange,
        network,
        allowExperimentalLive: (env.ALLOW_EXPERIMENTAL_LIVE ?? '').trim() === 'yes',
        asterEntryOrderType: (env.ASTER_ENTRY_ORDER_TYPE ?? '').trim().toUpperCase() === 'LIMIT_GTC' ? 'LIMIT_GTC' : 'MARKET'
      },
      watchlist: watchlist.length > 0 ? watchlist : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ZECUSDT'],
      auto: {
        on: boolOr(env.AUTO_TRADING, false),
        intervalMin: Math.max(1, Math.trunc(numOr(env.DEBATE_INTERVAL_MIN, 15))),
        reportIntervalMin: Math.max(1, Math.trunc(numOr(env.REPORT_INTERVAL_MIN, 60))),
        maxHoldHours: Math.max(0, Math.trunc(numOr(env.MAX_HOLD_HOURS, 0))),
        symbols: watchlist.length > 0 ? watchlist : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ZECUSDT'],
        connectedConsensus: boolOr(env.CONNECTED_CONSENSUS, false)
      },
      agents: {
        lead: resolveRoleConfig('lead'),
        market: resolveRoleConfig('market'),
        research: resolveRoleConfig('research'),
        strategist: resolveRoleConfig('strategist'),
        risk: resolveRoleConfig('risk'),
        execution: resolveRoleConfig('execution')
      },
      jev: {
        enabled: boolOr(env.JEV_ENABLED, false),
        provider: 'openrouter',
        model: (env.JEV_MODEL ?? 'openai/gpt-5-mini').trim() || 'openai/gpt-5-mini',
        mode:
          env.JEV_MODE === 'advisory' || env.JEV_MODE === 'strict'
            ? env.JEV_MODE
            : 'off',
        allowLive: boolOr(env.JEV_ALLOW_LIVE, false)
      },
      dataSources: {
        newsProvider: (env.NEWS_PROVIDER ?? '').trim().toLowerCase() === 'cryptopanic' ? 'cryptopanic' : 'none',
        whaleAlertEnabled: Boolean((env.WHALE_ALERT_API_KEY ?? '').trim()),
        cmcEnabled: Boolean((env.CMC_API_KEY ?? '').trim()),
        coinglassEnabled: Boolean((env.COINGLASS_API_KEY ?? '').trim()),
        arkhamEnabled: Boolean((env.ARKHAM_API_KEY ?? '').trim()),
        fredEnabled: Boolean((env.FRED_API_KEY ?? '').trim())
      },
      preferences: {
        theme: 'day',
        language: 'en',
        currency: 'USD',
        tradingviewWidget: boolOr(env.TRADINGVIEW_WIDGET, false),
        tradingviewWebhook: boolOr(env.TRADINGVIEW_WEBHOOK, false),
        tradingviewPrefix: (env.TRADINGVIEW_PREFIX ?? 'BYBIT:').trim() || 'BYBIT:',
        debateMode: (env.DEBATE_MODE ?? '').trim().toLowerCase() === 'fast' ? 'fast' : 'normal',
        fightThreshold: Math.min(1, Math.max(0.05, numOr(env.FIGHT_THRESHOLD, 0.35)))
      },
      channels: {
        commandsEnabled: boolOr(env.CHANNEL_COMMANDS, false),
        supervisorIntervalMin: Math.max(1, Math.trunc(numOr(env.SUPERVISOR_INTERVAL_MIN, 10))),
        telegramEnabled: Boolean((env.TELEGRAM_BOT_TOKEN ?? '').trim() && (env.TELEGRAM_CHAT_ID ?? '').trim()),
        discordEnabled: Boolean((env.DISCORD_WEBHOOK_URL ?? '').trim() || (env.DISCORD_BOT_TOKEN ?? '').trim()),
        slackEnabled: Boolean((env.SLACK_WEBHOOK_URL ?? '').trim() || (env.SLACK_BOT_TOKEN ?? '').trim()),
        whatsappEnabled: Boolean((env.WHATSAPP_ACCESS_TOKEN ?? '').trim()),
        ownerAllowlist: (env.CHANNEL_OWNER_IDS ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      }
    });
  }

  static async initialize(
    store: RuntimeStore,
    secrets: SecretStore,
    hooks: SettingsCoordinatorHooks = {}
  ): Promise<SettingsService> {
    const existing = await store.execute(
      `SELECT ac.active_version, ac.saved_version, ac.last_acknowledged_remote_version, ac.updated_at, cv.payload_json
       FROM active_config ac
       JOIN config_versions cv ON cv.version = ac.active_version
       WHERE ac.singleton_id = 1`
    );

    if (existing.rows.length > 0) {
      const row = existing.rows[0]!;
      const effective = OwnerSettingsSchema.parse(JSON.parse(String(row.payload_json)));
      const appliedAt = Date.parse(String(row.updated_at));
      const service = new SettingsService(
        store,
        secrets,
        {
          savedVersion: Number(row.saved_version),
          activeVersion: Number(row.active_version),
          effective,
          appliedAt: Number.isFinite(appliedAt) ? appliedAt : Date.now()
        },
        hooks
      );
      service.remoteAckVersion =
        row.last_acknowledged_remote_version === null
          ? null
          : Number(row.last_acknowledged_remote_version);
      return service;
    }

    const imported = SettingsService.parseLegacyEnv(secrets.readEnvMap());
    const nowIso = new Date().toISOString();
    const nowMs = Date.parse(nowIso);
    const checksum = computeChecksum(imported);

    await store.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO config_versions (version, payload_json, checksum, created_at) VALUES (?, ?, ?, ?)`,
        [1, JSON.stringify(imported), checksum, nowIso]
      );
      await tx.execute(
        `INSERT INTO active_config (singleton_id, active_version, saved_version, last_acknowledged_remote_version, updated_at)
         VALUES (1, 1, 1, NULL, ?)`,
        [nowIso]
      );
      await tx.execute(
        `INSERT INTO config_applies (request_id, candidate_version, expected_active_version, status, subsystem_json, reason, created_at, updated_at)
         VALUES (?, 1, NULL, 'ACTIVE', ?, NULL, ?, ?)`,
        [`init-${randomUUID()}`, JSON.stringify({ bootstrap: 'imported' }), nowIso, nowIso]
      );
      await tx.append({
        eventId: `settings-import-v1-${checksum.slice(0, 16)}`,
        scope: 'settings',
        kind: 'settings.imported',
        createdAt: nowIso,
        correlationId: null,
        causationId: null,
        schemaVersion: 1,
        payload: {
          version: 1,
          mode: imported.mode,
          appMode: imported.appMode,
          checksum
        }
      });
    });

    return new SettingsService(
      store,
      secrets,
      {
        savedVersion: 1,
        activeVersion: 1,
        effective: imported,
        appliedAt: nowMs
      },
      hooks
    );
  }

  current(): SettingsSnapshot {
    return structuredClone(this.snapshotState);
  }

  tradingPolicyVersion(): string {
    return computeTradingPolicyHash(this.snapshotState.effective);
  }

  requiresIntentReevaluation(intentPolicyFingerprint: string): boolean {
    return this.tradingPolicyVersion() !== intentPolicyFingerprint;
  }

  lastAcknowledgedRemoteVersion(): number | null {
    return this.remoteAckVersion;
  }

  async recordRemoteConfigAck(version: number): Promise<void> {
    if (!Number.isInteger(version) || version < 1) return;
    if (this.remoteAckVersion !== null && version <= this.remoteAckVersion) {
      return;
    }
    const bounded = Math.min(version, this.snapshotState.activeVersion);
    if (this.remoteAckVersion !== null && bounded <= this.remoteAckVersion) {
      return;
    }
    this.remoteAckVersion = bounded;
    const nowIso = new Date().toISOString();
    await this.store.transaction(async (tx) => {
      await tx.execute(
        `UPDATE active_config
         SET last_acknowledged_remote_version = CASE
           WHEN last_acknowledged_remote_version IS NULL OR last_acknowledged_remote_version < ? THEN ?
           ELSE last_acknowledged_remote_version
         END
         WHERE singleton_id = 1`,
        [bounded, bounded]
      );
      await tx.append({
        eventId: `settings-remote-ack-${bounded}-${randomUUID()}`,
        scope: 'settings',
        kind: 'settings.remote_acknowledged',
        createdAt: nowIso,
        correlationId: null,
        causationId: null,
        schemaVersion: 1,
        payload: { acknowledgedVersion: bounded }
      });
    });
  }

  async recover(): Promise<SettingsSnapshot> {
    const res = await this.store.execute(
      `SELECT ac.active_version, ac.saved_version, ac.last_acknowledged_remote_version, ac.updated_at, cv.payload_json
       FROM active_config ac
       JOIN config_versions cv ON cv.version = ac.active_version
       WHERE ac.singleton_id = 1`
    );
    if (res.rows.length === 0) {
      return this.current();
    }
    const row = res.rows[0]!;
    const effective = OwnerSettingsSchema.parse(JSON.parse(String(row.payload_json)));
    const appliedAt = Date.parse(String(row.updated_at));
    this.snapshotState = {
      savedVersion: Number(row.saved_version),
      activeVersion: Number(row.active_version),
      effective,
      appliedAt: Number.isFinite(appliedAt) ? appliedAt : Date.now()
    };
    this.remoteAckVersion =
      row.last_acknowledged_remote_version === null
        ? null
        : Number(row.last_acknowledged_remote_version);
    await this.hooks.onActivated?.(this.current());
    return this.current();
  }

  private async withBarrier<T>(work: () => Promise<T>): Promise<T> {
    const prev = this.activationMutex;
    let release!: () => void;
    this.activationMutex = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await work();
    } finally {
      release();
    }
  }

  async apply(
    rawPatch: OwnerSettingsPatch,
    expectedActiveVersion: number
  ): Promise<ApplyResult> {
    return this.withBarrier(async () => {
      const dbActive = await this.store.execute(
        `SELECT active_version, saved_version FROM active_config WHERE singleton_id = 1`
      );
      const currentActiveVersion = Number(dbActive.rows[0]?.active_version ?? this.snapshotState.activeVersion);
      const currentSavedVersion = Number(dbActive.rows[0]?.saved_version ?? this.snapshotState.savedVersion);

      if (expectedActiveVersion !== currentActiveVersion) {
        return {
          savedVersion: currentSavedVersion,
          activeVersion: currentActiveVersion,
          applyStatus: 'conflict',
          appliedAt: this.snapshotState.appliedAt,
          reason: `Expected activeVersion ${expectedActiveVersion}, but current activeVersion is ${currentActiveVersion}.`,
          subsystems: {}
        };
      }

      const parsedPatch = OwnerSettingsPatchSchema.safeParse(rawPatch);
      if (!parsedPatch.success) {
        return {
          savedVersion: currentSavedVersion,
          activeVersion: currentActiveVersion,
          applyStatus: 'failed',
          appliedAt: this.snapshotState.appliedAt,
          reason: parsedPatch.error.issues.map((i) => i.message).join('; '),
          subsystems: {}
        };
      }

      let candidate: OwnerSettings;
      try {
        candidate = mergeSettings(this.snapshotState.effective, parsedPatch.data);
      } catch (err) {
        return {
          savedVersion: currentSavedVersion,
          activeVersion: currentActiveVersion,
          applyStatus: 'failed',
          appliedAt: this.snapshotState.appliedAt,
          reason: err instanceof Error ? err.message : String(err),
          subsystems: {}
        };
      }

      const maxVerRow = await this.store.execute(`SELECT COALESCE(MAX(version), 0) AS max_ver FROM config_versions`);
      const candidateVersion = Number(maxVerRow.rows[0]?.max_ver ?? currentSavedVersion) + 1;
      const requestId = `apply-${randomUUID()}`;
      const createdIso = new Date().toISOString();
      const checksum = computeChecksum(candidate);

      // Step 4: Persist PREPARING and candidate version first
      await this.store.transaction(async (tx) => {
        await tx.execute(
          `INSERT INTO config_versions (version, payload_json, checksum, created_at) VALUES (?, ?, ?, ?)`,
          [candidateVersion, JSON.stringify(candidate), checksum, createdIso]
        );
        await tx.execute(
          `UPDATE active_config SET saved_version = ? WHERE singleton_id = 1`,
          [candidateVersion]
        );
        await tx.execute(
          `INSERT INTO config_applies (request_id, candidate_version, expected_active_version, status, subsystem_json, reason, created_at, updated_at)
           VALUES (?, ?, ?, 'PREPARING', '{}', NULL, ?, ?)`,
          [requestId, candidateVersion, expectedActiveVersion, createdIso, createdIso]
        );
      });

      // Step 3: Prepare subsystems outside database transaction (no network inside SQL tx)
      let subsystems: Record<string, string> = { settings: 'validated' };
      if (this.hooks.prepareHook) {
        try {
          subsystems = await this.hooks.prepareHook(candidate, candidateVersion);
        } catch (err) {
          const failReason = err instanceof Error ? err.message : String(err);
          const failIso = new Date().toISOString();
          await this.store.transaction(async (tx) => {
            await tx.execute(
              `UPDATE config_applies SET status = 'FAILED', reason = ?, updated_at = ? WHERE request_id = ?`,
              [failReason, failIso, requestId]
            );
            await tx.append({
              eventId: `settings-failed-${requestId}`,
              scope: 'settings',
              kind: 'settings.apply_failed',
              createdAt: failIso,
              correlationId: requestId,
              causationId: null,
              schemaVersion: 1,
              payload: {
                candidateVersion,
                activeVersion: currentActiveVersion,
                reason: failReason
              }
            });
          });
          this.snapshotState = {
            ...this.snapshotState,
            savedVersion: candidateVersion
          };
          return {
            savedVersion: candidateVersion,
            activeVersion: currentActiveVersion,
            applyStatus: 'failed',
            appliedAt: this.snapshotState.appliedAt,
            reason: failReason,
            subsystems: {}
          };
        }
      }

      // Step 5: Commit active pointer inside serialized activation barrier
      const activatedIso = new Date().toISOString();
      const activatedMs = Date.parse(activatedIso);
      await this.store.transaction(async (tx) => {
        await tx.execute(
          `UPDATE active_config SET active_version = ?, saved_version = ?, updated_at = ? WHERE singleton_id = 1`,
          [candidateVersion, candidateVersion, activatedIso]
        );
        await tx.execute(
          `UPDATE config_applies SET status = 'ACTIVE', subsystem_json = ?, updated_at = ? WHERE request_id = ?`,
          [JSON.stringify(subsystems), activatedIso, requestId]
        );
        await tx.append({
          eventId: `settings-activated-${requestId}`,
          scope: 'settings',
          kind: 'settings.activated',
          createdAt: activatedIso,
          correlationId: requestId,
          causationId: null,
          schemaVersion: 1,
          payload: {
            activeVersion: candidateVersion,
            savedVersion: candidateVersion,
            subsystems
          }
        });
      });

      this.hooks.afterCommitBeforePublishHook?.();

      // Step 6: Publish immutable snapshot in memory only after commit
      this.snapshotState = {
        savedVersion: candidateVersion,
        activeVersion: candidateVersion,
        effective: candidate,
        appliedAt: activatedMs
      };
      await this.hooks.onActivated?.(this.current());

      return {
        savedVersion: candidateVersion,
        activeVersion: candidateVersion,
        applyStatus: 'applied',
        appliedAt: activatedMs,
        reason: null,
        subsystems
      };
    });
  }
}
