export type AgentId = 'lead' | 'market' | 'research' | 'strategist' | 'risk' | 'execution';
export type Stance = 'LONG' | 'SHORT' | 'NEUTRAL';
export type Action = 'OPEN_LONG' | 'OPEN_SHORT' | 'CLOSE' | 'HOLD';
export type AgentStatus = 'idle' | 'reading' | 'thinking' | 'typing' | 'arguing' | 'fighting' | 'executing' | 'journaling';

export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }

export interface MeasurementEvidence {
  source: string;
  observedAt: number;
  status: 'live' | 'unavailable';
  sampleAt?: number;
  baselineAt?: number;
  basis?: string;
  reason?: string;
}

export interface RoomMessage {
  operationalSessionId?: string;
  conversationId?: string;
  id: string;
  seq?: number;
  at: number;
  from: AgentId | 'owner';
  to?: AgentId | 'all' | 'owner';
  text: string;
  symbol?: string;
  example?: boolean;
}

export interface ConversationSummary {
  operationalSessionId?: string;
  accountScope?: string;
  id: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  lastMessage?: string;
  symbol?: string;
}

export interface OrderbookSummary {
  provenance?: import('./market/provenance.js').FeedProvenance;
  liquidityChanges?: import('./market/microstructure.js').LiquidityChanges | null;
  bidObservedCoveragePct?: number;
  askObservedCoveragePct?: number;
  maxObservedCoveragePct?: number;
  requestedVenue?: string;
  actualDataVenue?: string;
  dataType?: string;
  sourceEndpoint?: string;
  depthBands?: Record<'0.5%' | '1.0%' | '2.0%', import('./market/microstructure.js').DepthBand>;
  levelsReturned?: { bids: number; asks: number };
  evidence?: MeasurementEvidence;
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
  provenance?: import('./market/provenance.js').FeedProvenance;
  requestedVenue?: string;
  actualDataVenue?: string;
  dataType?: string;
  sourceEndpoint?: string;
  rollingWindows?: Record<'1m' | '5m' | '15m', import('./market/microstructure.js').FlowWindow>;
  evidence?: MeasurementEvidence;
  takerBuyVol: number;
  takerSellVol: number;
  cvdDelta: number;
  buySellRatio: number | null;
  deltaDivergence: boolean;
  tradesCount?: number;
}

export interface DerivativesSummary {
  positioning?: import('./market/positioning.js').PositioningSummary;
  evidence?: Record<string, MeasurementEvidence>;
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
  derivation?: Record<string, string>;
  mtfTrend: Record<'5m' | '15m' | '1h' | '4h', {
    ema9: number;
    ema21: number;
    ema50: number;
    ema200: number | null;
    regime: 'STRONG_UPTREND' | 'STRONG_DOWNTREND' | 'RANGING_CHOP' | 'SQUEEZE_BREAKOUT';
  } | null>;
  volatility: {
    atr14: number;
    atrPct: number;
    realizedVol24h: number | null;
    realizedVol24hBasis?: string;
    bollingerBandWidthPct: number;
  } | null;
  momentum: {
    rsi14_15m: number | null;
    rsi14_1h: number | null;
    rsi14_4h: number | null;
  };
  volumeProfile: {
    sessionVwap: number;
    poc: number;
    vah: number;
    val: number;
  } | null;
  swingLevels: {
    recentSwingHigh: number;
    recentSwingLow: number;
    distToLiquiditySweepPct: number;
  } | null;
}

export interface WhaleOnChainSummary {
  hyperliquidWhales?: {
    coverageStatus?: string;
    coverageNote?: string;
    evidence?: MeasurementEvidence;
    walletsChecked?: number;
    walletsRequested?: number;
    longCount: number;
    shortCount: number;
    avgLongNotional: number;
    avgShortNotional: number;
    totalUnrealizedPnl: number;
    topPositions?: Array<{ address: string; side: 'LONG' | 'SHORT'; notional: number; pnl: number }>;
  };
  deribitMacro?: {
    evidence?: Record<string, MeasurementEvidence>;
    currency?: string;
    putCallRatioBasis?: 'open_interest';
    dvol: number | null;
    putCallRatio: number | null;
    indexPrice: number | null;
  };
  newsWire?: NewsItem[];
  arkhamAlerts?: Array<{ id: string; summary: string; timestamp: number }>;
}

export interface MarketSnapshot {
  collectorStartedAt?: number;
  collectorEndedAt?: number;
  candleMetadata?: import('./market/observations.js').CandleMetadata;
  volumeDiagnostics?: ReturnType<typeof import('./strategy.js').volumeDiagnostics>;
  feedProvenance?: Record<string, import('./market/provenance.js').FeedProvenance>;
  dataProvenance?: { requestedVenue: string; actualVenue: string; dataType: 'native' | 'reference'; symbolMapping: { requested: string; actual: string; transformed: boolean }; executionCompatible: boolean; fetchedAt: number };
  snapshotId?: string;
  cmcMomentum?: import('./market/coinmarketcap.js').CmcMomentum;
  tacticalTradePlan?: import('./market/tactical.js').TacticalTradePlan;
  evidence?: Record<string, MeasurementEvidence>;
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
  coinMarketCap?: import('./market/coinmarketcap.js').CoinMarketCapSummary | null;
}

export interface NewsItem {
  eventAt?: number | null;
  windowStartAt?: number | null;
  windowEndAt?: number | null;
  metric?: { value: number; unit: string; scope: string; windowHours?: number };
  metricProvenance?: import('./market/news.js').MetricProvenance;
  observedAt?: number;
  affectedAssets?: string[];
  eventCategory?: string;
  evidenceStatus?: string;
  provider?: 'cryptopanic' | 'bybit' | 'sample';
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
  /** Structural thesis boundary, independent of the Owner's margin-based SL/TP. */
  invalidationLevel?: number;
  entryZone?: { low: number; high: number; basis: string };
  entryScenarioId?: string;
  decisionEvidence?: Record<string, unknown>;
  ownership?: 'managed' | 'recovered' | 'external';
  protectionStatus?: 'confirmed' | 'missing' | 'unknown';
  protectionEvidence?: import('./exchange/types.js').ProtectionEvidence;
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

export type ExitCause = 'EXCHANGE_SL' | 'EXCHANGE_TP' | 'AI_DEBATE' | 'OWNER_MANUAL' | 'OWNER_KILL' | 'RECONCILIATION' | 'EXTERNAL' | 'UNKNOWN';
export interface ClosedTrade extends Omit<Position, 'unrealizedPnl'> {
  exitCause?: ExitCause;
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
  entryPolicy?: 'RISK_AND_OWNER_CONFIDENCE';
  aiDecision?: Action;
  exitCause?: ExitCause;
  executionOutcome?: string;
  finalOperationalStatus?: string;
  ownerMinConfidencePct?: number;
  riskAssessment?: { decision: string; reason: string; fallback: boolean };
  nativeQuote?: Record<string, unknown>;
  debateEvidence?: import('./decision/debate-evidence.js').DebateEvidence;
  closeTrigger?: import('./decision/debate-evidence.js').CloseTriggerReason;
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

export interface ChatLine { operationalSessionId?: string; clientRequestId?: string; status?: 'pending' | 'model_working' | 'waiting_on_venue' | 'consulting' | 'completed' | 'failed' | 'cancelled';
  id?: string;
  seq?: number;
  conversationId?: string;
  from: 'user' | AgentId | 'system';
  text: string;
  at: number;
}
