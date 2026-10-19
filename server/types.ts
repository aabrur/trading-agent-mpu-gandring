export type AgentId = 'lead' | 'market' | 'research' | 'strategist' | 'risk' | 'execution';
export type Stance = 'LONG' | 'SHORT' | 'NEUTRAL';
export type Action = 'OPEN_LONG' | 'OPEN_SHORT' | 'CLOSE' | 'HOLD';
export type AgentStatus = 'idle' | 'reading' | 'thinking' | 'typing' | 'arguing' | 'fighting' | 'executing' | 'journaling';

export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }

export interface MarketSnapshot {
  symbol: string;
  source: 'bybit' | 'binance' | 'hyperliquid' | 'aster' | 'dydx' | 'paradex' | 'orderly' | 'sample';
  example: boolean;
  last: number;
  change24hPct: number;
  fundingRate: number | null;
  bid: number | null;
  ask: number | null;
  candles: Candle[]; // closed 15m bars, oldest first
  fetchedAt: number;
}

export interface NewsItem {
  id: string;
  symbol: string;
  headline: string;
  body: string;
  source: string;
  sentiment: 'bullish' | 'bearish' | 'neutral' | 'severe';
  example: boolean;
  flagged?: boolean;
  publishedAt?: number | null;
  sourceUrl?: string | null;
}

export interface Position {
  decisionEvidence?: Record<string, unknown>;
  ownership?: 'managed' | 'recovered' | 'external';
  protectionStatus?: 'confirmed' | 'missing' | 'unknown';
  entryStatus?: 'confirmed' | 'estimated';
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  qty: number;
  entry: number;
  stop: number;
  tp: number | null;
  margin: number;
  leverage: number;
  openedAt: number;
  mark: number;
  unrealizedPnl: number;
}

export interface ClosedTrade extends Omit<Position, 'unrealizedPnl'> {
  positionId?: string;
  remainingQty?: number;
  pnlStatus?: 'confirmed' | 'estimated' | 'unknown';
  exitStatus?: 'confirmed' | 'estimated';
  executionId?: string;
  exit: number;
  closedAt: number;
  realizedPnl: number;
  reason: string;
}

export interface Opinion {
  agent: AgentId;
  stance: Stance;
  confidence: number;
  text: string;
}

export interface Verdict {
  executionStatus?: 'partial' | 'filled' | 'closed';
  id: string;
  symbol: string;
  action: Action;
  riskDecision: 'APPROVE' | 'REDUCE' | 'REJECT' | 'N/A';
  executed: boolean;
  reason: string;
  reasonCode?: string;
  outcome?: 'HOLD' | 'BLOCKED' | 'FAILED' | 'SUBMITTED' | 'PARTIAL' | 'FILLED' | 'CLOSED';
  timing?: {
    marketData: number; marketAnalyst: number; researchAnalyst: number; strategist: number;
    jevPreAnalysis: number; rebuttals: number; deskLead: number; jevReview: number;
    riskManager: number; orderSubmission: number; fillConfirmation: number; total: number;
  };
  disagreement: number;
  camps: { bull: AgentId[]; bear: AgentId[]; neutral: AgentId[] };
  order?: { positionId?: string; status?: 'partial' | 'filled'; side: 'LONG' | 'SHORT'; qty: number; entry: number; stop: number; tp: number | null; margin: number; leverage: number };
  example: boolean;
  at: number;
}

export interface ChatLine { from: 'user' | AgentId | 'system'; text: string; at: number }
