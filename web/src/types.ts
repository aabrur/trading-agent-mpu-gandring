export type AgentId = 'lead' | 'market' | 'research' | 'strategist' | 'risk' | 'execution';
export type Stance = 'LONG' | 'SHORT' | 'NEUTRAL';
export type AgentStatus = 'idle' | 'reading' | 'thinking' | 'typing' | 'arguing' | 'fighting' | 'executing' | 'journaling';

export interface AgentView {
  id: AgentId; name: string; title: string; color: string; desk: { x: number; y: number };
  provider: string; model: string; fellBackToMock: boolean;
  status: AgentStatus; mood: number; stance: Stance | null; confidence: number | null; lastLine: string;
  lastFailure?: { kind: string; attempts: number; requestId: string | null; at: number } | null;
}
export interface Ticker { symbol: string; last: number; change24hPct: number; source: string; example: boolean; at: number }
export interface Position {
  decisionEvidence?: Record<string, unknown>; ownership?: 'managed' | 'recovered' | 'external'; protectionStatus?: 'confirmed' | 'missing' | 'unknown'; entryStatus?: 'confirmed' | 'estimated'; isHedge?: boolean; id: string; symbol: string; side: 'LONG' | 'SHORT'; qty: number; entry: number; stop: number; tp: number | null; margin: number; leverage: number; openedAt: number; mark: number; unrealizedPnl: number }
export interface ClosedTrade { pnlStatus?: 'confirmed' | 'estimated' | 'unknown'; remainingQty?: number; exitStatus?: 'confirmed' | 'estimated'; id: string; symbol: string; side: 'LONG' | 'SHORT'; qty: number; entry: number; exit: number; realizedPnl: number; reason: string; closedAt: number }
export interface Verdict {
  executionStatus?: 'partial' | 'filled' | 'closed';
  id: string; symbol: string; action: 'OPEN_LONG' | 'OPEN_SHORT' | 'CLOSE' | 'HOLD'; riskDecision: string; executed: boolean; reason: string;
  disagreement: number; camps: { bull: AgentId[]; bear: AgentId[]; neutral: AgentId[] };
  order?: { positionId?: string; status?: 'partial' | 'filled'; side: 'LONG' | 'SHORT'; qty: number; entry: number; stop: number; tp: number | null; margin: number; leverage: number }; example: boolean; at: number;
}
export interface LogLine { id?: string; conversationId?: string; at: number; kind: string; agent?: AgentId; from?: RoomMessage['from']; to?: RoomMessage['to']; text: string; example?: boolean; source?: string; level?: 'info' | 'warn' | 'error'; status?: string; durationMs?: number }
export interface ChatLine { operationalSessionId?: string; clientRequestId?: string; status?: 'pending' | 'model_working' | 'waiting_on_venue' | 'consulting' | 'completed' | 'failed' | 'cancelled'; id?: string; seq?: number; conversationId?: string; from: 'user' | AgentId | 'system'; text: string; at: number }
export interface RoomMessage { id: string; seq?: number; conversationId?: string; at: number; from: AgentId | 'owner'; to?: AgentId | 'all' | 'owner'; text: string; symbol?: string; example?: boolean }
export interface ConversationSummary { id: string; title?: string; createdAt: number; updatedAt: number; messageCount: number; lastMessage?: string; symbol?: string; }
export interface DeskState {
  nativeMarketPreferred?: boolean;
  operationalChat?: { id: string; startedAt: number; recovered: boolean };
  version?: string;
  conversations?: ConversationSummary[];
  accountState?: { hasTradableCapital: boolean | null; openPositionsCount: number; maxPositions: number; freeSlots: number; occupiedSlots?: number; pendingOpenCount?: number; canOpenNewSlot: boolean; mode: string; source: string; status: string; observedAt: number | null };
  chatMetrics?: { agentCalls: number; modelAttempts: number; failures: number; lastLatencyMs: number; totalLatencyMs: number; tokenUsage: null; modelCost: null };
  capabilities?: Array<{ name: string; category: string; available: boolean; configured: boolean; status: string; reachable?: boolean; lastSuccessfulObservation?: number; requiresApiKey: boolean | 'provider-dependent'; keyConfigured?: boolean; limitations: string[] }>;
  trading?: { network: 'testnet' | 'mainnet' | null; profile: import('../../server/trading-settings').TradingProfile; values: import('../../server/trading-settings').TradingSettings };
  app: string; mode: 'PAPER' | 'TESTNET' | 'LIVE'; appMode: 'local' | 'grokbot'; marketSource: string; bridgeEnabled: boolean; paused: boolean;
  live: { exchange: string; network: string; experimental: boolean } | null; killed: boolean;
  venue?: { name: string; label: string; kind: 'CEX' | 'DEX'; experimental: boolean } | null;
  venueAccount?: { equity: number; available: number; unrealized: number; at: number; status: 'confirmed' | 'stale'; positions?: { symbol: string; side: string; qty: number }[]; pendingSymbols?: string[] } | null;
  opportunities?: Record<string, { score: number; reasons: string[]; at: number; source: string }>;
  auto: { trigger?: 'manual' | 'scheduled' | null; stopping?: boolean; completedAt?: number; on: boolean; intervalMin: number; nextAt: number; cycles: number; lastCycleAt: number; running: boolean; symbols: string[]; maxHoldHours: number };
  reports: Report[]; reportIntervalMin: number;
  lessons: Lesson[]; standingRules: Lesson[]; lessonsRefused: number; scan: { at: number; findings: Finding[] } | null;
  scorecard: RoleScore[]; learning: { on: boolean; scan: boolean; promoteAfter: number };
  dailyLoss: { limitPct: number; startEquity: number; hit: boolean };
  tradingview: { widget: boolean; prefix: string; webhook: boolean }; agentEvents: boolean;
  signals: { source: string; symbol: string; action: string; price: number | null; note: string; at: number }[];
  agents: Record<AgentId, AgentView>; tickers: Record<string, Ticker>;
  debate: null | { id: string; symbol: string; phase: string; mode?: 'normal' | 'fast'; round: number; disagreement: number; weighted: number; camps: Verdict['camps'] };
  paper: { balance: number; safetyNet: number; n: number; moneyTrade: number; perOrder: number; orderSizePct?: number; canOpen: boolean; usedMargin: number; unrealized: number; equity: number; positions: Position[]; closed: ClosedTrade[]; minOrderUsdt: number; maxLeverage: number; defaultStopPct?: number; takeProfitR?: number };
  equityHistory: { t: number; equity: number; balance: number }[];
  verdicts: Verdict[]; logs: LogLine[]; chats: Record<AgentId, ChatLine[]>; roomHistory?: RoomMessage[]; watchlist: string[];  fightThreshold: number;
  debateMode?: 'normal' | 'fast';
  lastCycle?: { symbol: string; durationMs: number; stage: string; verdict: string | null; noTradeReason: string | null; executionStatus: string | null; reasonCode: string | null; outcome: string | null } | null;
  jev?: {
    enabled: boolean; provider: string; model: string; mode: string; configuredMode?: string; health: string;
    openrouterKeySet?: boolean; dedicatedKeySet?: boolean; keySource?: string; allowLive?: boolean; affectedContext?: boolean;
    lastDecision?: Record<string, unknown> | null;
    metrics?: { requests: number; success: number; errors: number; timeouts: number; lastLatencyMs: number | null; lastModel: string | null; lastCost: number | null; lastInputTokens: number | null; lastError: string | null };
  };
}
export interface Lesson {
  id: string; role: string; kind: string; symbol?: string;
  happened: string; rootCause: string; lesson: string;
  condition?: string; evaluationStatus?: string;
  sourceTradeIds?: string[]; sourceDecisionIds?: string[]; sourceMessageIds?: string[]; accountScope?: string;
  status: 'new' | 'confirmed' | 'promoted'; count: number; firstAt: number; lastAt: number; source: string;
}
export interface Finding { level: 'ok' | 'info' | 'warn' | 'alert'; code: string; text: string }
export interface RoleScore { role: string; name: string; calls: number; right: number; wrong: number; note: string }
export interface Activity { at: number; kind: 'opened' | 'closed' | 'skipped'; symbol: string; detail: string }
export interface Report {
  monitoring?: { symbols: string[]; killed: boolean; running: boolean; current: string | null; previous: string | null };
  opportunityReviews?: { observed: number; pending: number; unavailable: number; items: { id: string; symbol: string; side: string | null; reasonKind: string; reason: string; status: string; directionalMovePct: number | null; reference: { source: string } }[] };
  accounting?: { source: string; status: string; observedAt: number | null; confirmedRealized: number; estimatedRealized: number; unknownExits: number; actualFees: number | null; funding: number | null; financialEvidence?: { coverage: string; confirmedNetRealized: number | null; unattributedRecords: number; observedAt: number | null } };
  id: string; at: number; since: number; mode: string; exchange: string | null;
  balance: number; safetyNet: number; moneyTrade: number; n: number; perOrder: number; equity: number; unrealized: number; realized: number;
  dailyLoss: { limitPct: number; hit: boolean }; auto: { on: boolean; cycles: number; intervalMin: number };
  positions: { ownership?: string; protectionStatus?: string; entryStatus?: string; symbol: string; side: string; qty: number; entry: number; stop: number; tp: number | null; mark: number; pnl: number; openedAt: number }[];
  opened: Activity[]; closed: Activity[]; skipped: Activity[]; text: string;
  scorecard?: RoleScore[]; lessons?: { role: string; kind: string; status: string; count: number; symbol?: string; lesson: string; rootCause: string }[]; standingRules?: string[]; scan?: Finding[];
}
export interface Speech { id?: string; conversationId?: string; agent: AgentId; text: string; done: boolean; example: boolean; at: number }
export interface CendolEvent { id: string; supporter: string; quantity: number; message?: string; text: string; at: number }
export interface Fight { id: number; from: AgentId; to: AgentId; intensity: number; punches: number; at: number }
export const AGENT_ORDER: AgentId[] = ['lead', 'market', 'research', 'strategist', 'risk', 'execution'];
export type Reaction = 'cheer' | 'worried';
export type ChartTimeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
export interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number }
export interface CandleData { requestedVenue?: string; dataType?: 'native' | 'reference'; symbol: string; tf?: ChartTimeframe; source: string; example: boolean; fetchedAt?: number; last: number | null; change24hPct?: number; candles: Candle[] }

export const VERIFIED_TOKENS = [
  // Tier 1 Mega-Cap (10)
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'BNBUSDT',
  'XRPUSDT',
  'DOGEUSDT',
  'ADAUSDT',
  'AVAXUSDT',
  'SUIUSDT',
  'LINKUSDT',

  // Tier 2 Major L1 & L2 (25)
  'NEARUSDT',
  'APTUSDT',
  'ARBUSDT',
  'OPUSDT',
  'TIAUSDT',
  'INJUSDT',
  'SEIUSDT',
  'DOTUSDT',
  'ATOMUSDT',
  'LTCUSDT',
  'BCHUSDT',
  'XLMUSDT',
  'FILUSDT',
  'ICPUSDT',
  'HBARUSDT',
  'STXUSDT',
  'ALGOUSDT',
  'FLOWUSDT',
  'EGLDUSDT',
  'XTZUSDT',
  'POLUSDT',
  'MNTUSDT',
  'STRKUSDT',
  'ZROUSDT',
  'CFXUSDT',

  // Tier 2 DeFi & DEX Protocol (20)
  'AAVEUSDT',
  'UNIUSDT',
  'CRVUSDT',
  'KASUSDT',
  'SNXUSDT',
  'COMPUSDT',
  'PENDLEUSDT',
  'JUPUSDT',
  'ENAUSDT',
  'LDOUSDT',
  'DYDXUSDT',
  'GMXUSDT',
  '1INCHUSDT',
  'SUSHIUSDT',
  'KNCUSDT',
  'CAKEUSDT',
  'RAYDIUMUSDT',
  'RUNEUSDT',
  'ONDOUSDT',
  'AEROUSDT',

  // Tier 2 AI, DePIN & Compute (15)
  'TAOUSDT',
  'RENDERUSDT',
  'WLDUSDT',
  'GRASSUSDT',
  'ARKMUSDT',
  'IOUSDT',
  'ATHUSDT',
  'AKTUSDT',
  'THETAUSDT',
  'GRTUSDT',
  'JASMYUSDT',
  'ARUSDT',
  'STORJUSDT',
  'GLMUSDT',
  'HYPEUSDT',

  // Tier 2 Oracles, Interop & Infra (15)
  'PYTHUSDT',
  'JTOUSDT',
  'QNTUSDT',
  'WOOUSDT',
  'NOTUSDT',
  'AXISUSDT',
  'BLURUSDT',
  'CHZUSDT',
  'ENSUSDT',
  'GALAUSDT',
  'MANAUSDT',
  'SANDUSDT',
  'AXSUSDT',
  'BEAMUSDT',
  'APEUSDT',

  // Tier 2 Top Memes & Ecosystems (15)
  'WIFUSDT',
  '1000PEPEUSDT',
  '1000BONKUSDT',
  '1000FLOKIUSDT',
  'SHIB1000USDT',
  'POPCATUSDT',
  'MEWUSDT',
  'BOMEUSDT',
  'MEMEUSDT',
  'PENGUUSDT',
  'ORDIUSDT',
  'NEOUSDT',
  'IOTAUSDT',
  'ZECUSDT',
  'DASHUSDT'
] as const;

export const POPULAR_SYMBOLS = VERIFIED_TOKENS;
