import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { log, safe } from '../redact.js';
import { configurationFingerprint } from '../session-entry.js';
import {
  getSessionLogger,
  recordDiagnostic,
  registerDiagnosticSecrets
} from '../session-log.js';
import {
  EXCHANGES,
  ROLE_IDS,
  unavailableEvidence,
  availableFinancialField,
  unavailableFinancialField,
  type AppMode,
  type Network,
  type OfficeCommand,
  type OfficeReply,
  type OfficeRuntime,
  type OfficeState,
  type RoleId,
  type TradingMode,
  type VenueId
} from './contracts.js';
import {
  attachOfficeWebSocket,
  createInitialOfficeState,
  OfficeEventHub
} from './office.js';
import { createReplacementApp } from './app.js';
import { BybitMarketHub } from './market/bybit.js';
import { computeIntelligence, type IntelligenceFrame } from './market/intelligence.js';
import { RoleRunner } from './agents/runner.js';
import { CycleRunner, type CyclePolicy, type CycleReason } from './decision/cycle.js';
import { JevClient } from './agents/jev.js';
import { createOfficialProviderCaller } from './agents/providers.js';
import { resolveCanonicalRole } from './agents/roles.js';
import { PROVIDER_KEY_ENV, SecretStore } from './settings/secrets.js';
import {
  DEFAULT_TRADING_SETTINGS,
  resolveTradingPresetValues,
  TRADING_PRESET_IDS,
  TRADING_PROFILES,
  type ApiProviderId,
  type TradingPresetId,
  type TradingProfile
} from './settings/schema.js';
import type { Position, Stance, Verdict } from '../../shared/office.js';
import { RuntimeStore } from './store/database.js';
import { ExecutionAuthorityService } from './accounts/authority.js';
import { AccountRegistry } from './accounts/registry.js';
import { SettingsService } from './settings/service.js';
import { ExecutionGateway, convertDailyLossPctToUsdt, resolveOwnerPerOrderUsdt } from './execution/gateway.js';
import { getVenueAdapter, createTransportFromAdapter } from './execution/adapters/factory.js';
import { ChatService, buildLiveDeskChatContext } from './api/chat.js';
import { PaperVenue } from './sandbox/paper.js';
import {
  assertLivePermissionEvidence,
  type PermissionEvidence,
  type NativeAccountIdentity,
  type NativeBalance,
  type NativePosition
} from './execution/adapters/types.js';
import { ResearchHost } from './research/host.js';
import { GrokBridge } from './connectors/grok/bridge.js';
import type { KeyRegistry } from './connectors/grok/auth.js';
import { HELP_TEXT, DiscordGateway } from './channels.js';
import { formatDeskReportText, ReportsService } from './reports.js';
import {
  deskOpenPnl,
  formatLessonsCard,
  formatPositionsCard,
  formatScanCard,
  formatScorecardCard,
  formatStatusCard,
  formatWatchlistCard
} from './channel-text.js';
import { readKill, writeKill, clearKill, DEFAULT_KILL_FILE } from './kill-file.js';
function normSymbol(s: string): string {
  const up = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!up) return '';
  return /USDT$|USDC$|USD$/.test(up) ? up : `${up}USDT`;
}

export class StartupValidationError extends Error {
  constructor(message: string, public readonly exitCode = 2) {
    super(message);
    this.name = 'StartupValidationError';
  }
}

const VENUE_PREFIX: Record<VenueId, string> = {
  bybit: 'BYBIT',
  binance: 'BINANCE',
  okx: 'OKX',
  hyperliquid: 'HYPERLIQUID',
  aster: 'ASTER',
  dydx: 'DYDX',
  paradex: 'PARADEX',
  orderly: 'ORDERLY'
};

export function venueCredentialEnvNames(
  venue: VenueId,
  network: Network
): { key: string; secret: string; passphrase?: string } {
  const prefix = VENUE_PREFIX[venue] + (network === 'testnet' ? '_TESTNET' : '');
  switch (venue) {
    case 'hyperliquid':
      return { key: `${prefix}_ACCOUNT_ADDRESS`, secret: `${prefix}_AGENT_PRIVATE_KEY` };
    case 'aster':
      return { key: `${prefix}_USER_ADDRESS`, secret: `${prefix}_SIGNER_PRIVATE_KEY` };
    case 'dydx':
      return { key: `${prefix}_ADDRESS`, secret: `${prefix}_API_PRIVATE_KEY`, passphrase: `${prefix}_AUTHENTICATOR_ID` };
    case 'paradex':
      return { key: `${prefix}_ACCOUNT_ADDRESS`, secret: `${prefix}_SUBKEY_PRIVATE_KEY` };
    case 'orderly':
      return { key: `${prefix}_ACCOUNT_ID`, secret: `${prefix}_KEY_SECRET` };
    case 'okx':
      return { key: `${prefix}_API_KEY`, secret: `${prefix}_API_SECRET`, passphrase: `${prefix}_API_PASSPHRASE` };
    default:
      return { key: `${prefix}_API_KEY`, secret: `${prefix}_API_SECRET` };
  }
}

export interface StartupEnvCheck {
  tradingMode: TradingMode;
  appMode: AppMode;
  host: string;
  port: number;
  venue: VenueId | null;
  network: Network | null;
}

export function resolveEffectiveSafetyNet(
  env: NodeJS.ProcessEnv = process.env,
  network: Network | null = null,
  savedValue?: number | null
): { value: number; source: string; isExplicitZero: boolean; isValidPositive: boolean } {
  if (savedValue !== undefined && savedValue !== null && Number.isFinite(savedValue)) {
    return {
      value: savedValue,
      source: 'saved_settings',
      isExplicitZero: savedValue === 0,
      isValidPositive: savedValue > 0
    };
  }

  const networkKey = network === 'mainnet' ? 'MAINNET_DESK_SAFETY_NET' : network === 'testnet' ? 'TESTNET_DESK_SAFETY_NET' : null;
  const netRaw = networkKey ? env[networkKey] : undefined;
  if (netRaw !== undefined && netRaw.trim() !== '') {
    const parsed = Number(netRaw.trim());
    if (Number.isFinite(parsed)) {
      return {
        value: parsed,
        source: networkKey!,
        isExplicitZero: parsed === 0,
        isValidPositive: parsed > 0
      };
    }
  }

  const globalRaw = env.SAFETY_NET;
  if (globalRaw !== undefined && globalRaw.trim() !== '') {
    const parsed = Number(globalRaw.trim());
    if (Number.isFinite(parsed)) {
      return {
        value: parsed,
        source: 'SAFETY_NET',
        isExplicitZero: parsed === 0,
        isValidPositive: parsed > 0
      };
    }
  }

  return {
    value: 200,
    source: 'default',
    isExplicitZero: false,
    isValidPositive: true
  };
}

export function validateStartupEnvironment(env: NodeJS.ProcessEnv = process.env): StartupEnvCheck {
  const rawMode = (env.TRADING_MODE ?? 'PAPER').trim().toUpperCase();
  if (rawMode !== 'PAPER' && rawMode !== 'TESTNET' && rawMode !== 'LIVE') {
    throw new StartupValidationError(
      `TRADING_MODE is "${rawMode}". Use PAPER (default), TESTNET or LIVE. Refusing to start.`,
      2
    );
  }
  const tradingMode = rawMode as TradingMode;

  const rawAppMode = (env.APP_MODE || 'local').trim().toLowerCase();
  if (rawAppMode !== 'local' && rawAppMode !== 'grokbot') {
    throw new StartupValidationError('APP_MODE must be local or grokbot', 2);
  }
  const appMode = rawAppMode as AppMode;

  const rawVenue = (env.EXCHANGE ?? '').trim().toLowerCase();
  if (rawVenue && rawVenue !== 'none' && !(EXCHANGES as readonly string[]).includes(rawVenue)) {
    throw new StartupValidationError(
      `EXCHANGE="${rawVenue}" is not one of none, ${EXCHANGES.join(', ')}`,
      2
    );
  }
  const venue = rawVenue && rawVenue !== 'none' ? (rawVenue as VenueId) : null;
  const network: Network | null =
    tradingMode === 'LIVE' ? 'mainnet' : tradingMode === 'TESTNET' ? 'testnet' : null;

  if (network) {
    const reasons: string[] = [];
    if (!venue) {
      reasons.push('EXCHANGE is not set');
    } else {
      const names = venueCredentialEnvNames(venue, network);
      const key = (env[names.key] ?? '').trim();
      const secret = (env[names.secret] ?? '').trim();
      const passphrase = names.passphrase ? (env[names.passphrase] ?? '').trim() : 'ok';
      if (!key || !secret || !passphrase) {
        reasons.push(`${network} ${venue} keys are missing in .env`);
      }
      if (tradingMode === 'LIVE' && venue !== 'bybit' && (env.ALLOW_EXPERIMENTAL_LIVE ?? '').trim() !== 'yes') {
        reasons.push(`the ${venue} adapter is experimental and unverified; LIVE on it needs ALLOW_EXPERIMENTAL_LIVE=yes`);
      }
    }
    const resolvedSafety = resolveEffectiveSafetyNet(env, network);
    if (!resolvedSafety.isValidPositive) {
      reasons.push(`SAFETY_NET must be above zero outside PAPER (resolved ${resolvedSafety.value} from ${resolvedSafety.source})`);
    }
    if (reasons.length > 0) {
      throw new StartupValidationError(
        `TRADING_MODE=${tradingMode} cannot start, refusing. Fix this with "mpu setup" or go back to PAPER with "mpu paper":\n  - ${reasons.join('\n  - ')}`,
        2
      );
    }
  }

  const rawN = env.OPEN_ORDERS_N;
  if (rawN !== undefined && rawN !== '') {
    const n = Number(rawN);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      throw new StartupValidationError('OPEN_ORDERS_N must be an integer from 1 to 100', 2);
    }
  }

  const rawPort = env.PORT === undefined || env.PORT === '' ? 8787 : Number(env.PORT);
  if (!Number.isInteger(rawPort) || rawPort < 0 || rawPort > 65535) {
    throw new StartupValidationError('PORT must be a valid TCP port (0..65535)', 2);
  }

  const requestedHost = (env.HOST || '127.0.0.1').trim();
  const host = tradingMode === 'LIVE' ? '127.0.0.1' : requestedHost;

  return {
    tradingMode,
    appMode,
    host,
    port: rawPort,
    venue,
    network
  };
}

export interface ReplacementRuntimeHandle extends OfficeRuntime {
  readonly hub: OfficeEventHub;
  readonly marketHub: BybitMarketHub;
  readonly roleRunner: RoleRunner;
  readonly cycleRunner: CycleRunner;
  updateState(mutator: (draft: OfficeState) => OfficeState | void): OfficeState;
  triggerCycle(
    symbol?: string,
    reason?: CycleReason
  ): Promise<{ ok: boolean; message: string; cycleId?: string }>;
  updateAutoSettings(patch: {
    on?: boolean;
    intervalMin?: number;
    maxHoldHours?: number;
    reportIntervalMin?: number;
    symbols?: string[];
    debateMode?: 'normal' | 'fast';
    n?: number;
  }): OfficeState;
  handleCommand(input: {
    text: string;
    agent?: string;
    clientRequestId?: string;
    conversationId?: string;
  }): Promise<{ ok: boolean; command?: string; reply?: string; error?: string }>;
  readonly reportsService?: ReportsService;
  stop(): Promise<void>;
}

export interface ReplacementRuntimeOptions {
  version?: string;
  sessionId?: string | null;
  startedAt?: number;
  initialMode?: TradingMode;
  initialAppMode?: AppMode;
  dispatcher?: (input: OfficeCommand, state: OfficeState) => Promise<OfficeReply>;
  marketHub?: BybitMarketHub;
  roleRunner?: RoleRunner;
  cycleRunner?: CycleRunner;
  jevClient?: JevClient;
  env?: Record<string, string | undefined>;
  initialFinancial?: OfficeState['financial'];
  initialPositions?: Position[];
  venue?: OfficeState['venue'];
  venueAccount?: OfficeState['venueAccount'];
  runtimeIdentity?: OfficeState['runtimeIdentity'];
  accountState?: OfficeState['accountState'];
  executionGateway?: ExecutionGateway;
  settings?: SettingsService;
  secrets?: SecretStore;
  chatService?: ChatService;
  researchHost?: ResearchHost;
  reportsService?: ReportsService;
  initialKilled?: boolean;
}

export function ownerAllocationPerOrder(
  moneyTrade: number,
  n: number,
  orderSizePct?: number | null
): number {
  if (orderSizePct != null && Number.isFinite(orderSizePct) && orderSizePct > 0) {
    return Math.floor(((moneyTrade * orderSizePct) / 100) * 100) / 100;
  }
  if (n > 0 && Number.isFinite(moneyTrade) && moneyTrade > 0) {
    return Math.floor((moneyTrade / n) * 100) / 100;
  }
  return 0;
}

export function verifiedVenueStop(input: {
  protectionState?: string | null;
  stopPrice?: string | null;
}): { stop: number; protectionStatus: 'confirmed' | 'missing' | 'unknown' } {
  if (input.protectionState === 'VERIFIED') {
    const stop = Number(input.stopPrice);
    if (Number.isFinite(stop) && stop > 0) return { stop, protectionStatus: 'confirmed' };
    return { stop: 0, protectionStatus: 'unknown' };
  }
  if (input.protectionState === 'MISSING') return { stop: 0, protectionStatus: 'missing' };
  return { stop: 0, protectionStatus: 'unknown' };
}

export function createReplacementRuntime(
  options: ReplacementRuntimeOptions = {}
): ReplacementRuntimeHandle {
  const hub = new OfficeEventHub();
  const env = options.env ?? process.env;
  let state = createInitialOfficeState({
    version: options.version,
    sessionId: options.sessionId,
    startedAt: options.startedAt
  });
  if (options.initialKilled) {
    state = { ...state, killed: true, auto: { ...state.auto, on: false } };
  }
  if (options.initialMode) {
    state = { ...state, mode: options.initialMode };
  }
  if (options.initialAppMode) {
    state = { ...state, appMode: options.initialAppMode };
  }
  if (options.initialFinancial) {
    state.financial = { ...state.financial, ...options.initialFinancial };
  }
  if (options.initialPositions) {
    state.paper.positions = options.initialPositions;
    const initialUpnl = options.initialPositions.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0);
    state.paper.unrealized = initialUpnl;
    state.paper.equity = state.paper.balance + initialUpnl;
  }
  if (options.venue) {
    state.venue = options.venue;
  }
  if (options.runtimeIdentity) {
    state.runtimeIdentity = options.runtimeIdentity;
  }
  if (options.venueAccount) {
    state.venueAccount = options.venueAccount;
  }
  if (options.accountState) {
    state.accountState = options.accountState;
  }

  const effectiveAgents = options.settings?.current().effective.agents;
  if (effectiveAgents) {
    for (const role of ROLE_IDS) {
      const conf = effectiveAgents[role];
      if (conf) {
        state.agents[role].provider = conf.provider;
        state.agents[role].model = conf.model;
        state.agents[role].configuredProvider = conf.provider;
        state.agents[role].configuredModel = conf.model;
        state.agents[role].invokedProvider = conf.provider;
        state.agents[role].invokedModel = conf.model;
        state.agents[role].executionStatus = 'IDLE';
        state.agents[role].lastLine = `Configured for ${conf.provider}/${conf.model}.`;
      }
    }
  }

  state.conversations = options.chatService?.listConversations() ?? [
    {
      id: 'office',
      title: 'Main Office',
      createdAt: Date.now() - 3600000,
      updatedAt: Date.now(),
      messageCount: 0
    }
  ];

  const savedPaper = options.settings?.current().effective.paper;
  const savedTrading = options.settings?.current().effective.trading;

  const rawPaperBal = Number(savedPaper?.balance ?? env.PAPER_BALANCE ?? 1000);
  const finBal = options.initialFinancial?.balance?.value != null ? Number(options.initialFinancial.balance.value) : null;
  const initBal = state.mode !== 'PAPER' && finBal !== null && Number.isFinite(finBal) && finBal > 0
    ? finBal
    : (Number.isFinite(rawPaperBal) ? rawPaperBal : 1000);

  const resolvedSafety = resolveEffectiveSafetyNet(
    env,
    state.mode === 'LIVE' ? 'mainnet' : state.mode === 'TESTNET' ? 'testnet' : null,
    savedTrading?.safetyNet ?? savedPaper?.safetyNet
  );
  const initSafety = resolvedSafety.value >= 0 ? resolvedSafety.value : 200;

  const rawN = Math.trunc(Number(
    savedTrading?.maxPositions ??
    savedPaper?.n ??
    (state.mode === 'LIVE' ? env.MAINNET_DESK_OPEN_ORDERS_N : undefined) ??
    env.OPEN_ORDERS_N ??
    3
  ));
  const initN = Math.max(1, Number.isFinite(rawN) ? rawN : 3);

  const moneyTrade = Math.round(Math.max(0, initBal - initSafety) * 100) / 100;
  const orderSizePct = savedTrading?.orderSizePct;
  const perOrder = ownerAllocationPerOrder(moneyTrade, initN, orderSizePct);
  const canOpen = perOrder > 0 && (options.initialPositions ? options.initialPositions.length < initN : true);

  const rawLev = Math.trunc(Number(
    savedTrading?.maxLeverage ??
    (state.mode === 'LIVE' ? env.MAINNET_DESK_MAX_LEVERAGE : undefined) ??
    env.MAX_LEVERAGE ??
    5
  ));
  const initLev = Math.max(1, Math.min(100, Number.isFinite(rawLev) ? rawLev : 5));

  state.paper.balance = initBal;
  state.paper.safetyNet = initSafety;
  state.paper.n = initN;
  state.paper.maxLeverage = initLev;
  state.paper.moneyTrade = moneyTrade;
  state.paper.perOrder = perOrder;
  state.paper.orderSizePct = orderSizePct;
  state.paper.canOpen = canOpen;
  state.paper.equity = initBal;

  if (state.mode === 'PAPER') {
    state.accountState = {
      hasTradableCapital: canOpen,
      openPositionsCount: 0,
      maxPositions: initN,
      freeSlots: initN,
      occupiedSlots: 0,
      pendingOpenCount: 0,
      canOpenNewSlot: canOpen,
      mode: 'PAPER',
      source: 'simulated',
      status: 'AVAILABLE',
      observedAt: Date.now()
    };
  } else {
    const finAvail = state.venueAccount?.available ?? (options.initialFinancial?.availableBalance?.value != null
      ? Number(options.initialFinancial.availableBalance.value)
      : finBal);
    if (!state.venueAccount && finBal !== null) {
      state.venueAccount = {
        equity: finBal,
        available: finAvail ?? finBal,
        unrealized: 0,
        at: Date.now(),
        status: 'confirmed',
        positions: (options.initialPositions ?? []).map((p) => ({ symbol: p.symbol, side: p.side, qty: p.qty }))
      };
    }
    state.accountState = {
      hasTradableCapital: canOpen,
      openPositionsCount: options.initialPositions?.length ?? 0,
      maxPositions: initN,
      freeSlots: Math.max(0, initN - (options.initialPositions?.length ?? 0)),
      occupiedSlots: options.initialPositions?.length ?? 0,
      pendingOpenCount: 0,
      canOpenNewSlot: canOpen,
      mode: state.mode,
      source: state.venueAccount ? 'native_exchange' : 'reconciliation',
      status: 'AVAILABLE',
      observedAt: Date.now()
    };
  }

  const tvWidget = ['1', 'on', 'yes', 'true'].includes((env.TRADINGVIEW_WIDGET ?? '').trim().toLowerCase());
  const tvPass = (env.TRADINGVIEW_PASSPHRASE ?? '').trim();
  const tvWebhook = ['1', 'on', 'yes', 'true'].includes((env.TRADINGVIEW_WEBHOOK ?? '').trim().toLowerCase()) || Boolean(tvPass);
  const rawTvPrefix = (env.TRADINGVIEW_EXCHANGE_PREFIX ?? env.TRADINGVIEW_PREFIX ?? 'BYBIT').trim();
  const tvPrefix = rawTvPrefix.replace(/:+$/, '') || 'BYBIT';
  state.tradingview = {
    widget: tvWidget,
    prefix: tvPrefix,
    webhook: tvWebhook
  };

  const savedAuto = options.settings?.current().effective.auto;
  const savedWatchlist = options.settings?.current().effective.watchlist;
  if (savedAuto) {
    state.auto.on = savedAuto.on ?? state.auto.on;
    state.auto.intervalMin = savedAuto.intervalMin ?? state.auto.intervalMin;
    state.auto.maxHoldHours = savedAuto.maxHoldHours ?? state.auto.maxHoldHours;
    if (savedAuto.symbols && savedAuto.symbols.length > 0) {
      state.auto.symbols = [...savedAuto.symbols];
    }
  }
  if (savedWatchlist && savedWatchlist.length > 0) {
    state.watchlist = [...savedWatchlist];
    if (!savedAuto?.symbols || savedAuto.symbols.length === 0) {
      state.auto.symbols = [...savedWatchlist];
    }
  }
  if (savedTrading && state.trading) {
    state.trading.profile = options.settings?.current().effective.tradingProfile ?? 'manual';
    state.trading.values = {
      ...state.trading.values,
      ...savedTrading,
      maxPositions: initN,
      safetyNet: initSafety,
      maxLeverage: initLev
    };
    state.paper.maxLeverage = state.trading.values.maxLeverage;
  }

  const snapshot = (): OfficeState => structuredClone(state);

  const updateState = (mutator: (draft: OfficeState) => OfficeState | void): OfficeState => {
    const next = structuredClone(state);
    const returned = mutator(next);
    state = returned ?? next;
    const currentSnap = structuredClone(state);
    hub.emit('state', currentSnap);
    return currentSnap;
  };

  const marketHub =
    options.marketHub ??
    new BybitMarketHub({
      retainedSymbolsProvider: () => state.watchlist
    });

  const savedJev = options.settings?.current().effective.jev;
  const jevKey = (
    options.secrets?.getSecret('JEV_OPENROUTER_API_KEY') ??
    options.secrets?.getSecret('OPENROUTER_API_KEY') ??
    env.JEV_OPENROUTER_API_KEY ??
    env.OPENROUTER_API_KEY ??
    ''
  ).trim();
  const jevEnabled = savedJev?.enabled ?? ['true', 'yes', '1', 'on'].includes(
    (env.JEV_ENABLED ?? '').trim().toLowerCase()
  );
  const jevModel = savedJev?.model || env.JEV_MODEL || 'typesafe/jev-1.14';
  const jevMode = savedJev?.mode || 'off';
  const jevAllowLive = savedJev?.allowLive ?? false;
  const hasJevKey = Boolean(options.secrets?.hasProviderKey('openrouter') || jevKey);

  state.jev = {
    ...state.jev,
    enabled: jevEnabled,
    provider: savedJev?.provider || 'openrouter',
    model: jevModel,
    mode: jevMode,
    configuredMode: jevMode,
    allowLive: jevAllowLive,
    health: !jevEnabled ? 'disabled' : (hasJevKey ? 'configured' : 'unavailable'),
    openrouterKeySet: Boolean(options.secrets?.hasProviderKey('openrouter') || env.OPENROUTER_API_KEY),
    dedicatedKeySet: Boolean(options.secrets?.getSecret('JEV_OPENROUTER_API_KEY') || env.JEV_OPENROUTER_API_KEY),
    configHealth: !jevEnabled ? 'off' : (hasJevKey ? 'configured' : 'unconfigured'),
    remoteHealth: 'unused'
  };

  const jevClient =
    options.jevClient ??
    new JevClient({
      enabled: jevEnabled,
      apiKey: jevKey || null,
      model: jevModel
    });

  const roleRunner =
    options.roleRunner ??
    new RoleRunner({
      researchHost: options.researchHost,
      providerCaller: createOfficialProviderCaller(),
      resolveAssignment: (role, _version) => {
        const settingsSnap = options.settings?.current();
        const configuredAgent = settingsSnap?.effective?.agents?.[role];
        const defaultAgent = settingsSnap?.effective?.agents?.lead;

        const upper = role.toUpperCase();
        const rawProv = (configuredAgent?.provider ?? defaultAgent?.provider ?? env[`AGENT_${upper}_PROVIDER`] ?? env.DEFAULT_PROVIDER ?? '').trim().toLowerCase();
        const provider = rawProv && rawProv !== 'mock' ? rawProv : (rawProv === 'mock' ? 'mock' : 'unconfigured');
        const model = (configuredAgent?.model ?? defaultAgent?.model ?? env[`AGENT_${upper}_MODEL`] ?? env.DEFAULT_MODEL ?? 'unconfigured').trim();
        const reasoningEffort = configuredAgent?.reasoning ?? defaultAgent?.reasoning;

        const secretsMap = options.secrets?.readEnvMap() ?? env;
        const keyEnv = PROVIDER_KEY_ENV[provider as ApiProviderId] || `${provider.toUpperCase()}_API_KEY`;
        const apiKey = (secretsMap[keyEnv] ?? env[keyEnv] ?? '').trim();
        return {
          provider,
          model,
          apiKey: apiKey || null,
          reasoningEffort: reasoningEffort ?? undefined,
          provenOsSandbox: true
        };
      }
    });

  const cycleRunner =
    options.cycleRunner ??
    new CycleRunner({
      roleRunner,
      jevClient
    });

  let autoTimer: NodeJS.Timeout | null = null;

  const scheduleNextAutoCycle = () => {
    if (autoTimer) {
      clearTimeout(autoTimer);
      autoTimer = null;
    }
    const current = snapshot();
    if (!current.auto.on || current.killed) {
      return;
    }
    const delayMs = Math.max(5000, current.auto.intervalMin * 60 * 1000);
    autoTimer = setTimeout(() => {
      autoTimer = null;
      const s = snapshot();
      if (s.auto.on && !s.killed && !s.paused && !s.auto.running) {
        void triggerCycle(undefined, 'schedule').finally(() => {
          scheduleNextAutoCycle();
        });
      } else if (s.auto.on && !s.killed) {
        scheduleNextAutoCycle();
      }
    }, delayMs);
    autoTimer.unref();
  };

  const updateAutoSettings = (patch: {
    on?: boolean;
    intervalMin?: number;
    maxHoldHours?: number;
    reportIntervalMin?: number;
    symbols?: string[];
    debateMode?: 'normal' | 'fast';
    n?: number;
  }): OfficeState => {
    updateState((draft) => {
      if (patch.on !== undefined) draft.auto.on = patch.on;
      if (patch.intervalMin !== undefined) draft.auto.intervalMin = patch.intervalMin;
      if (patch.maxHoldHours !== undefined) draft.auto.maxHoldHours = patch.maxHoldHours;
      if (patch.reportIntervalMin !== undefined) draft.reportIntervalMin = patch.reportIntervalMin;
      if (patch.symbols !== undefined && patch.symbols.length > 0) {
        draft.auto.symbols = [...patch.symbols];
        draft.watchlist = [...patch.symbols];
      }
      if (patch.debateMode !== undefined) draft.debateMode = patch.debateMode;
      if (patch.n !== undefined) {
        draft.paper.n = patch.n;
        if (draft.trading) {
          draft.trading.values.maxPositions = patch.n;
        }
        if (draft.accountState) {
          draft.accountState.maxPositions = patch.n;
          draft.accountState.freeSlots = Math.max(0, patch.n - draft.paper.positions.length);
        }
        const mt = Math.max(0, draft.paper.balance - draft.paper.safetyNet);
        draft.paper.moneyTrade = mt;
        draft.paper.perOrder = Math.floor((mt / patch.n) * 100) / 100;
        draft.paper.canOpen = draft.paper.perOrder > 0 && draft.paper.positions.length < patch.n;
      }
      if (draft.auto.on) {
        draft.auto.nextAt = Date.now() + draft.auto.intervalMin * 60 * 1000;
      } else {
        draft.auto.nextAt = 0;
      }
    });

    scheduleNextAutoCycle();

    if (patch.reportIntervalMin !== undefined && options.reportsService) {
      options.reportsService.start({
        snapshot,
        updateState,
        dispatch,
        triggerCycle,
        updateAutoSettings,
        handleCommand
      }, patch.reportIntervalMin);
    }

    if (patch.symbols !== undefined && patch.symbols.length > 0) {
      void marketHub.configure(patch.symbols).catch((err) => {
        console.error('[marketHub] Configure error:', err);
      });
    }

    if (patch.on && !snapshot().auto.running && !snapshot().killed) {
      setTimeout(() => {
        const s = snapshot();
        if (s.auto.on && !s.killed && !s.auto.running) {
          void triggerCycle(undefined, 'schedule');
        }
      }, 2000).unref();
    }

    if (options.settings) {
      const cur = options.settings.current();
      const nextSymbols = patch.symbols && patch.symbols.length > 0 ? patch.symbols : cur.effective.auto.symbols;
      void options.settings.apply({
        auto: {
          on: patch.on ?? cur.effective.auto.on,
          intervalMin: patch.intervalMin ?? cur.effective.auto.intervalMin,
          reportIntervalMin: patch.reportIntervalMin ?? cur.effective.auto.reportIntervalMin,
          maxHoldHours: patch.maxHoldHours ?? cur.effective.auto.maxHoldHours,
          symbols: nextSymbols
        },
        watchlist: nextSymbols,
        ...(patch.n !== undefined ? {
          trading: { maxPositions: patch.n },
          paper: { n: patch.n }
        } : {})
      }, cur.activeVersion).catch(() => {});
    }

    if (options.secrets) {
      const updates: Record<string, string> = {};
      if (patch.on !== undefined) updates.AUTO_TRADING = patch.on ? 'on' : 'off';
      if (patch.intervalMin !== undefined) updates.DEBATE_INTERVAL_MIN = String(patch.intervalMin);
      if (patch.reportIntervalMin !== undefined) updates.REPORT_INTERVAL_MIN = String(patch.reportIntervalMin);
      if (patch.symbols !== undefined && patch.symbols.length > 0) {
        updates.WATCHLIST = patch.symbols.join(',');
      }
      if (patch.n !== undefined) {
        updates.OPEN_ORDERS_N = String(patch.n);
        updates.MAINNET_DESK_OPEN_ORDERS_N = String(patch.n);
      }
      if (Object.keys(updates).length > 0) {
        options.secrets.writeSecrets(updates);
      }
    }

    hub.emit('state', snapshot());
    return snapshot();
  };

  const executeSingleSymbolCycle = async (
    targetSymbol: string,
    reason: CycleReason = 'owner'
  ): Promise<{ ok: boolean; message: string; cycleId: string; verdict?: Verdict }> => {
    const snap = snapshot();
    const cycleId = `cycle-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const debateId = `debate-${Date.now()}`;

    updateState((draft) => {
      draft.debate = {
        id: debateId,
        symbol: targetSymbol,
        phase: 'opening',
        mode: draft.debateMode ?? 'normal',
        round: 1,
        disagreement: 0,
        weighted: 0,
        camps: { bull: [], bear: [], neutral: [] }
      };
      for (const role of ROLE_IDS) {
        draft.agents[role].status = 'reading';
      }
    });

    hub.emit('debate', snapshot().debate);
    hub.emit('log', {
      at: Date.now(),
      kind: 'debate',
      text: `Started deliberation cycle for ${targetSymbol} (reason: ${reason})`
    });

    let intelFrame: IntelligenceFrame;
    try {
      const marketFrame = marketHub.snapshot(targetSymbol);
      const book = marketHub.orderbook(targetSymbol);
      const trades = marketHub.recentTrades(targetSymbol);
      intelFrame = computeIntelligence(marketFrame, { orderbook: book, trades });
    } catch {
      intelFrame = {
        evidenceId: `ev-${targetSymbol}-${Date.now()}`,
        marketEvidenceId: `mkt-${targetSymbol}`,
        marketRevision: 1,
        symbol: targetSymbol,
        formulaVersion: '1.0',
        byTimeframe: {} as any,
        microstructure: {
          coverage: 'unavailable',
          spreadBps: unavailableEvidence('bybit', 'Quote unavailable', Date.now(), 'bps'),
          bookImbalanceTop10: unavailableEvidence('bybit', 'Orderbook unavailable', Date.now(), 'ratio_-1_to_1'),
          takerFlow: unavailableEvidence('bybit', 'Trades unavailable', Date.now(), 'base_coin'),
          funding: unavailableEvidence('bybit', 'Funding unavailable', Date.now(), 'rate'),
          openInterest: unavailableEvidence('bybit', 'OI unavailable', Date.now(), 'contracts')
        },
        opposingFacts: [],
        generatedAt: Date.now()
      };
    }

    const timeframesSummary: Record<string, unknown> = {};
    if (intelFrame.byTimeframe) {
      for (const [tf, feat] of Object.entries(intelFrame.byTimeframe)) {
        if (!feat) continue;
        const highs = feat.structure?.pivots?.filter((p) => p.kind === 'HIGH') ?? [];
        const lows = feat.structure?.pivots?.filter((p) => p.kind === 'LOW') ?? [];
        timeframesSummary[tf] = {
          momentum: feat.momentumRegime,
          volatility: feat.volatilityRegime,
          ema9: feat.ema9?.value ?? null,
          ema21: feat.ema21?.value ?? null,
          ema50: feat.ema50?.value ?? null,
          ema200: feat.ema200?.value ?? null,
          sma20: feat.sma20?.value ?? null,
          rsi14: feat.rsi14?.value ?? null,
          atr14: feat.atr14?.value ?? null,
          macd: feat.macd?.value ? {
            line: feat.macd.value.macd,
            signal: feat.macd.value.signal,
            histogram: feat.macd.value.histogram
          } : null,
          bollinger: feat.bollinger20?.value ? {
            upper: feat.bollinger20.value.upper,
            middle: feat.bollinger20.value.middle,
            lower: feat.bollinger20.value.lower,
            bandwidth: feat.bollinger20.value.bandwidth
          } : null,
          vwapUtc: feat.vwapUtc?.value ?? null,
          relativeVolume20: feat.relativeVolume20?.value ?? null,
          structure: {
            swingHigh: highs[highs.length - 1]?.price ?? null,
            swingLow: lows[lows.length - 1]?.price ?? null,
            priorSwingHigh: highs[highs.length - 2]?.price ?? null,
            priorSwingLow: lows[lows.length - 2]?.price ?? null,
            bos: feat.structure?.bos ?? null,
            choch: feat.structure?.choch ?? null,
            rsiDivergence: feat.structure?.rsiDivergence ?? null
          }
        };
      }
    }

    const microstructureSummary = {
      spreadBps: intelFrame.microstructure?.spreadBps?.value ?? null,
      bookImbalanceTop10: intelFrame.microstructure?.bookImbalanceTop10?.value ?? null,
      takerFlow: intelFrame.microstructure?.takerFlow?.value ?? null,
      fundingRate: intelFrame.microstructure?.funding?.value ?? null,
      openInterest: intelFrame.microstructure?.openInterest?.value ?? null
    };

    const paperPos = snap.paper.positions.find((p) => p.symbol.toUpperCase() === targetSymbol);
    const venuePos = snap.venueAccount?.positions?.find((p) => p.symbol.toUpperCase() === targetSymbol);
    const existingPos = paperPos ?? (venuePos ? {
      side: venuePos.side,
      entry: Number(snap.tickers[targetSymbol]?.last ?? 0),
      qty: venuePos.qty,
      stop: 0,
      tp: null,
      unrealizedPnl: 0
    } : null);
    const currentPosCount = snap.mode === 'PAPER' ? snap.paper.positions.length : (snap.venueAccount?.positions?.length || snap.paper.positions.length);

    const marketSummary: Record<string, unknown> = {
      symbol: targetSymbol,
      venue: 'bybit',
      category: 'linear',
      lastPrice: snap.tickers[targetSymbol]?.last ? String(snap.tickers[targetSymbol].last) : undefined,
      evidenceId: intelFrame.evidenceId,
      timeframes: timeframesSummary,
      microstructure: microstructureSummary,
      opposingFacts: intelFrame.opposingFacts,
      existingPosition: existingPos ? {
        side: existingPos.side,
        entryPrice: existingPos.entry,
        qty: existingPos.qty,
        stop: existingPos.stop,
        tp: existingPos.tp,
        unrealizedPnl: existingPos.unrealizedPnl
      } : null,
      deskSlots: {
        maxPositions: snap.paper.n || 3,
        occupiedPositions: currentPosCount,
        freeSlots: Math.max(0, (snap.paper.n || 3) - currentPosCount)
      },
      optionalResearch: {
        news: { status: 'unavailable', reason: 'not fetched this cycle' },
        whale: { status: 'unavailable', reason: 'not fetched this cycle' },
        catalyst: { status: 'unavailable', reason: 'not fetched this cycle' }
      }
    };

    const tv = snap.trading?.values;
    const policy: CyclePolicy = {
      minEntryConfidencePct: tv?.minEntryConfidencePct ?? 60,
      requireTwoOfThreeAnalysts: false,
      maxLeverage: tv?.maxLeverage ?? snap.paper.maxLeverage,
      defaultStopPct: tv?.defaultStopPct ?? snap.paper.defaultStopPct,
      takeProfitPct: tv?.takeProfitPct,
      availableCapitalUsdt: snap.paper.moneyTrade,
      allocationPerOrderUsdt: resolveOwnerPerOrderUsdt(snap.paper),
      maxPositions: snap.paper.n,
      orderSizePct: tv?.orderSizePct ?? null,
      dailyLossLimitPct: tv?.dailyLossLimitPct
    };

    try {
      const out = await cycleRunner.run({
        cycleId,
        reason,
        accountRef: 'paper:default',
        symbol: targetSymbol,
        evidenceId: intelFrame.evidenceId,
        configVersion: options.settings?.current().activeVersion ?? 1,
        policy,
        marketSummary,
        deadlineMs: 360_000,
        onRoleStart: (task) => {
          const assignment = options.settings?.current().effective.agents[task.role as RoleId];
          updateState((draft) => {
            const agentView = draft.agents[task.role as RoleId];
            if (agentView) {
              agentView.status =
                task.phase === 'observe' ? 'reading' : task.phase === 'challenge' ? 'arguing' : 'thinking';
              if (assignment) {
                agentView.provider = assignment.provider;
                agentView.model = assignment.model;
                agentView.configuredProvider = assignment.provider;
                agentView.configuredModel = assignment.model;
                agentView.invokedProvider = assignment.provider;
                agentView.invokedModel = assignment.model;
              }
              agentView.lastAttemptAt = Date.now();
              agentView.executionStatus = task.phase === 'observe' ? 'OBSERVING' : 'THINKING';
            }
            if (draft.debate) {
              draft.debate.phase =
                task.phase === 'challenge'
                  ? 'round 1'
                  : task.phase === 'observe'
                  ? 'gathering'
                  : task.role === 'risk'
                  ? 'risk gate'
                  : task.role === 'execution'
                  ? 'execution review'
                  : task.role === 'lead'
                  ? 'verdict'
                  : task.phase;
              if (task.phase === 'challenge') {
                draft.debate.round = 1;
              }
            }
          });
          hub.emit('status', { agent: task.role, status: snapshot().agents[task.role as RoleId]?.status ?? 'thinking' });
          hub.emit('state', snapshot());
        },
        onRoleResult: (res) => {
          const at = Date.now();
          const reasoning =
            res.reasoning ?? (res.errorReason ? `Failure: ${res.errorReason}` : `Completed with stance ${res.stance ?? 'HOLD'}`);
          const roomMsg = {
            id: `room-${at}-${res.role}`,
            conversationId: 'office',
            at,
            from: res.role,
            to: 'owner' as const,
            text: reasoning,
            symbol: targetSymbol
          };

          updateState((draft) => {
            draft.agents[res.role].status = 'idle';
            if (res.provider) {
              draft.agents[res.role].provider = res.provider;
              draft.agents[res.role].invokedProvider = res.provider;
            }
            if (res.model) {
              draft.agents[res.role].model = res.model;
              draft.agents[res.role].invokedModel = res.model;
            }
            if (res.status === 'completed') {
              draft.agents[res.role].lastSuccessAt = at;
              draft.agents[res.role].executionStatus = 'IDLE';
            } else {
              draft.agents[res.role].lastError = res.errorReason ?? res.status;
              draft.agents[res.role].executionStatus = 'ERROR';
            }
            if (res.stance) draft.agents[res.role].stance = res.stance as Stance;
            if (res.confidence?.value !== null && res.confidence?.value !== undefined) {
              draft.agents[res.role].confidence =
                res.confidence.scale === 'probability_0_1'
                  ? Math.round(res.confidence.value * 100)
                  : Math.round(res.confidence.value);
            }
            draft.agents[res.role].lastLine = reasoning.slice(0, 160);

            if (!draft.roomHistory) draft.roomHistory = [];
            draft.roomHistory.push(roomMsg);
            draft.roomHistory = draft.roomHistory.slice(-100);

            if (!draft.logs) draft.logs = [];
            draft.logs.push({
              id: `log-${at}-${res.role}`,
              conversationId: 'office',
              at,
              kind: 'speech',
              agent: res.role,
              text: `[${res.role.toUpperCase()}] ${res.stance ?? 'HOLD'} (${res.confidence?.value ?? '-'}): ${reasoning}`
            });
            draft.logs = draft.logs.slice(-500);

            const bull = Object.values(draft.agents).filter((a) => a.stance === 'LONG').map((a) => a.id);
            const bear = Object.values(draft.agents).filter((a) => a.stance === 'SHORT').map((a) => a.id);
            const neutral = Object.values(draft.agents).filter((a) => a.stance !== 'LONG' && a.stance !== 'SHORT').map((a) => a.id);
            const disagreement = Math.min(bull.length, bear.length) > 0 ? (Math.min(bull.length, bear.length) * 2) / 6 : 0;
            if (draft.debate) {
              draft.debate.camps = { bull, bear, neutral };
              draft.debate.disagreement = disagreement;
            }

            if (disagreement >= (draft.fightThreshold ?? 0.35) && bull.length > 0 && bear.length > 0) {
              const fromAgent = bull[Math.floor(Math.random() * bull.length)]!;
              const toAgent = bear[Math.floor(Math.random() * bear.length)]!;
              const punches = 1 + Math.round(disagreement * 3);
              draft.agents[fromAgent].status = 'fighting';
              draft.agents[toAgent].status = 'fighting';
              hub.emit('fight', {
                from: fromAgent,
                to: toAgent,
                intensity: Math.min(1, disagreement),
                punches,
                at
              });
              draft.logs.push({
                id: `fight-${at}-${fromAgent}`,
                conversationId: 'office',
                at,
                kind: 'fight',
                agent: fromAgent,
                text: `${fromAgent.toUpperCase()} clashes with ${toAgent.toUpperCase()} over ${targetSymbol} (heat ${Math.round(disagreement * 100)}%)`
              });
            }
          });

          if (options.chatService) {
            void options.chatService.recordMessage({
              messageId: roomMsg.id,
              conversationId: 'office',
              role: res.role,
              text: reasoning
            }).catch(() => {});
          }

          hub.emit('speech', {
            id: `speech-${at}-${res.role}`,
            agent: res.role,
            text: reasoning,
            done: true,
            example: false,
            at
          });
          hub.emit('room', roomMsg);
          hub.emit('log', {
            at,
            kind: 'debate',
            agent: res.role,
            text: `[${res.role.toUpperCase()}] ${res.stance ?? 'HOLD'} (${res.confidence?.value ?? '-'}): ${reasoning}`
          });
          hub.emit('meter', { disagreement: snapshot().debate?.disagreement ?? 0 });
          hub.emit('state', snapshot());
        }
      });

      const currentSnap = snapshot();
      const bull = Object.values(currentSnap.agents).filter((a) => a.stance === 'LONG').map((a) => a.id);
      const bear = Object.values(currentSnap.agents).filter((a) => a.stance === 'SHORT').map((a) => a.id);
      const neutral = Object.values(currentSnap.agents).filter((a) => a.stance !== 'LONG' && a.stance !== 'SHORT').map((a) => a.id);
      const disagreement = Math.min(bull.length, bear.length) > 0 ? (Math.min(bull.length, bear.length) * 2) / 6 : 0;

      let verdictRecord: Verdict;
      if (out.status === 'completed' && out.verdict) {
        const action = out.verdict.action;
        const isApproved = out.verdict.thesis !== null && (action === 'OPEN_LONG' || action === 'OPEN_SHORT');

        verdictRecord = {
          id: `verdict-${Date.now()}`,
          symbol: targetSymbol,
          action,
          riskDecision: isApproved ? 'APPROVE' : (action === 'CLOSE' ? 'APPROVE' : 'HOLD'),
          executed: false,
          reason: out.verdict.rejectionReason ?? (isApproved ? 'Thesis verified and approved by Risk Manager' : (action === 'CLOSE' ? 'Exit criteria met; position closed' : 'Consensus synthesis reached HOLD')),
          disagreement,
          camps: { bull, bear, neutral },
          example: false,
          at: Date.now()
        };

        if (action === 'CLOSE') {
          if (currentSnap.mode === 'PAPER') {
            const posIdx = currentSnap.paper.positions.findIndex((p) => p.symbol.toUpperCase() === targetSymbol);
            if (posIdx >= 0) {
              const closedPos = currentSnap.paper.positions[posIdx]!;
              updateState((draft) => {
                const idx = draft.paper.positions.findIndex((p) => p.symbol.toUpperCase() === targetSymbol);
                if (idx >= 0) {
                  draft.paper.positions.splice(idx, 1);
                  draft.paper.usedMargin = Math.max(0, draft.paper.usedMargin - closedPos.margin);
                  draft.paper.canOpen = draft.paper.positions.length < draft.paper.n;
                }
              });
              verdictRecord.executed = true;
              hub.emit('log', {
                at: Date.now(),
                kind: 'execution',
                text: `Closed PAPER position for ${targetSymbol} upon CLOSE verdict`
              });
            }
          } else {
            const dispatchRes = await dispatch({
              kind: 'close',
              actor: 'system',
              symbol: targetSymbol,
              payload: { symbol: targetSymbol }
            });
            verdictRecord.executed = dispatchRes.ok;
            hub.emit('log', {
              at: Date.now(),
              kind: 'execution',
              text: `Dispatched close for ${targetSymbol}: ${dispatchRes.message}`
            });
          }
        } else if (isApproved && out.verdict.thesis) {
          const stopPrice = Number(out.verdict.thesis.stop);
          const tpPrice = out.verdict.thesis.tp ? Number(out.verdict.thesis.tp) : null;
          const leverage = currentSnap.trading?.values.maxLeverage ?? currentSnap.paper.maxLeverage ?? 5;
          const perOrder = resolveOwnerPerOrderUsdt(currentSnap.paper);
          const thesisOrderType = out.verdict.thesis.orderType ?? 'MARKET';
          const thesisLimit = out.verdict.thesis.limitPrice ?? null;
          const entryPrice = thesisOrderType === 'LIMIT_GTC' && thesisLimit
            ? Number(thesisLimit)
            : Number(currentSnap.tickers[targetSymbol]?.last ?? out.verdict.thesis.stop);
          const margin = Math.round(perOrder * 100) / 100;
          const qty = entryPrice > 0 ? Math.round(((margin * leverage) / entryPrice) * 1000) / 1000 : 1;
          const side = action === 'OPEN_LONG' ? 'LONG' : 'SHORT';

          if (perOrder <= 0) {
            verdictRecord.executed = false;
            verdictRecord.reason = 'Owner-derived per-order size is 0; refusing to substitute a fallback size.';
          } else if (currentSnap.mode === 'PAPER') {
            if (currentSnap.paper.positions.length < currentSnap.paper.n) {
              const positionId = `pos-${Date.now()}-${targetSymbol}`;

              verdictRecord.executed = true;
              verdictRecord.order = {
                positionId,
                status: 'filled',
                side,
                qty,
                entry: entryPrice,
                stop: stopPrice,
                tp: tpPrice,
                margin,
                leverage
              };

              const newPos: Position = {
                id: positionId,
                symbol: targetSymbol,
                side,
                qty,
                entry: entryPrice,
                stop: stopPrice,
                tp: tpPrice,
                margin,
                leverage,
                openedAt: Date.now(),
                mark: entryPrice,
                unrealizedPnl: 0,
                protectionStatus: 'confirmed',
                entryStatus: 'confirmed'
              };

              updateState((draft) => {
                draft.paper.positions.push(newPos);
                draft.paper.usedMargin += margin;
                draft.paper.canOpen = draft.paper.positions.length < draft.paper.n;
              });

              hub.emit('log', {
                at: Date.now(),
                kind: 'execution',
                text: `Opened PAPER ${side} ${qty} ${targetSymbol} at ${entryPrice} (SL: ${stopPrice}, TP: ${tpPrice ?? 'none'})`
              });
            } else {
              verdictRecord.executed = false;
              verdictRecord.reason = `Risk gate held: Max open positions (${currentSnap.paper.n}) reached.`;
            }
          } else {
            const dispatchRes = await dispatch({
              kind: 'open',
              actor: 'system',
              symbol: targetSymbol,
              payload: {
                symbol: targetSymbol,
                side,
                qty: String(qty),
                stop: String(stopPrice),
                tp: tpPrice ? String(tpPrice) : null,
                leverage,
                orderType: thesisOrderType,
                limitPrice: thesisLimit,
                entry: thesisLimit
              }
            });

            if (dispatchRes.ok) {
              const resData = (dispatchRes.data as any) ?? {};
              const orderState: string = resData.orderState ?? 'UNKNOWN';
              const isFilled = orderState === 'FILLED';
              const isPartial = orderState === 'PARTIAL';
              const isPending = ['ACCEPTED', 'PENDING', 'SUBMITTED', 'NEW', 'OPEN'].includes(orderState);
              const clientOrderId = resData.clientOrderId ?? `order-${Date.now()}`;
              verdictRecord.executed = isFilled || isPartial;
              verdictRecord.executionStatus = isFilled ? 'filled' : (isPartial ? 'partial' : undefined);
              if (isPending && !verdictRecord.executed) {
                verdictRecord.reason = `Limit order resting (${orderState}), not filled.`;
              }
              verdictRecord.order = {
                positionId: clientOrderId,
                status: isFilled ? 'filled' : (isPartial ? 'partial' : undefined),
                side,
                qty: resData.filledQty ? Number(resData.filledQty) : qty,
                entry: entryPrice,
                stop: stopPrice,
                tp: tpPrice,
                margin,
                leverage
              };
              hub.emit('log', {
                at: Date.now(),
                kind: 'execution',
                text: `Submitted ${currentSnap.mode} ${side} ${qty} ${targetSymbol} (SL: ${stopPrice}, TP: ${tpPrice ?? 'none'}) via ExecutionGateway: [${orderState}] ${dispatchRes.message}`
              });
            } else {
              verdictRecord.executed = false;
              verdictRecord.reason = `ExecutionGateway rejected order: ${dispatchRes.message}`;
              hub.emit('log', {
                at: Date.now(),
                kind: 'execution',
                text: `${currentSnap.mode} order for ${targetSymbol} rejected by gateway: ${dispatchRes.message}`
              });
            }
          }
        }
      } else {
        const failedRoles = out.roleResults.filter((r) => r.status !== 'completed');
        const details = failedRoles.map((r) => `${r.role}: ${r.errorReason ?? r.status}`).join('; ');
        verdictRecord = {
          id: `verdict-${Date.now()}`,
          symbol: targetSymbol,
          action: 'HOLD',
          riskDecision: 'INCOMPLETE',
          executed: false,
          reason: details ? `Deliberation incomplete (${details})` : 'Deliberation incomplete. No trade executed.',
          disagreement,
          camps: { bull, bear, neutral },
          example: false,
          at: Date.now()
        };
      }

      updateState((draft) => {
        draft.verdicts = [verdictRecord, ...draft.verdicts.slice(0, 49)];
        draft.lastVerdict = verdictRecord;
        if (!draft.logs) draft.logs = [];
        draft.logs.push({
          id: `log-${Date.now()}-verdict`,
          conversationId: 'office',
          at: Date.now(),
          kind: 'verdict',
          text: `[VERDICT] ${verdictRecord.action} on ${targetSymbol}: ${verdictRecord.reason}`
        });
        draft.logs = draft.logs.slice(-500);
        draft.lastCycle = {
          symbol: targetSymbol,
          durationMs: Date.now() - Number(cycleId.split('-')[1] || Date.now()),
          stage: out.status,
          verdict: verdictRecord.action,
          noTradeReason: verdictRecord.executed ? null : verdictRecord.reason,
          executionStatus: verdictRecord.executed ? 'filled' : null,
          reasonCode: verdictRecord.riskDecision,
          outcome: verdictRecord.action
        };

        if (out.jevReview && draft.jev) {
          draft.jev.lastDecision = {
            reviewId: out.jevReview.reviewId,
            reason: out.jevReview.reason,
            interpretation: {
              marketRegime: (out.jevReview as { market_regime?: string }).market_regime || 'EVALUATED'
            }
          };
          const tel = jevClient.telemetry();
          draft.jev.configHealth = tel.configHealth;
          draft.jev.remoteHealth = tel.remoteHealth;
          draft.jev.health = tel.remoteHealth === 'ok' ? 'healthy' : tel.configHealth === 'off' ? 'disabled' : tel.remoteHealth;
          draft.jev.metrics = {
            requests: tel.requests,
            success: tel.success,
            errors: tel.errors,
            timeouts: tel.timeouts,
            lastLatencyMs: tel.lastLatencyMs,
            lastModel: tel.lastModel,
            lastCost: tel.lastCost,
            lastInputTokens: null,
            lastError: tel.lastError
          };
        }
      });

      hub.emit('verdict', verdictRecord);
      hub.emit('state', snapshot());
      return { ok: true, message: `Cycle ${cycleId} finished with verdict ${verdictRecord.action}`, cycleId, verdict: verdictRecord };
    } catch (err) {
      return { ok: false, message: `Cycle failed: ${(err as Error).message}`, cycleId };
    }
  };

  const triggerCycle = async (
    symbol?: string,
    reason: CycleReason = 'owner'
  ): Promise<{ ok: boolean; message: string; cycleId?: string }> => {
    const snap = snapshot();
    if (snap.killed) {
      return { ok: false, message: 'Kill switch is ON. Trading is halted.' };
    }
    if (snap.auto.running) {
      return { ok: false, message: `A cycle is already running for ${snap.debate?.symbol ?? 'symbol'}` };
    }

    updateState((draft) => {
      draft.auto.running = true;
    });

    try {
      if (symbol) {
        const res = await executeSingleSymbolCycle(symbol.toUpperCase(), reason);
        return res;
      }

      // Multi-symbol automated evaluation:
      // 1. Inspect existing open positions first (for potential revalidation/close).
      const currentPos = snap.mode === 'PAPER'
        ? snap.paper.positions
        : (snap.venueAccount?.positions?.length ? snap.venueAccount.positions : snap.paper.positions);
      const openSymbols = [...new Set(currentPos.map((p) => p.symbol.toUpperCase()))];
      const maxN = snap.paper.n || 3;
      const freeSlots = Math.max(0, maxN - currentPos.length);

      // 2. Select candidates from active watchlist that do not already have open positions.
      const watchlistCandidates = snap.auto.symbols
        .map((s) => s.toUpperCase())
        .filter((s) => !openSymbols.includes(s));

      const symbolsToEvaluate: string[] = [];
      // Re-evaluate open positions first
      symbolsToEvaluate.push(...openSymbols);
      // If slots are available, evaluate candidate symbols
      if (freeSlots > 0 && watchlistCandidates.length > 0) {
        symbolsToEvaluate.push(...watchlistCandidates.slice(0, Math.max(freeSlots, snap.auto.symbols.length)));
      } else if (symbolsToEvaluate.length === 0) {
        symbolsToEvaluate.push((snap.auto.symbols[0] ?? 'BTCUSDT').toUpperCase());
      }

      let lastResult: { ok: boolean; message: string; cycleId: string } | null = null;
      for (const targetSym of symbolsToEvaluate) {
        if (snapshot().killed) break;
        const curSnap = snapshot();
        const activePos = curSnap.mode === 'PAPER'
          ? curSnap.paper.positions
          : (curSnap.venueAccount?.positions ?? curSnap.paper.positions);
        const hasPosition = activePos.some((p) => p.symbol.toUpperCase() === targetSym);
        if (!hasPosition && activePos.length >= (curSnap.paper.n || 3)) {
          // All slots occupied; skip further entry scanning
          continue;
        }

        lastResult = await executeSingleSymbolCycle(targetSym, reason);
      }

      return lastResult ?? { ok: true, message: 'All watchlist symbols evaluated successfully.' };
    } finally {
      updateState((draft) => {
        draft.debate = null;
        draft.auto.running = false;
        draft.auto.lastCycleAt = Date.now();
        draft.auto.cycles += 1;
        if (draft.auto.on) {
          draft.auto.nextAt = Date.now() + draft.auto.intervalMin * 60 * 1000;
        }
      });
      hub.emit('state', snapshot());
    }
  };

  const extractCleanAgentReply = (raw: string): string => {
    if (!raw) return '';
    const trimmed = raw.trim();
    let candidate = trimmed;
    if (candidate.startsWith('```')) {
      candidate = candidate.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    }
    if (candidate.startsWith('{') && candidate.endsWith('}')) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object') {
          if (typeof parsed.reply === 'string' && parsed.reply) return parsed.reply;
          if (typeof parsed.text === 'string' && parsed.text) return parsed.text;
          if (typeof parsed.message === 'string' && parsed.message) return parsed.message;
          if (typeof parsed.content === 'string' && parsed.content) return parsed.content;
        }
      } catch {
        // Fall back to raw string if JSON parsing fails
      }
    }
    return raw;
  };

  const handleCommand = async (input: {
    text: string;
    agent?: string;
    clientRequestId?: string;
    conversationId?: string;
  }): Promise<{ ok: boolean; command?: string; reply?: string; error?: string }> => {
    const raw = input.text.trim();
    if (!raw) return { ok: false, error: 'empty command' };
    const cmd = raw.toLowerCase();
    const cleanCmd = cmd.replace(/^\//, '');
    const toAll = /^@all\s+/i.test(raw);
    const targetRole = input.agent ? resolveCanonicalRole(input.agent) : null;

    if (targetRole || toAll) {
      const roles: RoleId[] = targetRole ? [targetRole] : [...ROLE_IDS];
      const prompt = toAll ? raw.replace(/^@all\s+/i, '') : raw;
      const conversationId = input.conversationId || 'office';
      const deskSnapshot = buildLiveDeskChatContext(snapshot());
      const deskContext = `Live desk snapshot (informational only; not an execution command).\n${JSON.stringify(deskSnapshot, null, 2)}`;
      const outcomes = await Promise.allSettled(roles.map(async role => {
        const answer = await roleRunner.chat({
          cycleId: `chat-${randomUUID()}`,
          role,
          prompt,
          deskContext,
          configVersion: options.settings?.current().activeVersion ?? 1
        });
        return { role, answer: extractCleanAgentReply(String(answer)) };
      }));
      const results = outcomes.flatMap((item) => item.status === 'fulfilled' ? [item.value] : []);
      const failures = outcomes.length - results.length;
      updateState(draft => {
        const at = Date.now();
        if (!draft.roomHistory) draft.roomHistory = [];
        draft.roomHistory.push({
          id: randomUUID(), conversationId, at, from: 'owner',
          to: toAll ? 'all' : roles[0], text: prompt
        });
        for (const { role, answer } of results) {
          const chatList = draft.chats[role] ?? [];
          chatList.push(
            { from: 'user', text: prompt, at, conversationId, clientRequestId: input.clientRequestId },
            { from: role, text: answer, at: Date.now(), conversationId }
          );
          draft.chats[role] = chatList.slice(-50);
          draft.roomHistory.push({ id: randomUUID(), conversationId, at: Date.now(), from: role, to: 'owner', text: answer });
        }
        draft.roomHistory = draft.roomHistory.slice(-100);
      });
      if (options.chatService) {
        void options.chatService.recordMessage({
          conversationId,
          clientRequestId: input.clientRequestId,
          role: 'owner',
          text: prompt
        });
        for (const { role, answer } of results) {
          void options.chatService.recordMessage({
            conversationId,
            role,
            text: answer
          });
        }
      }
      return {
        ok: failures === 0,
        command: 'chat',
        reply: results.map(({ role, answer }) => `${role}: ${answer}`).join('\n\n') +
          (failures ? `\n${failures} agent(s) failed to reply.` : ''),
        error: failures ? `${failures} agent(s) failed to reply.` : undefined
      };
    }

    if (cleanCmd.startsWith('analyze ') || cleanCmd.startsWith('debate ')) {
      const sym = raw.split(/\s+/)[1]?.toUpperCase();
      if (!sym) {
        return { ok: false, error: 'Symbol required for analyze command' };
      }
      const snap = snapshot();
      if (snap.killed) {
        return { ok: false, error: 'Kill switch is ON. Release it first.' };
      }
      if (snap.auto.running) {
        return { ok: false, error: `A debate is already in progress for ${snap.debate?.symbol ?? 'symbol'}` };
      }
      void triggerCycle(sym, 'owner').catch(console.error);
      return { ok: true, command: 'analyze', reply: `Starting debate for ${sym}...` };
    }

    if (cleanCmd === 'status') {
      const snap = snapshot();
      const open = deskOpenPnl({
        mode: snap.mode,
        paperUnrealized: snap.paper.unrealized,
        venueUnrealized: snap.venueAccount?.unrealized ?? null,
        venueStatus: snap.venueAccount?.status ?? null
      });
      const realized = snap.financial.realizedPnl.availability === 'AVAILABLE' ? snap.financial.realizedPnl.value : null;
      return {
        ok: true,
        command: 'status',
        reply: formatStatusCard({
          mode: snap.mode,
          venue: snap.venue?.name ?? null,
          killed: snap.killed,
          paused: snap.paused,
          autoOn: snap.auto.on,
          autoIntervalMin: snap.auto.intervalMin,
          equity: snap.financial.equity.value ?? snap.paper.equity,
          balance: snap.financial.balance.value ?? snap.paper.balance,
          safetyNet: snap.paper.safetyNet,
          moneyTrade: snap.paper.moneyTrade,
          perOrder: snap.paper.perOrder,
          openPnl: open.value,
          pnlSource: open.source,
          realized,
          positions: snap.paper.positions.length,
          slots: snap.paper.n,
          freeSlots: snap.accountState?.freeSlots ?? Math.max(0, snap.paper.n - snap.paper.positions.length),
          dailyLossHit: snap.dailyLoss?.hit ?? false,
          dailyLossLimitPct: snap.dailyLoss?.limitPct ?? 10
        })
      };
    }

    if (cleanCmd === 'help') {
      return { ok: true, command: 'help', reply: HELP_TEXT };
    }

    if (cleanCmd === 'report' || cleanCmd.startsWith('report')) {
      const snap = snapshot();
      const open = deskOpenPnl({
        mode: snap.mode,
        paperUnrealized: snap.paper.unrealized,
        venueUnrealized: snap.venueAccount?.unrealized ?? null,
        venueStatus: snap.venueAccount?.status ?? null
      });
      const realized = snap.financial.realizedPnl.availability === 'AVAILABLE' ? snap.financial.realizedPnl.value : null;
      return {
        ok: true,
        command: 'report',
        reply: formatDeskReportText({
          at: Date.now(),
          mode: snap.mode,
          venue: snap.venue?.name ?? null,
          killed: snap.killed,
          equity: snap.financial.equity.value ?? snap.paper.equity,
          balance: snap.financial.balance.value ?? snap.paper.balance,
          safetyNet: snap.paper.safetyNet,
          moneyTrade: snap.paper.moneyTrade,
          dailyLossHit: snap.dailyLoss?.hit ?? false,
          dailyLossLimitPct: snap.dailyLoss?.limitPct ?? 10,
          positions: snap.paper.positions ?? [],
          openPnl: open.value,
          pnlSource: open.source,
          realized,
          autoOn: snap.auto.on,
          autoIntervalMin: snap.auto.intervalMin
        })
      };
    }

    if (cleanCmd === 'positions') {
      const snap = snapshot();
      return {
        ok: true,
        command: 'positions',
        reply: safe(formatPositionsCard({
          mode: snap.mode,
          positions: (snap.paper.positions ?? []).map((p) => ({
            symbol: p.symbol,
            side: p.side,
            leverage: p.leverage,
            qty: Number(p.qty) || 0,
            margin: Number(p.margin) || 0,
            entry: Number(p.entry) || 0,
            mark: Number(p.mark) || 0,
            stop: Number(p.stop) || 0,
            tp: p.tp,
            protectionStatus: p.protectionStatus,
            unrealizedPnl: Number(p.unrealizedPnl) || 0
          }))
        }))
      };
    }

    if (cleanCmd === 'scan') {
      const snap = snapshot();
      const ps = snap.paper.positions ?? [];
      const unprot = ps.filter(p => !p.stop || p.stop <= 0);
      const findings: string[] = [];
      if (unprot.length > 0) {
        findings.push(`ALERTS: ${unprot.length} position(s) missing stop loss!`);
      }
      if (snap.killed) {
        findings.push('ALERTS: Kill switch is currently engaged.');
      }
      return {
        ok: true,
        command: 'scan',
        reply: safe(formatScanCard(findings.map((line) => line.replace(/^ALERTS: /, '🚨 '))))
      };
    }

    if (cleanCmd === 'watchlist' || cleanCmd === 'tokens') {
      const snap = snapshot();
      return {
        ok: true,
        command: 'watchlist',
        reply: formatWatchlistCard(snap.watchlist, snap.auto.intervalMin)
      };
    }

    if (cleanCmd === 'scorecard' || cleanCmd === 'scores') {
      const snap = snapshot();
      const sc = snap.scorecard ?? [];
      return { ok: true, command: 'scorecard', reply: formatScorecardCard(sc) };
    }

    if (cleanCmd === 'lessons' || cleanCmd === 'learnings') {
      const snap = snapshot();
      const ls = snap.lessons ?? [];
      return { ok: true, command: 'lessons', reply: formatLessonsCard(ls.slice(-5)) };
    }

    if (cleanCmd === 'kill' || cleanCmd.startsWith('kill')) {
      const confirm = /confirm|yes/i.test(raw);
      if (!confirm) {
        return {
          ok: true,
          command: 'kill',
          reply: 'This flattens every position and stops the desk until the local Owner releases it with the Office OFF button or npm run unkill -- --yes. Send "/kill confirm" to do it.'
        };
      }
      const res = await dispatch({ kind: 'kill', actor: 'owner_channel' });
      return {
        ok: res.ok,
        command: 'kill',
        reply: safe(`KILL SWITCH ON. ${res.message}. Release only on the desk computer: the local Office OFF button or npm run unkill -- --yes.`)
      };
    }

    if (cleanCmd === 'pause') {
      updateState((d) => { d.paused = true; });
      return { ok: true, command: 'pause', reply: 'Desk paused.' };
    }
    if (cleanCmd === 'resume') {
      updateState((d) => { d.paused = false; });
      return { ok: true, command: 'resume', reply: 'Desk resumed.' };
    }

    if (cleanCmd.startsWith('close')) {
      const parts = raw.split(/\s+/);
      const target = (parts[1] ?? 'all').toUpperCase();
      const currentSnap = snapshot();

      if (currentSnap.mode !== 'PAPER') {
        const dispatchRes = await dispatch({
          kind: 'close',
          actor: 'local_owner',
          symbol: target
        });
        return {
          ok: dispatchRes.ok,
          command: 'close',
          reply: dispatchRes.message,
          error: dispatchRes.ok ? undefined : dispatchRes.message
        };
      }

      let closedCount = 0;
      updateState((draft) => {
        if (target === 'ALL') {
          closedCount = draft.paper.positions.length;
          for (const pos of draft.paper.positions) {
            draft.paper.closed.push({
              id: `closed-${Date.now()}-${pos.symbol}`,
              symbol: pos.symbol,
              side: pos.side,
              qty: pos.qty,
              entry: pos.entry,
              exit: pos.mark,
              realizedPnl: pos.unrealizedPnl,
              reason: 'Command Close All',
              closedAt: Date.now()
            });
          }
          draft.paper.positions = [];
          draft.paper.usedMargin = 0;
          draft.paper.canOpen = true;
        } else {
          const remaining: Position[] = [];
          for (const pos of draft.paper.positions) {
            if (pos.symbol === target) {
              closedCount += 1;
              draft.paper.closed.push({
                id: `closed-${Date.now()}-${pos.symbol}`,
                symbol: pos.symbol,
                side: pos.side,
                qty: pos.qty,
                entry: pos.entry,
                exit: pos.mark,
                realizedPnl: pos.unrealizedPnl,
                reason: `Command Close ${target}`,
                closedAt: Date.now()
              });
              draft.paper.usedMargin = Math.max(0, draft.paper.usedMargin - pos.margin);
            } else {
              remaining.push(pos);
            }
          }
          draft.paper.positions = remaining;
          draft.paper.canOpen = remaining.length < draft.paper.n;
        }
      });
      hub.emit('state', snapshot());
      return { ok: true, command: 'close', reply: `Closed ${closedCount} position(s).` };
    }

    if (/^(?:open|buy|sell)\b/i.test(cleanCmd) && !/^open\s+orders?\b/i.test(cleanCmd)) {
      const stopMatch = raw.match(/--stop(?:=|\s+)(\d+(?:\.\d+)?)/i);
      const tpMatch = raw.match(/--tp(?:=|\s+)(\d+(?:\.\d+)?)/i);
      const qtyMatch = raw.match(/--qty(?:=|\s+)(\d+(?:\.\d+)?)/i);
      const levMatch = raw.match(/(?:--leverage(?:=|\s+)|-l\s+)(\d+)/i) ?? raw.match(/\b(\d+)x\b/i);

      if (!stopMatch) {
        return {
          ok: false,
          command: 'open',
          error: 'Stop loss is required for open command. Usage: open <symbol> <LONG|SHORT> --stop <price> [--tp <price>]'
        };
      }
      const stopPrice = Number(stopMatch[1]);
      if (!Number.isFinite(stopPrice) || stopPrice <= 0) {
        return {
          ok: false,
          command: 'open',
          error: 'Invalid stop price. Must be a positive number.'
        };
      }

      const positional = cleanCmd
        .replace(/--stop(?:=|\s+)\S+/gi, '')
        .replace(/--tp(?:=|\s+)\S+/gi, '')
        .replace(/--qty(?:=|\s+)\S+/gi, '')
        .replace(/(?:--leverage(?:=|\s+)|-l\s+)\S+/gi, '')
        .replace(/\b\d+x\b/gi, '')
        .trim()
        .split(/\s+/);

      let side: 'LONG' | 'SHORT' | null = null;
      let targetSym = '';

      if (positional[0] === 'buy') {
        side = 'LONG';
        targetSym = positional[1] ?? '';
      } else if (positional[0] === 'sell') {
        side = 'SHORT';
        targetSym = positional[1] ?? '';
      } else if (positional[0] === 'open') {
        const arg1 = (positional[1] ?? '').toUpperCase();
        const arg2 = (positional[2] ?? '').toUpperCase();
        if (arg1 === 'LONG' || arg1 === 'SHORT') {
          side = arg1;
          targetSym = arg2;
        } else if (arg2 === 'LONG' || arg2 === 'SHORT') {
          side = arg2;
          targetSym = arg1;
        }
      }

      if (!side || !targetSym) {
        return {
          ok: false,
          command: 'open',
          error: 'Usage: open <symbol> <LONG|SHORT> --stop <price> [--tp <price>]'
        };
      }

      const symbol = normSymbol(targetSym);
      const snap = snapshot();
      if (snap.killed) {
        return { ok: false, command: 'open', error: 'Kill switch is ON. Release it first.' };
      }

      const dispatchRes = await dispatch({
        kind: 'open',
        actor: 'local_owner',
        symbol,
        payload: {
          symbol,
          side,
          stop: stopPrice,
          tp: tpMatch ? Number(tpMatch[1]) : null,
          qty: qtyMatch ? qtyMatch[1] : undefined,
          leverage: levMatch ? Number(levMatch[1]) : undefined
        }
      });

      return {
        ok: dispatchRes.ok,
        command: 'open',
        reply: dispatchRes.message,
        error: dispatchRes.ok ? undefined : dispatchRes.message
      };
    }

    const balanceMatch = raw.replace(/^\//, '').match(/^(?:set\s+)?(?:balance|saldo)\s*(?:=|to|:)?\s*(\d+(?:\.\d+)?)/i);
    if (balanceMatch) {
      const val = Number(balanceMatch[1]);
      if (Number.isFinite(val) && val >= 0) {
        updateState((d) => {
          d.paper.balance = val;
          d.paper.equity = val + (d.paper.unrealized ?? 0);
          d.financial.balance = availableFinancialField(val);
          d.financial.equity = availableFinancialField(val + (d.paper.unrealized ?? 0));
          d.financial.availableBalance = availableFinancialField(val);
          d.venueAccount = {
            equity: val,
            available: val,
            unrealized: d.paper.unrealized ?? 0,
            at: Date.now(),
            status: 'confirmed',
            positions: d.paper.positions.map((p) => ({ symbol: p.symbol, side: p.side, qty: p.qty }))
          };
          const mt = Math.round(Math.max(0, val - d.paper.safetyNet) * 100) / 100;
          d.paper.moneyTrade = mt;
          d.paper.perOrder = Math.floor((mt / d.paper.n) * 100) / 100;
          d.paper.canOpen = d.paper.perOrder > 0 && d.paper.positions.length < d.paper.n;
          if (d.accountState) {
            d.accountState.hasTradableCapital = d.paper.canOpen;
            d.accountState.canOpenNewSlot = d.paper.canOpen;
          }
        });
        if (options.settings) {
          void options.settings
            .apply({ paper: { balance: val } }, options.settings.current().activeVersion)
            .catch(() => {});
        }
        hub.emit('state', snapshot());
        return { ok: true, command: 'set_balance', reply: `Balance set to ${val} USDT. Money trade: ${snapshot().paper.moneyTrade} USDT.` };
      }
      return { ok: false, error: 'Balance must be a non-negative number.' };
    }

    const safetyMatch = raw.match(/^(?:set\s+)?(?:safety(?:\s*net)?|sn)\s*(?:=|to|:)?\s*(\d+(?:\.\d+)?)/i);
    if (safetyMatch) {
      const val = Number(safetyMatch[1]);
      if (Number.isFinite(val) && val >= 0) {
        updateState((d) => {
          d.paper.safetyNet = val;
          if (d.trading) {
            d.trading.values.safetyNet = val;
          }
          const mt = Math.round(Math.max(0, d.paper.balance - val) * 100) / 100;
          d.paper.moneyTrade = mt;
          d.paper.perOrder = Math.floor((mt / d.paper.n) * 100) / 100;
          d.paper.canOpen = d.paper.perOrder > 0 && d.paper.positions.length < d.paper.n;
          if (d.accountState) {
            d.accountState.hasTradableCapital = d.paper.canOpen;
            d.accountState.canOpenNewSlot = d.paper.canOpen;
          }
        });
        if (options.settings) {
          void options.settings
            .apply(
              {
                paper: { safetyNet: val },
                trading: { safetyNet: val }
              },
              options.settings.current().activeVersion
            )
            .catch(() => {});
        }
        hub.emit('state', snapshot());
        return { ok: true, command: 'set_safety', reply: `Safety net set to ${val} USDT. Money trade: ${snapshot().paper.moneyTrade} USDT.` };
      }
      return { ok: false, error: 'Safety net must be a non-negative number.' };
    }

    const nMatch = raw.match(/^(?:set\s+)?(?:n|orders?|open\s+orders?|order)\s*(?:=|to|:)?\s*(\d+)\b/i);
    if (nMatch) {
      const count = Number(nMatch[1]);
      if (Number.isInteger(count) && count >= 1 && count <= 100) {
        updateState((d) => {
          d.paper.n = count;
          if (d.trading) {
            d.trading.values.maxPositions = count;
          }
          const mt = Math.round(Math.max(0, d.paper.balance - d.paper.safetyNet) * 100) / 100;
          d.paper.moneyTrade = mt;
          d.paper.perOrder = Math.floor((mt / count) * 100) / 100;
          d.paper.canOpen = d.paper.perOrder > 0 && d.paper.positions.length < count;
          if (d.accountState) {
            d.accountState.maxPositions = count;
            d.accountState.freeSlots = Math.max(0, count - d.paper.positions.length);
            d.accountState.hasTradableCapital = d.paper.canOpen;
            d.accountState.canOpenNewSlot = d.paper.canOpen;
          }
        });
        if (options.settings) {
          void options.settings
            .apply(
              {
                paper: { n: count },
                trading: { maxPositions: count }
              },
              options.settings.current().activeVersion
            )
            .catch(() => {});
        }
        hub.emit('state', snapshot());
        return { ok: true, command: 'set_n', reply: `Slots N set to ${count}.` };
      }
      return { ok: false, error: 'N must be an integer between 1 and 100.' };
    }

    const leverageMatch = raw.replace(/^\//, '').match(/^(?:set\s+)?(?:leverage|lev|pengali)\s*(?:=|to|:)?\s*(\d+)(?:x)?\b/i);
    if (leverageMatch) {
      const val = Number(leverageMatch[1]);
      if (Number.isInteger(val) && val >= 1 && val <= 100) {
        updateState((d) => {
          d.paper.maxLeverage = val;
          if (d.trading) {
            d.trading.values.maxLeverage = val;
          }
        });
        if (options.settings) {
          void options.settings
            .apply(
              {
                trading: { maxLeverage: val }
              },
              options.settings.current().activeVersion
            )
            .catch(() => {});
        }
        if (options.secrets) {
          options.secrets.writeSecrets({
            MAX_LEVERAGE: String(val),
            MAINNET_DESK_MAX_LEVERAGE: String(val)
          });
        }
        hub.emit('state', snapshot());
        return { ok: true, command: 'set_leverage', reply: `Max leverage set to ${val}x.` };
      }
      return { ok: false, error: 'Leverage must be an integer between 1 and 100.' };
    }

    const profileMatch = raw.replace(/^\//, '').match(/^(?:set\s+)?profile\s+(\S+)$/i);
    if (profileMatch) {
      const prof = profileMatch[1].toLowerCase();
      if ((TRADING_PROFILES as readonly string[]).includes(prof as any)) {
        const snap = snapshot();
        const baseVals = snap.trading?.values ?? DEFAULT_TRADING_SETTINGS;
        const nextVals = (TRADING_PRESET_IDS as readonly string[]).includes(prof as any)
          ? resolveTradingPresetValues(prof as TradingPresetId, baseVals)
          : baseVals;

        updateState((d) => {
          if (d.trading) {
            d.trading.profile = prof as TradingProfile;
            d.trading.values = { ...d.trading.values, ...nextVals };
          }
          if (nextVals.maxLeverage) d.paper.maxLeverage = nextVals.maxLeverage;
        });
        if (options.settings) {
          void options.settings
            .apply(
              {
                tradingProfile: prof as TradingProfile,
                trading: nextVals
              },
              options.settings.current().activeVersion
            )
            .catch(() => {});
        }
        if (options.secrets && nextVals.maxLeverage) {
          options.secrets.writeSecrets({
            MAX_LEVERAGE: String(nextVals.maxLeverage),
            MAINNET_DESK_MAX_LEVERAGE: String(nextVals.maxLeverage)
          });
        }
        hub.emit('state', snapshot());
        return { ok: true, command: 'set_profile', reply: `Trading profile set to ${prof} (leverage ${nextVals.maxLeverage}x, SL ${nextVals.defaultStopPct}%, TP ${nextVals.takeProfitPct}%).` };
      }
      return { ok: false, error: `Profile must be one of: ${TRADING_PROFILES.join(', ')}` };
    }

    if (cleanCmd === 'sync' || cleanCmd === 'sync balance' || cleanCmd === 'sync to book' || cleanCmd === 'refresh balance') {
      const snap = snapshot();
      hub.emit('state', snap);
      return { ok: true, command: 'sync', reply: `Synced book. Balance: ${snap.paper.balance} USDT, Safety net: ${snap.paper.safetyNet} USDT, Money trade: ${snap.paper.moneyTrade} USDT.` };
    }

    return {
      ok: false,
      command: cmd,
      error: `Unsupported command: "${safe(raw)}". Type "help" for available commands.`
    };
  };

  const stop = async (): Promise<void> => {
    if (autoTimer) {
      clearTimeout(autoTimer);
      autoTimer = null;
    }
    await marketHub.stop();
  };

  const dispatch = async (input: OfficeCommand): Promise<OfficeReply> => {
    if (options.dispatcher) {
      return options.dispatcher(input, snapshot());
    }
    if (input.kind === 'kill') {
      if (env.KILL_SWITCH_FILE) {
        try {
          writeKill(env.KILL_SWITCH_FILE, { at: Date.now(), reason: 'Owner kill switch', source: 'office' });
        } catch {}
      }
      updateState((draft) => {
        draft.killed = true;
        draft.auto.on = false;
      });
      return {
        ok: true,
        code: 'OK',
        message: 'Local halt latch engaged.'
      };
    }
    if (input.kind === 'unkill') {
      if (input.actor !== 'local_owner') {
        return {
          ok: false,
          code: 'UNAUTHORIZED',
          message: 'Only local Owner may release the kill switch.'
        };
      }
      const killFile = env.KILL_SWITCH_FILE;
      if (killFile) {
        try { clearKill(killFile); } catch {}
        if (readKill(killFile)) {
          return {
            ok: false,
            code: 'REJECTED',
            message: 'Release failed: persisted halt latch remains active.'
          };
        }
      }
      updateState((draft) => {
        draft.killed = false;
      });
      return {
        ok: true,
        code: 'OK',
        message: 'Local halt latch released; Auto remains OFF.'
      };
    }
    if (input.kind === 'open') {
      const p = input.payload ?? {};
      const symbol = String(p.symbol ?? input.symbol ?? 'BTCUSDT').toUpperCase();
      const side = (p.side as 'LONG' | 'SHORT') ?? 'LONG';
      const qty = Number(p.qty ?? '0.01');
      const stop = p.stop ? Number(p.stop) : null;
      const tp = p.tp ? Number(p.tp) : null;
      const leverage = Number(p.leverage ?? state.trading?.values.maxLeverage ?? state.paper.maxLeverage ?? 5);
      const entry = Number(p.entry ?? 65000);
      const margin = (qty * entry) / leverage;

      updateState((draft) => {
        draft.paper.positions.push({
          id: `pos-${Date.now()}`,
          symbol,
          side,
          qty,
          entry,
          stop: stop ?? (side === 'LONG' ? entry * 0.95 : entry * 1.05),
          tp,
          margin,
          leverage,
          openedAt: Date.now(),
          mark: entry,
          unrealizedPnl: 0,
          protectionStatus: 'confirmed',
          entryStatus: 'confirmed'
        });
        draft.paper.usedMargin += margin;
        draft.paper.canOpen = draft.paper.positions.length < draft.paper.n;
      });

      return {
        ok: true,
        code: 'OK',
        message: 'Order filled in paper mode',
        data: {
          clientOrderId: (p.clientOrderId as string) ?? `ord-paper-${Date.now()}`,
          orderState: 'FILLED',
          filledQty: String(qty),
          protectionState: 'VERIFIED'
        }
      };
    }

    if (input.kind === 'close') {
      const sym = String(input.symbol ?? input.payload?.symbol ?? '').toUpperCase();
      let closedCount = 0;
      updateState((draft) => {
        if (sym === 'ALL') {
          for (const pos of draft.paper?.positions ?? []) {
            draft.paper.closed.push({
              id: `closed-${Date.now()}-${pos.symbol}`,
              symbol: pos.symbol,
              side: pos.side,
              qty: pos.qty,
              entry: pos.entry,
              exit: pos.mark,
              realizedPnl: pos.unrealizedPnl,
              reason: (input.payload?.cause as string) ?? 'Manual Close All',
              closedAt: Date.now()
            });
            closedCount += 1;
          }
          draft.paper.positions = [];
          draft.paper.usedMargin = 0;
          draft.paper.canOpen = true;
        } else {
          const remaining: Position[] = [];
          for (const pos of draft.paper?.positions ?? []) {
            if (pos.symbol.toUpperCase() === sym) {
              draft.paper.closed.push({
                id: `closed-${Date.now()}-${pos.symbol}`,
                symbol: pos.symbol,
                side: pos.side,
                qty: pos.qty,
                entry: pos.entry,
                exit: pos.mark,
                realizedPnl: pos.unrealizedPnl,
                reason: (input.payload?.cause as string) ?? `Manual Close ${sym}`,
                closedAt: Date.now()
              });
              draft.paper.usedMargin = Math.max(0, (draft.paper.usedMargin ?? 0) - pos.margin);
              closedCount += 1;
            } else {
              remaining.push(pos);
            }
          }
          draft.paper.positions = remaining;
          draft.paper.canOpen = remaining.length < draft.paper.n;
        }
      });
      return {
        ok: true,
        code: 'OK',
        message: `Closed ${closedCount} position(s) for ${sym}`,
        data: { orderState: 'CLOSED' }
      };
    }

    if (input.kind === 'cancel_entry') {
      return {
        ok: true,
        code: 'OK',
        message: 'Order cancelled in paper mode',
        data: { state: 'CANCELLED' }
      };
    }

    if (input.kind === 'scan') {
      return {
        ok: true,
        code: 'OK',
        message: 'All positions healthy and protected.',
        data: { findings: [] }
      };
    }

    if (input.kind === 'command') {
      const res = await handleCommand({
        text: input.text ?? '',
        agent: input.agent,
        clientRequestId: input.clientRequestId
      });
      return {
        ok: res.ok,
        code: res.ok ? 'OK' : 'REJECTED',
        message: res.reply ?? res.error ?? 'Command executed'
      };
    }

    return {
      ok: false,
      code: 'SERVICE_UNAVAILABLE',
      message: `Runtime service for "${input.kind}" is not configured yet; refusing to fabricate results.`
    };
  };

  return {
    hub,
    marketHub,
    roleRunner,
    cycleRunner,
    snapshot,
    updateState,
    triggerCycle,
    updateAutoSettings,
    handleCommand,
    reportsService: options.reportsService,
    stop,
    dispatch
  };
}

export async function startReplacementServer(
  env: NodeJS.ProcessEnv = process.env
): Promise<{ server: HttpServer; runtime: ReplacementRuntimeHandle } | null> {
  registerDiagnosticSecrets(env);
  let startup: StartupEnvCheck;
  try {
    startup = validateStartupEnvironment(env);
  } catch (error) {
    console.error(`[trading-agent-mpu-gandring] ${safe((error as Error).message)}`);
    recordDiagnostic({
      source: 'startup',
      category: 'SESSION',
      eventName: 'startup.configuration_failed',
      level: 'ERROR',
      status: 'failed',
      message: 'Configuration validation failed',
      details: { error }
    });
    process.exitCode = error instanceof StartupValidationError ? error.exitCode : 1;
    return null;
  }

  const sessionLogger = getSessionLogger();
  sessionLogger?.updateContext({
    mode: startup.tradingMode,
    appMode: startup.appMode.toUpperCase(),
    exchange: startup.venue,
    providers: {},
    configFingerprint: configurationFingerprint(startup)
  });

  const dataDir = path.resolve('.mpu-gandring', 'rebirth');
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch {
    // Directory may already exist
  }
  const store = await RuntimeStore.open(path.join(dataDir, 'runtime.sqlite'));
  const secrets = new SecretStore({ envFile: '.env', allowWrite: true });
  const authority = new ExecutionAuthorityService(store);
  const accounts = await AccountRegistry.open(store, authority);
  const settings = await SettingsService.initialize(store, secrets);

  let venueAdapter: import('./execution/adapters/types.js').VenueAdapter;
  let accountRef: string;
  let nativeBalance: NativeBalance;
  let nativePositions: NativePosition[] = [];

  if (startup.network) {
    const credentialRef = `${startup.venue}:${startup.network}`;
    const readSecret = async () => {
      const names = venueCredentialEnvNames(startup.venue!, startup.network!);
      const envMap = secrets.readEnvMap();
      const key = (envMap[names.key] ?? env[names.key] ?? '').trim();
      const secret = (envMap[names.secret] ?? env[names.secret] ?? '').trim();
      const passphrase = names.passphrase ? (envMap[names.passphrase] ?? env[names.passphrase] ?? '').trim() : null;
      const verifiedAgentAddress = (
        envMap.ASTER_AGENT_WITHDRAW_OFF_VERIFIED ??
        env.ASTER_AGENT_WITHDRAW_OFF_VERIFIED ??
        envMap.ASTER_TESTNET_AGENT_WITHDRAW_OFF_VERIFIED ??
        env.ASTER_TESTNET_AGENT_WITHDRAW_OFF_VERIFIED ??
        ''
      ).trim() || null;
      return { key, secret, passphrase, verifiedAgentAddress };
    };

    venueAdapter = getVenueAdapter(startup.venue!, {
      network: startup.network,
      credentialRef,
      fetchImpl: fetch,
      readSecret
    });

    let perm: PermissionEvidence;
    try {
      perm = await venueAdapter.permissions();
      assertLivePermissionEvidence(perm);
    } catch (err) {
      const msg = safe((err as Error).message);
      recordDiagnostic({
        source: 'startup',
        category: 'SESSION',
        eventName: 'startup.permission_refused',
        status: 'refused',
        level: 'ERROR',
        message: msg
      });
      console.error(`[trading-agent-mpu-gandring] ${startup.tradingMode} refused at startup: ${msg}`);
      process.exitCode = 2;
      return null;
    }
    console.log(`[trading-agent-mpu-gandring] ${startup.tradingMode} verified on ${startup.venue} (${startup.network}): ${perm.detail}`);

    try {
      const identity = await venueAdapter.accountIdentity();
      nativeBalance = await venueAdapter.balance();
      nativePositions = await venueAdapter.positions();
      const accountContext = await accounts.register({
        venue: startup.venue!,
        network: startup.network!,
        mode: startup.tradingMode,
        nativeIdentity: identity.publicAccountId,
        subaccountRef: identity.subaccountRef ?? null
      });
      accountRef = accountContext.accountRef;
      await authority.claim(accountRef);
    } catch (err) {
      const msg = safe((err as Error).message);
      console.error(`[trading-agent-mpu-gandring] ${startup.tradingMode} account read failed: ${msg}`);
      process.exitCode = 2;
      return null;
    }
  } else {
    const paperVenue = new PaperVenue({
      initialBalance: String(settings.current().effective.paper.balance ?? 1000)
    });
    venueAdapter = paperVenue;
    const identity = await venueAdapter.accountIdentity();
    const accountContext = await accounts.register({
      accountRef: 'acct-paper-local',
      venue: (startup.venue ?? 'bybit') as VenueId,
      network: 'testnet',
      mode: 'PAPER',
      nativeIdentity: 'paper-local',
      subaccountRef: null
    });
    accountRef = accountContext.accountRef;
    await authority.claim(accountRef);
    nativeBalance = await venueAdapter.balance();
    nativePositions = await venueAdapter.positions();
  }

  const transport = createTransportFromAdapter(venueAdapter);
  const marketHub = new BybitMarketHub({
    retainedSymbolsProvider: () => settings.current().effective.watchlist
  });

  const gateway = new ExecutionGateway({
    store,
    authority,
    getTransport: () => transport,
    getAccountPolicy: () => {
      const snap = settings.current();
      const equityBasis = Number(
        runtimeRef?.snapshot().paper.equity ??
        runtimeRef?.snapshot().paper.balance ??
        snap.effective.paper.balance ??
        0
      );
      return {
        activeConfigVersion: snap.activeVersion,
        safetyNetUsdt: String(snap.effective.trading.safetyNet),
        maxPositions: snap.effective.trading.maxPositions,
        dailyLossCapUsdt: convertDailyLossPctToUsdt(equityBasis, snap.effective.trading.dailyLossLimitPct),
        minEntryConfidencePct: snap.effective.trading.minEntryConfidencePct
      };
    },
    readFreshMarket: (symbol) => marketHub.snapshot(symbol)
  });

  const killFile = env.KILL_SWITCH_FILE || DEFAULT_KILL_FILE;
  const killRec = readKill(killFile);
  const authHalt = await authority.current(accountRef);
  const persistedHalt = Boolean(killRec) || Boolean(authHalt?.haltLatched);
  if (persistedHalt) {
    gateway.restorePersistedHalt(accountRef);
    if (killRec && !authHalt?.haltLatched) {
      await authority.setHalt(accountRef, true, 'startup', killRec.reason);
    }
  }
  let startupRecon: Awaited<ReturnType<typeof gateway.reconcile>> | null = null;
  if (startup.tradingMode !== 'PAPER') {
    startupRecon = await gateway.reconcile(accountRef).catch(() => null);
  }

  const equityNum = nativeBalance.equity !== null ? Number(nativeBalance.equity) : null;
  const availNum = nativeBalance.available !== null ? Number(nativeBalance.available) : null;
  const realizedNum = nativeBalance.realizedDailyPnl !== null ? Number(nativeBalance.realizedDailyPnl) : null;

  const initialFinancial = {
    balance: equityNum !== null ? availableFinancialField(equityNum) : unavailableFinancialField(),
    equity: equityNum !== null ? availableFinancialField(equityNum) : unavailableFinancialField(),
    availableBalance: availNum !== null ? availableFinancialField(availNum) : unavailableFinancialField(),
    realizedPnl: realizedNum !== null ? availableFinancialField(realizedNum) : unavailableFinancialField(),
    unrealizedPnl: unavailableFinancialField()
  };

  const initialPositions: Position[] = nativePositions.map((p, idx) => {
    const qty = Number(p.qty);
    const entry = Number(p.entryPrice);
    const leverage = p.leverage ?? 5;
    const margin = (qty * entry) / leverage;
    const shown = verifiedVenueStop({
      protectionState: startupRecon?.protection[p.positionKey],
      stopPrice: startupRecon?.verifiedStops[p.positionKey]
    });
    return {
      id: `pos-${p.symbol}-${idx}`,
      symbol: p.symbol,
      side: p.side,
      qty,
      entry,
      stop: shown.stop,
      tp: null,
      mark: entry,
      unrealizedPnl: p.unrealizedPnl ? Number(p.unrealizedPnl) : 0,
      leverage,
      margin,
      openedAt: p.observedAt,
      protectionStatus: shown.protectionStatus,
      entryStatus: 'confirmed'
    };
  });

  const snapSettings = settings.current();
  const initialIdentity = {
    savedVersion: snapSettings.savedVersion,
    activeVersion: snapSettings.activeVersion,
    appliedAt: snapSettings.appliedAt ? new Date(snapSettings.appliedAt).toISOString() : null,
    applyStatus: 'ACTIVE' as const,
    reason: 'Durable settings loaded',
    lastAcknowledgedConfigVersion: settings.lastAcknowledgedRemoteVersion()
  };

  const venueId = (startup.venue ?? 'bybit') as VenueId;
  const isDex = ['aster', 'dydx', 'hyperliquid', 'orderly', 'paradex'].includes(venueId);
  const initialVenue = {
    name: venueId,
    label: venueId.toUpperCase(),
    kind: (isDex ? 'DEX' : 'CEX') as 'CEX' | 'DEX',
    experimental: venueId !== 'bybit'
  };

  let runtimeRef: ReplacementRuntimeHandle | null = null;

  const dispatcher = async (input: OfficeCommand, state: OfficeState): Promise<OfficeReply> => {
    if (input.kind === 'kill') {
      runtimeRef?.updateState((draft) => {
        draft.killed = true;
        draft.auto.on = false;
      });
      try {
        writeKill(env.KILL_SWITCH_FILE || DEFAULT_KILL_FILE, {
          at: Date.now(),
          reason: 'Owner kill switch',
          source: 'office'
        });
      } catch {}
      const haltRes = await gateway.halt({
        requestId: `halt-${Date.now()}`,
        source: input.actor,
        policy: 'HALT_AND_FLATTEN',
        accountRef
      });
      return {
        ok: haltRes.halted,
        code: 'OK',
        message: 'Local halt latch engaged. Auto turned OFF. Orders cancelled and positions flattened.',
        data: {
          flatten: haltRes.flatten,
          entryCancellation: haltRes.entryCancellation,
          persisted: haltRes.persisted
        }
      };
    }

    if (input.kind === 'unkill') {
      if (input.actor !== 'local_owner') {
        return {
          ok: false,
          code: 'UNAUTHORIZED',
          message: 'Only local Owner may release the kill switch.'
        };
      }
      const killFile = env.KILL_SWITCH_FILE || DEFAULT_KILL_FILE;
      try { clearKill(killFile); } catch {}
      await authority.setHalt(accountRef, false, 'local_owner', 'Owner released kill switch');
      const persisted = await authority.current(accountRef);
      if (persisted?.haltLatched || readKill(killFile)) {
        return {
          ok: false,
          code: 'REJECTED',
          message: 'Release failed: persisted halt latch remains active.'
        };
      }
      gateway.clearInMemoryHalt(accountRef);
      runtimeRef?.updateState((draft) => {
        draft.killed = false;
      });
      return {
        ok: true,
        code: 'OK',
        message: 'Local halt latch released; Auto remains OFF.'
      };
    }

    if (input.kind === 'open') {
      const p = input.payload ?? {};
      const symbol = String(p.symbol ?? input.symbol ?? '').toUpperCase();
      const side = (p.side as 'LONG' | 'SHORT') ?? 'LONG';
      const qty = String(p.qty ?? '0');
      const stop = p.stop ? String(p.stop) : null;
      const tp = p.tp ? String(p.tp) : null;
      const leverage = Number(p.leverage ?? state.trading?.values.maxLeverage ?? state.paper.maxLeverage ?? 5);
      const orderType = (p.orderType as 'MARKET' | 'LIMIT_GTC') ?? 'MARKET';
      const limitPrice = p.limitPrice != null ? String(p.limitPrice) : (p.entry != null ? String(p.entry) : null);

      const receipt = await gateway.submit({
        intentId: `intent-${Date.now()}`,
        accountRef,
        configVersion: settings.current().activeVersion,
        authorityEpoch: (await authority.current(accountRef))?.writerEpoch ?? 1,
        action: 'OPEN',
        symbol,
        side,
        quantity: qty,
        entry: limitPrice,
        stop,
        tp,
        leverage,
        thesisId: null,
        orderType,
        limitPrice
      });

      return {
        ok: receipt.orderState !== 'REJECTED',
        code: receipt.orderState === 'FILLED' ? 'OK' : receipt.orderState === 'REJECTED' ? 'REJECTED' : 'ACCEPTED',
        message: receipt.reason ?? `Order ${receipt.orderState}`,
        data: {
          clientOrderId: receipt.clientOrderId,
          orderState: receipt.orderState,
          filledQty: receipt.filledQty,
          protectionState: receipt.protectionState
        }
      };
    }

    if (input.kind === 'close') {
      const symbol = String(input.symbol ?? input.payload?.symbol ?? '').toUpperCase();
      const positions = await transport.positions();
      const targetPos = symbol === 'ALL'
        ? positions
        : positions.filter((p) => p.symbol.toUpperCase() === symbol);

      if (targetPos.length === 0) {
        if (state.mode === 'PAPER') {
          runtimeRef?.updateState((draft) => {
            if (symbol === 'ALL') {
              draft.paper.positions = [];
              draft.paper.canOpen = true;
            } else {
              draft.paper.positions = draft.paper.positions.filter((p) => p.symbol !== symbol);
              draft.paper.canOpen = draft.paper.positions.length < draft.paper.n;
            }
          });
          return {
            ok: true,
            code: 'OK',
            message: `Position closed for ${symbol}`,
            data: { orderState: 'CLOSED' }
          };
        }
        return {
          ok: false,
          code: 'INVALID_INPUT',
          message: `No open position found for ${symbol}`
        };
      }

      const receipts = [];
      for (const pos of targetPos) {
        const r = await gateway.close({
          intentId: `close-${Date.now()}-${pos.symbol}`,
          accountRef,
          configVersion: settings.current().activeVersion,
          authorityEpoch: (await authority.current(accountRef))?.writerEpoch ?? 1,
          symbol: pos.symbol,
          side: pos.side,
          quantity: pos.qty,
          ownerAuthorized: true,
          trigger: 'Owner close command'
        });
        receipts.push(r);
      }

      const allFilled = receipts.length > 0 && receipts.every((r) => r.orderState === 'FILLED');
      const anyRejected = receipts.some((r) => r.orderState === 'REJECTED');
      const anyUnknown = receipts.some((r) => r.orderState === 'UNKNOWN');
      const overallState = allFilled
        ? 'CLOSED'
        : anyRejected
        ? 'REJECTED'
        : anyUnknown
        ? 'UNKNOWN'
        : 'PENDING';

      try {
        const freshPositions = await transport.positions();
        runtimeRef?.updateState((draft) => {
          draft.paper.positions = freshPositions.map((p, idx) => {
            const qty = Number(p.qty);
            const entry = Number(p.entryPrice);
            const existing = draft.paper.positions.find(
              (pos) => pos.symbol.toUpperCase() === p.symbol.toUpperCase() && pos.side === p.side
            );
            const leverage = existing?.leverage ?? 5;
            const margin = (qty * entry) / leverage;
            const stop = existing?.stop ?? 0;
            return {
              id: existing?.id ?? `pos-${p.symbol}-${idx}`,
              symbol: p.symbol,
              side: p.side,
              qty,
              entry,
              stop,
              tp: existing?.tp ?? null,
              mark: existing?.mark ?? entry,
              unrealizedPnl: existing?.unrealizedPnl ?? 0,
              leverage,
              margin,
              openedAt: existing?.openedAt ?? Date.now(),
              protectionStatus: existing?.protectionStatus ?? 'unknown',
              entryStatus: 'confirmed'
            };
          });
          draft.paper.usedMargin = draft.paper.positions.reduce((sum, pos) => sum + pos.margin, 0);
          draft.paper.canOpen = draft.paper.positions.length < draft.paper.n;
        });
      } catch {
        // Venue read failure in close reconciliation
      }

      return {
        ok: !anyRejected,
        code: allFilled ? 'OK' : anyRejected ? 'REJECTED' : 'ACCEPTED',
        message: allFilled
          ? `Position(s) closed for ${symbol}`
          : `Position close submitted for ${symbol}: ${overallState}`,
        data: {
          orderState: overallState,
          receipts
        }
      };
    }

    if (input.kind === 'cancel_entry') {
      const clientOrderId = String(input.payload?.clientOrderId ?? '');
      const symbol = String(input.payload?.symbol ?? input.symbol ?? 'BTCUSDT');
      const result = await transport.cancelEntryOrder(symbol, clientOrderId);
      return {
        ok: result.state === 'CANCELLED',
        code: result.state === 'CANCELLED' ? 'OK' : 'REJECTED',
        message: `Order ${clientOrderId} ${result.state}`
      };
    }

    if (input.kind === 'scan') {
      const positions = await transport.positions();
      const findings: string[] = [];
      for (const pos of positions) {
        const prot = await transport.readProtection(pos);
        if (prot.state !== 'VERIFIED') {
          findings.push(`WARNING: Position ${pos.symbol} ${pos.side} has unverified stop protection!`);
        }
      }
      return {
        ok: true,
        code: 'OK',
        message: findings.length === 0 ? 'All positions healthy and protected.' : findings.join('; '),
        data: { findings }
      };
    }

    if (input.kind === 'debate' || input.kind === 'auto_cycle') {
      const sym = input.symbol ?? 'BTCUSDT';
      const res = await (runtimeRef?.triggerCycle(sym, input.actor === 'system' ? 'schedule' : 'owner') ?? Promise.resolve({ ok: false, message: 'Runtime unavailable' }));
      return {
        ok: res.ok,
        code: res.ok ? 'OK' : 'REJECTED',
        message: res.message
      };
    }

    if (input.kind === 'command') {
      const res = await (runtimeRef?.handleCommand({
        text: input.text ?? '',
        agent: input.agent,
        clientRequestId: input.clientRequestId
      }) ?? Promise.resolve({ ok: false, error: 'Runtime unavailable' }));
      const msg = ('reply' in res && res.reply) ? res.reply : (res.error ?? 'Command executed');
      return {
        ok: res.ok,
        code: res.ok ? 'OK' : 'REJECTED',
        message: msg
      };
    }

    return {
      ok: false,
      code: 'SERVICE_UNAVAILABLE',
      message: `Runtime service for "${input.kind}" is not configured yet; refusing to fabricate results.`
    };
  };

  const initialUnrealized = initialPositions.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0);
  const initialVenueAccount = equityNum !== null ? {
    equity: equityNum,
    available: availNum ?? equityNum,
    unrealized: initialUnrealized,
    at: Date.now(),
    status: 'confirmed' as const,
    positions: initialPositions.map((p) => ({ symbol: p.symbol, side: p.side, qty: p.qty }))
  } : null;

  const cryptopanicKey =
    secrets.getSecret('CRYPTOPANIC_API_KEY') ?? env.CRYPTOPANIC_API_KEY ?? null;
  const whaleAlertKey =
    secrets.getSecret('WHALE_ALERT_API_KEY') ?? env.WHALE_ALERT_API_KEY ?? null;
  const coinmarketcapKey =
    secrets.getSecret('CMC_API_KEY') ??
    secrets.getSecret('COINMARKETCAP_API_KEY') ??
    env.CMC_API_KEY ??
    env.COINMARKETCAP_API_KEY ??
    null;

  const researchHost = new ResearchHost({
    optionalSources: {
      cryptopanicKey,
      whaleAlertKey,
      coinmarketcapKey
    },
    readMarketSnapshot: async (sym) => marketHub.snapshot(sym),
    readOrderbook: async (sym) => marketHub.orderbook(sym),
    readCandles: async (sym, tf) => marketHub.candles(sym, tf as any),
    readFundingOi: async (sym) => {
      const snap = marketHub.snapshot(sym);
      return { funding: snap.funding, openInterest: snap.openInterest };
    },
    readPortfolio: async () => ({
      positions: runtimeRef?.snapshot().paper.positions ?? [],
      balance: runtimeRef?.snapshot().paper.balance ?? 0,
      equity: runtimeRef?.snapshot().paper.equity ?? 0
    })
  });

  const chatService = new ChatService(store);
  await chatService.hydrateFromStore();

  const reportsService = new ReportsService();

  const runtime = createReplacementRuntime({
    sessionId: sessionLogger?.session.sessionId ?? null,
    initialMode: startup.tradingMode,
    initialAppMode: startup.appMode,
    marketHub,
    dispatcher,
    initialFinancial,
    initialPositions,
    venue: initialVenue,
    venueAccount: initialVenueAccount,
    runtimeIdentity: initialIdentity,
    executionGateway: gateway,
    env,
    settings,
    secrets,
    chatService,
    researchHost,
    reportsService,
    initialKilled: persistedHalt
  });
  runtimeRef = runtime;

  const grokKey = secrets.getSecret('AGENT_EVENT_SECRET');
  const grokRegistry: KeyRegistry = {
    async getKey(keyId: string) {
      if (!grokKey) return null;
      if (keyId === 'default' || keyId === 'grok') {
        return {
          keyId,
          secret: grokKey,
          revoked: false,
          scopes: ['read', 'write']
        };
      }
      return null;
    }
  };
  const grokBridge = new GrokBridge();

  const app = createReplacementApp(runtime, {
    sessionLogger,
    chatService,
    reportsService,
    setupDeps: { settings, secrets, accounts },
    researchDeps: { host: researchHost, activeAccountRef: () => accountRef },
    grokBridge,
    grokKeyRegistry: grokRegistry
  });
  const server = createServer(app);
  const wss = attachOfficeWebSocket(server, runtime, runtime.hub);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(startup.port, startup.host, () => resolve());
  });

  const boundPort = (server.address() as AddressInfo | null)?.port ?? startup.port;
  recordDiagnostic({
    source: 'server',
    category: 'SESSION',
    eventName: 'service.ready',
    status: 'ready',
    message: 'Replacement office services ready',
    details: { host: startup.host, port: boundPort, runtimeGeneration: 'v2' }
  });
  log(
    `Trading Agent Mpu Gandring backend on http://${startup.host}:${boundPort} (mode ${startup.tradingMode}, app ${startup.appMode}, generation v2)`
  );

  // Background Bybit Market Hub configure
  void runtime.marketHub.configure(runtime.snapshot().watchlist).catch((err) => {
    console.warn(`[market] Bybit bootstrap warning: ${(err as Error).message}`);
  });

  // Wire market frame updates to tickers with state update throttling
  const lastTickerUpdateBySymbol = new Map<string, { price: number; at: number }>();
  runtime.marketHub.onFrame((frame) => {
    const lastPrice = frame.last.value !== null ? Number(frame.last.value) : null;
    if (lastPrice !== null && Number.isFinite(lastPrice)) {
      const now = Date.now();
      const prev = lastTickerUpdateBySymbol.get(frame.symbol);
      if (prev && prev.price === lastPrice && now - prev.at < 2000) {
        return;
      }
      if (prev && now - prev.at < 1000) {
        return;
      }
      lastTickerUpdateBySymbol.set(frame.symbol, { price: lastPrice, at: now });
      runtime.updateState((draft) => {
        const rawPcnt = frame.price24hPcnt != null ? Number(frame.price24hPcnt) * 100 : 0;
        draft.tickers[frame.symbol] = {
          symbol: frame.symbol,
          last: lastPrice,
          change24hPct: Number.isFinite(rawPcnt) ? Math.round(rawPcnt * 100) / 100 : 0,
          source: 'bybit.v5.linear',
          example: false,
          at: now
        };
        let posChanged = false;
        if (Array.isArray(draft.paper.positions)) {
          for (const pos of draft.paper.positions) {
            if (pos.symbol.toUpperCase() === frame.symbol.toUpperCase()) {
              pos.mark = lastPrice;
              const mult = pos.side === 'LONG' ? 1 : -1;
              pos.unrealizedPnl = Math.round(mult * (lastPrice - pos.entry) * pos.qty * 100) / 100;
              posChanged = true;
            }
          }
        }
        if (posChanged) {
          const totalUpnl = Math.round(draft.paper.positions.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0) * 100) / 100;
          draft.paper.unrealized = totalUpnl;
          draft.paper.equity = Math.round((draft.paper.balance + totalUpnl) * 100) / 100;
          if (draft.venueAccount) {
            draft.venueAccount.unrealized = totalUpnl;
          }
        }
      });
    }
  });

  // If AUTO_TRADING is configured in env, activate
  const rawAuto = (env.AUTO_TRADING ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(rawAuto) && !runtime.snapshot().killed) {
    const intervalMin = Math.max(1, Number(env.DEBATE_INTERVAL_MIN || 15));
    runtime.updateAutoSettings({ on: true, intervalMin });
  }

  // Start Discord Gateway if configured for bot interactions
  let discordGateway: any = null;
  const dcBot = (env.DISCORD_BOT_TOKEN ?? '').trim();
  const dcDelivery = (env.DISCORD_DELIVERY ?? 'gateway').trim().toLowerCase();
  const commandsEnabled = /^on$/i.test((env.CHANNEL_COMMANDS ?? '').trim());

  if (dcBot && (dcDelivery === 'gateway' || !env.DISCORD_DELIVERY)) {
    try {
      const channelCfg = () => ({
        commands: commandsEnabled,
        discord: {
          botToken: dcBot,
          channelId: (env.DISCORD_CHANNEL_ID ?? '').trim() || undefined,
          guildId: (env.DISCORD_GUILD_ID ?? '').trim() || undefined,
          applicationId: (env.DISCORD_APPLICATION_ID ?? '').trim() || undefined,
          allowed: (env.DISCORD_ALLOWED_USER_IDS ?? '').split(/[\s,]+/).filter(Boolean),
          commands: commandsEnabled
        }
      });
      discordGateway = new DiscordGateway(
        channelCfg as any,
        fetch,
        async (commandText: string, actor: string) => {
          if (!commandsEnabled) {
            return 'Chat commands are off on this desk (CHANNEL_COMMANDS=off).';
          }
          const res = await runtime.handleCommand({
            text: commandText,
            conversationId: 'discord'
          });
          return res.reply ?? res.error ?? 'Command executed.';
        },
        () => {
          void runtime.dispatch({ kind: 'kill', actor: 'owner_channel' });
        }
      );
      discordGateway.start();
      log(`[channels:discord] Gateway client started (commands: ${commandsEnabled ? 'on' : 'off'})`);
    } catch (err) {
      console.error(`[channels:discord] Failed to start Gateway: ${(err as Error).message}`);
    }
  }

  let syncTimer: NodeJS.Timeout | null = null;
  if (startup.tradingMode !== 'PAPER') {
    let isSyncing = false;
    const syncVenueAccount = async () => {
      if (isSyncing) return;
      isSyncing = true;
      try {
        let recon: Awaited<ReturnType<typeof gateway.reconcile>> | null = null;
        try {
          recon = await gateway.reconcile(accountRef);
        } catch {
          recon = null;
        }
        const [bal, posList] = await Promise.all([
          venueAdapter.balance(),
          venueAdapter.positions()
        ]);
        const eq = bal.equity !== null ? Number(bal.equity) : null;
        const av = bal.available !== null ? Number(bal.available) : null;
        if (eq !== null && Number.isFinite(eq)) {
          runtime.updateState((d) => {
            d.financial.balance = availableFinancialField(eq);
            d.financial.equity = availableFinancialField(eq);
            if (av !== null && Number.isFinite(av)) {
              d.financial.availableBalance = availableFinancialField(av);
            }
            const totalUnrealized = Math.round(
              posList.reduce((sum, p) => sum + (p.unrealizedPnl ? Number(p.unrealizedPnl) : 0), 0) * 100
            ) / 100;
            d.venueAccount = {
              equity: eq,
              available: av ?? eq,
              unrealized: totalUnrealized,
              at: Date.now(),
              status: 'confirmed',
              positions: posList.map((p) => ({ symbol: p.symbol, side: p.side, qty: Number(p.qty) }))
            };
            d.paper.balance = av ?? eq;
            d.paper.unrealized = totalUnrealized;
            // Venue equity is authoritative and already includes unrealized PnL; avoid double counting.
            d.paper.equity = eq;

            const updatedPositions: Position[] = [];
            for (let idx = 0; idx < posList.length; idx++) {
              const nativePos = posList[idx];
              const qty = Number(nativePos.qty);
              const entry = Number(nativePos.entryPrice);
              const leverage = nativePos.leverage ?? 5;
              const margin = (qty * entry) / leverage;
              const existing = d.paper.positions.find(
                (p) => p.symbol.toUpperCase() === nativePos.symbol.toUpperCase() && p.side === nativePos.side
              );
              // Stop price comes only from a verified native readback. A local number is not a venue stop.
              const upnl = nativePos.unrealizedPnl != null ? Number(nativePos.unrealizedPnl) : (existing?.unrealizedPnl ?? 0);
              const mark = existing?.mark && Math.abs(existing.mark - entry) > 0.0001
                ? existing.mark
                : (entry + (nativePos.side === 'LONG' ? 1 : -1) * (qty > 0 ? upnl / qty : 0));

              const shown = verifiedVenueStop({
                protectionState: recon?.protection[nativePos.positionKey],
                stopPrice: recon?.verifiedStops?.[nativePos.positionKey]
              });
              updatedPositions.push({
                id: existing?.id ?? `pos-${nativePos.symbol}-${idx}`,
                symbol: nativePos.symbol,
                side: nativePos.side,
                qty,
                entry,
                stop: shown.stop,
                tp: existing?.tp ?? null,
                mark,
                unrealizedPnl: Math.round(upnl * 100) / 100,
                leverage,
                margin,
                openedAt: existing?.openedAt ?? nativePos.observedAt ?? Date.now(),
                protectionStatus: shown.protectionStatus,
                entryStatus: 'confirmed'
              });
            }
            d.paper.positions = updatedPositions;
            d.paper.usedMargin = updatedPositions.reduce((sum, p) => sum + p.margin, 0);

            const trading = settings.current().effective.trading;
            const slots = trading.maxPositions ?? d.paper.n;
            const safety = trading.safetyNet ?? d.paper.safetyNet;
            const mt = Math.round(Math.max(0, eq - safety) * 100) / 100;
            d.paper.safetyNet = safety;
            d.paper.n = slots;
            d.paper.moneyTrade = mt;
            d.paper.orderSizePct = trading.orderSizePct;
            d.paper.perOrder = ownerAllocationPerOrder(mt, slots, trading.orderSizePct);
            d.paper.canOpen = d.paper.perOrder > 0 && d.paper.positions.length < slots;
            if (d.accountState) {
              d.accountState.hasTradableCapital = d.paper.canOpen;
              d.accountState.canOpenNewSlot = d.paper.canOpen;
              d.accountState.status = 'AVAILABLE';
              d.accountState.mode = d.mode;
              d.accountState.observedAt = Date.now();
            }
          });
        }
      } catch {
        // Venue polling failure is non-fatal
      } finally {
        isSyncing = false;
      }
    };
    void syncVenueAccount();
    syncTimer = setInterval(syncVenueAccount, 15_000);
    syncTimer.unref();
  }

  const shutdown = () => {
    if (discordGateway) {
      try { discordGateway.stop(); } catch {}
      discordGateway = null;
    }
    if (syncTimer) clearInterval(syncTimer);
    wss.close();
    server.closeAllConnections();
    void runtime.stop().catch(() => {});
    server.close(() => {
      void (getSessionLogger()?.finish('INTERRUPTED', 'Server shutdown completed') ?? Promise.resolve()).finally(() => {
        process.exit(0);
      });
    });
    setTimeout(() => process.exit(0), 1500).unref();
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return { server, runtime };
}
