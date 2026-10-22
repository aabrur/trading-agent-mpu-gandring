export type AgentId = 'lead' | 'market' | 'research' | 'strategist' | 'risk' | 'execution';
export type Stance = 'LONG' | 'SHORT' | 'NEUTRAL';
export type Action = 'OPEN_LONG' | 'OPEN_SHORT' | 'CLOSE' | 'HOLD';
export type AgentStatus = 'idle' | 'reading' | 'thinking' | 'typing' | 'arguing' | 'fighting' | 'executing' | 'journaling';

export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }

export interface RoomMessage {
  id: string;
  at: number;
  from: AgentId | 'owner';
  to?: AgentId | 'all' | 'owner';
  text: string;
  symbol?: string;
  example?: boolean;
}

export interface OrderbookSummary {
  bidAskImbalance05Pct: number;
  bidAskImbalance1Pct: number;
  spreadBps: number;
  microPrice: number;
  topBidWall: { price: number; size: number } | null;
  topAskWall: { price: number; size: number } | null;
  bids?: [number, number][];
  asks?: [number, number][];
}

export interface OrderflowSummary {
  takerBuyVol: number;
  takerSellVol: number;
  cvdDelta: number;
  buySellRatio: number;
  deltaDivergence: boolean;
  tradesCount?: number;
}

export interface DerivativesSummary {
  fundingRate: number | null;
  predictedFunding: number | null;
  openInterest: number | null;
  oiDelta15mPct: number | null;
  oiDelta1hPct: number | null;
  oiDelta4hPct: number | null;
  spotPerpBasisBps: number | null;
  multiVenueFunding?: Record<string, { fundingRate: number | null; openInterest?: number | null }>;
  liquidations24hUsd?: number | null;
  liquidationClusters?: Array<{ price: number; estimatedVolUsd: number; side: 'LONG' | 'SHORT' }>;
}

export interface TechnicalSummary {
  mtfTrend: Record<'5m' | '15m' | '1h' | '4h', {
    ema9: number;
    ema21: number;
    ema50: number;
    ema200: number;
    regime: 'STRONG_UPTREND' | 'STRONG_DOWNTREND' | 'RANGING_CHOP' | 'SQUEEZE_BREAKOUT';
  }>;
  volatility: {
    atr14: number;
    atrPct: number;
    realizedVol24h: number;
    bollingerBandWidthPct: number;
  };
  momentum: {
    rsi14_15m: number;
    rsi14_1h: number;
    rsi14_4h: number;
  };
  volumeProfile: {
    sessionVwap: number;
    poc: number;
    vah: number;
    val: number;
  };
  swingLevels: {
    recentSwingHigh: number;
    recentSwingLow: number;
    distToLiquiditySweepPct: number;
  };
}

export interface WhaleOnChainSummary {
  hyperliquidWhales?: {
    longCount: number;
    shortCount: number;
    avgLongNotional: number;
    avgShortNotional: number;
    totalUnrealizedPnl: number;
    topPositions?: Array<{ address: string; side: 'LONG' | 'SHORT'; notional: number; pnl: number }>;
  };
  deribitMacro?: {
    dvol: number | null;
    putCallRatio: number | null;
    indexPrice: number | null;
  };
  newsWire?: NewsItem[];
  arkhamAlerts?: Array<{ id: string; summary: string; timestamp: number }>;
}

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
  orderbook?: OrderbookSummary | null;
  orderflow?: OrderflowSummary | null;
  derivatives?: DerivativesSummary | null;
  technicalSummary?: TechnicalSummary | null;
  whaleOnChain?: WhaleOnChainSummary | null;
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
  isHedge?: boolean;
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
