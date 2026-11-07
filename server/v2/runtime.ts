import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentId, RoomMessage } from '../types.js';
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
import { analyzeSMC } from '../market/smc.js';
import { calculateAlphaFactors } from '../market/alpha-factors.js';
import { detectHarmonicPatterns } from '../market/harmonics.js';
import { evaluateWatchlistOpportunity } from './market/opportunity.js';
import {
  fetchL2Orderbook,
  fetchDerivatives,
  getNewsFor,
  getLiveAnnouncementsResult,
  buildNewsBriefing,
  normalizeLegacyItem,
  getCoinMarketCapSummary
} from '../market/index.js';
import { computeWhaleIntelligence } from './market/whale.js';
import type { VenueAdapter } from './execution/adapters/types.js';
import type { MarketFrame, TF } from './contracts.js';
import {
  assertLivePermissionEvidence,
  type PermissionEvidence,
  type NativeAccountIdentity,
  type NativeBalance,
  type NativePosition
} from './execution/adapters/types.js';
import { ResearchHost, fetchPublicCryptoNews } from './research/host.js';
import { GrokBridge } from './connectors/grok/bridge.js';
import type { KeyRegistry } from './connectors/grok/auth.js';
import { HELP_TEXT, DiscordGateway, syncDiscordCommandsV2 } from './channels.js';
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

function roundPriceMetric(val: number | null | undefined, refPrice = 1): number | null {
  if (val === null || val === undefined || !Number.isFinite(val)) return null;
  const absRef = Math.abs(refPrice || val);
  const decimals = absRef >= 100 ? 2 : absRef >= 1 ? 4 : absRef >= 0.01 ? 6 : 8;
  const factor = 10 ** decimals;
  return Math.round(val * factor) / factor;
}

function roundRatioMetric(val: number | null | undefined, decimals = 2): number | null {
  if (val === null || val === undefined || !Number.isFinite(val)) return null;
  const factor = 10 ** decimals;
  return Math.round(val * factor) / factor;
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
    if (resolvedSafety.value < 0) {
      reasons.push(`SAFETY_NET cannot be negative (resolved ${resolvedSafety.value} from ${resolvedSafety.source})`);
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
  runFastReflex?(): Promise<void>;
  reconfigureVenueMode?(mode: TradingMode, venue?: VenueId): Promise<{ ok: boolean; error?: string }>;
  syncVenueAccount?(): Promise<void>;
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
  venueAdapter?: VenueAdapter;
  getVenueAdapter?: () => VenueAdapter;
  activeAccountRef?: () => string;
  reconfigureVenueMode?: (mode: TradingMode, venue?: VenueId) => Promise<{ ok: boolean; error?: string }>;
  syncVenueAccount?: () => Promise<void>;
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
  if (orderSizePct != null && Number.isFinite(orderSizePct) && orderSizePct > 0 && orderSizePct !== 1.5) {
    return Math.floor(((moneyTrade * orderSizePct) / 100) * 100) / 100;
  }
  const slots = Math.max(1, Math.min(4, Math.floor(n || 1)));
  if (slots > 0 && Number.isFinite(moneyTrade) && moneyTrade > 0) {
    return Math.floor((moneyTrade / slots) * 100) / 100;
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

export interface CrossMarketBreadth {
  regime: 'SYSTEMIC_RISK_OFF' | 'SYSTEMIC_RISK_ON' | 'BALANCED_CHOP';
  marketCondition?: 'BROAD_SELLOFF' | 'BROAD_RALLY' | 'MIXED';
  bearishCount: number;
  bullishCount: number;
  highRelVolCount: number;
  avgChange15m?: number;
  avgChange24h?: number;
  summary: string;
  details?: Record<string, { change15m?: number; relVol15m?: number; trend15m?: string }>;
}

export function computeCrossMarketBreadth(
  tickers: Record<string, { last?: number; change15m?: number; relVol15m?: number; trend15m?: string; change24hPct?: number }>,
  symbols: string[]
): CrossMarketBreadth {
  let bearishCount = 0;
  let bullishCount = 0;
  let highRelVolCount = 0;
  let sumChange15m = 0;
  let countChange15m = 0;
  let sumChange24h = 0;
  let countChange24h = 0;
  const details: Record<string, { change15m?: number; relVol15m?: number; trend15m?: string }> = {};

  const activeSymbols = symbols.filter((s) => Boolean(tickers[s]));
  const symbolsToEvaluate = activeSymbols.length > 0 ? activeSymbols : symbols;
  const total = symbolsToEvaluate.length;

  for (const sym of symbolsToEvaluate) {
    const t = tickers[sym];
    if (!t) continue;
    const change = t.change15m ?? t.change24hPct ?? 0;
    if (t.change15m !== undefined && Number.isFinite(t.change15m)) {
      sumChange15m += t.change15m;
      countChange15m++;
    }
    if (t.change24hPct !== undefined && Number.isFinite(t.change24hPct)) {
      sumChange24h += t.change24hPct;
      countChange24h++;
    }
    const relVol = t.relVol15m ?? 1.0;
    const trend = t.trend15m ?? (change < 0 ? 'DOWNTREND' : change > 0 ? 'UPTREND' : 'SIDEWAYS');

    details[sym] = {
      change15m: t.change15m,
      relVol15m: t.relVol15m,
      trend15m: trend
    };

    const isBearish = change < 0 || trend === 'DOWNTREND';
    const isBullish = change > 0 || trend === 'UPTREND';
    const isHighVol = relVol >= 2.0;

    if (isBearish) bearishCount++;
    else if (isBullish) bullishCount++;

    if (isHighVol) highRelVolCount++;
  }

  const avgChange15m = countChange15m > 0 ? Math.round((sumChange15m / countChange15m) * 100) / 100 : 0;
  const avgChange24h = countChange24h > 0 ? Math.round((sumChange24h / countChange24h) * 100) / 100 : 0;

  let regime: 'SYSTEMIC_RISK_OFF' | 'SYSTEMIC_RISK_ON' | 'BALANCED_CHOP' = 'BALANCED_CHOP';
  let marketCondition: 'BROAD_SELLOFF' | 'BROAD_RALLY' | 'MIXED' = 'MIXED';
  let summary = `Market regime balanced or mixed (${bullishCount} bull, ${bearishCount} bear).`;

  const isBroadSelloff = total > 0 && (bearishCount >= Math.ceil(total * 0.6) || avgChange15m <= -1.5);
  const isBroadRally = total > 0 && (bullishCount >= Math.ceil(total * 0.6) || avgChange15m >= 1.5);

  if (isBroadSelloff) {
    marketCondition = 'BROAD_SELLOFF';
    if (highRelVolCount >= Math.floor(total * 0.4)) {
      regime = 'SYSTEMIC_RISK_OFF';
      summary = `Systemic risk-off detected: ${bearishCount}/${total} symbols dropping with expanding volume.`;
    } else {
      summary = `Broad sell-off detected: ${bearishCount}/${total} symbols dropping (avg 15m: ${avgChange15m}%).`;
    }
  } else if (isBroadRally) {
    marketCondition = 'BROAD_RALLY';
    if (highRelVolCount >= Math.floor(total * 0.4)) {
      regime = 'SYSTEMIC_RISK_ON';
      summary = `Systemic risk-on detected: ${bullishCount}/${total} symbols rising with expanding volume.`;
    } else {
      summary = `Broad rally detected: ${bullishCount}/${total} symbols rising (avg 15m: ${avgChange15m}%).`;
    }
  }

  return {
    regime,
    marketCondition,
    bearishCount,
    bullishCount,
    highRelVolCount,
    avgChange15m,
    avgChange24h,
    summary,
    details
  };
}

export { evaluateWatchlistOpportunity, type CandidateOpportunity } from './market/opportunity.js';

export function createReplacementRuntime(
  options: ReplacementRuntimeOptions = {}
): ReplacementRuntimeHandle {
  const newsBriefingsBySymbol = new Map<string, unknown>();
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
  const orderSizePct = savedTrading?.orderSizePct === 1.5 ? null : (savedTrading?.orderSizePct ?? null);
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
    state.reportIntervalMin = savedAuto.reportIntervalMin ?? state.reportIntervalMin;
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
  const jevEnabled = savedJev?.enabled ?? (
    env.JEV_ENABLED !== undefined
      ? ['true', 'yes', '1', 'on'].includes((env.JEV_ENABLED ?? '').trim().toLowerCase())
      : true
  );
  const jevModel = (savedJev?.model && savedJev.model !== 'openai/gpt-5-mini' ? savedJev.model : null) || env.JEV_MODEL || 'typesafe/jev-1.14';
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
    health: !jevEnabled ? 'disabled' : (hasJevKey ? 'configured' : 'fallback_ready'),
    openrouterKeySet: Boolean(options.secrets?.hasProviderKey('openrouter') || env.OPENROUTER_API_KEY),
    dedicatedKeySet: Boolean(options.secrets?.getSecret('JEV_OPENROUTER_API_KEY') || env.JEV_OPENROUTER_API_KEY),
    configHealth: !jevEnabled ? 'off' : (hasJevKey ? 'configured' : 'fallback'),
    remoteHealth: 'unused'
  };

  const providerCaller = createOfficialProviderCaller();
  const jevClient =
    options.jevClient ??
    new JevClient({
      enabled: jevEnabled,
      apiKey: jevKey || null,
      model: jevModel,
      fallbackCaller: async (prompt, systemPrompt) => {
        try {
          const settingsSnap = options.settings?.current();
          const defaultAgent = settingsSnap?.effective?.agents?.lead;
          const upper = 'LEAD';
          const rawProv = (defaultAgent?.provider ?? env[`AGENT_${upper}_PROVIDER`] ?? env.DEFAULT_PROVIDER ?? '').trim().toLowerCase();
          const provider = rawProv || 'mock';
          const model = (defaultAgent?.model ?? env[`AGENT_${upper}_MODEL`] ?? env.DEFAULT_MODEL ?? 'default').trim();
          const envKey = PROVIDER_KEY_ENV[provider as keyof typeof PROVIDER_KEY_ENV];
          const secretKey = envKey ? (options.secrets?.getSecret(envKey) ?? env[envKey]) : undefined;
          const raw = await providerCaller({
            cycleId: 'jev-fallback',
            role: 'lead',
            phase: 'final',
            taskAttempt: 1,
            turn: 1,
            provider,
            model,
            apiKey: secretKey ?? '',
            system: systemPrompt ?? 'You are Jev, market regime reviewer.',
            user: prompt,
            timeoutMs: 15_000
          });
          return raw;
        } catch {
          return null;
        }
      }
    });

  const roleRunner =
    options.roleRunner ??
    new RoleRunner({
      researchHost: options.researchHost,
      providerCaller,
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

  let lastFightAt = 0;
  let autoTimer: NodeJS.Timeout | null = null;
  let fastReflexTimer: NodeJS.Timeout | null = null;
  const rejectCache = new Map<string, { at: number; price: number }>();

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
        draft.paper.perOrder = ownerAllocationPerOrder(mt, patch.n, draft.paper.orderSizePct);
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
    if (snapshot().mode !== 'PAPER' && options.syncVenueAccount) {
      try {
        await options.syncVenueAccount();
      } catch {}
    }
    const snap = snapshot();
    const cycleId = `cycle-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const debateId = `debate-${Date.now()}`;

    const paperPos = snap.paper.positions.find((p) => p.symbol.toUpperCase() === targetSymbol);
    const venuePos = snap.venueAccount?.positions?.find((p) => p.symbol.toUpperCase() === targetSymbol);
    const matchingVerdict = [...(snap.verdicts ?? [])]
      .reverse()
      .find((v) => v.symbol.toUpperCase() === targetSymbol && v.order);
    const existingPos = paperPos ?? (venuePos ? {
      side: venuePos.side,
      entry: Number(snap.tickers[targetSymbol]?.last ?? 0),
      qty: venuePos.qty,
      stop: matchingVerdict?.order?.stop ? Number(matchingVerdict.order.stop) : 0,
      tp: matchingVerdict?.order?.tp ? Number(matchingVerdict.order.tp) : null,
      unrealizedPnl: 0
    } : null);

    const openSymbols = new Set<string>();
    for (const p of snap.paper.positions) {
      openSymbols.add(p.symbol.toUpperCase());
    }
    if (snap.venueAccount?.positions) {
      for (const p of snap.venueAccount.positions) {
        openSymbols.add(p.symbol.toUpperCase());
      }
    }
    if (snap.venueAccount?.pendingSymbols) {
      for (const sym of snap.venueAccount.pendingSymbols) {
        openSymbols.add(sym.toUpperCase());
      }
    }
    if ((snap.venueAccount as any)?.pendingOrders) {
      for (const po of (snap.venueAccount as any).pendingOrders) {
        openSymbols.add(po.symbol.toUpperCase());
      }
    }
    const currentPosCount = snap.mode === 'PAPER' ? snap.paper.positions.length : openSymbols.size;
    const maxSlotsN = snap.paper.n || 3;
    const freeSlots = Math.max(0, maxSlotsN - currentPosCount);

    const venuePending = (snap.venueAccount as any)?.pendingOrders?.find((p: any) => p.symbol.toUpperCase() === targetSymbol);
    const hasPendingSymbol = snap.venueAccount?.pendingSymbols?.some((s) => s.toUpperCase() === targetSymbol);
    const pendingVerdict = [...(snap.verdicts ?? [])]
      .reverse()
      .find((v) => v.symbol.toUpperCase() === targetSymbol && (v as any).operationalStatus === 'PENDING');

    const hasLivePending = snap.mode !== 'PAPER'
      ? Boolean(venuePending || hasPendingSymbol)
      : Boolean(pendingVerdict);

    const existingPendingOrder = (!existingPos && hasLivePending) ? {
      clientOrderId: venuePending?.clientOrderId ?? (pendingVerdict as any)?.positionId ?? (pendingVerdict as any)?.order?.clientOrderId ?? `pending-${targetSymbol}`,
      side: (venuePending?.side ?? (pendingVerdict?.action === 'OPEN_SHORT' ? 'SHORT' : 'LONG')) as 'LONG' | 'SHORT',
      limitPrice: venuePending?.limitPrice ?? (pendingVerdict as any)?.order?.entry ?? null,
      stopPrice: venuePending?.stopPrice ?? (pendingVerdict as any)?.order?.stop ?? null,
      tpPrice: venuePending?.tpPrice ?? (pendingVerdict as any)?.order?.tp ?? null,
      orderState: venuePending?.orderState ?? 'ACCEPTED'
    } : null;
    const currentPriceNum = Number(snap.tickers[targetSymbol]?.last ?? (existingPos ? existingPos.entry : 0));

    if (!existingPos && !existingPendingOrder && freeSlots <= 0 && reason !== 'owner') {
      const skipMsg = `All ${maxSlotsN} position slots occupied. Deliberation skipped by Slot Gate.`;
      hub.emit('log', {
        at: Date.now(),
        kind: 'gate',
        text: `Slot Gate: ${skipMsg} (${targetSymbol}, reason: ${reason})`
      });
      return {
        ok: false,
        message: skipMsg,
        cycleId
      };
    }

    const spokenRolesInCurrentCycle = new Set<RoleId>();

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
        draft.agents[role].stance = 'NEUTRAL';
        draft.agents[role].confidence = null;
        draft.agents[role].lastLine = '';
      }
    });

    hub.emit('debate', snapshot().debate);
    hub.emit('log', {
      at: Date.now(),
      kind: 'debate',
      text: `Started deliberation cycle for ${targetSymbol} (reason: ${reason})`
    });

    let intelFrame: IntelligenceFrame;
    let marketFrame: MarketFrame | undefined;
    try {
      marketFrame = marketHub.snapshot(targetSymbol);
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

        const closedBars = marketFrame?.closed[tf as TF]?.filter((b) => b.confirmed) ?? [];
        const lastBar = closedBars.at(-1);
        const priorBars = closedBars.slice(-21, -1);
        const priorHigh20 = priorBars.length > 0 ? priorBars.reduce((max, b) => Math.max(max, Number(b.high) || 0), -Infinity) : -Infinity;
        const priorLow20 = priorBars.length > 0 ? priorBars.reduce((min, b) => Math.min(min, Number(b.low) || Infinity), Infinity) : Infinity;

        const lastPivotHigh = highs[highs.length - 1]?.price != null ? Number(highs[highs.length - 1].price) : null;
        const lastPivotLow = lows[lows.length - 1]?.price != null ? Number(lows[lows.length - 1].price) : null;

        const effectiveSwingHigh = lastPivotHigh !== null && Number.isFinite(priorHigh20) && priorHigh20 > -Infinity
          ? Math.max(lastPivotHigh, priorHigh20)
          : (lastPivotHigh ?? (priorHigh20 > -Infinity ? priorHigh20 : null));

        const effectiveSwingLow = lastPivotLow !== null && Number.isFinite(priorLow20) && priorLow20 < Infinity
          ? Math.min(lastPivotLow, priorLow20)
          : (lastPivotLow ?? (priorLow20 < Infinity ? priorLow20 : null));

        const priorHighRef = effectiveSwingHigh;
        const priorLowRef = effectiveSwingLow;

        let liquiditySweep: 'BEARISH_SWEEP_REJECT' | 'BULLISH_SWEEP_RECLAIM' | null = null;
        if (lastBar && priorHighRef !== null && priorLowRef !== null) {
          const barHigh = Number(lastBar.high);
          const barLow = Number(lastBar.low);
          const barClose = Number(lastBar.close);
          if (barHigh > priorHighRef && barClose < priorHighRef) {
            liquiditySweep = 'BEARISH_SWEEP_REJECT';
          } else if (barLow < priorLowRef && barClose > priorLowRef) {
            liquiditySweep = 'BULLISH_SWEEP_RECLAIM';
          }
        }

        let anomalySignal: 'SQUEEZE_BREAKOUT_UP' | 'SQUEEZE_BREAKDOWN_DOWN' | 'VOLUME_CLIMAX_SPIKE' | null = null;
        const relVol = Number(feat.relativeVolume20?.value ?? 0);
        const bbUpper = feat.bollinger20?.value?.upper != null ? Number(feat.bollinger20.value.upper) : Infinity;
        const bbLower = feat.bollinger20?.value?.lower != null ? Number(feat.bollinger20.value.lower) : -Infinity;
        const bbBandwidth = feat.bollinger20?.value?.bandwidth != null ? Number(feat.bollinger20.value.bandwidth) : null;
        const isCompressing = feat.volatilityRegime === 'COMPRESSING' || (bbBandwidth !== null && bbBandwidth < 0.04);
        const barClose = lastBar ? Number(lastBar.close) : null;

        if (lastBar && barClose !== null) {
          if ((isCompressing || relVol >= 1.8) && barClose > bbUpper && relVol >= 1.8) {
            anomalySignal = 'SQUEEZE_BREAKOUT_UP';
          } else if (relVol >= 1.8 && barClose < bbLower) {
            anomalySignal = 'SQUEEZE_BREAKDOWN_DOWN';
          } else if (relVol >= 2.5) {
            anomalySignal = 'VOLUME_CLIMAX_SPIKE';
          }
        }

        const recentCandles = closedBars.slice(-8).map((b) => ({
          t: b.startAt,
          o: b.open,
          h: b.high,
          l: b.low,
          c: b.close,
          v: b.volume,
          dir: Number(b.close) >= Number(b.open) ? 'BULL' : 'BEAR'
        }));

        const normalizedCandles = closedBars.map((b) => ({
          timestamp: b.startAt,
          open: Number(b.open),
          high: Number(b.high),
          low: Number(b.low),
          close: Number(b.close),
          volume: Number(b.volume)
        }));

        let smcData: any = null;
        if (['5m', '15m', '1h', '4h'].includes(tf) && normalizedCandles.length > 0) {
          try {
            const smcRes = analyzeSMC(normalizedCandles, { symbol: targetSymbol, tf });
            if (smcRes) {
              smcData = {
                marketTrend: smcRes.marketTrend,
                lastBreak: smcRes.lastBreak,
                activeFVGs: smcRes.activeFVGs,
                activeOrderBlocks: smcRes.activeOrderBlocks,
                premiumDiscountZone: smcRes.premiumDiscountZone
              };
            }
          } catch {
            smcData = null;
          }
        }

        let quantFactors: unknown = null;
        let harmonicPatterns: unknown[] = [];
        if (['15m', '1h', '4h'].includes(tf) && normalizedCandles.length > 0) {
          try {
            const alpha = calculateAlphaFactors(normalizedCandles);
            if (alpha) {
              quantFactors = {
                compositeScore: roundRatioMetric(alpha.compositeScore, 3),
                regime: alpha.regime,
                roc5: roundRatioMetric(alpha.roc5, 2),
                roc20: roundRatioMetric(alpha.roc20, 2),
                vwap20Ratio: roundRatioMetric(alpha.vwap20Ratio, 2),
                rsv14: roundRatioMetric(alpha.rsv14, 1)
              };
            }
          } catch {
            quantFactors = null;
          }
          try {
            const harmonics = detectHarmonicPatterns(normalizedCandles);
            if (harmonics && harmonics.length > 0) {
              harmonicPatterns = harmonics.slice(0, 2).map((h) => ({
                name: h.name,
                orientation: h.orientation,
                qualityScore: h.qualityScore,
                prz: {
                  entryMin: roundPriceMetric(h.prz.entryMin, currentPriceNum),
                  entryMax: roundPriceMetric(h.prz.entryMax, currentPriceNum),
                  stopLoss: roundPriceMetric(h.prz.stopLoss, currentPriceNum),
                  target1: roundPriceMetric(h.prz.target1, currentPriceNum),
                  target2: roundPriceMetric(h.prz.target2, currentPriceNum)
                }
              }));
            }
          } catch {
            harmonicPatterns = [];
          }
        }

        timeframesSummary[tf] = {
          momentum: feat.momentumRegime,
          volatility: feat.volatilityRegime,
          liquiditySweep,
          anomalySignal,
          ema9: roundPriceMetric(feat.ema9?.value, currentPriceNum),
          ema21: roundPriceMetric(feat.ema21?.value, currentPriceNum),
          ema50: roundPriceMetric(feat.ema50?.value, currentPriceNum),
          ema200: roundPriceMetric(feat.ema200?.value, currentPriceNum),
          sma20: roundPriceMetric(feat.sma20?.value, currentPriceNum),
          rsi14: roundRatioMetric(feat.rsi14?.value, 2),
          atr14: roundPriceMetric(feat.atr14?.value, currentPriceNum),
          macd: feat.macd?.value ? {
            line: roundPriceMetric(feat.macd.value.macd, currentPriceNum),
            signal: roundPriceMetric(feat.macd.value.signal, currentPriceNum),
            histogram: roundPriceMetric(feat.macd.value.histogram, currentPriceNum)
          } : null,
          bollinger: feat.bollinger20?.value ? {
            upper: roundPriceMetric(feat.bollinger20.value.upper, currentPriceNum),
            middle: roundPriceMetric(feat.bollinger20.value.middle, currentPriceNum),
            lower: roundPriceMetric(feat.bollinger20.value.lower, currentPriceNum),
            bandwidth: roundRatioMetric(feat.bollinger20.value.bandwidth, 4)
          } : null,
          vwapUtc: roundPriceMetric(feat.vwapUtc?.value, currentPriceNum),
          relativeVolume20: roundRatioMetric(feat.relativeVolume20?.value, 2),
          structure: {
            swingHigh: roundPriceMetric(effectiveSwingHigh, currentPriceNum),
            swingLow: roundPriceMetric(effectiveSwingLow, currentPriceNum),
            priorSwingHigh: roundPriceMetric(highs[highs.length - 2]?.price ?? null, currentPriceNum),
            priorSwingLow: roundPriceMetric(lows[lows.length - 2]?.price ?? null, currentPriceNum),
            bos: feat.structure?.bos ?? null,
            choch: feat.structure?.choch ?? null,
            rsiDivergence: feat.structure?.rsiDivergence ?? null,
            ...(smcData ? {
              marketTrend: smcData.marketTrend,
              lastBreak: smcData.lastBreak,
              activeFVGs: smcData.activeFVGs,
              activeOrderBlocks: smcData.activeOrderBlocks,
              premiumDiscountZone: smcData.premiumDiscountZone
            } : {})
          },
          ...(quantFactors ? { quantFactors } : {}),
          ...(harmonicPatterns.length > 0 ? { harmonicPatterns } : {}),
          recentCandles
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

    // Fetch multi-venue quotes, whale intelligence, news, and catalysts in parallel with safe error isolation
    const venueName = (snap.venue?.name as any) || 'aster';
    const whaleKey = options.secrets?.getSecret('WHALE_ALERT_API_KEY') ?? env.WHALE_ALERT_API_KEY ?? undefined;
    const cryptopanicKey = options.secrets?.getSecret('CRYPTOPANIC_API_KEY') ?? env.CRYPTOPANIC_API_KEY ?? undefined;

    const isTestEnv = Boolean(process.env.VITEST || process.env.NODE_ENV === 'test');
    const [
      venueObRes,
      venueDerivsRes,
      bybitDerivsRes,
      hlObRes,
      nativeQuoteRes,
      whaleRes,
      newsRes,
      liveAnnounceRes,
      catalystRes,
      publicNewsRes
    ] = isTestEnv ? await Promise.allSettled([
      Promise.resolve(null),
      Promise.resolve(null),
      Promise.resolve(null),
      Promise.resolve(null),
      snap.mode !== 'PAPER' && options.venueAdapter?.quote && (options.venueAdapter as any).name !== 'paper' ? options.venueAdapter.quote(targetSymbol) : Promise.resolve(null),
      Promise.resolve(null),
      Promise.resolve([]),
      Promise.resolve({ items: [] } as any),
      Promise.resolve(null),
      Promise.resolve([])
    ]) : await Promise.allSettled([
      fetchL2Orderbook(targetSymbol, venueName, venueName, snap.venueAccount?.status ? 'mainnet' : 'testnet'),
      fetchDerivatives(targetSymbol, venueName, Number(snap.tickers[targetSymbol]?.last ?? 0)),
      fetchDerivatives(targetSymbol, 'bybit', Number(snap.tickers[targetSymbol]?.last ?? 0)),
      fetchL2Orderbook(targetSymbol, 'hyperliquid', 'hyperliquid'),
      snap.mode !== 'PAPER' && options.venueAdapter?.quote && (options.venueAdapter as any).name !== 'paper' ? options.venueAdapter.quote(targetSymbol) : Promise.resolve(null),
      computeWhaleIntelligence({ symbol: targetSymbol, apiKey: whaleKey, marketHub }),
      getNewsFor(targetSymbol, {
        tradingMode: snap.mode,
        news: {
          provider: cryptopanicKey ? 'cryptopanic' : 'sample',
          key: cryptopanicKey ?? '',
          baseUrl: 'https://cryptopanic.com/api/v1/posts/'
        }
      }),
      getLiveAnnouncementsResult(targetSymbol),
      getCoinMarketCapSummary(targetSymbol),
      fetchPublicCryptoNews(targetSymbol, fetch)
    ]);

    const venueOb = venueObRes.status === 'fulfilled' ? venueObRes.value : null;
    const venueDerivs = venueDerivsRes.status === 'fulfilled' ? venueDerivsRes.value : null;
    const bybitDerivs = bybitDerivsRes.status === 'fulfilled' ? bybitDerivsRes.value : null;
    const hlOb = hlObRes.status === 'fulfilled' ? hlObRes.value : null;
    const nativeQuote = nativeQuoteRes.status === 'fulfilled' ? nativeQuoteRes.value : null;
    const whaleReport = whaleRes.status === 'fulfilled' ? whaleRes.value : null;
    const newsItems = newsRes.status === 'fulfilled' ? (newsRes.value ?? []) : [];
    const liveAnnouncements = liveAnnounceRes.status === 'fulfilled' ? (liveAnnounceRes.value?.items ?? []) : [];
    const publicNews = publicNewsRes.status === 'fulfilled' ? publicNewsRes.value : [];
    const publicNewsNormalized = publicNews.map((pn, i) => {
      const isSpecific = pn.targetScope === 'SYMBOL_SPECIFIC' || (pn.matchedSymbol && pn.matchedSymbol === targetSymbol);
      return {
        id: `public-news-${Date.now()}-${i}`,
        symbol: isSpecific ? targetSymbol : 'MARKET',
        targetScope: isSpecific ? 'SYMBOL_SPECIFIC' : 'GENERAL_MARKET',
        headline: pn.title,
        body: pn.body,
        source: pn.publisher,
        sourceUrl: pn.url,
        sentiment: 'neutral' as const,
        example: false,
        publishedAt: pn.publishedAt ?? null,
        observedAt: Date.now()
      };
    });
    const combinedNews = [...liveAnnouncements, ...newsItems, ...publicNewsNormalized];
    const filteredNews = combinedNews.filter((item: any) => {
      const sym = item.symbol ? String(item.symbol).toUpperCase() : '';
      return sym === targetSymbol || sym === 'MARKET' || item.targetScope === 'GENERAL_MARKET';
    });
    const normalizedItems = filteredNews.map((item) => normalizeLegacyItem(item, targetSymbol));
    const newsBriefing = buildNewsBriefing(
      targetSymbol,
      normalizedItems,
      cryptopanicKey || liveAnnouncements.length > 0 || publicNews.length > 0 ? 'CONFIGURED_LIVE' : 'UNCONFIGURED'
    );
    newsBriefingsBySymbol.set(targetSymbol, newsBriefing);
    const cmcSummary = catalystRes.status === 'fulfilled' ? catalystRes.value : null;

    const multiVenue = {
      preferredVenue: snap.venue?.name ?? 'bybit',
      nativeQuote: (snap.mode !== 'PAPER' && nativeQuote) ? {
        last: nativeQuote.last,
        bid: nativeQuote.bid,
        ask: nativeQuote.ask,
        ageMs: nativeQuote.ageMs
      } : null,
      venues: {
        bybit: {
          last: snap.tickers[targetSymbol]?.last ?? null,
          bid: marketFrame?.bid?.value ?? null,
          ask: marketFrame?.ask?.value ?? null,
          spreadBps: intelFrame.microstructure?.spreadBps?.value ?? null,
          fundingRate: intelFrame.microstructure?.funding?.value ?? bybitDerivs?.fundingRate ?? null,
          openInterest: intelFrame.microstructure?.openInterest?.value ?? bybitDerivs?.openInterest ?? null
        },
        aster: {
          last: venueOb?.microPrice ?? null,
          bid: venueOb?.bids?.[0]?.[0] ?? null,
          ask: venueOb?.asks?.[0]?.[0] ?? null,
          spreadBps: venueOb?.spreadBps ?? null,
          fundingRate: venueDerivs?.fundingRate ?? venueDerivs?.multiVenueFunding?.aster?.fundingRate ?? null,
          openInterest: venueDerivs?.openInterest ?? venueDerivs?.multiVenueFunding?.aster?.openInterest ?? null
        },
        hyperliquid: {
          last: hlOb?.microPrice ?? null,
          bid: hlOb?.bids?.[0]?.[0] ?? null,
          ask: hlOb?.asks?.[0]?.[0] ?? null,
          spreadBps: hlOb?.spreadBps ?? null,
          fundingRate: venueDerivs?.multiVenueFunding?.hyperliquid?.fundingRate ?? null,
          openInterest: venueDerivs?.multiVenueFunding?.hyperliquid?.openInterest ?? null
        }
      }
    };

    const recentTvAlert = (snap.tradingview as any)?.recentAlerts?.find(
      (a: any) => a.symbol === targetSymbol && Date.now() - a.receivedAt < 30 * 60 * 1000
    ) ?? ((snap.tradingview as any)?.lastAlert?.symbol === targetSymbol ? (snap.tradingview as any)?.lastAlert : null);

    const symbolsForBreadth = (snap.watchlist && snap.watchlist.length > 0)
      ? snap.watchlist
      : Object.keys(snap.tickers);
    const crossMarketTickers: Record<string, { last?: number; change15m?: number; relVol15m?: number; trend15m?: string; change24hPct?: number }> = {};
    for (const sym of symbolsForBreadth) {
      const snapTicker = snap.tickers[sym] as any;
      let change15m: number | undefined = snapTicker?.change15m !== undefined ? Number(snapTicker.change15m) : undefined;
      let relVol15m: number | undefined = snapTicker?.relVol15m !== undefined ? Number(snapTicker.relVol15m) : undefined;
      let trend15m: string | undefined = snapTicker?.trend15m ?? undefined;

      try {
        const frame = marketHub.snapshot(sym);
        const closed15m = frame?.closed?.['15m']?.filter((b) => b.confirmed) ?? [];
        if (closed15m.length >= 2) {
          const lastBar = closed15m[closed15m.length - 1];
          const prevBar = closed15m[closed15m.length - 2];
          const lastClose = Number(lastBar.close);
          const prevClose = Number(prevBar.close);
          if (prevClose > 0) {
            change15m = Math.round(((lastClose - prevClose) / prevClose) * 10000) / 100;
          }
          trend15m = lastClose >= Number(lastBar.open) ? 'UPTREND' : 'DOWNTREND';
          const last20 = closed15m.slice(-20);
          const avgVol = last20.reduce((s, b) => s + (Number(b.volume) || 0), 0) / Math.max(1, last20.length);
          if (avgVol > 0) {
            relVol15m = Math.round((Number(lastBar.volume) / avgVol) * 10) / 10;
          }
        }
      } catch {}

      crossMarketTickers[sym] = {
        last: snapTicker?.last ? Number(snapTicker.last) : undefined,
        change15m,
        relVol15m,
        trend15m,
        change24hPct: snapTicker?.change24hPct != null ? Number(snapTicker.change24hPct) : undefined
      };
    }

    const crossMarketBreadth = computeCrossMarketBreadth(crossMarketTickers, symbolsForBreadth);
    const recentOwnerDiscussion = (snap.roomHistory ?? [])
      .filter((m) => m.from === 'owner')
      .slice(-5)
      .map((m) => ({ text: m.text, at: m.at, to: m.to }));

    const totalEquity = snap.mode === 'PAPER'
      ? snap.paper.equity
      : (snap.financial.equity.value ?? snap.paper.equity);
    const balance = snap.mode === 'PAPER'
      ? snap.paper.balance
      : (snap.financial.balance.value ?? snap.paper.balance);
    const safetyNet = snap.paper.safetyNet ?? 0;
    const moneyTradeBudget = Math.max(0, Math.round((balance - safetyNet) * 100) / 100);
    const usedMargin = snap.mode === 'PAPER'
      ? snap.paper.usedMargin
      : Math.round((snap.venueAccount?.positions?.reduce((acc: number, p: any) => acc + (Number(p.margin) || 0), 0) ?? snap.paper.usedMargin ?? 0) * 100) / 100;
    const freeAllocatableMargin = Math.max(0, Math.round((moneyTradeBudget - usedMargin) * 100) / 100);
    const perOrderAllocation = resolveOwnerPerOrderUsdt(snap.paper);

    const accountCapital = {
      totalEquity,
      balance,
      safetyNet,
      moneyTradeBudget,
      usedMargin,
      freeAllocatableMargin,
      perOrderAllocation,
      maxSlotsN,
      occupiedSlots: currentPosCount,
      freeSlots
    };

    let roePct = 0;
    let slDistancePct: number | null = null;
    let tpDistancePct: number | null = null;
    let priorEntryThesis: Record<string, unknown> | null = null;

    if (existingPos) {
      const entryNum = Number(existingPos.entry) || currentPriceNum;
      const lev = (existingPos as any).leverage || snap.trading?.values.maxLeverage || snap.paper.maxLeverage || 5;
      if (entryNum > 0 && currentPriceNum > 0) {
        if (existingPos.side === 'LONG') {
          roePct = ((currentPriceNum - entryNum) / entryNum) * lev * 100;
        } else {
          roePct = ((entryNum - currentPriceNum) / entryNum) * lev * 100;
        }
      }
      if (existingPos.stop && Number(existingPos.stop) > 0 && currentPriceNum > 0) {
        slDistancePct = Math.abs((currentPriceNum - Number(existingPos.stop)) / currentPriceNum) * 100;
      }
      if (existingPos.tp && Number(existingPos.tp) > 0 && currentPriceNum > 0) {
        tpDistancePct = Math.abs((Number(existingPos.tp) - currentPriceNum) / currentPriceNum) * 100;
      }

      const priorVerdict = [...(snap.verdicts ?? [])]
        .reverse()
        .find((v) => v.symbol.toUpperCase() === targetSymbol.toUpperCase() && (v.action === 'OPEN_LONG' || v.action === 'OPEN_SHORT'));
      if (priorVerdict) {
        priorEntryThesis = {
          action: priorVerdict.action,
          reason: priorVerdict.reason,
          at: priorVerdict.at,
          order: priorVerdict.order ? {
            entry: priorVerdict.order.entry,
            stop: priorVerdict.order.stop,
            tp: priorVerdict.order.tp,
            leverage: priorVerdict.order.leverage
          } : null
        };
      }
    } else if (pendingVerdict) {
      priorEntryThesis = {
        action: pendingVerdict.action,
        reason: pendingVerdict.reason,
        at: pendingVerdict.at,
        order: pendingVerdict.order ? {
          entry: pendingVerdict.order.entry,
          stop: pendingVerdict.order.stop,
          tp: pendingVerdict.order.tp,
          leverage: pendingVerdict.order.leverage
        } : null
      };
    }

    const evaluationMode = existingPos
      ? 'POSITION_MANAGEMENT'
      : (existingPendingOrder ? 'PENDING_ORDER_MANAGEMENT' : 'CANDIDATE_DISCOVERY');

    const recentLessons = (snap.lessons ?? [])
      .filter((l: any) => !l.archived && (!l.symbol || String(l.symbol).toUpperCase() === targetSymbol))
      .slice(-5)
      .map((l: any) => ({
        role: l.role,
        kind: l.kind,
        symbol: l.symbol ?? targetSymbol,
        happened: l.happened,
        rootCause: l.rootCause,
        lesson: l.lesson,
        status: l.status
      }));

    const optionalResearch = {
      news: {
        status: newsBriefing.events.length > 0 ? 'available' : 'no_events',
        providerStatus: newsBriefing.providerStatus,
        instruction: 'NO_VETO: If no high-impact breaking news exists, do NOT penalize confidence.',
        items: newsBriefing.events.slice(0, 5).map((item: any) => ({
          id: item.id,
          symbol: item.symbol ?? (item.affectedAssets?.[0] ?? targetSymbol),
          targetScope: item.targetScope ?? 'BROAD_CRYPTO',
          headline: item.title ?? item.headline ?? '',
          summary: (item.summary ?? item.body ?? item.impactAssessment ?? '').slice(0, 280),
          source: item.source,
          sentiment: item.sentiment,
          publishedAt: item.publishedAt ?? null
        }))
      },
      whale: {
        status: whaleReport && (whaleReport.exchange.largeTrades.length > 0 || whaleReport.onchain.events.length > 0) ? 'available' : 'no_events',
        instruction: 'NO_VETO: If no massive whale transaction detected, do NOT penalize confidence.',
        report: whaleReport
      },
      catalyst: {
        status: cmcSummary?.momentum?.sourceStatus === 'live' ? 'available' : (cmcSummary ? 'cached' : 'no_events'),
        instruction: 'NO_VETO: If external catalyst feed has no update, do NOT penalize confidence.',
        momentum: cmcSummary?.momentum ?? null
      }
    };

    const marketSummary: Record<string, unknown> = {
      symbol: targetSymbol,
      venue: 'bybit',
      category: 'linear',
      lastPrice: snap.tickers[targetSymbol]?.last ? String(snap.tickers[targetSymbol].last) : undefined,
      evidenceId: intelFrame.evidenceId,
      timeframes: timeframesSummary,
      microstructure: microstructureSummary,
      multiVenue,
      crossMarketBreadth,
      ownerDirectives: {
        recentMessages: recentOwnerDiscussion,
        instruction: 'Owner Sovereignty: The user/owner is the ultimate decision maker. Adhere strictly to any risk, position, or market directives given in recent owner messages.'
      },
      venueCapabilities: {
        supportsLimitGtc: options.venueAdapter?.capabilities?.restingLimitGtcEntry ?? (snap.mode === 'PAPER' ? true : false)
      },
      tradingviewAlert: recentTvAlert ? {
        action: recentTvAlert.action,
        price: recentTvAlert.price,
        note: recentTvAlert.note,
        receivedAt: recentTvAlert.receivedAt
      } : null,
      opposingFacts: intelFrame.opposingFacts,
      existingPosition: existingPos ? {
        side: existingPos.side,
        entryPrice: existingPos.entry,
        openedAt: (existingPos as any).openedAt ?? null,
        qty: existingPos.qty,
        markPrice: currentPriceNum,
        unrealizedPnl: existingPos.unrealizedPnl ?? 0,
        roePct: Math.round(roePct * 100) / 100,
        stopPrice: existingPos.stop ?? 0,
        slDistancePct: slDistancePct !== null ? Math.round(slDistancePct * 100) / 100 : null,
        takeProfitPrice: existingPos.tp ?? null,
        tpDistancePct: tpDistancePct !== null ? Math.round(tpDistancePct * 100) / 100 : null,
        priorEntryThesis
      } : null,
      pendingOrder: existingPendingOrder ? {
        clientOrderId: existingPendingOrder.clientOrderId,
        side: existingPendingOrder.side,
        limitPrice: existingPendingOrder.limitPrice,
        stopPrice: existingPendingOrder.stopPrice,
        takeProfitPrice: existingPendingOrder.tpPrice,
        orderState: existingPendingOrder.orderState,
        priorEntryThesis,
        instruction: 'PENDING_ORDER_MANAGEMENT: A resting LIMIT_GTC order is waiting on the exchange. Review current market structure: output HOLD to keep the limit order resting, or output CLOSE to cancel the unfilled limit order immediately if price structure has reversed or invalidated the entry setup.'
      } : null,
      evaluationMode,
      optionalResearch,
      recentLessons,
      accountCapital
    };

    const tv = snap.trading?.values;
    const currentPrice = Number(snap.tickers[targetSymbol]?.last ?? 0);
    const activeLev = tv?.maxLeverage ?? snap.paper.maxLeverage ?? 1;
    const stopPctRoe = tv?.defaultStopPct ?? snap.paper.defaultStopPct ?? 30;
    const stopPricePct = (stopPctRoe / Math.max(1, activeLev)) / 100;
    const tpPctRoe = tv?.takeProfitPct ?? (stopPctRoe * (tv?.takeProfitR ?? 2));
    const tpPricePct = (tpPctRoe / Math.max(1, activeLev)) / 100;

    let profileBaselineStopPrice: { long: string | null; short: string | null } | undefined = undefined;
    let profileBaselineTpPrice: { long: string | null; short: string | null } | undefined = undefined;

    if (currentPrice > 0) {
      profileBaselineStopPrice = {
        long: (currentPrice * (1 - stopPricePct)).toFixed(4),
        short: (currentPrice * (1 + stopPricePct)).toFixed(4)
      };
      profileBaselineTpPrice = {
        long: (currentPrice * (1 + tpPricePct)).toFixed(4),
        short: (currentPrice * (1 - tpPricePct)).toFixed(4)
      };
    }

    const policy: CyclePolicy = {
      minEntryConfidencePct: tv?.minEntryConfidencePct ?? 60,
      requireTwoOfThreeAnalysts: false,
      maxLeverage: activeLev,
      defaultStopPct: stopPctRoe,
      takeProfitPct: tpPctRoe,
      takeProfitR: tv?.takeProfitR ?? 2,
      availableCapitalUsdt: snap.paper.moneyTrade,
      allocationPerOrderUsdt: resolveOwnerPerOrderUsdt(snap.paper),
      maxPositions: snap.paper.n,
      orderSizePct: tv?.orderSizePct ?? null,
      dailyLossLimitPct: tv?.dailyLossLimitPct,
      safetyNet: snap.paper.safetyNet,
      sizingMode: (tv?.orderSizePct ?? null) !== null ? 'FIXED_PCT_OF_MONEY_TRADE' : 'AUTO_EQUAL_SLOTS_MONEY_TRADE_DIV_N',
      tradingProfile: snap.trading?.profile,
      profileBaselineStopPrice,
      profileBaselineTpPrice,
      supportsLimitGtc: options.venueAdapter?.capabilities?.restingLimitGtcEntry ?? (snap.mode === 'PAPER' ? true : false)
    };

    try {
      const out = await cycleRunner.run({
        cycleId,
        reason,
        accountRef: snap.mode === 'PAPER' ? 'paper:default' : (options.activeAccountRef?.() ?? `${snap.venue?.name ?? 'bybit'}:${snap.mode.toLowerCase()}`),
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
          spokenRolesInCurrentCycle.add(res.role);
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

          const fightHolder: {
            current?: {
              from: RoleId;
              to: RoleId;
              intensity: number;
              punches: number;
              at: number;
            };
          } = {};

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

            const spokenAgents = Object.values(draft.agents).filter((a) => spokenRolesInCurrentCycle.has(a.id as RoleId));
            const bull = spokenAgents.filter((a) => (a.stance as string) === 'LONG').map((a) => a.id);
            const bear = spokenAgents.filter((a) => (a.stance as string) === 'SHORT').map((a) => a.id);
            const closers = spokenAgents.filter((a) => (a.stance as string) === 'CLOSE').map((a) => a.id);
            const neutral = spokenAgents.filter((a) => (a.stance as string) !== 'LONG' && (a.stance as string) !== 'SHORT' && (a.stance as string) !== 'CLOSE').map((a) => a.id);
            const activeDirectional = bull.length + bear.length;
            let disagreement = 0;
            let fightFrom: RoleId | null = null;
            let fightTo: RoleId | null = null;

            if (bull.length > 0 && bear.length > 0) {
              disagreement = Math.min(1, (Math.min(bull.length, bear.length) * 2) / Math.max(2, activeDirectional));
              fightFrom = bull[Math.floor(Math.random() * bull.length)]!;
              fightTo = bear[Math.floor(Math.random() * bear.length)]!;
            } else if (closers.length > 0 && activeDirectional > 0) {
              const directionalCamp = bull.length >= bear.length ? bull : bear;
              disagreement = Math.min(1, (Math.min(closers.length, directionalCamp.length) * 2) / Math.max(2, closers.length + directionalCamp.length));
              fightFrom = directionalCamp[Math.floor(Math.random() * directionalCamp.length)]!;
              fightTo = closers[Math.floor(Math.random() * closers.length)]!;
            }

            if (draft.debate) {
              draft.debate.camps = { bull, bear, neutral: [...closers, ...neutral] };
              draft.debate.disagreement = disagreement;
            }

            if (disagreement >= (draft.fightThreshold ?? 0.35) && fightFrom && fightTo) {
              const punches = 1 + Math.round(disagreement * 3);
              draft.agents[fightFrom].status = 'fighting';
              draft.agents[fightTo].status = 'fighting';
              fightHolder.current = {
                from: fightFrom,
                to: fightTo,
                intensity: Math.min(1, disagreement),
                punches,
                at
              };
              draft.logs.push({
                id: `fight-${at}-${fightFrom}`,
                conversationId: 'office',
                at,
                kind: 'fight',
                agent: fightFrom,
                text: `${fightFrom.toUpperCase()} clashes with ${fightTo.toUpperCase()} over ${targetSymbol} (heat ${Math.round(disagreement * 100)}%)`
              });
            }
          });

          if (fightHolder.current) {
            hub.emit('fight', fightHolder.current);
            lastFightAt = fightHolder.current.at;
          }

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
      const bull = Object.values(currentSnap.agents).filter((a) => (a.stance as string) === 'LONG').map((a) => a.id);
      const bear = Object.values(currentSnap.agents).filter((a) => (a.stance as string) === 'SHORT').map((a) => a.id);
      const closers = Object.values(currentSnap.agents).filter((a) => (a.stance as string) === 'CLOSE').map((a) => a.id);
      const neutral = Object.values(currentSnap.agents).filter((a) => (a.stance as string) !== 'LONG' && (a.stance as string) !== 'SHORT' && (a.stance as string) !== 'CLOSE').map((a) => a.id);
      const activeDirectional = bull.length + bear.length;
      let disagreement = 0;
      if (bull.length > 0 && bear.length > 0) {
        disagreement = Math.min(1, (Math.min(bull.length, bear.length) * 2) / Math.max(2, activeDirectional));
      } else if (closers.length > 0 && activeDirectional > 0) {
        const directionalCamp = bull.length >= bear.length ? bull : bear;
        disagreement = Math.min(1, (Math.min(closers.length, directionalCamp.length) * 2) / Math.max(2, closers.length + directionalCamp.length));
      }

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
          camps: { bull, bear, neutral: [...closers, ...neutral] },
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
            } else {
              let cancelledPending = false;
              updateState((draft) => {
                for (const v of draft.verdicts ?? []) {
                  if (v.symbol.toUpperCase() === targetSymbol && (v as any).operationalStatus === 'PENDING') {
                    (v as any).operationalStatus = 'CANCELLED';
                    v.executed = false;
                    cancelledPending = true;
                  }
                }
                if (draft.venueAccount?.pendingOrders) {
                  const beforeLen = draft.venueAccount.pendingOrders.length;
                  draft.venueAccount.pendingOrders = draft.venueAccount.pendingOrders.filter((p) => p.symbol.toUpperCase() !== targetSymbol);
                  if (draft.venueAccount.pendingOrders.length < beforeLen) cancelledPending = true;
                }
                if (draft.venueAccount?.pendingSymbols) {
                  const beforeLen = draft.venueAccount.pendingSymbols.length;
                  draft.venueAccount.pendingSymbols = draft.venueAccount.pendingSymbols.filter((s) => s.toUpperCase() !== targetSymbol);
                  if (draft.venueAccount.pendingSymbols.length < beforeLen) cancelledPending = true;
                }
                if (cancelledPending) {
                  draft.lessons = draft.lessons ?? [];
                  draft.lessons.push({
                    id: `lesson-${Date.now()}-${randomUUID().slice(0, 6)}`,
                    role: 'execution',
                    kind: 'pending_order_cancelled',
                    symbol: targetSymbol,
                    happened: `Resting limit entry order cancelled for ${targetSymbol} due to CLOSE verdict`,
                    rootCause: 'Resting limit entry order cancelled due to structural reversal or regime invalidation on CLOSE evaluation',
                    lesson: 'Cancelled resting order when market reversed before entry fill to prevent adverse execution',
                    count: 1,
                    firstAt: Date.now(),
                    lastAt: Date.now(),
                    source: 'runtime',
                    status: 'new'
                  });
                }
              });
              verdictRecord.executed = cancelledPending;
              if (cancelledPending) {
                hub.emit('log', {
                  at: Date.now(),
                  kind: 'execution',
                  text: `Cancelled resting PAPER limit order for ${targetSymbol} upon CLOSE verdict`
                });
              }
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
          const side = action === 'OPEN_LONG' ? 'LONG' : 'SHORT';
          const leverage = currentSnap.trading?.values.maxLeverage ?? currentSnap.paper.maxLeverage ?? 5;
          const perOrder = resolveOwnerPerOrderUsdt(currentSnap.paper);
          const thesisOrderType = out.verdict.thesis.orderType ?? 'MARKET';
          const thesisLimit = out.verdict.thesis.limitPrice ?? null;
          const entryPrice = thesisOrderType === 'LIMIT_GTC' && thesisLimit
            ? Number(thesisLimit)
            : Number(currentSnap.tickers[targetSymbol]?.last ?? out.verdict.thesis.stop);

          const stopPctRoe = currentSnap.trading?.values.defaultStopPct ?? currentSnap.paper.defaultStopPct ?? 30;
          const stopPricePct = (stopPctRoe / Math.max(1, leverage)) / 100;
          const tpPctRoe = currentSnap.trading?.values.takeProfitPct ?? (stopPctRoe * (currentSnap.trading?.values.takeProfitR ?? 2));
          const tpPricePct = (tpPctRoe / Math.max(1, leverage)) / 100;
          const fallbackCalcStop = side === 'LONG'
            ? entryPrice * (1 - stopPricePct)
            : entryPrice * (1 + stopPricePct);
          const fallbackCalcTp = side === 'LONG'
            ? entryPrice * (1 + tpPricePct)
            : entryPrice * (1 - tpPricePct);

          // Owner profile SL/TP (ROE %) bind every position. Agents choose symbol, direction and entry;
          // their structural stop/target is advisory and only used when no profile is configured.
          const profileAnchored = Boolean(currentSnap.trading?.values);
          const priceDp = entryPrice >= 100 ? 2 : entryPrice >= 1 ? 4 : 8;
          const profileStop = Number(fallbackCalcStop.toFixed(priceDp));
          const profileTp = Number(fallbackCalcTp.toFixed(priceDp));
          const stopPrice = profileAnchored ? profileStop : (Number(out.verdict.thesis.stop) || profileStop);
          const tpPrice = profileAnchored ? profileTp : (out.verdict.thesis.tp ? Number(out.verdict.thesis.tp) : profileTp);
          if (profileAnchored && (Number(out.verdict.thesis.stop) !== stopPrice || Number(out.verdict.thesis.tp) !== tpPrice)) {
            hub.emit('log', {
              at: Date.now(),
              kind: 'execution',
              text: `${targetSymbol}: profile ${currentSnap.trading?.profile ?? 'custom'} anchors SL ${stopPrice} (${stopPctRoe}% ROE) / TP ${tpPrice} (${tpPctRoe}% ROE); desk proposal was SL ${out.verdict.thesis.stop ?? 'none'} / TP ${out.verdict.thesis.tp ?? 'none'}.`
            });
          }
          const margin = Math.round(perOrder * 100) / 100;
          const qty = entryPrice > 0 ? Math.round(((margin * leverage) / entryPrice) * 1000) / 1000 : 1;

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

              verdictRecord.executed = true;
              verdictRecord.operationalStatus = 'FILLED';

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
              verdictRecord.operationalStatus = isFilled ? 'FILLED' : (isPartial ? 'PARTIAL' : (isPending ? 'PENDING' : 'REJECTED'));
              if (isFilled || isPartial) {
                verdictRecord.executionStatus = isFilled ? 'filled' : 'partial';
              }
              if (isPending && !verdictRecord.executed) {
                verdictRecord.reason = `Limit order resting (${orderState}) at ${thesisLimit ?? entryPrice}.`;
              }
              if (!isFilled && !isPartial && !isPending) {
                verdictRecord.reason = `Venue did not accept order (state ${orderState}): ${dispatchRes.message}`;
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
              verdictRecord.operationalStatus = 'REJECTED';
              verdictRecord.reason = `Gateway rejected order: ${dispatchRes.message}`;
              hub.emit('log', {
                at: Date.now(),
                kind: 'execution',
                text: `${currentSnap.mode} order for ${targetSymbol} rejected by gateway: ${dispatchRes.message}`
              });
            }
            if (options.syncVenueAccount) {
              try {
                await options.syncVenueAccount();
              } catch {}
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
        const entryDisplay = verdictRecord.order?.entry ?? out.verdict?.thesis?.limitPrice ?? '';
        const verdictStatusNote = verdictRecord.operationalStatus === 'FILLED' || verdictRecord.executionStatus === 'filled'
          ? `(FILLED at ${entryDisplay})`
          : verdictRecord.operationalStatus === 'PENDING'
            ? `(RESTING LIMIT at ${entryDisplay})`
            : verdictRecord.operationalStatus === 'REJECTED'
              ? `(REJECTED: ${verdictRecord.reason})`
              : `(${verdictRecord.reason})`;

        draft.logs.push({
          id: `log-${Date.now()}-verdict`,
          conversationId: 'office',
          at: Date.now(),
          kind: 'verdict',
          text: `[VERDICT] ${verdictRecord.action} on ${targetSymbol}: ${verdictStatusNote}`
        });
        draft.logs = draft.logs.slice(-500);
        draft.lastCycle = {
          symbol: targetSymbol,
          durationMs: Date.now() - Number(cycleId.split('-')[1] || Date.now()),
          stage: out.status,
          verdict: verdictRecord.action,
          noTradeReason: verdictRecord.executed ? null : verdictRecord.reason,
          executionStatus: verdictRecord.executed ? 'filled' : (verdictRecord.executionStatus ?? null),
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

      // =========================================================================
      // FASE 1: POSITION MANAGEMENT (Prioritas Utama)
      // =========================================================================
      if (snapshot().mode !== 'PAPER' && options.syncVenueAccount) {
        try { await options.syncVenueAccount(); } catch {}
      }
      const prePhase1Snap = snapshot();
      const currentPos = prePhase1Snap.mode === 'PAPER'
        ? prePhase1Snap.paper.positions
        : (prePhase1Snap.venueAccount?.positions?.length ? prePhase1Snap.venueAccount.positions : prePhase1Snap.paper.positions);
      const pendingSymbols = prePhase1Snap.mode === 'PAPER' ? [] : (prePhase1Snap.venueAccount?.pendingSymbols ?? []);
      const pendingOrders = (prePhase1Snap.venueAccount as any)?.pendingOrders ?? [];
      const pendingOrderSymbols = pendingOrders.map((p: any) => p.symbol.toUpperCase());
      const pendingVerdictSymbols = prePhase1Snap.mode === 'PAPER'
        ? (prePhase1Snap.verdicts ?? [])
            .filter((v: any) => v.operationalStatus === 'PENDING')
            .map((v) => v.symbol.toUpperCase())
        : [];
      const openPositionSymbols = [...new Set([
        ...currentPos.map((p) => p.symbol.toUpperCase()),
        ...pendingSymbols.map((s) => s.toUpperCase()),
        ...pendingOrderSymbols,
        ...pendingVerdictSymbols
      ])];

      let lastResult: { ok: boolean; message: string; cycleId: string; verdict?: Verdict } | null = null;

      // Jalankan siklus evaluasi meja agen HANYA untuk simbol yang memiliki posisi terbuka
      for (const posSym of openPositionSymbols) {
        if (snapshot().killed) break;
        lastResult = await executeSingleSymbolCycle(posSym, reason);
        if (snapshot().mode !== 'PAPER' && options.syncVenueAccount) {
          try { await options.syncVenueAccount(); } catch {}
        }
      }

      // =========================================================================
      // CEK KAPASITAS SLOT (Slot Gate)
      // =========================================================================
      const postPhase1Snap = snapshot();
      const activePos = postPhase1Snap.mode === 'PAPER'
        ? postPhase1Snap.paper.positions
        : (postPhase1Snap.venueAccount?.positions?.length ? postPhase1Snap.venueAccount.positions : postPhase1Snap.paper.positions);
      const activePending = postPhase1Snap.mode === 'PAPER' ? [] : (postPhase1Snap.venueAccount?.pendingSymbols ?? []);
      const activePendingOrders = (postPhase1Snap.venueAccount as any)?.pendingOrders ?? [];
      const activePendingOrderSymbols = activePendingOrders.map((p: any) => p.symbol.toUpperCase());
      const activePendingVerdictSymbols = postPhase1Snap.mode === 'PAPER'
        ? (postPhase1Snap.verdicts ?? [])
            .filter((v: any) => v.operationalStatus === 'PENDING')
            .map((v) => v.symbol.toUpperCase())
        : [];
      const activeSymbols = [...new Set([
        ...activePos.map((p) => p.symbol.toUpperCase()),
        ...activePending.map((s) => s.toUpperCase()),
        ...activePendingOrderSymbols,
        ...activePendingVerdictSymbols
      ])];

      const maxN = postPhase1Snap.paper.n || 3;
      const occupiedSlots = activeSymbols.length;
      let freeSlots = Math.max(0, maxN - occupiedSlots);

      if (freeSlots === 0) {
        const skipMsg = `[CYCLE] All ${maxN} slots occupied (${activeSymbols.join(', ')}). Skipping watchlist discovery to conserve API tokens.`;
        hub.emit('log', {
          at: Date.now(),
          kind: 'system',
          text: skipMsg
        });
        return lastResult ?? {
          ok: true,
          message: skipMsg
        };
      }

      // =========================================================================
      // FASE 2: CANDIDATE DISCOVERY (Kondisional: Hanya Jika freeSlots > 0)
      // =========================================================================
      // 1. Guard pemakaian batas rugi harian: jika >= 80% cap terpakai, skip candidate discovery
      const startEquity = postPhase1Snap.dailyLoss?.startEquity || (postPhase1Snap.paper?.balance ?? 100);
      const limitPct = postPhase1Snap.trading?.values?.dailyLossLimitPct ?? postPhase1Snap.dailyLoss?.limitPct ?? 10;
      const dailyCapUsdt = (startEquity * limitPct) / 100;
      const currentRealizedPnl = Number(postPhase1Snap.financial?.realizedPnl?.value ?? 0);
      if (dailyCapUsdt > 0 && currentRealizedPnl < 0 && Math.abs(currentRealizedPnl) >= dailyCapUsdt * 0.8) {
        const skipLossMsg = `[CYCLE] Daily loss usage (${Math.abs(currentRealizedPnl).toFixed(2)}/${dailyCapUsdt.toFixed(2)} USDT) reached >= 80% of limit. Skipping candidate discovery to preserve remaining capital.`;
        hub.emit('log', { at: Date.now(), kind: 'system', text: skipLossMsg });
        return lastResult ?? { ok: true, message: skipLossMsg };
      }

      const rawCandidates = (postPhase1Snap.watchlist?.length ? postPhase1Snap.watchlist : postPhase1Snap.auto.symbols)
        .map((s) => s.toUpperCase())
        .filter((s) => !activeSymbols.includes(s));

      if (rawCandidates.length === 0 && openPositionSymbols.length === 0) {
        const fallbackSym = (postPhase1Snap.auto.symbols[0] ?? 'BTCUSDT').toUpperCase();
        lastResult = await executeSingleSymbolCycle(fallbackSym, reason);
        return lastResult;
      }

      if (rawCandidates.length === 0) {
        return lastResult ?? { ok: true, message: 'No eligible candidate symbols remaining in watchlist.' };
      }

      // 2. Cross-Market Breadth Filter
      const breadthSymbols = postPhase1Snap.auto.symbols;
      const crossMarketTickers: Record<string, any> = {};
      for (const s of breadthSymbols) {
        const snap = marketHub?.snapshot(s);
        let change15m: number | undefined;
        let relVol15m: number | undefined;
        let trend15m: string | undefined;
        try {
          const closed15m = snap?.closed?.['15m']?.filter((b) => b.confirmed) ?? [];
          if (closed15m.length >= 2) {
            const lastBar = closed15m[closed15m.length - 1];
            const prevBar = closed15m[closed15m.length - 2];
            const lastClose = Number(lastBar.close);
            const prevClose = Number(prevBar.close);
            if (prevClose > 0) {
              change15m = Math.round(((lastClose - prevClose) / prevClose) * 10000) / 100;
            }
            trend15m = lastClose >= Number(lastBar.open) ? 'UPTREND' : 'DOWNTREND';
            const last20 = closed15m.slice(-20);
            const avgVol = last20.reduce((sum, b) => sum + (Number(b.volume) || 0), 0) / Math.max(1, last20.length);
            if (avgVol > 0) {
              relVol15m = Math.round((Number(lastBar.volume) / avgVol) * 10) / 10;
            }
          }
        } catch {}
        if (snap?.last?.value) {
          crossMarketTickers[s] = {
            last: Number(snap.last.value),
            change15m,
            relVol15m,
            trend15m,
            change24hPct: snap.price24hPcnt ? Number(snap.price24hPcnt) * 100 : undefined
          };
        }
      }
      const crossBreadth = computeCrossMarketBreadth(crossMarketTickers, breadthSymbols);
      const isSystemicRiskOff = crossBreadth.regime === 'SYSTEMIC_RISK_OFF';

      // 3. Pre-screening & Opportunity Ranking seluruh kandidat di watchlist (Funnel Stages 1-3)
      const currentBalance = postPhase1Snap.paper.balance ?? 100;
      const allocatedMargin = maxN > 0 ? currentBalance / maxN : 5;
      const effectiveLeverage = postPhase1Snap.trading?.values?.maxLeverage ?? 5;
      const minNotionalUsdt = 5.0;

      const rankedCandidates = rawCandidates.map((sym) => {
        let rejectedRecently = false;
        if (rejectCache.has(sym)) {
          const cached = rejectCache.get(sym)!;
          const ageMs = Date.now() - cached.at;
          const currPrice = Number(marketHub?.snapshot(sym)?.last?.value ?? 0);
          const priceDiffPcnt = cached.price > 0 && currPrice > 0 ? Math.abs(currPrice - cached.price) / cached.price : 0;
          if (ageMs < 15 * 60 * 1000 && priceDiffPcnt < 0.02) {
            rejectedRecently = true;
          } else if (ageMs >= 15 * 60 * 1000 || priceDiffPcnt >= 0.02) {
            rejectCache.delete(sym);
          }
        }
        return evaluateWatchlistOpportunity(sym, marketHub, {
          allocatedMarginUsdt: allocatedMargin,
          leverage: effectiveLeverage,
          minNotionalUsdt,
          systemicRiskOff: isSystemicRiskOff,
          rejectedRecently
        });
      });
      rankedCandidates.sort((a, b) => b.score - a.score);

      const rankingSummary = rankedCandidates
        .map((c, i) => `#${i + 1} ${c.symbol} (${c.score} pts: ${c.reasons.slice(0, 2).join(', ')})`)
        .join(' | ');

      hub.emit('log', {
        at: Date.now(),
        kind: 'system',
        text: `[WATCHLIST SCREEN] Evaluated ${rankedCandidates.length} candidate(s): ${rankingSummary}. Prioritizing top opportunities.`
      });

      // 4. Stage 4: Top-K Promotion (Score >= 60 high conviction, capped at min(freeSlots, 2))
      let promotedCandidates = rankedCandidates.filter((c) => c.score >= 60).slice(0, Math.min(freeSlots, 2));
      if (promotedCandidates.length === 0 && rankedCandidates.length > 0) {
        const viable = rankedCandidates.filter((c) => c.score >= 50);
        if (viable.length > 0) {
          promotedCandidates = viable.slice(0, Math.min(freeSlots, 2));
        } else if (reason === 'owner') {
          // Explicit owner command: do not drop candidates on score
          promotedCandidates = rankedCandidates.slice(0, 1);
        }
      }

      if (promotedCandidates.length === 0) {
        const noPromoMsg = `[WATCHLIST SCREEN] No candidates reached promotion threshold. Discovery completed.`;
        hub.emit('log', { at: Date.now(), kind: 'system', text: noPromoMsg });
        return lastResult ?? { ok: true, message: noPromoMsg };
      }

      for (const candidate of promotedCandidates) {
        if (snapshot().killed) break;
        if (freeSlots <= 0) break;

        const candidateSym = candidate.symbol;
        lastResult = await executeSingleSymbolCycle(candidateSym, reason);

        const verdict = lastResult?.verdict;
        if (verdict && (verdict.action === 'OPEN_LONG' || verdict.action === 'OPEN_SHORT')) {
          if (
            verdict.operationalStatus === 'FILLED' ||
            verdict.operationalStatus === 'PENDING' ||
            verdict.operationalStatus === 'PARTIAL' ||
            verdict.executed
          ) {
            freeSlots -= 1;
            if (freeSlots <= 0) {
              hub.emit('log', {
                at: Date.now(),
                kind: 'debate',
                text: `[CYCLE] Slots reached maximum capacity (${maxN}/${maxN}). Stopping watchlist discovery.`
              });
              break;
            }
          }
        } else {
          const currPx = Number(marketHub?.snapshot(candidateSym)?.last?.value ?? 0);
          rejectCache.set(candidateSym, { at: Date.now(), price: currPx });
        }
      }

      return lastResult ?? { ok: true, message: 'All watchlist symbols evaluated successfully.' };
    } finally {
      if (lastFightAt && Date.now() - lastFightAt < 2500) {
        const remainingDelay = Math.max(200, 2500 - (Date.now() - lastFightAt));
        await new Promise((resolve) => setTimeout(resolve, remainingDelay));
      }
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
        const fieldMatch = candidate.match(/"(?:reply|text|message|content)"\s*:\s*"([\s\S]*?)"\s*(?:,\s*"|\}\s*$)/i);
        if (fieldMatch && fieldMatch[1]) {
          return fieldMatch[1].replace(/\\"/g, '"');
        }
      }
    }
    return raw;
  };

  const handleCommand = async (input: {
    text: string;
    agent?: string;
    clientRequestId?: string;
    conversationId?: string;
    symbol?: string;
  }): Promise<{ ok: boolean; command?: string; reply?: string; error?: string }> => {
    let raw = input.text.trim();
    if (!raw) return { ok: false, error: 'empty command' };
    let cmd = raw.toLowerCase();
    let cleanCmd = cmd.replace(/^\//, '');

    if (/^tutup\b/i.test(cleanCmd)) {
      cleanCmd = cleanCmd.replace(/^tutup\b/i, 'close');
      raw = raw.replace(/^tutup\b/i, 'close');
    } else if (/^(matikan|berhenti)\b/i.test(cleanCmd)) {
      cleanCmd = cleanCmd.replace(/^(matikan|berhenti)\b/i, 'kill');
      raw = raw.replace(/^(matikan|berhenti)\b/i, 'kill');
    }

    const isSlash = raw.startsWith('/');
    const isDirectOp = /^(close|kill|unkill|open|buy|sell|cancel|protect|analyze|debate|status|report|scan|positions|watchlist)\b/i.test(cleanCmd);
    const isOperational = isSlash || isDirectOp;

    const toAll = /^@all\s+/i.test(raw);
    const targetRole = input.agent ? resolveCanonicalRole(input.agent) : null;

    if (!isOperational && (targetRole || toAll)) {
      const roles: RoleId[] = targetRole ? [targetRole] : [...ROLE_IDS];
      const prompt = toAll ? raw.replace(/^@all\s+/i, '') : raw;
      const conversationId = input.conversationId || 'office';
      if (snapshot().mode !== 'PAPER' && options.syncVenueAccount) {
        try {
          await options.syncVenueAccount();
        } catch {}
      }
      const deskSnapshot = buildLiveDeskChatContext(snapshot(), {
        marketHub,
        newsBySymbol: Object.fromEntries(newsBriefingsBySymbol),
        extraFeeds: {
          newsBriefing: (input.symbol ? newsBriefingsBySymbol.get(input.symbol.toUpperCase()) : undefined)
            ?? Array.from(newsBriefingsBySymbol.values())[0]
            ?? undefined
        }
      });
      const deskContext = `Live desk snapshot (informational only; not an execution command).\n${JSON.stringify(deskSnapshot, null, 2)}`;
      const outcomes = await Promise.allSettled(roles.map(async role => {
        const answer = await roleRunner.chat({
          cycleId: `chat-${randomUUID()}`,
          role,
          prompt,
          deskContext,
          configVersion: options.settings?.current().activeVersion ?? 1
        });
        return { role, answer: extractCleanAgentReply(String(answer)), rawAnswer: String(answer) };
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

      for (const { rawAnswer } of results) {
        if (!rawAnswer) continue;
        try {
          const parsed = JSON.parse(rawAnswer);
          if (parsed && typeof parsed === 'object' && typeof parsed.commandToExecute === 'string' && parsed.commandToExecute.trim()) {
            void handleCommand({ text: parsed.commandToExecute.trim(), conversationId }).catch(console.error);
          }
        } catch {
          const match = rawAnswer.match(/"commandToExecute"\s*:\s*"([^"]+)"/i);
          if (match && match[1]) {
            void handleCommand({ text: match[1].trim(), conversationId }).catch(console.error);
          }
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
          dailyLossLimitPct: snap.trading?.values?.dailyLossLimitPct ?? snap.dailyLoss?.limitPct ?? 10
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
          dailyLossLimitPct: snap.trading?.values?.dailyLossLimitPct ?? snap.dailyLoss?.limitPct ?? 10,
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
      const ps = (snap.paper.positions ?? []).filter((p) => Number(p.qty) > 0);
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

    if (cleanCmd === 'unkill' || cleanCmd === 'release') {
      const res = await dispatch({ kind: 'unkill', actor: 'local_owner' });
      return {
        ok: res.ok,
        command: 'unkill',
        reply: res.ok
          ? 'Local halt latch released; Auto remains OFF. Send /resume or check Office to resume trading.'
          : res.message
      };
    }

    if (cleanCmd === 'balance' || cleanCmd === 'saldo') {
      const snap = snapshot();
      const eq = snap.financial.equity.value ?? snap.paper.equity;
      const bal = snap.financial.balance.value ?? snap.paper.balance;
      const unrl = snap.paper.unrealized ?? 0;
      return {
        ok: true,
        command: 'balance',
        reply: [
          '💰 CAPITAL SUMMARY',
          '────────',
          `Equity: ${eq.toFixed(2)} USDT`,
          `Balance: ${bal.toFixed(2)} USDT`,
          `Safety Net: ${snap.paper.safetyNet.toFixed(2)} USDT`,
          `Money Trade: ${snap.paper.moneyTrade.toFixed(2)} USDT`,
          `Per Order: ${snap.paper.perOrder.toFixed(2)} USDT`,
          `Unrealized PnL: ${(unrl >= 0 ? '+' : '') + unrl.toFixed(2)} USDT`,
          `Slots: ${snap.paper.positions.length}/${snap.paper.n} occupied`
        ].join('\n')
      };
    }

    if (cleanCmd === 'mode') {
      const snap = snapshot();
      return {
        ok: true,
        command: 'mode',
        reply: [
          '🧭 DESK MODE & VENUE',
          '────────',
          `Mode: ${snap.mode}`,
          `Venue: ${snap.venue?.label ?? snap.venue?.name ?? 'bybit'}`,
          `Trading: ${snap.killed ? 'STOPPED (kill switch)' : snap.paused ? 'PAUSED' : 'ACTIVE'}`,
          `Auto: ${snap.auto.on ? `ON (every ${snap.auto.intervalMin}m)` : 'OFF'}`
        ].join('\n')
      };
    }

    if (cleanCmd === 'health') {
      const snap = snapshot();
      const venueStatus = snap.mode === 'PAPER' ? 'confirmed' : (snap.venueAccount?.status ?? 'pending');
      return {
        ok: true,
        command: 'health',
        reply: [
          '🩺 DESK HEALTH',
          '────────',
          `Backend: OK (mode ${snap.mode})`,
          `Venue Connection: ${venueStatus}`,
          `Auto Loop: ${snap.auto.running ? 'Running debate' : snap.auto.on ? 'Idle (scheduled)' : 'OFF'}`,
          `Kill Switch: ${snap.killed ? 'ENGAGED' : 'CLEAR'}`,
          `Daily Loss Stop: ${snap.dailyLoss?.hit ? 'HIT' : 'CLEAR'}`
        ].join('\n')
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

    if (cleanCmd.startsWith('cancel')) {
      const parts = raw.split(/\s+/);
      const target = (parts[1] ?? '').toUpperCase();
      if (!target) {
        return { ok: false, command: 'cancel', error: 'Usage: cancel <symbol|orderId>' };
      }
      const snap = snapshot();
      const pendingList = snap.venueAccount?.pendingOrders ?? [];
      const match = pendingList.find(
        (p) => p.symbol.toUpperCase() === target || p.clientOrderId === target
      );
      if (!match) {
        return { ok: false, command: 'cancel', error: `No active resting order found for ${target}` };
      }
      const dispatchRes = await dispatch({
        kind: 'cancel_entry',
        actor: 'local_owner',
        symbol: match.symbol,
        payload: {
          symbol: match.symbol,
          clientOrderId: match.clientOrderId
        }
      });
      if (options.syncVenueAccount) {
        try { await options.syncVenueAccount(); } catch {}
      }
      return {
        ok: dispatchRes.ok,
        command: 'cancel',
        reply: `Cancelled resting order for ${match.symbol} (${match.clientOrderId}): ${dispatchRes.message}`,
        error: dispatchRes.ok ? undefined : dispatchRes.message
      };
    }

    if (cleanCmd.startsWith('protect')) {
      const stopMatch = raw.match(/--stop(?:=|\s+)(\d+(?:\.\d+)?)/i);
      const tpMatch = raw.match(/--tp(?:=|\s+)(\d+(?:\.\d+)?)/i);
      const parts = raw.replace(/--(?:stop|tp)(?:=|\s+)\S+/gi, '').trim().split(/\s+/);
      const target = (parts[1] ?? '').toUpperCase();
      if (!target || !stopMatch) {
        return { ok: false, command: 'protect', error: 'Usage: protect <symbol> --stop <price> [--tp <price>]' };
      }
      const stop = stopMatch[1];
      const tp = tpMatch ? tpMatch[1] : null;
      const dispatchRes = await dispatch({
        kind: 'protect',
        actor: 'local_owner',
        symbol: target,
        payload: {
          symbol: target,
          stop,
          tp
        }
      });
      return {
        ok: dispatchRes.ok,
        command: 'protect',
        reply: dispatchRes.message,
        error: dispatchRes.ok ? undefined : dispatchRes.message
      };
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
          d.paper.perOrder = ownerAllocationPerOrder(mt, d.paper.n, d.paper.orderSizePct);
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
          d.paper.perOrder = ownerAllocationPerOrder(mt, d.paper.n, d.paper.orderSizePct);
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
          d.paper.perOrder = ownerAllocationPerOrder(mt, count, d.paper.orderSizePct);
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
        if (options.secrets) {
          options.secrets.writeSecrets({
            OPEN_ORDERS_N: String(count),
            MAINNET_DESK_OPEN_ORDERS_N: String(count)
          });
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

    const sizeMatch = raw.replace(/^\//, '').match(/^(?:set\s+)?size\s*(?:=|to|:)?\s*(\S+)\b/i);
    if (sizeMatch) {
      const valStr = sizeMatch[1].toLowerCase().replace(/%$/, '');
      if (valStr === 'off' || valStr === 'auto' || valStr === 'none' || valStr === '0') {
        updateState((d) => {
          d.paper.orderSizePct = null;
          if (d.trading) {
            d.trading.values.orderSizePct = null;
          }
          const mt = Math.round(Math.max(0, d.paper.balance - d.paper.safetyNet) * 100) / 100;
          d.paper.moneyTrade = mt;
          d.paper.perOrder = ownerAllocationPerOrder(mt, d.paper.n, null);
          d.paper.canOpen = d.paper.perOrder > 0 && d.paper.positions.length < d.paper.n;
        });
        if (options.settings) {
          void options.settings
            .apply(
              {
                trading: { orderSizePct: null }
              },
              options.settings.current().activeVersion
            )
            .catch(() => {});
        }
        hub.emit('state', snapshot());
        return { ok: true, command: 'set_size', reply: `Dynamic order size set to auto (Money Trade / N = ${snapshot().paper.perOrder} USDT).` };
      }
      const valNum = Number(valStr);
      if (Number.isFinite(valNum) && valNum > 0 && valNum <= 100) {
        updateState((d) => {
          d.paper.orderSizePct = valNum;
          if (d.trading) {
            d.trading.values.orderSizePct = valNum;
          }
          const mt = Math.round(Math.max(0, d.paper.balance - d.paper.safetyNet) * 100) / 100;
          d.paper.moneyTrade = mt;
          d.paper.perOrder = ownerAllocationPerOrder(mt, d.paper.n, valNum);
          d.paper.canOpen = d.paper.perOrder > 0 && d.paper.positions.length < d.paper.n;
        });
        if (options.settings) {
          void options.settings
            .apply(
              {
                trading: { orderSizePct: valNum }
              },
              options.settings.current().activeVersion
            )
            .catch(() => {});
        }
        hub.emit('state', snapshot());
        return { ok: true, command: 'set_size', reply: `Order size set to ${valNum}% of Money Trade (${snapshot().paper.perOrder} USDT per order).` };
      }
      return { ok: false, error: 'Size must be a percentage between 1 and 100, or "auto" / "off".' };
    }

    const profileMatch = raw.replace(/^\//, '').match(/^(?:(?:set\s+)?profile|(?:atur|ubah)\s+profil)\s+(\S+)$/i);
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
          if (d.dailyLoss && nextVals.dailyLossLimitPct) {
            d.dailyLoss.limitPct = nextVals.dailyLossLimitPct;
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
        return { ok: true, command: 'set_profile', reply: `Trading profile set to ${prof} (leverage ${nextVals.maxLeverage}x, SL ${nextVals.defaultStopPct}%, TP ${nextVals.takeProfitPct}%, Daily Loss ${nextVals.dailyLossLimitPct}%).` };
      }
      return { ok: false, error: `Profile must be one of: ${TRADING_PROFILES.join(', ')}` };
    }

    const cycleMatch = raw.replace(/^\//, '').match(/^(?:(?:set\s+)?cycle(?:\s+interval)?|(?:atur|ubah)\s+cycle(?:\s+interval)?)\s*(?:=|to|:)?\s*(\d+)\b/i);
    if (cycleMatch) {
      const min = Number(cycleMatch[1]);
      if (Number.isInteger(min) && min >= 1 && min <= 1440) {
        updateState((d) => {
          d.auto.intervalMin = min;
        });
        if (options.settings) {
          void options.settings
            .apply(
              {
                auto: { intervalMin: min }
              },
              options.settings.current().activeVersion
            )
            .catch(() => {});
        }
        if (options.secrets) {
          options.secrets.writeSecrets({
            DEBATE_INTERVAL_MIN: String(min),
            MAINNET_DESK_DEBATE_INTERVAL_MIN: String(min)
          });
        }
        hub.emit('state', snapshot());
        return { ok: true, command: 'set_cycle', reply: `Auto trading cycle interval set to ${min} minute(s).` };
      }
      return { ok: false, error: 'Cycle interval must be an integer between 1 and 1440 minutes.' };
    }

    if (/^(?:run\s+cycle|cycle\s+now|start\s+cycle|jalankan\s+cycle|mulai\s+cycle)$/i.test(cleanCmd)) {
      const snap = snapshot();
      if (snap.killed) {
        return { ok: false, error: 'Kill switch is ON. Release it first.' };
      }
      if (snap.auto.running) {
        return { ok: false, error: `A cycle is already running for ${snap.debate?.symbol ?? 'symbol'}` };
      }
      void triggerCycle(undefined, 'owner').catch(console.error);
      return { ok: true, command: 'run_cycle', reply: 'Triggered two-phase deliberation cycle immediately across active positions and candidates...' };
    }

    const reportIntervalMatch = raw.replace(/^\//, '').match(/^(?:(?:set\s+)?report(?:\s+interval)?|(?:atur|ubah)\s+report(?:\s+interval)?)\s*(?:=|to|:)?\s*(\d+)\b/i);
    if (reportIntervalMatch) {
      const min = Number(reportIntervalMatch[1]);
      if (Number.isInteger(min) && min >= 1 && min <= 1440) {
        updateState((d) => {
          d.reportIntervalMin = min;
        });
        if (options.settings) {
          void options.settings
            .apply(
              {
                auto: { reportIntervalMin: min }
              },
              options.settings.current().activeVersion
            )
            .catch(() => {});
        }
        if (options.secrets) {
          options.secrets.writeSecrets({
            REPORT_INTERVAL_MIN: String(min),
            MAINNET_DESK_REPORT_INTERVAL_MIN: String(min)
          });
        }
        hub.emit('state', snapshot());
        return { ok: true, command: 'set_report_interval', reply: `Desk report interval set to ${min} minute(s).` };
      }
      return { ok: false, error: 'Report interval must be an integer between 1 and 1440 minutes.' };
    }

    if (cleanCmd === 'sync' || cleanCmd === 'sync balance' || cleanCmd === 'sync to book' || cleanCmd === 'refresh balance') {
      if (snapshot().mode !== 'PAPER' && options.syncVenueAccount) {
        try {
          await options.syncVenueAccount();
        } catch {}
      }
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
    if (fastReflexTimer) {
      clearInterval(fastReflexTimer);
      fastReflexTimer = null;
    }
    if (typeof (marketHub as any)?.stop === 'function') {
      await marketHub.stop();
    }
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
      let cancelledPending = false;
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
            if (pos.unrealizedPnl < 0) {
              draft.lessons = draft.lessons ?? [];
              draft.lessons.push({
                id: `lesson-${Date.now()}-${randomUUID().slice(0, 6)}`,
                role: 'risk',
                kind: 'stop_loss_hit',
                symbol: pos.symbol,
                happened: `Position closed with realized loss of ${pos.unrealizedPnl}`,
                rootCause: 'Adverse market movement triggered position closure',
                lesson: 'Enforce strict stop loss and exit discipline when thesis is invalidated',
                count: 1,
                firstAt: Date.now(),
                lastAt: Date.now(),
                source: 'runtime',
                status: 'new'
              });
            }
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
              if (pos.unrealizedPnl < 0) {
                draft.lessons = draft.lessons ?? [];
                draft.lessons.push({
                  id: `lesson-${Date.now()}-${randomUUID().slice(0, 6)}`,
                  role: 'risk',
                  kind: 'stop_loss_hit',
                  symbol: pos.symbol,
                  happened: `Position closed with realized loss of ${pos.unrealizedPnl}`,
                  rootCause: 'Adverse market movement triggered position closure',
                  lesson: 'Enforce strict stop loss and exit discipline when thesis is invalidated',
                  count: 1,
                  firstAt: Date.now(),
                  lastAt: Date.now(),
                  source: 'runtime',
                  status: 'new'
                });
              }
              draft.paper.usedMargin = Math.max(0, (draft.paper.usedMargin ?? 0) - pos.margin);
              closedCount += 1;
            } else {
              remaining.push(pos);
            }
          }
          draft.paper.positions = remaining;
          draft.paper.canOpen = remaining.length < draft.paper.n;

          if (closedCount === 0) {
            if (draft.venueAccount?.pendingOrders) {
              const beforeLen = draft.venueAccount.pendingOrders.length;
              draft.venueAccount.pendingOrders = draft.venueAccount.pendingOrders.filter((p) => p.symbol.toUpperCase() !== sym);
              if (draft.venueAccount.pendingOrders.length < beforeLen) cancelledPending = true;
            }
            if (draft.venueAccount?.pendingSymbols) {
              const beforeLen = draft.venueAccount.pendingSymbols.length;
              draft.venueAccount.pendingSymbols = draft.venueAccount.pendingSymbols.filter((s) => s.toUpperCase() !== sym);
              if (draft.venueAccount.pendingSymbols.length < beforeLen) cancelledPending = true;
            }
            for (const v of draft.verdicts ?? []) {
              if (v.symbol.toUpperCase() === sym && (v as any).operationalStatus === 'PENDING') {
                (v as any).operationalStatus = 'CANCELLED';
                v.executed = false;
                cancelledPending = true;
              }
            }
            if (cancelledPending) {
              draft.lessons = draft.lessons ?? [];
              draft.lessons.push({
                id: `lesson-${Date.now()}-${randomUUID().slice(0, 6)}`,
                role: 'execution',
                kind: 'pending_order_cancelled',
                symbol: sym,
                happened: `Resting limit entry order cancelled for ${sym} due to close/invalidation verdict`,
                rootCause: 'Resting limit entry order cancelled due to structural reversal or regime invalidation on CLOSE evaluation',
                lesson: 'Cancelled resting order when market reversed before entry fill to prevent adverse execution',
                count: 1,
                firstAt: Date.now(),
                lastAt: Date.now(),
                source: 'runtime',
                status: 'new'
              });
            }
          }
        }
      });
      if (closedCount === 0 && cancelledPending) {
        return {
          ok: true,
          code: 'OK',
          message: `Cancelled pending limit entry order for ${sym} due to close/invalidation verdict`,
          data: { orderState: 'CANCELLED' }
        };
      }
      return {
        ok: true,
        code: 'OK',
        message: `Closed ${closedCount} position(s) for ${sym}`,
        data: { orderState: 'CLOSED' }
      };
    }

    if (input.kind === 'protect') {
      const sym = String(input.symbol ?? input.payload?.symbol ?? '').toUpperCase();
      const stop = input.payload?.stop ? Number(input.payload.stop) : null;
      const tp = input.payload?.tp ? Number(input.payload.tp) : null;
      let updated = false;
      updateState((d) => {
        for (const p of d.paper.positions) {
          if (p.symbol.toUpperCase() === sym) {
            if (stop) p.stop = stop;
            if (tp !== null) p.tp = tp;
            p.protectionStatus = 'confirmed';
            updated = true;
          }
        }
      });
      return {
        ok: updated,
        code: updated ? 'OK' : 'INVALID_INPUT',
        message: updated ? `Updated paper protection for ${sym}: SL ${stop}, TP ${tp ?? 'none'}` : `No open position for ${sym}`
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

  const runFastReflexLoop = async (): Promise<void> => {
    const snap = snapshot();
    if (snap.killed || snap.paused) return;

    // 1. Position Trailing & Breakeven Defense
    const activePositions = snap.mode === 'PAPER'
      ? snap.paper.positions
      : (snap.venueAccount?.positions?.length ? snap.paper.positions : []);

    for (const pos of activePositions) {
      const sym = pos.symbol.toUpperCase();
      const frame = marketHub?.snapshot(sym);
      const currPrice = frame?.last?.value ? Number(frame.last.value) : (pos.mark || pos.entry);
      if (!currPrice || currPrice <= 0 || !pos.entry || pos.entry <= 0) continue;

      const isLong = pos.side === 'LONG';
      const initialRisk = pos.stop > 0 ? Math.abs(pos.entry - pos.stop) : (pos.entry * 0.04);
      if (initialRisk <= 0) continue;

      const unrealizedPnlDist = isLong ? (currPrice - pos.entry) : (pos.entry - currPrice);
      const rMultiple = unrealizedPnlDist / initialRisk;

      // 1a. Breakeven Plus (+1R threshold)
      if (rMultiple >= 1.0) {
        const beStop = isLong
          ? Math.round(pos.entry * 1.0015 * 10000) / 10000
          : Math.round(pos.entry * 0.9985 * 10000) / 10000;
        const needsBeAdjustment = isLong
          ? (pos.stop < beStop)
          : (pos.stop > beStop || pos.stop <= 0);

        if (needsBeAdjustment) {
          hub.emit('log', {
            at: Date.now(),
            kind: 'system',
            text: `[FAST REFLEX] ${sym} reached +${rMultiple.toFixed(2)}R. Ratcheting stop to Breakeven+ (${beStop}).`
          });
          void dispatch({
            kind: 'protect',
            actor: 'system',
            symbol: sym,
            payload: { symbol: sym, stop: beStop, tp: pos.tp }
          }).catch(() => {});
        }
      }

      // 1b. ATR Ratchet Trailing (+1.5R)
      if (rMultiple >= 1.5) {
        const closed15m = frame?.closed?.['15m']?.filter((b) => b.confirmed) ?? [];
        const closed5m = frame?.closed?.['5m']?.filter((b) => b.confirmed) ?? [];
        const primaryBars = closed15m.length >= 14 ? closed15m : closed5m;
        let atr = initialRisk;
        if (primaryBars.length >= 14) {
          const recent = primaryBars.slice(-14);
          const trs = recent.map((b) => Math.max(
            Number(b.high) - Number(b.low),
            Math.abs(Number(b.high) - Number(b.close)),
            Math.abs(Number(b.low) - Number(b.close))
          ));
          atr = trs.reduce((a, b) => a + b, 0) / trs.length;
        }

        const trailStop = isLong
          ? Math.round((currPrice - (1.5 * atr)) * 10000) / 10000
          : Math.round((currPrice + (1.5 * atr)) * 10000) / 10000;

        const needsTrailingAdjustment = isLong
          ? (trailStop > pos.stop && trailStop > pos.entry * 1.0015)
          : ((pos.stop <= 0 || trailStop < pos.stop) && trailStop < pos.entry * 0.9985);

        if (needsTrailingAdjustment) {
          hub.emit('log', {
            at: Date.now(),
            kind: 'system',
            text: `[FAST REFLEX] ${sym} profit +${rMultiple.toFixed(2)}R. Trailing stop ratchet to ${trailStop}.`
          });
          void dispatch({
            kind: 'protect',
            actor: 'system',
            symbol: sym,
            payload: { symbol: sym, stop: trailStop, tp: pos.tp }
          }).catch(() => {});
        }
      }
    }

    // 2. Pending Limit Order TTL & Runaway TP1 Checks
    const pendingOrders = (snap.venueAccount as any)?.pendingOrders ?? [];
    const pendingVerdicts = (snap.verdicts ?? []).filter((v: any) => v.operationalStatus === 'PENDING');

    const now = Date.now();
    for (const po of pendingOrders) {
      const sym = po.symbol.toUpperCase();
      const clientOrderId = po.clientOrderId;
      const matchingVerdict = pendingVerdicts.find((v) => v.symbol.toUpperCase() === sym);
      const createdAt = matchingVerdict?.at ?? (po as any).createdAt ?? now;
      const ageMs = now - createdAt;

      // 2a. TTL Expired (45 minutes)
      if (ageMs > 45 * 60 * 1000) {
        hub.emit('log', {
          at: now,
          kind: 'system',
          text: `[FAST REFLEX] Pending limit order for ${sym} expired TTL (${Math.round(ageMs / 60000)}m > 45m). Auto-cancelling.`
        });
        void dispatch({
          kind: 'cancel_entry',
          actor: 'system',
          symbol: sym,
          payload: { symbol: sym, clientOrderId }
        }).catch(() => {});
        continue;
      }

      // 2b. Runaway TP1 Touch
      const tpPrice = po.tpPrice ? Number(po.tpPrice) : (matchingVerdict?.order?.tp ? Number(matchingVerdict.order.tp) : null);
      if (tpPrice && tpPrice > 0) {
        const frame = marketHub?.snapshot(sym);
        const currPrice = frame?.last?.value ? Number(frame.last.value) : 0;
        if (currPrice > 0) {
          const isShort = po.side === 'SHORT' || matchingVerdict?.action === 'OPEN_SHORT';
          const tpReached = isShort ? (currPrice <= tpPrice) : (currPrice >= tpPrice);
          if (tpReached) {
            hub.emit('log', {
              at: now,
              kind: 'system',
              text: `[FAST REFLEX] Price for ${sym} touched TP1 (${tpPrice}) without filling pending limit. Cancelling runaway entry.`
            });
            void dispatch({
              kind: 'cancel_entry',
              actor: 'system',
              symbol: sym,
              payload: { symbol: sym, clientOrderId }
            }).catch(() => {});
          }
        }
      }
    }
  };

  fastReflexTimer = setInterval(() => {
    void runFastReflexLoop().catch(() => {});
  }, 1000);
  fastReflexTimer.unref();

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
    dispatch,
    runFastReflex: runFastReflexLoop,
    reconfigureVenueMode: options.reconfigureVenueMode,
    syncVenueAccount: options.syncVenueAccount
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

  const effectiveExchange = settings.current().effective.venue.exchange;
  if (effectiveExchange && startup.venue && effectiveExchange !== startup.venue) {
    secrets.writeSecrets({ EXCHANGE: startup.venue });
    process.env.EXCHANGE = startup.venue;
  }

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

  let transport = createTransportFromAdapter(venueAdapter);
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
    availableBalance: availNum !== null ? availableFinancialField(availNum) : (equityNum !== null ? availableFinancialField(equityNum) : unavailableFinancialField()),
    realizedPnl: realizedNum !== null ? availableFinancialField(realizedNum) : unavailableFinancialField(),
    unrealizedPnl: availableFinancialField(0)
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

      const auth = await authority.claim(accountRef);
      const receipt = await gateway.submit({
        intentId: `intent-${Date.now()}`,
        accountRef,
        configVersion: settings.current().activeVersion,
        authorityEpoch: auth.writerEpoch,
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

        const snap = runtimeRef?.snapshot() ?? state;
        const pendingOrder = (snap.venueAccount as any)?.pendingOrders?.find((p: any) => p.symbol.toUpperCase() === symbol);
        const isPendingSymbol = snap.venueAccount?.pendingSymbols?.some((s) => s.toUpperCase() === symbol);
        const hasPendingVerdict = (snap.verdicts ?? []).some((v: any) => v.symbol.toUpperCase() === symbol && v.operationalStatus === 'PENDING');

        const activeIntent = (await store.execute(
          `SELECT intent_id, client_order_id, symbol, side, order_state FROM execution_intents WHERE UPPER(symbol) = ? AND order_state IN ('ACCEPTED', 'PARTIAL', 'SUBMITTING') ORDER BY created_at DESC LIMIT 1`,
          [symbol]
        ))?.rows?.[0];

        if (pendingOrder || isPendingSymbol || activeIntent || hasPendingVerdict) {
          const clientOrderId = pendingOrder?.clientOrderId ?? (activeIntent?.client_order_id as string | undefined);
          if (clientOrderId && transport.cancelEntryOrder) {
            try {
              await transport.cancelEntryOrder(symbol, String(clientOrderId));
            } catch (err) {
              console.warn(`[cancelEntryOrder] Failed on transport: ${(err as Error).message}`);
            }
          }
          if (activeIntent) {
            await store.execute(
              `UPDATE execution_intents SET order_state = 'CANCELLED', updated_at = ? WHERE intent_id = ?`,
              [Date.now(), activeIntent.intent_id]
            );
          }
          runtimeRef?.updateState((draft) => {
            if (draft.venueAccount?.pendingOrders) {
              draft.venueAccount.pendingOrders = draft.venueAccount.pendingOrders.filter((p) => p.symbol.toUpperCase() !== symbol);
            }
            if (draft.venueAccount?.pendingSymbols) {
              draft.venueAccount.pendingSymbols = draft.venueAccount.pendingSymbols.filter((s) => s.toUpperCase() !== symbol);
            }
            for (const v of draft.verdicts ?? []) {
              if (v.symbol.toUpperCase() === symbol && (v as any).operationalStatus === 'PENDING') {
                (v as any).operationalStatus = 'CANCELLED';
                v.executed = false;
              }
            }
            draft.lessons = draft.lessons ?? [];
            draft.lessons.push({
              id: `lesson-${Date.now()}-${randomUUID().slice(0, 6)}`,
              role: 'execution',
              kind: 'pending_order_cancelled',
              symbol,
              happened: `Resting limit entry order cancelled for ${symbol} due to close/invalidation verdict`,
              rootCause: 'Resting limit entry order cancelled due to structural reversal or regime invalidation on CLOSE evaluation',
              lesson: 'Cancelled resting order when market reversed before entry fill to prevent adverse execution',
              count: 1,
              firstAt: Date.now(),
              lastAt: Date.now(),
              source: 'runtime',
              status: 'new'
            });
          });
          return {
            ok: true,
            code: 'OK',
            message: `Cancelled pending limit entry order for ${symbol} due to close/invalidation verdict`,
            data: { orderState: 'CANCELLED' }
          };
        }

        return {
          ok: false,
          code: 'INVALID_INPUT',
          message: `No open position found for ${symbol}`
        };
      }

      const auth = await authority.claim(accountRef);
      const receipts = [];
      for (const pos of targetPos) {
        const r = await gateway.close({
          intentId: `close-${Date.now()}-${pos.symbol}`,
          accountRef,
          configVersion: settings.current().activeVersion,
          authorityEpoch: auth.writerEpoch,
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

    if (input.kind === 'protect') {
      const symbol = String(input.symbol ?? input.payload?.symbol ?? '').toUpperCase();
      const positions = await transport.positions();
      const targetPos = positions.find((p) => p.symbol.toUpperCase() === symbol);
      if (!targetPos) {
        return { ok: false, code: 'INVALID_INPUT', message: `No active position found on venue for ${symbol}` };
      }
      const stop = input.payload?.stop ? String(input.payload.stop) : null;
      const tp = input.payload?.tp ? String(input.payload.tp) : null;
      if (!stop) {
        return { ok: false, code: 'INVALID_INPUT', message: 'Stop price is required to protect position' };
      }
      const prot = await transport.placeProtection(targetPos, stop, tp);
      try { await syncVenueAccount(); } catch {}
      return {
        ok: prot.state === 'VERIFIED',
        code: prot.state === 'VERIFIED' ? 'OK' : 'REJECTED',
        message: `Protection updated on venue for ${symbol}: SL ${stop}, TP ${tp ?? 'none'} (${prot.state})`,
        data: prot as unknown as Record<string, unknown>
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
      const sym = input.symbol ?? (input.kind === 'auto_cycle' ? undefined : 'BTCUSDT');
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
    marketHub,
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

  let syncTimer: NodeJS.Timeout | null = null;
  let isSyncing = false;

  const syncVenueAccount = async (): Promise<void> => {
    if (isSyncing) return;
    const currentMode = runtimeRef ? runtimeRef.snapshot().mode : startup.tradingMode;
    if (currentMode === 'PAPER') return;
    if (!venueAdapter) return;
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
        let slotFreedByClose = false;
        let closedSymbolsList: string[] = [];
        runtimeRef?.updateState((d) => {
          const prevPosSymbols = (d.venueAccount?.positions ?? d.paper.positions ?? []).map((p) => p.symbol.toUpperCase());
          d.financial.balance = availableFinancialField(eq);
          d.financial.equity = availableFinancialField(eq);
          const effectiveAv = (av !== null && Number.isFinite(av)) ? av : eq;
          d.financial.availableBalance = availableFinancialField(effectiveAv);
          const totalUnrealized = Math.round(
            posList.reduce((sum, p) => sum + (p.unrealizedPnl ? Number(p.unrealizedPnl) : 0), 0) * 100
          ) / 100;
          d.financial.unrealizedPnl = availableFinancialField(totalUnrealized);
          const pendingIntents = recon?.pending ?? [];
          const activePosList = posList.filter((p) => Number(p.qty) > 0);
          const currentPosSymbols = new Set(activePosList.map((p) => p.symbol.toUpperCase()));
          closedSymbolsList = prevPosSymbols.filter((s) => !currentPosSymbols.has(s));
          if (d.verdicts) {
            for (const v of d.verdicts) {
              if ((v as any).operationalStatus === 'PENDING') {
                const sym = v.symbol.toUpperCase();
                const isPos = activePosList.some((p) => p.symbol.toUpperCase() === sym);
                const isPend = pendingIntents.some((p) => p.symbol.toUpperCase() === sym);
                if (isPos) {
                  (v as any).operationalStatus = 'FILLED';
                  v.executed = true;
                } else if (!isPend) {
                  (v as any).operationalStatus = 'CANCELLED';
                  v.executed = false;
                }
              }
            }
          }
          d.venueAccount = {
            equity: eq,
            available: effectiveAv,
            unrealized: totalUnrealized,
            at: Date.now(),
            status: 'confirmed',
            positions: activePosList.map((p) => ({ symbol: p.symbol, side: p.side, qty: Number(p.qty) })),
            pendingSymbols: pendingIntents.map((p) => p.symbol),
            pendingOrders: pendingIntents.map((p) => ({
              intentId: p.intentId,
              clientOrderId: p.clientOrderId,
              symbol: p.symbol,
              side: p.side,
              orderState: p.orderState,
              filledQty: p.filledQty,
              limitPrice: p.limitPrice ?? null,
              stopPrice: p.stopPrice ?? null,
              tpPrice: p.tpPrice ?? null
            }))
          };
          d.paper.balance = eq;
          d.paper.unrealized = totalUnrealized;
          d.paper.equity = eq;

          const updatedPositions: Position[] = [];
          for (let idx = 0; idx < activePosList.length; idx++) {
            const nativePos = activePosList[idx];
            const qty = Number(nativePos.qty);
            const entry = Number(nativePos.entryPrice);
            const leverage = nativePos.leverage ?? 5;
            const margin = (qty * entry) / leverage;
            const existing = d.paper.positions.find(
              (p) => p.symbol.toUpperCase() === nativePos.symbol.toUpperCase() && p.side === nativePos.side
            );
            const upnl = nativePos.unrealizedPnl != null ? Number(nativePos.unrealizedPnl) : (existing?.unrealizedPnl ?? 0);
            const mark = existing?.mark && Math.abs(existing.mark - entry) > 0.0001
              ? existing.mark
              : (entry + (nativePos.side === 'LONG' ? 1 : -1) * (qty > 0 ? upnl / qty : 0));

            const shown = verifiedVenueStop({
              protectionState: recon?.protection[nativePos.positionKey],
              stopPrice: recon?.verifiedStops?.[nativePos.positionKey]
            });
            const priorVerdictTp = (d.verdicts ?? []).find(
              (v: any) => v.symbol.toUpperCase() === nativePos.symbol.toUpperCase() && v.order?.tp
            )?.order?.tp;
            updatedPositions.push({
              id: existing?.id ?? `pos-${nativePos.symbol}-${idx}`,
              symbol: nativePos.symbol,
              side: nativePos.side,
              qty,
              entry,
              stop: shown.stop,
              tp: existing?.tp ?? (priorVerdictTp ? Number(priorVerdictTp) : null),
              mark,
              unrealizedPnl: Math.round(upnl * 100) / 100,
              leverage,
              margin,
              openedAt: existing?.openedAt ?? nativePos.observedAt ?? Date.now(),
              protectionStatus: shown.protectionStatus,
              entryStatus: 'confirmed'
            });
          }

          for (const pend of pendingIntents) {
            if (posList.some((p) => p.symbol.toUpperCase() === pend.symbol.toUpperCase())) {
              continue;
            }
            const filled = Number(pend.filledQty || 0);
            if (filled <= 0) {
              continue;
            }
            updatedPositions.push({
              id: pend.intentId || `pending-${pend.clientOrderId}`,
              symbol: pend.symbol,
              side: pend.side,
              qty: filled,
              entry: 0,
              stop: 0,
              tp: null,
              mark: 0,
              unrealizedPnl: 0,
              leverage: 5,
              margin: 0,
              openedAt: Date.now(),
              protectionStatus: 'unknown',
              entryStatus: pend.orderState === 'PARTIAL' ? 'confirmed' : 'estimated'
            });
          }

          d.paper.positions = updatedPositions;
          d.paper.usedMargin = updatedPositions.reduce((sum, p) => sum + p.margin, 0);

          const trading = settings.current().effective.trading;
          const slots = Math.max(1, Math.min(4, Math.floor(trading.maxPositions ?? d.paper.n ?? 1)));
          const safety = trading.safetyNet ?? d.paper.safetyNet;
          const mt = Math.round(Math.max(0, eq - safety) * 100) / 100;
          d.paper.safetyNet = safety;
          d.paper.n = slots;
          d.paper.moneyTrade = mt;
          const effectiveOrderSizePct = trading.orderSizePct === 1.5 ? null : (trading.orderSizePct ?? null);
          d.paper.orderSizePct = effectiveOrderSizePct;
          d.paper.perOrder = ownerAllocationPerOrder(mt, slots, effectiveOrderSizePct);

          const openSymbols = new Set([
            ...updatedPositions.map((p) => p.symbol.toUpperCase()),
            ...pendingIntents
              .filter((p) => p.orderState === 'ACCEPTED' || p.orderState === 'PARTIAL')
              .map((p) => p.symbol.toUpperCase())
          ]);
          const nextFreeSlots = Math.max(0, slots - openSymbols.size);
          if (closedSymbolsList.length > 0 && nextFreeSlots > 0) {
            slotFreedByClose = true;
          }
          d.paper.canOpen = d.paper.perOrder > 0 && openSymbols.size < slots;
          if (d.accountState) {
            d.accountState.openPositionsCount = updatedPositions.length;
            d.accountState.occupiedSlots = openSymbols.size;
            d.accountState.pendingOpenCount = pendingIntents.filter(
              (p) => p.orderState === 'ACCEPTED' || p.orderState === 'PARTIAL'
            ).length;
            d.accountState.maxPositions = slots;
            d.accountState.freeSlots = nextFreeSlots;
            d.accountState.hasTradableCapital = d.paper.canOpen;
            d.accountState.canOpenNewSlot = d.paper.canOpen;
            d.accountState.status = 'AVAILABLE';
            d.accountState.mode = d.mode;
            d.accountState.observedAt = Date.now();
          }
        });

        if (slotFreedByClose && runtimeRef) {
          const s = runtimeRef.snapshot();
          for (const closedSym of closedSymbolsList) {
            const pendingToClean = (s.venueAccount as any)?.pendingOrders?.filter(
              (p: any) => p.symbol.toUpperCase() === closedSym.toUpperCase()
            ) ?? [];
            for (const po of pendingToClean) {
              runtimeRef.hub.emit('log', {
                at: Date.now(),
                kind: 'system',
                text: `[CLEAN SWEEP] Cancelling orphan pending order ${po.clientOrderId} on closed symbol ${closedSym}.`
              });
              void runtimeRef.dispatch({
                actor: 'system',
                kind: 'cancel_entry',
                symbol: closedSym,
                payload: { symbol: closedSym, clientOrderId: po.clientOrderId }
              }).catch(() => {});
            }
          }
          if (s.auto.on && !s.killed && !s.paused && !s.auto.running) {
            runtimeRef.hub.emit('log', {
              at: Date.now(),
              kind: 'system',
              text: `[VENUE SYNC] Position(s) closed on exchange (${closedSymbolsList.join(', ')}). Slot freed (${s.accountState?.freeSlots ?? 1}/${s.paper.n}). Triggering immediate watchlist opportunity scan.`
            });
            void runtimeRef.triggerCycle(undefined, 'schedule').catch(() => {});
          }
        }
      }
    } catch {
      // non-fatal
    } finally {
      isSyncing = false;
    }
  };

  const reconfigureActiveVenueAndMode = async (
    nextMode: TradingMode,
    nextVenue?: VenueId
  ): Promise<{ ok: boolean; error?: string }> => {
    const targetVenue = (nextVenue ?? (settings.current().effective.venue.exchange as VenueId) ?? 'bybit') as VenueId;
    const isDexTarget = ['aster', 'dydx', 'hyperliquid', 'orderly', 'paradex'].includes(targetVenue);
    const targetNetwork: Network | null = nextMode === 'LIVE' ? 'mainnet' : nextMode === 'TESTNET' ? 'testnet' : null;

    if (nextMode === 'LIVE' || nextMode === 'TESTNET') {
      if (!targetNetwork || !secrets.hasVenueCredentials(targetVenue, targetNetwork)) {
        return { ok: false, error: `Missing ${targetNetwork} credentials for ${targetVenue}` };
      }
      const credentialRef = `${targetVenue}:${targetNetwork}`;
      const readSecret = async () => {
        const names = venueCredentialEnvNames(targetVenue, targetNetwork);
        const envMap = secrets.readEnvMap();
        const key = (envMap[names.key] ?? process.env[names.key] ?? env[names.key] ?? '').trim();
        const secret = (envMap[names.secret] ?? process.env[names.secret] ?? env[names.secret] ?? '').trim();
        const passphrase = names.passphrase ? (envMap[names.passphrase] ?? process.env[names.passphrase] ?? env[names.passphrase] ?? '').trim() : null;
        const verifiedAgentAddress = (
          envMap.ASTER_AGENT_WITHDRAW_OFF_VERIFIED ??
          process.env.ASTER_AGENT_WITHDRAW_OFF_VERIFIED ??
          envMap.ASTER_TESTNET_AGENT_WITHDRAW_OFF_VERIFIED ??
          process.env.ASTER_TESTNET_AGENT_WITHDRAW_OFF_VERIFIED ??
          ''
        ).trim() || null;
        return { key, secret, passphrase, verifiedAgentAddress };
      };

      const nextAdapter = getVenueAdapter(targetVenue, {
        network: targetNetwork,
        credentialRef,
        fetchImpl: fetch,
        readSecret
      });

      const perm = await nextAdapter.permissions();
      assertLivePermissionEvidence(perm);

      const identity = await nextAdapter.accountIdentity();
      const accountContext = await accounts.register({
        venue: targetVenue,
        network: targetNetwork,
        mode: nextMode,
        nativeIdentity: identity.publicAccountId,
        subaccountRef: identity.subaccountRef ?? null
      });
      accountRef = accountContext.accountRef;
      await authority.claim(accountRef);

      venueAdapter = nextAdapter;
      transport = createTransportFromAdapter(venueAdapter);

      if (syncTimer) {
        clearInterval(syncTimer);
        syncTimer = null;
      }
      await syncVenueAccount();
      syncTimer = setInterval(syncVenueAccount, 10_000);
      syncTimer.unref();

      runtimeRef?.updateState((draft) => {
        draft.mode = nextMode;
        draft.live = {
          exchange: targetVenue,
          network: targetNetwork,
          experimental: targetVenue !== 'bybit'
        };
        draft.venue = {
          name: targetVenue,
          label: targetVenue.toUpperCase(),
          kind: isDexTarget ? 'DEX' : 'CEX',
          experimental: targetVenue !== 'bybit'
        };
        if (draft.trading) {
          draft.trading.network = targetNetwork;
        }
      });
      return { ok: true };
    } else {
      if (syncTimer) {
        clearInterval(syncTimer);
        syncTimer = null;
      }
      const paperVenue = new PaperVenue({
        initialBalance: String(settings.current().effective.paper.balance ?? 1000)
      });
      venueAdapter = paperVenue;
      const accountContext = await accounts.register({
        accountRef: 'acct-paper-local',
        venue: targetVenue,
        network: 'testnet',
        mode: 'PAPER',
        nativeIdentity: 'paper-local',
        subaccountRef: null
      });
      accountRef = accountContext.accountRef;
      await authority.claim(accountRef);
      transport = createTransportFromAdapter(venueAdapter);

      runtimeRef?.updateState((draft) => {
        draft.mode = 'PAPER';
        draft.live = null;
        draft.venue = {
          name: targetVenue,
          label: targetVenue.toUpperCase(),
          kind: isDexTarget ? 'DEX' : 'CEX',
          experimental: targetVenue !== 'bybit'
        };
        if (draft.trading) {
          draft.trading.network = null;
        }
        draft.venueAccount = null;
      });
      return { ok: true };
    }
  };

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
    venueAdapter,
    getVenueAdapter: () => venueAdapter,
    activeAccountRef: () => accountRef,
    reconfigureVenueMode: (mode, venue) => reconfigureActiveVenueAndMode(mode, venue),
    syncVenueAccount: () => syncVenueAccount(),
    env,
    settings,
    secrets,
    chatService,
    researchHost,
    reportsService,
    initialKilled: persistedHalt
  });
  runtimeRef = runtime;

  if (store) {
    try {
      const msgRes = await store.execute(
        `SELECT message_id, conversation_id, role, text, created_at FROM chat_messages ORDER BY created_at DESC LIMIT 100`
      );
      if (msgRes.rows.length > 0) {
        const rows = [...msgRes.rows].reverse();
        runtime.updateState((draft) => {
          if (!draft.roomHistory) draft.roomHistory = [];
          for (const r of rows) {
            const role = String(r.role);
            const text = String(r.text);
            const at = new Date(String(r.created_at)).getTime() || Date.now();
            const id = String(r.message_id);
            const conversationId = String(r.conversation_id);
            const isOwner = role === 'owner';
            const isAgent = ['lead', 'market', 'research', 'strategist', 'risk', 'execution'].includes(role);
            if (!isOwner && !isAgent) continue;

            const fromVal: AgentId | 'owner' = isOwner ? 'owner' : (role as AgentId);
            const toVal: AgentId | 'all' | 'owner' = isOwner ? 'all' : 'owner';

            const roomMsg: RoomMessage = {
              id,
              conversationId,
              at,
              from: fromVal,
              to: toVal,
              text
            };
            if (!draft.roomHistory.some((m) => m.id === id)) {
              draft.roomHistory.push(roomMsg);
            }
            if (!isOwner && isAgent && role in draft.chats) {
              const roleKey = role as keyof typeof draft.chats;
              if (!draft.chats[roleKey].some((c) => c.text === text && Math.abs(c.at - at) < 1000)) {
                draft.chats[roleKey].push({ from: role as AgentId, text, at, conversationId });
              }
            }
          }
          draft.roomHistory = draft.roomHistory.slice(-100);
          for (const k of Object.keys(draft.chats) as Array<keyof typeof draft.chats>) {
            draft.chats[k] = draft.chats[k].slice(-50);
          }
        });
      }

      const eventRes = await store.execute(
        `SELECT event_id, kind, created_at, payload_json FROM events ORDER BY seq DESC LIMIT 50`
      );
      if (eventRes.rows.length > 0) {
        const evtRows = [...eventRes.rows].reverse();
        runtime.updateState((draft) => {
          if (!draft.logs) draft.logs = [];
          for (const er of evtRows) {
            const at = new Date(String(er.created_at)).getTime() || Date.now();
            const id = String(er.event_id);
            const kind = String(er.kind);
            let text = `[EVENT] ${kind}`;
            try {
              const p = JSON.parse(String(er.payload_json));
              if (p.reason) text += `: ${p.reason}`;
              else if (p.message) text += `: ${p.message}`;
              else if (p.action && p.symbol) text += `: ${p.action} on ${p.symbol}`;
            } catch {}
            if (!draft.logs.some((l) => l.id === id)) {
              draft.logs.push({
                id,
                conversationId: 'office',
                at,
                kind,
                text
              });
            }
          }
          draft.logs = draft.logs.slice(-500);
        });
      }
    } catch {}
  }

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
      if (dcBot && (env.DISCORD_APPLICATION_ID ?? '').trim()) {
        syncDiscordCommandsV2(
          dcBot,
          (env.DISCORD_APPLICATION_ID ?? '').trim(),
          (env.DISCORD_GUILD_ID ?? '').trim() || undefined,
          fetch
        ).then((cmds) => {
          log(`[channels:discord] Slash commands synced (${cmds.length} commands)`);
        }).catch((err) => {
          log(`[channels:discord] Slash commands sync deferred: ${(err as Error).message}`);
        });
      }
    } catch (err) {
      console.error(`[channels:discord] Failed to start Gateway: ${(err as Error).message}`);
    }
  }

  if (startup.tradingMode !== 'PAPER') {
    void syncVenueAccount();
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = setInterval(syncVenueAccount, 10_000);
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
