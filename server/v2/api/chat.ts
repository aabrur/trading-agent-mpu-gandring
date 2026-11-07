import type express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { safe } from '../../redact.js';
import { isLocalLoopbackClient, type OfficeRuntime, type OfficeState, type TF } from '../contracts.js';
import type { RuntimeStore } from '../store/database.js';
import type { BybitMarketHub } from '../market/bybit.js';
import { computeIntelligence } from '../market/intelligence.js';
import { liveAnnouncementObservation } from '../../market/live-news.js';
import { analyzeSMC } from '../../market/smc.js';
import { calculateAlphaFactors } from '../../market/alpha-factors.js';
import { detectHarmonicPatterns } from '../../market/harmonics.js';
import { evaluateWatchlistOpportunity } from '../market/opportunity.js';

function roundPriceMetric(val: number | string | null | undefined, refPrice = 1): number | null {
  if (val === null || val === undefined) return null;
  const num = typeof val === 'number' ? val : Number(val);
  if (!Number.isFinite(num)) return null;
  const absRef = Math.abs(refPrice || num);
  const decimals = absRef >= 100 ? 2 : absRef >= 1 ? 4 : absRef >= 0.01 ? 6 : 8;
  const factor = 10 ** decimals;
  return Math.round(num * factor) / factor;
}

function roundRatioMetric(val: number | string | null | undefined, decimals = 2): number | null {
  if (val === null || val === undefined) return null;
  const num = typeof val === 'number' ? val : Number(val);
  if (!Number.isFinite(num)) return null;
  const factor = 10 ** decimals;
  return Math.round(num * factor) / factor;
}

export interface StudioConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

const newConversationSchema = z.object({
  title: z.string().min(1).max(120).optional()
});

export class ChatService {
  private conversations: StudioConversation[] = [
    {
      id: 'office',
      title: 'Main Office',
      createdAt: Date.now() - 3600000,
      updatedAt: Date.now(),
      messageCount: 0
    }
  ];
  private activeRequests = new Set<string>();

  constructor(private readonly store?: RuntimeStore) {
    if (this.store) {
      void this.hydrateFromStore();
    }
  }

  public async hydrateFromStore(): Promise<void> {
    if (!this.store) return;
    try {
      const res = await this.store.execute(
        `SELECT conversation_id, title, created_at, updated_at FROM conversations WHERE deleted_at IS NULL ORDER BY created_at DESC`
      );
      const loaded: StudioConversation[] = [];
      const hasOffice = res.rows.some((r) => String(r.conversation_id) === 'office');
      if (!hasOffice) {
        loaded.push({
          id: 'office',
          title: 'Main Office',
          createdAt: Date.now() - 3600000,
          updatedAt: Date.now(),
          messageCount: 0
        });
      }
      for (const row of res.rows) {
        loaded.push({
          id: String(row.conversation_id),
          title: String(row.title ?? 'Discussion Session'),
          createdAt: new Date(String(row.created_at)).getTime() || Date.now(),
          updatedAt: new Date(String(row.updated_at)).getTime() || Date.now(),
          messageCount: 0
        });
      }
      if (loaded.length > 0) {
        const existingMap = new Map(this.conversations.map(c => [c.id, c]));
        for (const item of loaded) {
          if (!existingMap.has(item.id)) {
            existingMap.set(item.id, item);
          }
        }
        this.conversations = Array.from(existingMap.values());
      }
    } catch {}
  }

  public listConversations(): StudioConversation[] {
    return [...this.conversations];
  }

  public createConversation(title?: string): StudioConversation {
    const id = `conv-${randomUUID()}`;
    const conv: StudioConversation = {
      id,
      title: safe(title ?? 'New Discussion Session'),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: 0
    };
    this.conversations.unshift(conv);

    if (this.store) {
      const iso = new Date(conv.createdAt).toISOString();
      void this.store.execute(
        `INSERT OR REPLACE INTO conversations (conversation_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
        [conv.id, conv.title, iso, iso]
      ).catch(() => {});
    }

    return conv;
  }

  public deleteConversation(id: string): boolean {
    if (id === 'office') return false;
    const index = this.conversations.findIndex(item => item.id === id);
    if (index < 0) return false;
    this.conversations.splice(index, 1);

    if (this.store) {
      const now = new Date().toISOString();
      void this.store.execute(
        `UPDATE conversations SET deleted_at = ? WHERE conversation_id = ?`,
        [now, id]
      ).catch(() => {});
      void this.store.execute(
        `DELETE FROM chat_messages WHERE conversation_id = ?`,
        [id]
      ).catch(() => {});
    }

    return true;
  }

  public async recordMessage(msg: {
    messageId?: string;
    conversationId: string;
    clientRequestId?: string;
    role: string;
    text: string;
    status?: string;
  }): Promise<void> {
    if (!this.store) return;
    const messageId = msg.messageId || randomUUID();
    const now = new Date().toISOString();
    await this.store.execute(
      `INSERT OR IGNORE INTO chat_messages (message_id, conversation_id, client_request_id, role, text, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [messageId, msg.conversationId, msg.clientRequestId ?? null, msg.role, msg.text, now, msg.status ?? 'delivered']
    );
  }

  public async listMessages(conversationId: string, limit = 50): Promise<Array<{ messageId: string; role: string; text: string; createdAt: string }>> {
    if (!this.store) return [];
    const res = await this.store.execute(
      `SELECT message_id, role, text, created_at FROM chat_messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?`,
      [conversationId, limit]
    );
    return res.rows.map(r => ({
      messageId: String(r.message_id),
      role: String(r.role),
      text: String(r.text),
      createdAt: String(r.created_at)
    }));
  }

  public cancelRequest(requestId: string): boolean {
    this.activeRequests.delete(requestId);
    return true;
  }
}

export function mountChatRoutes(
  app: express.Express,
  service: ChatService,
  runtime: OfficeRuntime
): void {
  function verifyOwner(req: express.Request, res: express.Response): boolean {
    const check = isLocalLoopbackClient({
      remoteAddress: req.socket.remoteAddress,
      hostHeader: req.headers.host,
      origin: req.get('origin')
    });
    if (!check.ok) {
      res.status(403).json({ ok: false, error: check.reason });
      return false;
    }
    return true;
  }

  runtime.updateState?.((draft) => { draft.conversations = service.listConversations(); });

  app.get('/api/conversations', (_req, res) => {
    res.json({
      ok: true,
      conversations: service.listConversations()
    });
  });

  app.post('/api/conversations/new', (req, res) => {
    if (!verifyOwner(req, res)) return;

    const parsed = newConversationSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Invalid conversation title.' });
      return;
    }
    const conv = service.createConversation(parsed.data.title);
    runtime.updateState?.((draft) => { draft.conversations = service.listConversations(); });
    res.json({ ok: true, conversationId: conv.id, conversation: conv });
  });

  app.delete('/api/conversations/:id', (req, res) => {
    if (!verifyOwner(req, res)) return;
    if (req.query.confirm !== 'true' && req.body?.confirm !== true) {
      res.status(400).json({ ok: false, error: 'Deletion requires confirm=true.' });
      return;
    }
    const id = String(req.params.id);
    if (!service.deleteConversation(id)) {
      res.status(404).json({ ok: false, error: 'Conversation not found or protected.' });
      return;
    }
    runtime.updateState?.((draft) => {
      draft.conversations = service.listConversations();
      draft.roomHistory = (draft.roomHistory ?? []).filter(message => message.conversationId !== id);
      for (const role of Object.keys(draft.chats) as Array<keyof typeof draft.chats>) {
        draft.chats[role] = (draft.chats[role] ?? []).filter(message => message.conversationId !== id);
      }
    });
    res.json({ ok: true, deletedId: id });
  });

  app.post('/api/chat/cancel/:id', (req, res) => {
    if (!verifyOwner(req, res)) return;

    const requestId = req.params.id;
    service.cancelRequest(requestId);
    res.json({
      ok: true,
      requestId,
      cancelled: true
    });
  });
}

const SECRET_KEY_RE = /(key|secret|token|password|private|authorization|seed|mnemonic|webhook)/i;

export type DeskFreshness = 'live' | 'cached' | 'stale' | 'unavailable';

export interface AccountCapitalSummary {
  totalEquity: number;
  balance: number;
  safetyNet: number;
  moneyTradeBudget: number;
  usedMargin: number;
  freeAllocatableMargin: number;
  perOrderAllocation: number;
  maxSlotsN: number;
  occupiedSlots: number;
  freeSlots: number;
}

export interface LiveDeskChatContext {
  capturedAt: string;
  informationalOnly: true;
  accountCapital?: AccountCapitalSummary;
  tradingProfile: string | null;
  tradingValues?: {
    maxLeverage: number;
    defaultStopPct: number;
    takeProfitPct?: number;
    takeProfitR?: number;
    dailyLossLimitPct?: number;
    maxLossPerTradePct?: number;
    minEntryConfidencePct?: number;
    sizingMode?: string;
    safetyNet: number;
    maxPositions: number;
    orderSizePct?: number | null;
  } | null;
  moneySplit?: {
    balance: number;
    equity: number;
    safetyNet: number;
    moneyTrade: number;
    perOrder: number;
    slotsN: number;
  };
  venueAccount: {
    name: string | null;
    mode: string;
    equity: number | null;
    available: number | null;
    freshness: DeskFreshness;
  };
  positions: Array<{
    symbol: string;
    side: string;
    qty: number;
    entry: number;
    stop: number;
    tp: number | null;
    protectionStatus?: 'confirmed' | 'missing' | 'unknown';
  }>;
  restingOrders: Array<{ symbol: string; side: string; status: string }>;
  watchlistPrices: Array<{ symbol: string; last: number | null; freshness: DeskFreshness; source: string }>;
  assignedModels: Array<{ role: string; provider: string | null; model: string | null }>;
  freshness: { positions: DeskFreshness; prices: DeskFreshness };
  marketIntelligenceBySymbol?: Record<string, {
    timeframes: Record<string, unknown>;
    microstructure: {
      spreadBps: number | null;
      bookImbalanceTop10: number | null;
      takerFlow: unknown | null;
      fundingRate: number | null;
      openInterest: number | null;
    };
    whaleExchangeFlow?: unknown;
    liveNews?: unknown;
  }>;
  watchlistOpportunityRanking?: Array<{
    rank: number;
    symbol: string;
    score: number;
    bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    reasons: string[];
  }>;
  recentVerdicts?: Array<{
    id: string;
    symbol: string;
    action: string;
    operationalStatus?: string;
    executed: boolean;
    reason: string;
    order?: unknown;
    at: number;
  }>;
  recentLessons?: Array<{
    role: string;
    kind: string;
    symbol?: string;
    happened: string;
    rootCause: string;
    lesson: string;
    status?: string;
  }>;
  jev?: {
    enabled: boolean;
    health?: string;
    lastDecision?: unknown;
  } | null;
  extraFeeds?: Record<string, unknown>;
}

function classifyFreshness(
  at: number | null | undefined,
  now: number,
  liveMs = 15_000,
  cachedMs = 120_000
): DeskFreshness {
  if (at == null || at <= 0) return 'unavailable';
  const age = now - at;
  if (age <= liveMs) return 'live';
  if (age <= cachedMs) return 'cached';
  return 'stale';
}

export function buildLiveDeskChatContext(
  state: OfficeState,
  options: {
    capturedAt?: string;
    now?: number;
    secrets?: Record<string, unknown>;
    marketHub?: BybitMarketHub;
    extraFeeds?: Record<string, unknown>;
    newsBySymbol?: Record<string, unknown>;
  } = {}
): LiveDeskChatContext {
  const now = options.now ?? Date.now();
  const capturedAt = options.capturedAt ?? new Date(now).toISOString();
  const isConfirmedVenue = state.venueAccount?.status === 'confirmed';
  const venueLiveLimit = isConfirmedVenue ? 60_000 : 15_000;
  const venueCachedLimit = isConfirmedVenue ? 300_000 : 120_000;
  const posFresh = classifyFreshness(state.venueAccount?.at ?? (state.paper.positions[0]?.openedAt ?? now), now, venueLiveLimit, venueCachedLimit);
  const prices = Object.values(state.tickers ?? {}).slice(0, 12).map((ticker) => ({
    symbol: ticker.symbol,
    last: ticker.last ?? null,
    freshness: classifyFreshness(ticker.at, now),
    source: ticker.source ?? 'unknown'
  }));

  const marketIntelligenceBySymbol: Record<string, any> = {};
  const rawRanking: Array<{ symbol: string; score: number; bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'; reasons: string[] }> = [];

  if (options.marketHub) {
    const rawSymbols = (state.watchlist && state.watchlist.length > 0)
      ? state.watchlist
      : Object.keys(state.tickers ?? {});
    const activeSymbols = Array.from(new Set(rawSymbols)).slice(0, 8);

    for (const sym of activeSymbols) {
      try {
        const frame = options.marketHub.snapshot(sym);
        const book = options.marketHub.orderbook(sym);
        const trades = options.marketHub.recentTrades(sym);
        const intel = computeIntelligence(frame, { orderbook: book, trades });
        const currentPriceNum = Number(frame.last?.value ?? state.tickers?.[sym]?.last ?? 1) || 1;

        const tfSummary: Record<string, any> = {};
        for (const [tf, feat] of Object.entries(intel.byTimeframe ?? {})) {
          if (!feat) continue;
          const highs = feat.structure?.pivots?.filter((p) => p.kind === 'HIGH') ?? [];
          const lows = feat.structure?.pivots?.filter((p) => p.kind === 'LOW') ?? [];
          const closed = frame.closed[tf as TF]?.filter((b) => b.confirmed) ?? [];
          const lastBar = closed.at(-1);
          const priorBars = closed.slice(-21, -1);
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

          let liquiditySweep: 'BEARISH_SWEEP_REJECT' | 'BULLISH_SWEEP_RECLAIM' | null = null;
          if (lastBar && effectiveSwingHigh !== null && effectiveSwingLow !== null) {
            const barHigh = Number(lastBar.high);
            const barLow = Number(lastBar.low);
            const barClose = Number(lastBar.close);
            if (barHigh > effectiveSwingHigh && barClose < effectiveSwingHigh) {
              liquiditySweep = 'BEARISH_SWEEP_REJECT';
            } else if (barLow < effectiveSwingLow && barClose > effectiveSwingLow) {
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

          const normalizedCandles = closed.map((b) => ({
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
              const smcRes = analyzeSMC(normalizedCandles, { symbol: sym, tf });
              if (smcRes) {
                smcData = {
                  marketTrend: smcRes.marketTrend,
                  lastBreak: smcRes.lastBreak,
                  activeFVGs: smcRes.activeFVGs,
                  activeOrderBlocks: smcRes.activeOrderBlocks,
                  premiumDiscountZone: smcRes.premiumDiscountZone
                };
              }
            } catch {}
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
            } catch {}
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
            } catch {}
          }

          const recentCandles = closed.slice(-5).map((b) => ({
            t: b.startAt,
            o: b.open,
            h: b.high,
            l: b.low,
            c: b.close,
            v: b.volume,
            dir: Number(b.close) >= Number(b.open) ? 'BULL' : 'BEAR'
          }));

          tfSummary[tf] = {
            momentum: feat.momentumRegime,
            volatility: feat.volatilityRegime,
            liquiditySweep,
            anomalySignal,
            ema9: roundPriceMetric(feat.ema9?.value, currentPriceNum),
            ema21: roundPriceMetric(feat.ema21?.value, currentPriceNum),
            ema50: roundPriceMetric(feat.ema50?.value, currentPriceNum),
            ema200: roundPriceMetric(feat.ema200?.value, currentPriceNum),
            rsi14: roundRatioMetric(feat.rsi14?.value, 2),
            atr14: roundPriceMetric(feat.atr14?.value, currentPriceNum),
            macd: feat.macd?.value ? {
              line: roundPriceMetric(feat.macd.value.macd, currentPriceNum),
              signal: roundPriceMetric(feat.macd.value.signal, currentPriceNum),
              histogram: roundPriceMetric(feat.macd.value.histogram, currentPriceNum)
            } : null,
            vwapUtc: roundPriceMetric(feat.vwapUtc?.value, currentPriceNum),
            relativeVolume20: roundRatioMetric(feat.relativeVolume20?.value, 2),
            structure: {
              swingHigh: roundPriceMetric(effectiveSwingHigh, currentPriceNum),
              swingLow: roundPriceMetric(effectiveSwingLow, currentPriceNum),
              bos: feat.structure?.bos ?? null,
              choch: feat.structure?.choch ?? null,
              rsiDivergence: feat.structure?.rsiDivergence ?? null,
              ...(smcData ?? {})
            },
            ...(quantFactors ? { quantFactors } : {}),
            ...(harmonicPatterns.length > 0 ? { harmonicPatterns } : {}),
            recentCandles
          };
        }

        // Same scorer the auto cycle uses, so chat ranking and cycle ranking never disagree.
        rawRanking.push(evaluateWatchlistOpportunity(sym, options.marketHub));

        const tradesList = options.marketHub.recentTrades(sym) ?? [];
        let largeBuyVol = 0;
        let largeSellVol = 0;
        const exchangeTrades: any[] = [];
        for (const t of tradesList) {
          const p = Number(t.price);
          const s = Number(t.size);
          const usd = p * s;
          if (usd >= 50_000) {
            const side = t.side === 'Buy' ? 'BUY' : 'SELL';
            if (side === 'BUY') largeBuyVol += usd;
            else largeSellVol += usd;
            exchangeTrades.push({ side, price: p, quantity: s, usdValue: usd, time: t.sourceAt || t.observedAt });
          }
        }
        let obImbalance: number | null = null;
        if (book && book.bids.length && book.asks.length) {
          const topBids = book.bids.slice(0, 20).reduce((acc: number, b) => acc + (Number(b.price) * Number(b.size)), 0);
          const topAsks = book.asks.slice(0, 20).reduce((acc: number, a) => acc + (Number(a.price) * Number(a.size)), 0);
          const tot = topBids + topAsks;
          obImbalance = tot > 0 ? (topBids - topAsks) / tot : 0;
        }

        marketIntelligenceBySymbol[sym] = {
          timeframes: tfSummary,
          microstructure: {
            spreadBps: intel.microstructure?.spreadBps?.value ?? null,
            bookImbalanceTop10: intel.microstructure?.bookImbalanceTop10?.value ?? null,
            takerFlow: intel.microstructure?.takerFlow?.value ?? null,
            fundingRate: intel.microstructure?.funding?.value ?? null,
            openInterest: intel.microstructure?.openInterest?.value ?? null
          },
          whaleExchangeFlow: {
            status: 'AVAILABLE',
            largeTradesCount: exchangeTrades.length,
            largeBuyVolumeUsd: largeBuyVol,
            largeSellVolumeUsd: largeSellVol,
            netWhaleDeltaUsd: largeBuyVol - largeSellVol,
            orderbookImbalanceRatio: obImbalance,
            recentLargeTrades: exchangeTrades.slice(0, 5)
          },
          liveNews: {
            announcements: liveAnnouncementObservation(sym) ?? null,
            // Only attach a public news briefing that was actually gathered for this symbol.
            publicNews: options.newsBySymbol?.[sym] ?? null
          }
        };
      } catch {}
    }
  }

  const context: LiveDeskChatContext = {
    capturedAt,
    informationalOnly: true,
    tradingProfile: state.trading?.profile ?? null,
    tradingValues: state.trading?.values ? {
      maxLeverage: state.trading.values.maxLeverage,
      defaultStopPct: state.trading.values.defaultStopPct,
      takeProfitPct: state.trading.values.takeProfitPct,
      takeProfitR: state.trading.values.takeProfitR,
      dailyLossLimitPct: state.trading.values.dailyLossLimitPct,
      minEntryConfidencePct: state.trading.values.minEntryConfidencePct,
      sizingMode: (state.trading.values.orderSizePct ?? null) !== null ? 'FIXED_PCT_OF_MONEY_TRADE' : 'AUTO_EQUAL_SLOTS_MONEY_TRADE_DIV_N',
      safetyNet: state.trading.values.safetyNet,
      maxPositions: state.trading.values.maxPositions,
      orderSizePct: state.trading.values.orderSizePct ?? null
    } : null,
    moneySplit: {
      balance: state.paper.balance,
      equity: state.paper.equity,
      safetyNet: state.paper.safetyNet,
      moneyTrade: state.paper.moneyTrade,
      perOrder: state.paper.perOrder,
      slotsN: state.paper.n
    },
    accountCapital: {
      totalEquity: state.mode === 'PAPER' ? state.paper.equity : (state.financial.equity.value ?? state.paper.equity),
      balance: state.mode === 'PAPER' ? state.paper.balance : (state.financial.balance.value ?? state.paper.balance),
      safetyNet: state.paper.safetyNet ?? 0,
      moneyTradeBudget: state.paper.moneyTrade,
      usedMargin: state.paper.usedMargin ?? 0,
      freeAllocatableMargin: Math.max(0, Math.round(((state.paper.moneyTrade ?? 0) - (state.paper.usedMargin ?? 0)) * 100) / 100),
      perOrderAllocation: state.paper.perOrder ?? 0,
      maxSlotsN: state.paper.n || 3,
      occupiedSlots: state.paper.positions?.length ?? 0,
      freeSlots: Math.max(0, (state.paper.n || 3) - (state.paper.positions?.length ?? 0))
    },
    venueAccount: {
      name: state.venue?.name ?? null,
      mode: state.mode,
      equity: state.venueAccount?.equity ?? state.paper.equity ?? null,
      available: state.venueAccount?.available ?? state.paper.moneyTrade ?? null,
      freshness: classifyFreshness(state.venueAccount?.at, now, venueLiveLimit, venueCachedLimit)
    },
    positions: (state.paper.positions ?? []).slice(0, 8).map((p) => ({
      symbol: p.symbol,
      side: p.side,
      qty: p.qty,
      entry: p.entry,
      stop: p.stop,
      tp: p.tp,
      protectionStatus: p.protectionStatus ?? (p.stop ? 'confirmed' : 'missing')
    })),
    restingOrders: [
      ...(state.paper.positions ?? [])
        .filter((p) => Boolean(p.entryStatus) && p.entryStatus !== 'confirmed')
        .map((p) => ({ symbol: p.symbol, side: p.side, status: String(p.entryStatus) })),
      ...(state.venueAccount?.pendingSymbols ?? []).map((sym) => ({
        symbol: sym,
        side: 'PENDING',
        status: 'pending_fill'
      }))
    ],
    watchlistPrices: prices,
    assignedModels: Object.values(state.agents).map((agent) => ({
      role: agent.id,
      provider: agent.provider ?? null,
      model: agent.model ?? null
    })),
    freshness: {
      positions: posFresh,
      prices: prices.length ? prices[0]!.freshness : 'unavailable'
    },
    marketIntelligenceBySymbol: Object.keys(marketIntelligenceBySymbol).length > 0 ? marketIntelligenceBySymbol : undefined,
    watchlistOpportunityRanking: rawRanking.length > 0
      ? [...rawRanking]
          .sort((a, b) => b.score - a.score)
          .map((item, idx) => ({
            rank: idx + 1,
            symbol: item.symbol,
            score: item.score,
            bias: item.bias,
            reasons: item.reasons
          }))
      : undefined,
    recentVerdicts: (state.verdicts ?? []).slice(0, 5).map((v) => ({
      id: v.id,
      symbol: v.symbol,
      action: v.action,
      operationalStatus: (v as any).operationalStatus,
      executed: v.executed,
      reason: v.reason,
      order: v.order,
      at: v.at
    })),
    recentLessons: (state.lessons ?? [])
      .filter((l: any) => !l.archived)
      .slice(-5)
      .map((l: any) => ({
        role: l.role,
        kind: l.kind,
        symbol: l.symbol,
        happened: l.happened,
        rootCause: l.rootCause,
        lesson: l.lesson,
        status: l.status
      })),
    jev: state.jev ? {
      enabled: state.jev.enabled,
      health: state.jev.health,
      lastDecision: state.jev.lastDecision ?? null
    } : null,
    extraFeeds: options.extraFeeds
  };
  const encoded = JSON.stringify(context);
  if (options.secrets) {
    for (const [key, value] of Object.entries(options.secrets)) {
      if (SECRET_KEY_RE.test(key) && typeof value === 'string' && value && encoded.includes(value)) {
        throw new Error('Live chat context leaked a secret field');
      }
    }
  }
  return context;
}
