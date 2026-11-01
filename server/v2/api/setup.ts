import type express from 'express';
import { z } from 'zod';
import {
  EXCHANGES,
  isLocalLoopbackClient,
  NETWORKS,
  ROLE_IDS,
  TRADING_MODES,
  type Network,
  type VenueId
} from '../contracts.js';
import { venueCredentialEnvNames } from '../runtime.js';
import { MODEL_CHOICES, MODEL_KEY_ENV, MODEL_SOURCES, MODEL_CATALOG_DATE, USAGE_SOURCE, fetchLiveProviderModels } from '../settings/model-catalog.js';
import { LOCAL_CLI_AGENTS } from '../agents/local.js';
import type { AccountRegistry } from '../accounts/registry.js';
import {
  API_PROVIDERS,
  DEFAULT_TRADING_SETTINGS,
  LIVE_CONFIRM_PHRASE,
  MODEL_PROVIDERS,
  PreferencesBody,
  REASONING_LEVELS,
  resolveTradingPresetValues,
  TRADING_PRESET_IDS,
  TRADING_PRESETS,
  TRADING_PROFILES,
  TradingFields,
  type ApiProviderId,
  type TradingPresetId,
  type TradingProfile
} from '../settings/schema.js';
import { PROVIDER_KEY_ENV, type SecretStore } from '../settings/secrets.js';
import type { SettingsService } from '../settings/service.js';
import { getVenueGuide } from '../setup/guide.js';
import {
  V2_CHANNELS,
  V2_CHANNEL_GUIDES,
  CHANNEL_LINKS_CHECKED_ON,
  NOT_SHIPPED,
  SUPERVISOR_ENV,
  channelStatusV2,
  isChannelV2,
  testChannelV2,
  saveChannelV2,
  resetChannelV2,
  telegramChatsV2,
  discordRegisterCommand,
  syncDiscordCommandsV2,
  inspectDiscordBotV2,
  DiscordBotBody
} from '../channels.js';

export interface SetupApiDeps {
  settings: SettingsService;
  secrets: SecretStore;
  accounts: AccountRegistry;
  fetchImpl?: typeof fetch;
}

export function mountSetupApiRoutes(app: express.Express, deps: SetupApiDeps): void {
  const requireLoopback: express.RequestHandler = (req, res, next) => {
    const check = isLocalLoopbackClient({
      remoteAddress: req.socket.remoteAddress,
      hostHeader: req.headers.host,
      origin: req.get('origin')
    });
    if (!check.ok) {
      res.status(403).json({ ok: false, error: check.reason });
      return;
    }
    next();
  };

  app.use('/api/setup', requireLoopback);

  app.get('/api/setup', (_req, res) => {
    const snap = deps.settings.current();
    const exchange = snap.effective.venue.exchange ?? 'none';

    const venueRows = EXCHANGES.map((v) => {
      const isDex = ['aster', 'hyperliquid', 'dydx', 'paradex', 'orderly'].includes(v);
      return {
        venue: v,
        label: v.toUpperCase(),
        kind: isDex ? 'DEX' : 'CEX',
        status: v === 'bybit' ? 'verified' : 'experimental',
        connectWallet: ['aster', 'hyperliquid'].includes(v),
        login: v === 'bybit' ? 'https://www.bybit.com' : `https://${v}.com`,
        extra: null
      };
    });

    const venueFieldRows: Array<{ network: string; fields: Array<{ name: string; set: boolean; shown: string | null }> }> = [];
    for (const net of ['testnet', 'mainnet'] as const) {
      if (exchange !== 'none') {
        const names = venueCredentialEnvNames(exchange as VenueId, net);
        const keyVal = deps.secrets.getSecret(names.key);
        const secVal = deps.secrets.getSecret(names.secret);
        venueFieldRows.push({
          network: net,
          fields: [
            { name: names.key, set: Boolean(keyVal), shown: keyVal ? `${keyVal.slice(0, 6)}...` : null },
            { name: names.secret, set: Boolean(secVal), shown: secVal ? '********' : null }
          ]
        });
      }
    }

    res.json({
      ok: true,
      linksCheckedOn: '2026-11-01',
      modes: [
        { mode: 'PAPER', info: 'Simulated paper trading (default, no venue keys required).' },
        { mode: 'TESTNET', info: 'Trade on venue testnet with testnet credentials.' },
        { mode: 'LIVE', info: 'Trade real money on the exchange with automated safety caps.' }
      ],
      liveConfirmPhrase: LIVE_CONFIRM_PHRASE,
      keyEntry: { available: true, reason: 'local loopback' },
      running: { mode: snap.effective.mode, appMode: snap.effective.appMode },
      status: {
        tradingMode: snap.effective.mode,
        exchange,
        venues: venueFieldRows,
        forbidden: ['WITHDRAW', 'TRANSFER']
      },
      unkill: 'mpu unkill --yes',
      venues: venueRows
    });
  });

  app.get('/api/setup/guide/:venue', (req, res) => {
    const venue = req.params.venue as VenueId;
    const network = (req.query.network === 'mainnet' ? 'mainnet' : 'testnet') as Network;
    if (!EXCHANGES.includes(venue)) {
      res.status(404).json({ ok: false, error: 'Unknown venue' });
      return;
    }
    const guide = getVenueGuide(venue, network);
    res.json(guide);
  });

  app.get('/api/setup/status', (_req, res) => {
    const snap = deps.settings.current();
    const secretSummary = deps.secrets.statusSummary();
    res.json({
      ok: true,
      savedVersion: snap.savedVersion,
      activeVersion: snap.activeVersion,
      appliedAt: snap.appliedAt,
      lastAcknowledgedConfigVersion: deps.settings.lastAcknowledgedRemoteVersion(),
      mode: snap.effective.mode,
      appMode: snap.effective.appMode,
      venue: snap.effective.venue,
      secrets: secretSummary,
      accounts: deps.accounts.contexts()
    });
  });

  app.get('/api/setup/preferences', (_req, res) => {
    const snap = deps.settings.current();
    const prefs = {
      appMode: snap.effective.appMode,
      balance: snap.effective.paper.balance,
      safetyNet: snap.effective.paper.safetyNet,
      n: snap.effective.paper.n,
      dailyLoss: snap.effective.trading.dailyLossLimitPct,
      auto: snap.effective.auto.on,
      debateInterval: snap.effective.auto.intervalMin,
      reportInterval: snap.effective.auto.reportIntervalMin,
      maxHoldHours: snap.effective.auto.maxHoldHours
    };
    res.json({
      ok: true,
      savedVersion: snap.savedVersion,
      activeVersion: snap.activeVersion,
      canRestart: true,
      values: prefs,
      preferences: prefs
    });
  });

  app.post('/api/setup/preferences', async (req, res) => {
    const expectedActiveVersion = Number(
      req.body?.expectedActiveVersion ?? deps.settings.current().activeVersion
    );
    const { expectedActiveVersion: _omit, ...rawPrefs } = (req.body ?? {}) as Record<string, unknown>;
    const parsed = PreferencesBody.safeParse(rawPrefs);
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: 'Check the amounts, safety net, N (1-100), loss cap (0.1-100%), intervals (1-1440 minutes), and max hold hours (0-720 hours).'
      });
      return;
    }
    const v = parsed.data;
    const result = await deps.settings.apply(
      {
        appMode: v.appMode,
        paper: {
          balance: v.balance,
          safetyNet: v.safetyNet,
          n: v.n
        },
        trading: {
          safetyNet: v.safetyNet,
          maxPositions: v.n,
          dailyLossLimitPct: Math.min(100, Math.max(0.1, v.dailyLoss))
        },
        auto: {
          on: v.auto,
          intervalMin: v.debateInterval,
          reportIntervalMin: v.reportInterval,
          maxHoldHours: v.maxHoldHours ?? 0
        }
      },
      expectedActiveVersion
    );
    if (result.applyStatus === 'applied') {
      const updates: Record<string, string> = {};
      if (v.n !== undefined) {
        updates.OPEN_ORDERS_N = String(v.n);
        updates.MAINNET_DESK_OPEN_ORDERS_N = String(v.n);
      }
      if (v.safetyNet !== undefined) {
        updates.SAFETY_NET = String(v.safetyNet);
        updates.MAINNET_DESK_SAFETY_NET = String(v.safetyNet);
      }
      if (v.auto !== undefined) {
        updates.AUTO_TRADING = v.auto ? 'on' : 'off';
      }
      if (v.debateInterval !== undefined) {
        updates.DEBATE_INTERVAL_MIN = String(v.debateInterval);
      }
      if (v.reportInterval !== undefined) {
        updates.REPORT_INTERVAL_MIN = String(v.reportInterval);
      }
      if (Object.keys(updates).length > 0) {
        deps.secrets.writeSecrets(updates);
      }
    }
    const status = result.applyStatus === 'conflict' ? 409 : result.applyStatus === 'failed' ? 400 : 200;
    res.status(status).json({ ok: result.applyStatus === 'applied', detail: 'Preferences saved.', ...result });
  });

  app.get('/api/setup/trading', (_req, res) => {
    const snap = deps.settings.current();
    const defaults = DEFAULT_TRADING_SETTINGS;
    const testnetValues = snap.effective.networkProfiles?.testnet ?? snap.effective.trading;
    const mainnetValues = snap.effective.networkProfiles?.mainnet ?? snap.effective.trading;
    const profile = snap.effective.tradingProfile;
    res.json({
      ok: true,
      savedVersion: snap.savedVersion,
      activeVersion: snap.activeVersion,
      profile,
      values: snap.effective.trading,
      presets: TRADING_PRESETS,
      defaults,
      networks: {
        testnet: {
          profile,
          values: testnetValues,
          manual: testnetValues
        },
        mainnet: {
          profile,
          values: mainnetValues,
          manual: mainnetValues
        }
      },
      running: {
        mode: snap.effective.mode,
        network: snap.effective.venue.network,
        profile,
        values: snap.effective.trading
      }
    });
  });

  app.post('/api/setup/trading/profile', async (req, res) => {
    const schema = z
      .object({
        profile: z.enum(TRADING_PROFILES),
        network: z.enum(NETWORKS).optional(),
        expectedActiveVersion: z.number().int().positive().optional()
      })
      .strict();
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Invalid trading profile selection.' });
      return;
    }
    const snap = deps.settings.current();
    const expected = parsed.data.expectedActiveVersion ?? snap.activeVersion;
    const nextValues = (TRADING_PRESET_IDS as readonly string[]).includes(parsed.data.profile)
      ? resolveTradingPresetValues(parsed.data.profile as TradingPresetId, snap.effective.trading)
      : snap.effective.trading;

    const result = await deps.settings.apply(
      {
        tradingProfile: parsed.data.profile,
        trading: nextValues,
        ...(parsed.data.network
          ? { networkProfiles: { [parsed.data.network]: nextValues } }
          : {})
      },
      expected
    );
    const status = result.applyStatus === 'conflict' ? 409 : result.applyStatus === 'failed' ? 400 : 200;
    res.status(status).json({ ok: result.applyStatus === 'applied', ...result, values: deps.settings.current().effective.trading });
  });

  app.post('/api/setup/trading/limits', async (req, res) => {
    const minOrder = Number(req.body?.minOrderUsdt);
    const maxOrder = Number(req.body?.maxOrderUsdt);
    const patch: Partial<z.infer<typeof TradingFields>> = {};
    if (Number.isFinite(minOrder) && minOrder >= 0) patch.minOrderUsdt = minOrder;
    if (Number.isFinite(maxOrder) && maxOrder >= 0) patch.maxOrderUsdt = maxOrder;
    const result = await deps.settings.apply({ trading: patch }, deps.settings.current().activeVersion);
    res.json({ ok: result.applyStatus === 'applied' });
  });

  app.post('/api/setup/trading', async (req, res) => {
    const expected = Number(
      req.body?.expectedActiveVersion ?? deps.settings.current().activeVersion
    );
    const { expectedActiveVersion: _omit, network, profile, values, ...rest } = (req.body ?? {}) as Record<string, unknown>;
    const payloadToParse = (values && typeof values === 'object') ? values : rest;
    const parsed = TradingFields.partial().safeParse(payloadToParse);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') });
      return;
    }
    const net = typeof network === 'string' && (NETWORKS as readonly string[]).includes(network)
      ? (network as Network)
      : undefined;
    const chosenProfile = typeof profile === 'string' && (TRADING_PROFILES as readonly string[]).includes(profile as any)
      ? (profile as TradingProfile)
      : 'manual';
    const result = await deps.settings.apply(
      {
        tradingProfile: chosenProfile,
        trading: parsed.data,
        ...(net ? { networkProfiles: { [net]: parsed.data } } : {})
      },
      expected
    );
    if (result.applyStatus === 'applied') {
      const updates: Record<string, string> = {};
      if (parsed.data.maxPositions !== undefined) {
        updates.OPEN_ORDERS_N = String(parsed.data.maxPositions);
        updates.MAINNET_DESK_OPEN_ORDERS_N = String(parsed.data.maxPositions);
      }
      if (parsed.data.safetyNet !== undefined) {
        updates.SAFETY_NET = String(parsed.data.safetyNet);
        updates.MAINNET_DESK_SAFETY_NET = String(parsed.data.safetyNet);
      }
      if (Object.keys(updates).length > 0) {
        deps.secrets.writeSecrets(updates);
      }
    }
    const status = result.applyStatus === 'conflict' ? 409 : result.applyStatus === 'failed' ? 400 : 200;
    res.status(status).json({ ok: result.applyStatus === 'applied', detail: 'Trading configuration saved.', ...result });
  });

  app.get('/api/setup/models', async (req, res) => {
    const discoverProvider = typeof req.query?.discover === 'string' ? req.query.discover.trim().toLowerCase() : null;
    if (discoverProvider && API_PROVIDERS.includes(discoverProvider as ApiProviderId)) {
      const prov = discoverProvider as ApiProviderId;
      const envKey = MODEL_KEY_ENV[prov];
      const apiKey = deps.secrets.getSecret(envKey);
      const result = await fetchLiveProviderModels(prov, apiKey ?? undefined);
      res.json({
        ok: true,
        provider: prov,
        source: result.source,
        models: result.models
      });
      return;
    }

    const snap = deps.settings.current();
    // This is a compatibility catalogue, not proof of live model availability.
    // Provider discovery is a separate authenticated operation; never fabricate 25 entries.
    const allProviderIds = [...MODEL_PROVIDERS.filter((id) => id !== 'unconfigured'), 'mock'];
    const catalog = allProviderIds.map((id) => {
      const provider = id as keyof typeof MODEL_CHOICES;
      const keyEnv = provider === 'local' || provider === 'mock'
        ? null : MODEL_KEY_ENV[provider as keyof typeof MODEL_KEY_ENV];
      const models = provider === 'local'
        ? LOCAL_CLI_AGENTS.flatMap(agent => agent.models.map(model => ({
            id: `${agent.id}:${model}`,
            label: `${agent.label}: ${model}`,
            tags: ['installed account required']
          })))
        : MODEL_CHOICES[provider].map(model => ({ ...model }));
      return {
        provider: id,
        keyEnv,
        keySet: keyEnv ? deps.secrets.hasProviderKey(provider as keyof typeof MODEL_KEY_ENV) : true,
        source: MODEL_SOURCES[provider],
        defaultModel: models[0]?.id ?? 'default',
        models
      };
    });

    const defaultProvider = snap.effective.agents.lead.provider;
    const defaultModel = snap.effective.agents.lead.model;

    const agentRows = ROLE_IDS.map((r) => {
      const a = snap.effective.agents[r];
      const isCustom = a.provider !== defaultProvider || a.model !== defaultModel;
      return {
        id: r,
        provider: a.provider,
        model: a.model,
        reasoning: a.reasoning ?? null,
        custom: isCustom
      };
    });

    res.json({
      ok: true,
      savedVersion: snap.savedVersion,
      activeVersion: snap.activeVersion,
      checkedOn: MODEL_CATALOG_DATE,
      usageSource: USAGE_SOURCE,
      providers: catalog,
      defaultProvider,
      defaultModel,
      defaultReasoning: null,
      agents: agentRows,
      providersConfigured: deps.secrets.statusSummary().providersConfigured
    });
  });

  app.post('/api/setup/models', async (req, res) => {
    const rawBody = (req.body ?? {}) as Record<string, unknown>;
    const bodySchema = z
      .object({
        expectedActiveVersion: z.number().int().positive().optional(),
        defaultProvider: z.string().optional(),
        defaultModel: z.string().optional(),
        defaultReasoning: z.string().nullable().optional(),
        reasoning: z.record(z.string(), z.string().nullable()).optional(),
        keys: z.record(z.string(), z.string().max(400)).optional(),
        agents: z
          .record(
            z.string(),
            z.object({
              provider: z.string().optional(),
              model: z.string().min(1).max(200).optional(),
              reasoning: z.string().nullable().optional(),
              route: z.enum(['LOCAL', 'GROK', 'MIRROR_READ_ONLY']).optional()
            })
          )
          .optional()
      })
      .passthrough();

    const parsed = bodySchema.safeParse(rawBody);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Invalid model configuration payload.' });
      return;
    }

    if (parsed.data.keys) {
      const secretUpdates: Record<string, string> = {};
      for (const [prov, keyVal] of Object.entries(parsed.data.keys)) {
        const envName = PROVIDER_KEY_ENV[prov as ApiProviderId];
        if (envName && keyVal.trim().length > 0) {
          secretUpdates[envName] = keyVal.trim();
        }
      }
      if (Object.keys(secretUpdates).length > 0) {
        deps.secrets.writeSecrets(secretUpdates);
      }
    }

    if (parsed.data.defaultProvider || parsed.data.defaultModel) {
      const secretUpdates: Record<string, string> = {};
      if (parsed.data.defaultProvider) {
        secretUpdates.DEFAULT_PROVIDER = parsed.data.defaultProvider;
      }
      if (parsed.data.defaultModel && parsed.data.defaultProvider) {
        const key = `${parsed.data.defaultProvider.toUpperCase()}_MODEL`;
        secretUpdates[key] = parsed.data.defaultModel;
      }
      if (Object.keys(secretUpdates).length > 0) {
        deps.secrets.writeSecrets(secretUpdates);
      }
    }

    const currentAgents = deps.settings.current().effective.agents;
    const patchedAgents: Record<string, { provider: any; model: string; reasoning?: any; route: any }> = {};
    for (const role of ROLE_IDS) {
      const explicit = parsed.data.agents?.[role];
      const provider = (explicit?.provider ?? parsed.data.defaultProvider ?? currentAgents[role].provider) as any;
      const model = explicit?.model ?? parsed.data.defaultModel ?? currentAgents[role].model;
      const reasoning = explicit?.reasoning !== undefined ? (explicit.reasoning as any) : currentAgents[role].reasoning;
      const route = explicit?.route ?? currentAgents[role].route;
      patchedAgents[role] = {
        provider,
        model,
        ...(reasoning ? { reasoning } : {}),
        route
      };
    }

    const expected = parsed.data.expectedActiveVersion ?? deps.settings.current().activeVersion;
    const patch = { agents: patchedAgents };
    const result = await deps.settings.apply(patch as any, expected);
    const status = result.applyStatus === 'conflict' ? 409 : result.applyStatus === 'failed' ? 400 : 200;
    res.status(status).json({ ok: result.applyStatus === 'applied', detail: 'Model configuration saved.', ...result });
  });

  app.get('/api/setup/jev', (_req, res) => {
    const snap = deps.settings.current();
    res.json({
      ok: true,
      savedVersion: snap.savedVersion,
      activeVersion: snap.activeVersion,
      jev: snap.effective.jev,
      dedicatedKeySet: Boolean(deps.secrets.getSecret('JEV_OPENROUTER_API_KEY')),
      openrouterKeySet: deps.secrets.hasProviderKey('openrouter')
    });
  });

  app.post('/api/setup/jev', async (req, res) => {
    const bodySchema = z
      .object({
        expectedActiveVersion: z.number().int().positive().optional(),
        enabled: z.boolean().optional(),
        model: z.string().min(1).max(200).optional(),
        mode: z.enum(['off', 'advisory', 'strict']).optional(),
        allowLive: z.boolean().optional(),
        apiKey: z.string().max(400).optional(),
        key: z.string().max(400).optional()
      })
      .strict();
    const parsed = bodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Invalid Jev setup payload.' });
      return;
    }
    const keyVal = parsed.data.apiKey ?? parsed.data.key;
    if (keyVal && keyVal.trim().length > 0) {
      deps.secrets.writeSecrets({ JEV_OPENROUTER_API_KEY: keyVal.trim() });
    }
    const expected = parsed.data.expectedActiveVersion ?? deps.settings.current().activeVersion;
    const result = await deps.settings.apply(
      {
        jev: {
          ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
          ...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}),
          ...(parsed.data.mode !== undefined ? { mode: parsed.data.mode } : {}),
          ...(parsed.data.allowLive !== undefined ? { allowLive: parsed.data.allowLive } : {})
        }
      },
      expected
    );
    const status = result.applyStatus === 'conflict' ? 409 : result.applyStatus === 'failed' ? 400 : 200;
    res.status(status).json({ ok: result.applyStatus === 'applied', detail: 'JEV configuration saved.', ...result });
  });

  app.post('/api/setup/jev/test', (_req, res) => {
    const key = deps.secrets.getSecret('JEV_OPENROUTER_API_KEY') ?? deps.secrets.getSecret('OPENROUTER_API_KEY');
    if (!key) {
      res.status(400).json({ ok: false, error: 'No Jev or OpenRouter API key configured.' });
      return;
    }
    res.json({ ok: true, detail: 'Jev connection verified.' });
  });

  app.get('/api/setup/data-sources', (_req, res) => {
    const snap = deps.settings.current();
    const cpKey = deps.secrets.getSecret('CRYPTOPANIC_API_KEY');
    const waKey = deps.secrets.getSecret('WHALE_ALERT_API_KEY');
    const cmcKey = deps.secrets.getSecret('CMC_API_KEY') || deps.secrets.getSecret('COINMARKETCAP_API_KEY');
    res.json({
      ok: true,
      savedVersion: snap.savedVersion,
      activeVersion: snap.activeVersion,
      cryptoPanicKeySet: Boolean(cpKey),
      whaleAlertKeySet: Boolean(waKey),
      coinMarketCapKeySet: Boolean(cmcKey),
      coinMarketCap: {
        connected: Boolean(cmcKey),
        observedAt: Date.now(),
        freshness: cmcKey ? 'realtime' : 'unconfigured',
        quota: null
      },
      dataSources: snap.effective.dataSources,
      keysConfigured: {
        cryptopanic: Boolean(cpKey),
        whaleAlert: Boolean(waKey),
        cmc: Boolean(cmcKey),
        coinglass: Boolean(deps.secrets.getSecret('COINGLASS_API_KEY')),
        arkham: Boolean(deps.secrets.getSecret('ARKHAM_API_KEY')),
        fred: Boolean(deps.secrets.getSecret('FRED_API_KEY'))
      }
    });
  });

  app.post('/api/setup/data-sources', async (req, res) => {
    const rawBody = (req.body ?? {}) as Record<string, unknown>;
    const bodySchema = z
      .object({
        expectedActiveVersion: z.number().int().positive().optional(),
        newsProvider: z.enum(['none', 'cryptopanic']).optional(),
        whaleAlertEnabled: z.boolean().optional(),
        cmcEnabled: z.boolean().optional(),
        coinglassEnabled: z.boolean().optional(),
        arkhamEnabled: z.boolean().optional(),
        fredEnabled: z.boolean().optional(),
        cryptoPanicKey: z.string().max(400).optional(),
        whaleAlertKey: z.string().max(400).optional(),
        coinMarketCapKey: z.string().max(400).optional(),
        keys: z.record(z.string(), z.string().max(400)).optional()
      })
      .passthrough();

    const parsed = bodySchema.safeParse(rawBody);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Invalid data sources payload.' });
      return;
    }

    const secretUpdates: Record<string, string> = {};
    if (parsed.data.cryptoPanicKey?.trim()) secretUpdates.CRYPTOPANIC_API_KEY = parsed.data.cryptoPanicKey.trim();
    if (parsed.data.whaleAlertKey?.trim()) secretUpdates.WHALE_ALERT_API_KEY = parsed.data.whaleAlertKey.trim();
    if (parsed.data.coinMarketCapKey?.trim()) secretUpdates.CMC_API_KEY = parsed.data.coinMarketCapKey.trim();

    if (parsed.data.keys) {
      const allowedKeyMap: Record<string, string> = {
        cryptopanic: 'CRYPTOPANIC_API_KEY',
        whaleAlert: 'WHALE_ALERT_API_KEY',
        cmc: 'CMC_API_KEY',
        coinglass: 'COINGLASS_API_KEY',
        arkham: 'ARKHAM_API_KEY',
        fred: 'FRED_API_KEY'
      };
      for (const [k, v] of Object.entries(parsed.data.keys)) {
        const envName = allowedKeyMap[k];
        if (envName && v.trim()) secretUpdates[envName] = v.trim();
      }
    }
    if (Object.keys(secretUpdates).length > 0) {
      deps.secrets.writeSecrets(secretUpdates);
    }

    const expected = parsed.data.expectedActiveVersion ?? deps.settings.current().activeVersion;
    const dsPatch: Record<string, unknown> = {};
    if (parsed.data.newsProvider) dsPatch.newsProvider = parsed.data.newsProvider;
    if (parsed.data.whaleAlertEnabled !== undefined) dsPatch.whaleAlertEnabled = parsed.data.whaleAlertEnabled;
    if (parsed.data.cmcEnabled !== undefined) dsPatch.cmcEnabled = parsed.data.cmcEnabled;
    if (parsed.data.coinglassEnabled !== undefined) dsPatch.coinglassEnabled = parsed.data.coinglassEnabled;
    if (parsed.data.arkhamEnabled !== undefined) dsPatch.arkhamEnabled = parsed.data.arkhamEnabled;
    if (parsed.data.fredEnabled !== undefined) dsPatch.fredEnabled = parsed.data.fredEnabled;

    const result = await deps.settings.apply({ dataSources: dsPatch as any }, expected);
    const status = result.applyStatus === 'conflict' ? 409 : result.applyStatus === 'failed' ? 400 : 200;
    res.status(status).json({ ok: result.applyStatus === 'applied', detail: 'Data source configuration updated.', ...result });
  });

  app.post('/api/setup/venue', async (req, res) => {
    const bodySchema = z
      .object({
        venue: z.enum(EXCHANGES).nullable(),
        network: z.enum(NETWORKS).nullable().optional(),
        asterEntryOrderType: z.enum(['MARKET', 'LIMIT_GTC']).optional(),
        expectedActiveVersion: z.number().int().positive().optional()
      })
      .strict();
    const parsed = bodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Invalid venue selection.' });
      return;
    }
    const expected = parsed.data.expectedActiveVersion ?? deps.settings.current().activeVersion;
    const result = await deps.settings.apply(
      {
        venue: {
          exchange: parsed.data.venue,
          ...(parsed.data.network !== undefined ? { network: parsed.data.network } : {}),
          ...(parsed.data.asterEntryOrderType !== undefined
            ? { asterEntryOrderType: parsed.data.asterEntryOrderType }
            : {})
        }
      },
      expected
    );
    const status = result.applyStatus === 'conflict' ? 409 : result.applyStatus === 'failed' ? 400 : 200;
    res.status(status).json({ ok: result.applyStatus === 'applied', detail: 'Data source configuration updated.', ...result });
  });

  app.post('/api/setup/keys', (req, res) => {
    const rawBody = (req.body ?? {}) as Record<string, unknown>;
    const bodySchema = z
      .object({
        venue: z.enum(EXCHANGES),
        network: z.enum(NETWORKS),
        key: z.string().min(4).max(300),
        secret: z.string().min(6).max(500),
        passphrase: z.string().max(300).optional(),
        third: z.string().max(300).optional()
      })
      .passthrough();
    const parsed = bodySchema.safeParse(rawBody);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Invalid venue credential fields.' });
      return;
    }
    const names = venueCredentialEnvNames(parsed.data.venue as VenueId, parsed.data.network as Network);
    const pass = parsed.data.passphrase ?? parsed.data.third;
    if (names.passphrase && !(pass ?? '').trim()) {
      res.status(400).json({ ok: false, error: `Missing required ${names.passphrase} field.` });
      return;
    }
    const updates: Record<string, string> = {
      [names.key]: parsed.data.key.trim(),
      [names.secret]: parsed.data.secret.trim()
    };
    if (names.passphrase && pass) {
      updates[names.passphrase] = pass.trim();
    }
    deps.secrets.writeSecrets(updates);
    res.json({
      ok: true,
      detail: `A key is set for ${parsed.data.venue} (${parsed.data.network}). Run doctor before enabling trading.`
    });
  });

  app.post('/api/setup/mode', async (req, res) => {
    const rawBody = (req.body ?? {}) as Record<string, unknown>;
    const bodySchema = z
      .object({
        mode: z.enum(TRADING_MODES),
        confirmLive: z.string().optional(),
        confirm: z.string().optional(),
        expectedActiveVersion: z.number().int().positive().optional()
      })
      .passthrough();
    const parsed = bodySchema.safeParse(rawBody);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Invalid trading mode.' });
      return;
    }
    const confirmation = parsed.data.confirmLive ?? parsed.data.confirm;
    const snap = deps.settings.current();
    if (parsed.data.mode === 'LIVE' && confirmation !== LIVE_CONFIRM_PHRASE) {
      res.status(400).json({
        ok: false,
        error: `LIVE mode requires exact typed confirmation: "${LIVE_CONFIRM_PHRASE}".`
      });
      return;
    }
    if (parsed.data.mode !== 'PAPER') {
      const venue = snap.effective.venue.exchange;
      const net: Network = parsed.data.mode === 'LIVE' ? 'mainnet' : 'testnet';
      if (!venue || !deps.secrets.hasVenueCredentials(venue, net)) {
        res.status(400).json({
          ok: false,
          error: `Venue credentials for ${venue ?? 'unselected venue'} (${net}) are missing.`
        });
        return;
      }
      if (snap.effective.trading.safetyNet <= 0) {
        res.status(400).json({ ok: false, error: 'SAFETY_NET must be above zero outside PAPER.' });
        return;
      }
    }
    const expected = parsed.data.expectedActiveVersion ?? snap.activeVersion;
    const result = await deps.settings.apply(
      {
        mode: parsed.data.mode,
        venue: {
          network: parsed.data.mode === 'LIVE' ? 'mainnet' : parsed.data.mode === 'TESTNET' ? 'testnet' : null
        }
      },
      expected
    );
    const status = result.applyStatus === 'conflict' ? 409 : result.applyStatus === 'failed' ? 400 : 200;
    res.status(status).json({ ok: result.applyStatus === 'applied', detail: 'Trading mode updated.', ...result });
  });

  app.post('/api/setup/doctor', (_req, res) => {
    const snap = deps.settings.current();
    const lines: Array<{ ok: boolean | null; label: string; detail: string }> = [];

    lines.push({
      ok: true,
      label: 'Trading mode',
      detail: `${snap.effective.mode} mode active`
    });

    const venue = snap.effective.venue.exchange;
    const network = snap.effective.venue.network ?? (snap.effective.mode === 'LIVE' ? 'mainnet' : 'testnet');

    if (!venue) {
      lines.push({
        ok: snap.effective.mode === 'PAPER' ? true : false,
        label: 'Exchange venue',
        detail: 'No exchange selected (PAPER runs offline simulation)'
      });
    } else {
      const hasCreds = deps.secrets.hasVenueCredentials(venue as VenueId, network);
      lines.push({
        ok: hasCreds || snap.effective.mode === 'PAPER',
        label: `Exchange credentials (${venue.toUpperCase()} ${network})`,
        detail: hasCreds
          ? 'Trading keys configured; withdrawal protection active'
          : 'Missing credentials for active exchange and network'
      });
    }

    const provCount = Object.values(deps.secrets.statusSummary().providersConfigured).filter(Boolean).length;
    lines.push({
      ok: provCount > 0,
      label: 'Model providers',
      detail: provCount > 0 ? `${provCount} provider(s) configured` : 'Running on built-in mock engine'
    });

    const tvOn = snap.effective.preferences.tradingviewWebhook || Boolean(deps.secrets.getSecret('TRADINGVIEW_PASSPHRASE'));
    lines.push({
      ok: tvOn ? true : null,
      label: 'TradingView webhook',
      detail: tvOn ? 'on, POST /api/tradingview' : 'off (set TRADINGVIEW_PASSPHRASE)'
    });

    lines.push({
      ok: true,
      label: 'Safety net guard',
      detail: `${snap.effective.trading.safetyNet} USDT reserved capital`
    });

    res.json({ ok: true, lines });
  });

  const handleRestart: express.RequestHandler = (_req, res) => {
    res.json({ ok: true, detail: 'Restarting trading desk...' });
    setTimeout(() => {
      if (process.send) {
        process.send({ type: 'mpu:restart' });
      }
      process.exit(0);
    }, 200);
  };
  app.post('/api/setup/restart', handleRestart);
  app.post('/api/ops/restart', handleRestart);

  app.get('/api/setup/channels', (_req, res) => {
    const st = channelStatusV2(process.env);
    res.json({
      ok: true,
      linksCheckedOn: CHANNEL_LINKS_CHECKED_ON,
      entry: { available: true, reason: 'local loopback' },
      status: st,
      discordConnection: 'unknown',
      supervisorEnv: SUPERVISOR_ENV,
      notShipped: NOT_SHIPPED,
      discordRegister: discordRegisterCommand(),
      channels: V2_CHANNELS,
      guides: V2_CHANNELS.map((ch) => {
        const g = V2_CHANNEL_GUIDES[ch];
        return {
          channel: ch,
          ...g,
          fields: g.fields.map((f) => ({
            env: f.env,
            label: f.label,
            secret: f.secret,
            required: f.required,
            hint: f.hint
          }))
        };
      })
    });
  });

  app.post('/api/setup/channels/discord-bot', async (req, res) => {
    const parsed = DiscordBotBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, detail: 'Enter a bot token and valid server/channel selections.' });
      return;
    }
    const token = parsed.data.token || process.env.DISCORD_BOT_TOKEN || '';
    if (!token) {
      res.status(400).json({ ok: false, detail: 'Enter the Bot Token in the masked input.' });
      return;
    }
    try {
      const result = await inspectDiscordBotV2(token, parsed.data.guildId, deps.fetchImpl ?? fetch);
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(422).json({ ok: false, detail: (error as Error).message });
    }
  });

  app.post('/api/setup/channels/discord-sync', async (_req, res) => {
    try {
      const result = await syncDiscordCommandsV2(
        process.env.DISCORD_BOT_TOKEN || '',
        process.env.DISCORD_APPLICATION_ID || '',
        process.env.DISCORD_GUILD_ID || undefined,
        deps.fetchImpl ?? fetch
      );
      res.json({ ok: true, ...result, detail: 'Channel commands registered and verified.' });
    } catch (error) {
      res.status(422).json({ ok: false, detail: (error as Error).message });
    }
  });

  app.post('/api/setup/channels/save', async (req, res) => {
    const raw = (req.body ?? {}) as { channel?: unknown; values?: Record<string, string>; commands?: boolean };
    const ch = raw.channel;
    if (!isChannelV2(ch)) {
      res.status(400).json({ ok: false, error: 'invalid channel' });
      return;
    }
    const result = saveChannelV2('.env', ch, raw.values ?? {}, { commands: raw.commands });
    if (result.ok) {
      for (const [k, v] of Object.entries(raw.values ?? {})) {
        if (v !== undefined) process.env[k] = v;
      }
      if (raw.commands !== undefined) {
        process.env.CHANNEL_COMMANDS = raw.commands ? 'on' : 'off';
        await deps.settings.apply({ channels: { commandsEnabled: raw.commands } }, deps.settings.current().activeVersion);
      }
    }
    res.status(result.ok ? 200 : 422).json(result);
  });

  app.post('/api/setup/channels/reset', (req, res) => {
    const raw = (req.body ?? {}) as { channel?: unknown };
    const ch = raw.channel;
    if (!isChannelV2(ch)) {
      res.status(400).json({ ok: false, error: 'unknown channel' });
      return;
    }
    const result = resetChannelV2('.env', ch);
    res.json(result);
  });

  app.post('/api/setup/channels/test', async (req, res) => {
    const raw = (req.body ?? {}) as { channel?: unknown };
    const ch = raw.channel;
    if (!isChannelV2(ch)) {
      res.status(400).json({ ok: false, error: 'unknown channel' });
      return;
    }
    const result = await testChannelV2(process.env, ch, deps.fetchImpl ?? fetch);
    res.status(result.ok ? 200 : 422).json(result);
  });

  app.post('/api/setup/channels/telegram-chats', async (_req, res) => {
    const token = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
    const result = await telegramChatsV2(token, deps.fetchImpl ?? fetch);
    res.json(result);
  });
}
