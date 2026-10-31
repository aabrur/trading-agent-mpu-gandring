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
import type { AccountRegistry } from '../accounts/registry.js';
import {
  API_PROVIDERS,
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
  type TradingPresetId
} from '../settings/schema.js';
import { PROVIDER_KEY_ENV, type SecretStore } from '../settings/secrets.js';
import type { SettingsService } from '../settings/service.js';

export interface SetupApiDeps {
  settings: SettingsService;
  secrets: SecretStore;
  accounts: AccountRegistry;
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
    res.json({
      ok: true,
      savedVersion: snap.savedVersion,
      activeVersion: snap.activeVersion,
      preferences: {
        appMode: snap.effective.appMode,
        balance: snap.effective.paper.balance,
        safetyNet: snap.effective.paper.safetyNet,
        n: snap.effective.paper.n,
        dailyLoss: snap.effective.trading.dailyLossLimitPct,
        auto: snap.effective.auto.on,
        debateInterval: snap.effective.auto.intervalMin,
        reportInterval: snap.effective.auto.reportIntervalMin,
        maxHoldHours: snap.effective.auto.maxHoldHours
      }
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
        error: 'Check the amounts, safety net, N (1-4), loss cap (0.1-100%), intervals (1-1440 minutes), and max hold hours (0-720 hours).'
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
          dailyLossLimitPct: Math.min(25, Math.max(0.5, v.dailyLoss))
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
    const status = result.applyStatus === 'conflict' ? 409 : result.applyStatus === 'failed' ? 400 : 200;
    res.status(status).json({ ok: result.applyStatus === 'applied', ...result });
  });

  app.get('/api/setup/trading', (_req, res) => {
    const snap = deps.settings.current();
    res.json({
      ok: true,
      savedVersion: snap.savedVersion,
      activeVersion: snap.activeVersion,
      profile: snap.effective.tradingProfile,
      values: snap.effective.trading,
      presets: TRADING_PRESETS
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

  app.post('/api/setup/trading', async (req, res) => {
    const expected = Number(
      req.body?.expectedActiveVersion ?? deps.settings.current().activeVersion
    );
    const { expectedActiveVersion: _omit, network, ...rawValues } = (req.body ?? {}) as Record<string, unknown>;
    const parsed = TradingFields.partial().safeParse(rawValues);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') });
      return;
    }
    const net = typeof network === 'string' && (NETWORKS as readonly string[]).includes(network)
      ? (network as Network)
      : undefined;
    const result = await deps.settings.apply(
      {
        tradingProfile: 'manual',
        trading: parsed.data,
        ...(net ? { networkProfiles: { [net]: parsed.data } } : {})
      },
      expected
    );
    const status = result.applyStatus === 'conflict' ? 409 : result.applyStatus === 'failed' ? 400 : 200;
    res.status(status).json({ ok: result.applyStatus === 'applied', ...result });
  });

  app.get('/api/setup/models', (_req, res) => {
    const snap = deps.settings.current();
    res.json({
      ok: true,
      savedVersion: snap.savedVersion,
      activeVersion: snap.activeVersion,
      agents: snap.effective.agents,
      providersConfigured: deps.secrets.statusSummary().providersConfigured
    });
  });

  app.post('/api/setup/models', async (req, res) => {
    const bodySchema = z
      .object({
        expectedActiveVersion: z.number().int().positive().optional(),
        keys: z.record(z.enum(API_PROVIDERS), z.string().max(400)).optional(),
        agents: z
          .record(
            z.enum(ROLE_IDS),
            z.object({
              provider: z.enum(MODEL_PROVIDERS).optional(),
              model: z.string().min(1).max(200).optional(),
              reasoning: z.enum(REASONING_LEVELS).optional(),
              route: z.enum(['LOCAL', 'GROK', 'MIRROR_READ_ONLY']).optional()
            })
          )
          .optional()
      })
      .strict();

    const parsed = bodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Invalid model configuration payload.' });
      return;
    }
    if (parsed.data.keys) {
      const secretUpdates: Record<string, string> = {};
      for (const [prov, keyVal] of Object.entries(parsed.data.keys) as Array<[ApiProviderId, string]>) {
        if (keyVal.trim().length > 0) {
          secretUpdates[PROVIDER_KEY_ENV[prov]] = keyVal.trim();
        }
      }
      if (Object.keys(secretUpdates).length > 0) {
        deps.secrets.writeSecrets(secretUpdates);
      }
    }
    const expected = parsed.data.expectedActiveVersion ?? deps.settings.current().activeVersion;
    const result = await deps.settings.apply(
      { agents: parsed.data.agents },
      expected
    );
    const status = result.applyStatus === 'conflict' ? 409 : result.applyStatus === 'failed' ? 400 : 200;
    res.status(status).json({ ok: result.applyStatus === 'applied', ...result });
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
        apiKey: z.string().max(400).optional()
      })
      .strict();
    const parsed = bodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Invalid Jev setup payload.' });
      return;
    }
    if (parsed.data.apiKey && parsed.data.apiKey.trim().length > 0) {
      deps.secrets.writeSecrets({ JEV_OPENROUTER_API_KEY: parsed.data.apiKey.trim() });
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
    res.status(status).json({ ok: result.applyStatus === 'applied', ...result });
  });

  app.get('/api/setup/data-sources', (_req, res) => {
    const snap = deps.settings.current();
    res.json({
      ok: true,
      savedVersion: snap.savedVersion,
      activeVersion: snap.activeVersion,
      dataSources: snap.effective.dataSources,
      keysConfigured: {
        cryptopanic: Boolean(deps.secrets.getSecret('CRYPTOPANIC_API_KEY')),
        whaleAlert: Boolean(deps.secrets.getSecret('WHALE_ALERT_API_KEY')),
        cmc: Boolean(deps.secrets.getSecret('CMC_API_KEY')),
        coinglass: Boolean(deps.secrets.getSecret('COINGLASS_API_KEY')),
        arkham: Boolean(deps.secrets.getSecret('ARKHAM_API_KEY')),
        fred: Boolean(deps.secrets.getSecret('FRED_API_KEY'))
      }
    });
  });

  app.post('/api/setup/data-sources', async (req, res) => {
    const bodySchema = z
      .object({
        expectedActiveVersion: z.number().int().positive().optional(),
        newsProvider: z.enum(['none', 'cryptopanic']).optional(),
        whaleAlertEnabled: z.boolean().optional(),
        cmcEnabled: z.boolean().optional(),
        coinglassEnabled: z.boolean().optional(),
        arkhamEnabled: z.boolean().optional(),
        fredEnabled: z.boolean().optional(),
        keys: z.record(z.string(), z.string().max(400)).optional()
      })
      .strict();
    const parsed = bodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Invalid data sources payload.' });
      return;
    }
    if (parsed.data.keys) {
      const allowedKeyMap: Record<string, string> = {
        cryptopanic: 'CRYPTOPANIC_API_KEY',
        whaleAlert: 'WHALE_ALERT_API_KEY',
        cmc: 'CMC_API_KEY',
        coinglass: 'COINGLASS_API_KEY',
        arkham: 'ARKHAM_API_KEY',
        fred: 'FRED_API_KEY'
      };
      const updates: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed.data.keys)) {
        const envName = allowedKeyMap[k];
        if (envName && v.trim()) updates[envName] = v.trim();
      }
      if (Object.keys(updates).length > 0) deps.secrets.writeSecrets(updates);
    }
    const expected = parsed.data.expectedActiveVersion ?? deps.settings.current().activeVersion;
    const { expectedActiveVersion: _omit, keys: _keys, ...dsPatch } = parsed.data;
    const result = await deps.settings.apply({ dataSources: dsPatch }, expected);
    const status = result.applyStatus === 'conflict' ? 409 : result.applyStatus === 'failed' ? 400 : 200;
    res.status(status).json({ ok: result.applyStatus === 'applied', ...result });
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
    res.status(status).json({ ok: result.applyStatus === 'applied', ...result });
  });

  app.post('/api/setup/keys', (req, res) => {
    const bodySchema = z
      .object({
        venue: z.enum(EXCHANGES),
        network: z.enum(NETWORKS),
        key: z.string().min(4).max(300),
        secret: z.string().min(6).max(500),
        passphrase: z.string().max(300).optional()
      })
      .strict();
    const parsed = bodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Invalid venue credential fields.' });
      return;
    }
    const names = venueCredentialEnvNames(parsed.data.venue as VenueId, parsed.data.network as Network);
    if (names.passphrase && !(parsed.data.passphrase ?? '').trim()) {
      res.status(400).json({ ok: false, error: `Missing required ${names.passphrase} field.` });
      return;
    }
    const updates: Record<string, string> = {
      [names.key]: parsed.data.key.trim(),
      [names.secret]: parsed.data.secret.trim()
    };
    if (names.passphrase && parsed.data.passphrase) {
      updates[names.passphrase] = parsed.data.passphrase.trim();
    }
    deps.secrets.writeSecrets(updates);
    res.json({
      ok: true,
      detail: `A key is set for ${parsed.data.venue} (${parsed.data.network}). Run doctor before enabling trading.`
    });
  });

  app.post('/api/setup/mode', async (req, res) => {
    const bodySchema = z
      .object({
        mode: z.enum(TRADING_MODES),
        confirmLive: z.string().optional(),
        expectedActiveVersion: z.number().int().positive().optional()
      })
      .strict();
    const parsed = bodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Invalid trading mode.' });
      return;
    }
    const snap = deps.settings.current();
    if (parsed.data.mode === 'LIVE' && parsed.data.confirmLive !== LIVE_CONFIRM_PHRASE) {
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
    res.status(status).json({ ok: result.applyStatus === 'applied', ...result });
  });
}
