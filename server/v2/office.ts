import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type {
  AgentId,
  AgentView,
  OfficeEvent,
  OfficeEventType,
  OfficeState,
  RoleScore
} from '../../shared/office.js';
import {
  isLocalLoopbackClient,
  ROLE_IDS,
  unavailableFinancialField,
  type OfficeRuntime
} from './contracts.js';

export interface RolePresentation {
  id: AgentId;
  name: string;
  title: string;
  color: string;
  desk: { x: number; y: number };
}

export const ROLE_PRESENTATION: Record<AgentId, RolePresentation> = {
  market: {
    id: 'market',
    name: 'Market Analyst',
    title: 'Tape, Momentum & Orderflow Hunter',
    color: '#38bdf8',
    desk: { x: 15, y: 48 }
  },
  research: {
    id: 'research',
    name: 'Research Analyst',
    title: 'Whale Flow, Macro & Catalyst Strategist',
    color: '#a78bfa',
    desk: { x: 84, y: 43 }
  },
  strategist: {
    id: 'strategist',
    name: 'Strategist',
    title: 'Quantitative Structure & Volatility Architect',
    color: '#f59e0b',
    desk: { x: 17, y: 78 }
  },
  lead: {
    id: 'lead',
    name: 'Desk Lead',
    title: 'Head of Prop Trading & Conviction Synthesis',
    color: '#10b981',
    desk: { x: 50, y: 39 }
  },
  risk: {
    id: 'risk',
    name: 'Risk Manager',
    title: 'Asymmetric Sizing & Stop-Width Optimizer',
    color: '#f43f5e',
    desk: { x: 83, y: 68 }
  },
  execution: {
    id: 'execution',
    name: 'Execution Trader',
    title: 'Low-Latency Order & Protection Specialist',
    color: '#06b6d4',
    desk: { x: 45, y: 91 }
  }
};

export function createInitialAgents(): Record<AgentId, AgentView> {
  const out = {} as Record<AgentId, AgentView>;
  for (const id of ROLE_IDS) {
    const meta = ROLE_PRESENTATION[id];
    out[id] = {
      id,
      name: meta.name,
      title: meta.title,
      color: meta.color,
      desk: { ...meta.desk },
      provider: 'unconfigured',
      model: 'unconfigured',
      fellBackToMock: false,
      status: 'idle',
      mood: 0.5,
      stance: null,
      confidence: null,
      lastLine: 'Provider unconfigured; awaiting Owner configuration.',
      lastFailure: null
    };
  }
  return out;
}

export function createInitialScorecard(): RoleScore[] {
  return ROLE_IDS.map((role) => ({
    role,
    name: ROLE_PRESENTATION[role].name,
    calls: 0,
    right: 0,
    wrong: 0,
    note: 'No settled decisions recorded'
  }));
}

export function createInitialOfficeState(options: {
  version?: string;
  sessionId?: string | null;
  startedAt?: number;
} = {}): OfficeState {
  const startedAt = options.startedAt ?? Date.now();
  return {
    runtimeGeneration: 'v2',
    version: options.version ?? '0.0.0.4.11',
    app: 'Trading Agent Mpu Gandring',
    mode: 'PAPER',
    appMode: 'local',
    marketSource: 'bybit',
    nativeMarketPreferred: true,
    bridgeEnabled: false,
    paused: false,
    live: null,
    killed: false,
    venue: null,
    venueAccount: null,
    operationalChat: options.sessionId
      ? { id: options.sessionId, startedAt, recovered: false }
      : undefined,
    conversations: [],
    accountState: {
      hasTradableCapital: null,
      openPositionsCount: 0,
      maxPositions: 3,
      freeSlots: 0,
      occupiedSlots: 0,
      pendingOpenCount: 0,
      canOpenNewSlot: false,
      mode: 'PAPER',
      source: 'uninitialized',
      status: 'UNAVAILABLE',
      observedAt: null
    },
    chatMetrics: {
      agentCalls: 0,
      modelAttempts: 0,
      failures: 0,
      lastLatencyMs: 0,
      totalLatencyMs: 0,
      tokenUsage: null,
      modelCost: null
    },
    capabilities: [],
    trading: {
      network: null,
      profile: 'current',
      values: {
        dailyLossLimitPct: 10,
        maxLossPerTradePct: 20,
        minEntryConfidencePct: 60,
        maxLeverage: 5,
        defaultStopPct: 20,
        minStopPct: 0,
        takeProfitPct: 60,
        takeProfitR: 3,
        maxOrderUsdt: 0,
        minOrderUsdt: 0,
        safetyNet: 200,
        maxPositions: 3
      }
    },
    opportunities: {},
    auto: {
      trigger: null,
      stopping: false,
      on: false,
      intervalMin: 15,
      nextAt: 0,
      cycles: 0,
      lastCycleAt: 0,
      running: false,
      symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ZECUSDT'],
      maxHoldHours: 0
    },
    reports: [],
    reportIntervalMin: 60,
    lessons: [],
    standingRules: [],
    lessonsRefused: 0,
    scan: null,
    scorecard: createInitialScorecard(),
    learning: { on: true, scan: true, promoteAfter: 3 },
    dailyLoss: { limitPct: 10, startEquity: 0, hit: false },
    tradingview: { widget: false, prefix: 'BYBIT:', webhook: false },
    agentEvents: false,
    signals: [],
    agents: createInitialAgents(),
    tickers: {},
    debate: null,
    paper: {
      balance: 0,
      safetyNet: 200,
      n: 3,
      moneyTrade: 0,
      perOrder: 0,
      canOpen: false,
      usedMargin: 0,
      unrealized: 0,
      equity: 0,
      positions: [],
      closed: [],
      minOrderUsdt: 0,
      maxLeverage: 5,
      defaultStopPct: 20,
      takeProfitR: 3
    },
    equityHistory: [],
    verdicts: [],
    lastVerdict: null,
    logs: [],
    chats: {
      lead: [],
      market: [],
      research: [],
      strategist: [],
      risk: [],
      execution: []
    },
    roomHistory: [],
    watchlist: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ZECUSDT'],
    fightThreshold: 0.35,
    debateMode: 'normal',
    lastCycle: null,
    jev: {
      enabled: false,
      provider: 'openrouter',
      model: 'unconfigured',
      mode: 'off',
      configuredMode: 'off',
      health: 'unavailable',
      openrouterKeySet: false,
      dedicatedKeySet: false,
      keySource: 'none',
      allowLive: false,
      affectedContext: false,
      lastDecision: null,
      metrics: {
        requests: 0,
        success: 0,
        errors: 0,
        timeouts: 0,
        lastLatencyMs: null,
        lastModel: null,
        lastCost: null,
        lastInputTokens: null,
        lastError: null
      }
    },
    financial: {
      balance: unavailableFinancialField(),
      equity: unavailableFinancialField(),
      availableBalance: unavailableFinancialField(),
      unrealizedPnl: unavailableFinancialField(),
      realizedPnl: unavailableFinancialField()
    },
    runtimeIdentity: {
      savedVersion: 0,
      activeVersion: 0,
      appliedAt: null,
      applyStatus: 'UNCONFIGURED',
      reason: 'Awaiting durable settings initialization',
      lastAcknowledgedConfigVersion: null
    }
  };
}

export class OfficeEventHub {
  private sequence = 0;
  private streamEpoch = 1;
  private readonly listeners = new Set<(event: OfficeEvent) => void>();

  nextEpoch(): number {
    this.streamEpoch += 1;
    return this.streamEpoch;
  }

  currentEpoch(): number {
    return this.streamEpoch;
  }

  emit(type: OfficeEventType, data: unknown, at = Date.now()): OfficeEvent {
    this.sequence += 1;
    const event: OfficeEvent = {
      type,
      data,
      payload: data,
      sequence: this.sequence,
      streamEpoch: this.streamEpoch,
      at
    };
    for (const listener of this.listeners) {
      listener(event);
    }
    return event;
  }

  subscribe(listener: (event: OfficeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export function attachOfficeWebSocket(
  server: HttpServer,
  runtime: OfficeRuntime,
  hub: OfficeEventHub,
  options: { requireLoopback?: boolean } = {}
): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (socket, req) => {
    if (options.requireLoopback !== false) {
      const check = isLocalLoopbackClient({
        remoteAddress: req.socket.remoteAddress,
        hostHeader: req.headers.host,
        origin: req.headers.origin
      });
      if (!check.ok && runtime.snapshot().mode === 'LIVE') {
        socket.close(1008, check.reason);
        return;
      }
    }

    const snap = runtime.snapshot();
    const initial: OfficeEvent = {
      type: 'state',
      data: snap,
      payload: snap,
      sequence: 0,
      streamEpoch: hub.currentEpoch(),
      at: Date.now()
    };
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(initial));
    }

    const unsubscribe = hub.subscribe((event) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(event));
      }
    });

    socket.on('close', unsubscribe);
    socket.on('error', unsubscribe);
  });
  return wss;
}
