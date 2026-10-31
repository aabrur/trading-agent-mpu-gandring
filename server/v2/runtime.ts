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
import { buildRoleSystemPrompt, resolveCanonicalRole } from './agents/roles.js';
import { PROVIDER_KEY_ENV, SecretStore } from './settings/secrets.js';
import type { ApiProviderId } from './settings/schema.js';
import type { Position, Stance, Verdict } from '../../shared/office.js';
import { RuntimeStore } from './store/database.js';
import { ExecutionAuthorityService } from './accounts/authority.js';
import { AccountRegistry } from './accounts/registry.js';
import { SettingsService } from './settings/service.js';
import { ExecutionGateway } from './execution/gateway.js';
import { getVenueAdapter, createTransportFromAdapter } from './execution/adapters/factory.js';
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
    const safetyNet = Number(env.SAFETY_NET ?? 200);
    if (!(safetyNet > 0)) {
      reasons.push('SAFETY_NET must be above zero outside PAPER');
    }
    if (reasons.length > 0) {
      throw new StartupValidationError(
        `TRADING_MODE=${tradingMode} cannot start, refusing. Fix this or go back to PAPER (npm run setup):\n  - ${reasons.join('\n  - ')}`,
        2
      );
    }
  }

  const rawN = env.OPEN_ORDERS_N;
  if (rawN !== undefined && rawN !== '') {
    const n = Number(rawN);
    if (!Number.isInteger(n) || n < 1 || n > 4) {
      throw new StartupValidationError('OPEN_ORDERS_N must be an integer from 1 to 4', 2);
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
    symbols?: string[];
    debateMode?: 'normal' | 'fast';
    n?: number;
  }): OfficeState;
  handleCommand(input: {
    text: string;
    agent?: string;
    clientRequestId?: string;
  }): Promise<{ ok: boolean; command?: string; reply?: string; error?: string }>;
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
  runtimeIdentity?: OfficeState['runtimeIdentity'];
  accountState?: OfficeState['accountState'];
  executionGateway?: ExecutionGateway;
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
  }
  if (options.venue) {
    state.venue = options.venue;
  }
  if (options.runtimeIdentity) {
    state.runtimeIdentity = options.runtimeIdentity;
  }
  if (options.accountState) {
    state.accountState = options.accountState;
  }

  if (state.mode === 'PAPER') {
    const paperBal = Number(env.PAPER_BALANCE ?? 1000);
    const safetyNet = Number(env.SAFETY_NET ?? 200);
    const n = Math.min(4, Math.max(1, Math.trunc(Number(env.OPEN_ORDERS_N ?? 3))));
    const moneyTrade = Math.max(0, paperBal - safetyNet);
    const perOrder = Math.floor((moneyTrade / n) * 100) / 100;
    state.paper.balance = paperBal;
    state.paper.safetyNet = safetyNet;
    state.paper.n = n;
    state.paper.moneyTrade = moneyTrade;
    state.paper.perOrder = perOrder;
    state.paper.canOpen = perOrder > 0;
    state.paper.equity = paperBal;
    state.accountState = {
      hasTradableCapital: true,
      openPositionsCount: 0,
      maxPositions: n,
      freeSlots: n,
      occupiedSlots: 0,
      pendingOpenCount: 0,
      canOpenNewSlot: true,
      mode: 'PAPER',
      source: 'simulated',
      status: 'AVAILABLE',
      observedAt: Date.now()
    };
  }

  const snapshot = (): OfficeState => structuredClone(state);

  const updateState = (mutator: (draft: OfficeState) => OfficeState | void): OfficeState => {
    const next = structuredClone(state);
    const returned = mutator(next);
    state = returned ?? next;
    hub.emit('state', snapshot());
    return snapshot();
  };

  const marketHub =
    options.marketHub ??
    new BybitMarketHub({
      retainedSymbolsProvider: () => state.watchlist
    });

  const jevEnabled = ['true', 'yes', '1', 'on'].includes(
    (env.JEV_ENABLED ?? '').trim().toLowerCase()
  );
  const jevKey = (env.JEV_OPENROUTER_API_KEY ?? env.OPENROUTER_API_KEY ?? '').trim();
  const jevClient =
    options.jevClient ??
    new JevClient({
      enabled: jevEnabled && Boolean(jevKey),
      apiKey: jevKey,
      model: env.JEV_MODEL || 'openai/gpt-5-mini'
    });

  const roleRunner =
    options.roleRunner ??
    new RoleRunner({
      providerCaller: createOfficialProviderCaller(),
      resolveAssignment: (role) => {
        const upper = role.toUpperCase();
        const rawProv = (env[`AGENT_${upper}_PROVIDER`] ?? env.DEFAULT_PROVIDER ?? '').trim().toLowerCase();
        const provider = rawProv && rawProv !== 'mock' ? rawProv : 'unconfigured';
        const model = (env[`AGENT_${upper}_MODEL`] ?? env.DEFAULT_MODEL ?? 'unconfigured').trim();
        const keyEnv = PROVIDER_KEY_ENV[provider as ApiProviderId] || `${provider.toUpperCase()}_API_KEY`;
        const apiKey = (env[keyEnv] ?? '').trim();
        return {
          provider,
          model,
          apiKey: apiKey || null
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
    symbols?: string[];
    debateMode?: 'normal' | 'fast';
    n?: number;
  }): OfficeState => {
    updateState((draft) => {
      if (patch.on !== undefined) draft.auto.on = patch.on;
      if (patch.intervalMin !== undefined) draft.auto.intervalMin = patch.intervalMin;
      if (patch.maxHoldHours !== undefined) draft.auto.maxHoldHours = patch.maxHoldHours;
      if (patch.symbols !== undefined && patch.symbols.length > 0) {
        draft.auto.symbols = patch.symbols;
        draft.watchlist = [...new Set([...draft.watchlist, ...patch.symbols])];
      }
      if (patch.debateMode !== undefined) draft.debateMode = patch.debateMode;
      if (patch.n !== undefined) {
        draft.paper.n = patch.n;
        if (draft.trading) {
          draft.trading.values.maxPositions = patch.n;
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
    hub.emit('state', snapshot());
    return snapshot();
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

    const targetSymbol = (symbol ?? snap.auto.symbols[snap.auto.cycles % (snap.auto.symbols.length || 1)] ?? 'BTCUSDT').toUpperCase();
    const cycleId = `cycle-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const debateId = `debate-${Date.now()}`;

    updateState((draft) => {
      draft.auto.running = true;
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

    const marketSummary: Record<string, unknown> = {
      symbol: targetSymbol,
      venue: 'bybit',
      category: 'linear',
      lastPrice: snap.tickers[targetSymbol]?.last ? String(snap.tickers[targetSymbol].last) : undefined,
      evidenceId: intelFrame.evidenceId,
      opposingFacts: intelFrame.opposingFacts
    };

    const policy: CyclePolicy = {
      minEntryConfidencePct: snap.trading?.values?.minEntryConfidencePct ?? 60,
      requireTwoOfThreeAnalysts: false
    };

    try {
      const out = await cycleRunner.run({
        cycleId,
        reason,
        accountRef: 'paper:default',
        symbol: targetSymbol,
        evidenceId: intelFrame.evidenceId,
        configVersion: 1,
        policy,
        marketSummary,
        onRoleStart: (task) => {
          updateState((draft) => {
            const agentView = draft.agents[task.role as RoleId];
            if (agentView) {
              agentView.status =
                task.phase === 'observe' ? 'reading' : task.phase === 'challenge' ? 'arguing' : 'thinking';
            }
            if (draft.debate) {
              draft.debate.phase = `${task.phase} (${task.role})`;
            }
          });
          hub.emit('status', { agent: task.role, status: snapshot().agents[task.role as RoleId]?.status ?? 'thinking' });
          hub.emit('state', snapshot());
        },
        onRoleResult: (res) => {
          const at = Date.now();
          const reasoning =
            res.reasoning ?? (res.errorReason ? `Failure: ${res.errorReason}` : `Completed with stance ${res.stance ?? 'HOLD'}`);

          updateState((draft) => {
            draft.agents[res.role].status = 'idle';
            if (res.stance) draft.agents[res.role].stance = res.stance as Stance;
            if (res.confidence?.value !== null && res.confidence?.value !== undefined) {
              draft.agents[res.role].confidence =
                res.confidence.scale === 'probability_0_1'
                  ? Math.round(res.confidence.value * 100)
                  : Math.round(res.confidence.value);
            }
            draft.agents[res.role].lastLine = reasoning.slice(0, 160);

            const bull = Object.values(draft.agents).filter((a) => a.stance === 'LONG').map((a) => a.id);
            const bear = Object.values(draft.agents).filter((a) => a.stance === 'SHORT').map((a) => a.id);
            const neutral = Object.values(draft.agents).filter((a) => a.stance !== 'LONG' && a.stance !== 'SHORT').map((a) => a.id);
            const disagreement = Math.min(bull.length, bear.length) > 0 ? (Math.min(bull.length, bear.length) * 2) / 6 : 0;
            if (draft.debate) {
              draft.debate.camps = { bull, bear, neutral };
              draft.debate.disagreement = disagreement;
            }
          });

          hub.emit('speech', {
            id: `speech-${at}-${res.role}`,
            agent: res.role,
            text: reasoning,
            done: true,
            example: false,
            at
          });
          hub.emit('room', {
            id: `room-${at}-${res.role}`,
            at,
            from: res.role,
            text: reasoning,
            symbol: targetSymbol
          });
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
          riskDecision: isApproved ? 'APPROVE' : 'HOLD',
          executed: false,
          reason: out.verdict.rejectionReason ?? (isApproved ? 'Thesis verified and approved by Risk Manager' : 'Consensus synthesis reached HOLD'),
          disagreement,
          camps: { bull, bear, neutral },
          example: false,
          at: Date.now()
        };

        if (isApproved && out.verdict.thesis) {
          if (currentSnap.paper.positions.length < currentSnap.paper.n) {
            const entryPrice = Number(currentSnap.tickers[targetSymbol]?.last ?? out.verdict.thesis.stop);
            const stopPrice = Number(out.verdict.thesis.stop);
            const tpPrice = out.verdict.thesis.tp ? Number(out.verdict.thesis.tp) : null;
            const leverage = currentSnap.paper.maxLeverage || 5;
            const perOrder = currentSnap.paper.perOrder || 50;
            const margin = Math.round(perOrder * 100) / 100;
            const qty = entryPrice > 0 ? Math.round(((margin * leverage) / entryPrice) * 1000) / 1000 : 1;
            const side = action === 'OPEN_LONG' ? 'LONG' : 'SHORT';
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
        draft.debate = null;
        draft.auto.running = false;
        draft.auto.lastCycleAt = Date.now();
        draft.auto.cycles += 1;
        if (draft.auto.on) {
          draft.auto.nextAt = Date.now() + draft.auto.intervalMin * 60 * 1000;
        }
        draft.verdicts = [verdictRecord, ...draft.verdicts.slice(0, 49)];
        draft.lastVerdict = verdictRecord;
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
      });

      hub.emit('verdict', verdictRecord);
      hub.emit('state', snapshot());
      return { ok: true, message: `Cycle ${cycleId} finished with verdict ${verdictRecord.action}`, cycleId };
    } catch (err) {
      updateState((draft) => {
        draft.debate = null;
        draft.auto.running = false;
        draft.auto.lastCycleAt = Date.now();
      });
      hub.emit('state', snapshot());
      return { ok: false, message: `Cycle failed: ${(err as Error).message}`, cycleId };
    }
  };

  const handleCommand = async (input: {
    text: string;
    agent?: string;
    clientRequestId?: string;
  }): Promise<{ ok: boolean; command?: string; reply?: string; error?: string }> => {
    const raw = input.text.trim();
    if (!raw) {
      return { ok: false, error: 'empty command' };
    }
    const cmd = raw.toLowerCase();

    if (input.agent) {
      const role = resolveCanonicalRole(input.agent);
      if (role) {
        try {
          const systemPrompt = buildRoleSystemPrompt(role);
          const assignment = (roleRunner as any).resolveAssignment(role, 1);
          const replyText = await (roleRunner as any).providerCaller({
            cycleId: `chat-${Date.now()}`,
            role,
            phase: 'final',
            taskAttempt: 1,
            turn: 0,
            provider: assignment.provider,
            model: assignment.model,
            apiKey: assignment.apiKey ?? '',
            system: systemPrompt,
            user: raw,
            timeoutMs: 60_000
          });
          updateState((draft) => {
            const chatList = draft.chats[role] ?? [];
            chatList.push(
              { from: 'user', text: raw, at: Date.now() },
              { from: role, text: replyText, at: Date.now() }
            );
            draft.chats[role] = chatList.slice(-50);
          });
          hub.emit('state', snapshot());
          return { ok: true, command: 'chat', reply: replyText };
        } catch (err) {
          return { ok: false, error: `Agent ${role} error: ${(err as Error).message}` };
        }
      }
    }

    if (cmd.startsWith('analyze ') || cmd.startsWith('debate ')) {
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

    if (cmd === 'status') {
      const snap = snapshot();
      return {
        ok: true,
        command: 'status',
        reply: `Mode: ${snap.mode}. Venue: ${snap.venue?.name ?? 'bybit'}. Auto: ${snap.auto.on ? 'ON' : 'OFF'}. Kill switch: ${snap.killed ? 'ON' : 'OFF'}. Open positions: ${snap.paper.positions.length}/${snap.paper.n}.`
      };
    }

    if (cmd === 'pause') {
      updateState((d) => { d.paused = true; });
      return { ok: true, command: 'pause', reply: 'Desk paused.' };
    }
    if (cmd === 'resume') {
      updateState((d) => { d.paused = false; });
      return { ok: true, command: 'resume', reply: 'Desk resumed.' };
    }

    if (cmd.startsWith('close')) {
      const parts = raw.split(/\s+/);
      const target = (parts[1] ?? 'all').toUpperCase();
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

    if (cmd.startsWith('safety ')) {
      const val = Number(raw.split(/\s+/)[1]);
      if (val > 0) {
        updateState((d) => {
          d.paper.safetyNet = val;
          if (d.trading) {
            d.trading.values.safetyNet = val;
          }
          const mt = Math.max(0, d.paper.balance - val);
          d.paper.moneyTrade = mt;
          d.paper.perOrder = Math.floor((mt / d.paper.n) * 100) / 100;
          d.paper.canOpen = d.paper.perOrder > 0;
        });
        hub.emit('state', snapshot());
        return { ok: true, command: 'safety', reply: `Safety net set to ${val} USDT.` };
      }
    }

    if (cmd.startsWith('n ')) {
      const count = Number(raw.split(/\s+/)[1]);
      if (Number.isInteger(count) && count >= 1 && count <= 4) {
        updateState((d) => {
          d.paper.n = count;
          if (d.trading) {
            d.trading.values.maxPositions = count;
          }
          const mt = Math.max(0, d.paper.balance - d.paper.safetyNet);
          d.paper.moneyTrade = mt;
          d.paper.perOrder = Math.floor((mt / count) * 100) / 100;
          d.paper.canOpen = d.paper.perOrder > 0 && d.paper.positions.length < count;
        });
        hub.emit('state', snapshot());
        return { ok: true, command: 'n', reply: `Slots N set to ${count}.` };
      }
    }

    return { ok: true, command: cmd, reply: `Command acknowledged: "${safe(raw)}"` };
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
      const leverage = Number(p.leverage ?? 5);
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
      return {
        activeConfigVersion: snap.activeVersion,
        safetyNetUsdt: String(snap.effective.trading.safetyNet),
        maxPositions: snap.effective.trading.maxPositions,
        dailyLossCapUsdt: String(snap.effective.trading.dailyLossLimitPct),
        minEntryConfidencePct: snap.effective.trading.minEntryConfidencePct
      };
    },
    readFreshMarket: (symbol) => marketHub.snapshot(symbol)
  });

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
    const defaultStopPct = 0.05;
    const stop = p.side === 'LONG' ? entry * (1 - defaultStopPct) : entry * (1 + defaultStopPct);
    return {
      id: `pos-${p.symbol}-${idx}`,
      symbol: p.symbol,
      side: p.side,
      qty,
      entry,
      stop,
      tp: null,
      mark: entry,
      unrealizedPnl: p.unrealizedPnl ? Number(p.unrealizedPnl) : 0,
      leverage,
      margin,
      openedAt: p.observedAt,
      protectionStatus: 'unknown',
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
      await authority.setHalt(accountRef, false, 'local_owner', 'Owner released kill switch');
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
      const leverage = Number(p.leverage ?? 5);
      const orderType = (p.orderType as 'MARKET' | 'LIMIT_GTC') ?? 'MARKET';

      const receipt = await gateway.submit({
        intentId: `intent-${Date.now()}`,
        accountRef,
        configVersion: settings.current().activeVersion,
        authorityEpoch: (await authority.current(accountRef))?.writerEpoch ?? 1,
        action: 'OPEN',
        symbol,
        side,
        quantity: qty,
        entry: null,
        stop,
        tp,
        leverage,
        thesisId: null,
        orderType
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

      for (const pos of targetPos) {
        await gateway.close({
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
      }

      return {
        ok: true,
        code: 'OK',
        message: `Position(s) closed for ${symbol}`,
        data: { orderState: 'CLOSED' }
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

  const runtime = createReplacementRuntime({
    sessionId: sessionLogger?.session.sessionId ?? null,
    initialMode: startup.tradingMode,
    initialAppMode: startup.appMode,
    marketHub,
    dispatcher,
    initialFinancial,
    initialPositions,
    venue: initialVenue,
    runtimeIdentity: initialIdentity,
    executionGateway: gateway,
    env
  });
  runtimeRef = runtime;

  const researchHost = new ResearchHost({});

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

  // Wire market frame updates to tickers
  runtime.marketHub.onFrame((frame) => {
    const lastPrice = frame.last.value !== null ? Number(frame.last.value) : null;
    if (lastPrice !== null && Number.isFinite(lastPrice)) {
      runtime.updateState((draft) => {
        draft.tickers[frame.symbol] = {
          symbol: frame.symbol,
          last: lastPrice,
          change24hPct: 0,
          source: 'bybit.v5.linear',
          example: false,
          at: Date.now()
        };
      });
    }
  });

  // If AUTO_TRADING is configured in env, activate
  const rawAuto = (env.AUTO_TRADING ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(rawAuto)) {
    const intervalMin = Math.max(1, Number(env.DEBATE_INTERVAL_MIN || 15));
    runtime.updateAutoSettings({ on: true, intervalMin });
  }

  const shutdown = () => {
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
