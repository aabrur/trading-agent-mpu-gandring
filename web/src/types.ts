export type AgentId = 'lead' | 'market' | 'research' | 'strategist' | 'risk' | 'execution' | 'reviewer';
export type Stance = 'LONG' | 'SHORT' | 'NEUTRAL';
export type AgentStatus = 'idle' | 'reading' | 'thinking' | 'typing' | 'arguing' | 'fighting' | 'executing' | 'journaling';

export interface AgentView {
  id: AgentId; name: string; title: string; color: string; desk: { x: number; y: number };
  provider: string; model: string; fellBackToMock: boolean;
  status: AgentStatus; mood: number; stance: Stance | null; confidence: number | null; lastLine: string;
}
export interface Ticker { symbol: string; last: number; change24hPct: number; source: string; example: boolean; at: number }
export interface Position { id: string; symbol: string; side: 'LONG' | 'SHORT'; qty: number; entry: number; stop: number; tp: number | null; margin: number; leverage: number; openedAt: number; mark: number; unrealizedPnl: number }
export interface ClosedTrade { id: string; symbol: string; side: 'LONG' | 'SHORT'; qty: number; entry: number; exit: number; realizedPnl: number; reason: string; closedAt: number }
export interface Verdict {
  id: string; symbol: string; action: 'OPEN_LONG' | 'OPEN_SHORT' | 'CLOSE' | 'HOLD'; riskDecision: string; executed: boolean; reason: string;
  disagreement: number; camps: { bull: AgentId[]; bear: AgentId[]; neutral: AgentId[] };
  order?: { side: 'LONG' | 'SHORT'; qty: number; entry: number; stop: number; tp: number | null; margin: number; leverage: number }; example: boolean; at: number;
}
export interface LogLine { at: number; kind: string; agent?: AgentId; text: string; example?: boolean }
export interface ChatLine { from: 'user' | AgentId | 'system'; text: string; at: number }
export interface DeskState {
  app: string; mode: 'PAPER'; marketSource: string; bridgeEnabled: boolean; paused: boolean;
  agents: Record<AgentId, AgentView>; tickers: Record<string, Ticker>;
  debate: null | { id: string; symbol: string; phase: string; round: number; disagreement: number; weighted: number; camps: Verdict['camps'] };
  paper: { balance: number; safetyNet: number; n: number; moneyTrade: number; perOrder: number; canOpen: boolean; usedMargin: number; unrealized: number; equity: number; positions: Position[]; closed: ClosedTrade[]; minOrderUsdt: number; maxLeverage: number };
  equityHistory: { t: number; equity: number; balance: number }[];
  verdicts: Verdict[]; logs: LogLine[]; chats: Record<AgentId, ChatLine[]>; watchlist: string[]; fightThreshold: number;
}
export interface Speech { agent: AgentId; text: string; done: boolean; example: boolean; at: number }
export interface Fight { id: number; from: AgentId; to: AgentId; intensity: number; punches: number; at: number }
export const AGENT_ORDER: AgentId[] = ['lead', 'market', 'research', 'strategist', 'risk', 'execution', 'reviewer'];
export type Reaction = 'cheer' | 'worried';
export interface Candle { time: number; open: number; high: number; low: number; close: number }
export interface CandleData { symbol: string; source: string; example: boolean; last: number; change24hPct: number; candles: Candle[] }
