export type AgentId = 'lead' | 'market' | 'research' | 'strategist' | 'risk' | 'execution';
export type Stance = 'LONG' | 'SHORT' | 'NEUTRAL';
export type AgentStatus = 'idle' | 'reading' | 'thinking' | 'typing' | 'arguing' | 'fighting' | 'executing' | 'journaling';

export interface AgentView {
  id: AgentId; name: string; title: string; color: string; desk: { x: number; y: number };
  provider: string; model: string; fellBackToMock: boolean;
  status: AgentStatus; mood: number; stance: Stance | null; confidence: number | null; lastLine: string;
}
export interface Ticker { symbol: string; last: number; change24hPct: number; source: string; example: boolean; at: number }
export interface Position {
  decisionEvidence?: Record<string, unknown>; ownership?: 'managed' | 'recovered' | 'external'; protectionStatus?: 'confirmed' | 'missing' | 'unknown'; entryStatus?: 'confirmed' | 'estimated'; id: string; symbol: string; side: 'LONG' | 'SHORT'; qty: number; entry: number; stop: number; tp: number | null; margin: number; leverage: number; openedAt: number; mark: number; unrealizedPnl: number }
export interface ClosedTrade { pnlStatus?: 'confirmed' | 'estimated' | 'unknown'; remainingQty?: number; exitStatus?: 'confirmed' | 'estimated'; id: string; symbol: string; side: 'LONG' | 'SHORT'; qty: number; entry: number; exit: number; realizedPnl: number; reason: string; closedAt: number }
export interface Verdict {
  executionStatus?: 'partial' | 'filled' | 'closed';
  id: string; symbol: string; action: 'OPEN_LONG' | 'OPEN_SHORT' | 'CLOSE' | 'HOLD'; riskDecision: string; executed: boolean; reason: string;
  disagreement: number; camps: { bull: AgentId[]; bear: AgentId[]; neutral: AgentId[] };
  order?: { positionId?: string; status?: 'partial' | 'filled'; side: 'LONG' | 'SHORT'; qty: number; entry: number; stop: number; tp: number | null; margin: number; leverage: number }; example: boolean; at: number;
}
export interface LogLine { at: number; kind: string; agent?: AgentId; text: string; example?: boolean }
export interface ChatLine { from: 'user' | AgentId | 'system'; text: string; at: number }
export interface DeskState {
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
  debate: null | { id: string; symbol: string; phase: string; round: number; disagreement: number; weighted: number; camps: Verdict['camps'] };
  paper: { balance: number; safetyNet: number; n: number; moneyTrade: number; perOrder: number; canOpen: boolean; usedMargin: number; unrealized: number; equity: number; positions: Position[]; closed: ClosedTrade[]; minOrderUsdt: number; maxLeverage: number; defaultStopPct?: number; takeProfitR?: number };
  equityHistory: { t: number; equity: number; balance: number }[];
  verdicts: Verdict[]; logs: LogLine[]; chats: Record<AgentId, ChatLine[]>; watchlist: string[]; fightThreshold: number;
}
export interface Lesson { id: string; role: string; kind: string; symbol?: string; happened: string; rootCause: string; lesson: string; status: 'new' | 'confirmed' | 'promoted'; count: number; firstAt: number; lastAt: number; source: string }
export interface Finding { level: 'ok' | 'info' | 'warn' | 'alert'; code: string; text: string }
export interface RoleScore { role: string; name: string; calls: number; right: number; wrong: number; note: string }
export interface Activity { at: number; kind: 'opened' | 'closed' | 'skipped'; symbol: string; detail: string }
export interface Report {
  opportunityReviews?: { observed: number; pending: number; unavailable: number; items: { id: string; symbol: string; side: string | null; reasonKind: string; reason: string; status: string; directionalMovePct: number | null; reference: { source: string } }[] };
  accounting?: { source: string; status: string; observedAt: number | null; confirmedRealized: number; estimatedRealized: number; unknownExits: number; actualFees: number | null; funding: number | null; financialEvidence?: { coverage: string; confirmedNetRealized: number | null; unattributedRecords: number; observedAt: number | null } };
  id: string; at: number; since: number; mode: string; exchange: string | null;
  balance: number; safetyNet: number; moneyTrade: number; n: number; perOrder: number; equity: number; unrealized: number; realized: number;
  dailyLoss: { limitPct: number; hit: boolean }; auto: { on: boolean; cycles: number; intervalMin: number };
  positions: { ownership?: string; protectionStatus?: string; entryStatus?: string; symbol: string; side: string; qty: number; entry: number; stop: number; tp: number | null; mark: number; pnl: number; openedAt: number }[];
  opened: Activity[]; closed: Activity[]; skipped: Activity[]; text: string;
  scorecard?: RoleScore[]; lessons?: { role: string; kind: string; status: string; count: number; symbol?: string; lesson: string; rootCause: string }[]; standingRules?: string[]; scan?: Finding[];
}
export interface Speech { agent: AgentId; text: string; done: boolean; example: boolean; at: number }
export interface Fight { id: number; from: AgentId; to: AgentId; intensity: number; punches: number; at: number }
export const AGENT_ORDER: AgentId[] = ['lead', 'market', 'research', 'strategist', 'risk', 'execution'];
export type Reaction = 'cheer' | 'worried';
export interface Candle { time: number; open: number; high: number; low: number; close: number }
export interface CandleData { symbol: string; source: string; example: boolean; last: number; change24hPct: number; candles: Candle[] }

export const POPULAR_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'DOGEUSDT',
  'XRPUSDT',
  'SUIUSDT',
  'PEPEUSDT',
  'BNBUSDT',
  'ADAUSDT',
  'AVAXUSDT',
  'LINKUSDT',
  'NEARUSDT',
  'APTUSDT',
  'ARBUSDT',
  'OPUSDT',
  'TONUSDT',
  'SHIBUSDT',
  'WIFUSDT'
] as const;
