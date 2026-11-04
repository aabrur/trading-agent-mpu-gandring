import type express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { safe } from '../../redact.js';
import { isLocalLoopbackClient, type OfficeRuntime, type OfficeState, type TF } from '../contracts.js';
import type { RuntimeStore } from '../store/database.js';
import type { BybitMarketHub } from '../market/bybit.js';
import { computeIntelligence } from '../market/intelligence.js';
import { liveAnnouncementObservation } from '../../market/live-news.js';

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

export interface LiveDeskChatContext {
  capturedAt: string;
  informationalOnly: true;
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
  jev?: {
    enabled: boolean;
    health?: string;
    lastDecision?: unknown;
  } | null;
  extraFeeds?: Record<string, unknown>;
}

function classifyFreshness(at: number | null | undefined, now: number): DeskFreshness {
  if (at == null || at <= 0) return 'unavailable';
  const age = now - at;
  if (age <= 15_000) return 'live';
  if (age <= 120_000) return 'cached';
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
  } = {}
): LiveDeskChatContext {
  const now = options.now ?? Date.now();
  const capturedAt = options.capturedAt ?? new Date(now).toISOString();
  const posFresh = classifyFreshness(state.venueAccount?.at ?? (state.paper.positions[0]?.openedAt ?? now), now);
  const prices = Object.values(state.tickers ?? {}).slice(0, 12).map((ticker) => ({
    symbol: ticker.symbol,
    last: ticker.last ?? null,
    freshness: classifyFreshness(ticker.at, now),
    source: ticker.source ?? 'unknown'
  }));

  const marketIntelligenceBySymbol: Record<string, any> = {};
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

        const tfSummary: Record<string, any> = {};
        for (const [tf, feat] of Object.entries(intel.byTimeframe ?? {})) {
          if (!feat) continue;
          const highs = feat.structure?.pivots?.filter((p) => p.kind === 'HIGH') ?? [];
          const lows = feat.structure?.pivots?.filter((p) => p.kind === 'LOW') ?? [];
          const closed = frame.closed[tf as TF]?.filter((b) => b.confirmed) ?? [];
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
            ema9: feat.ema9?.value ?? null,
            ema21: feat.ema21?.value ?? null,
            ema50: feat.ema50?.value ?? null,
            ema200: feat.ema200?.value ?? null,
            rsi14: feat.rsi14?.value ?? null,
            atr14: feat.atr14?.value ?? null,
            macd: feat.macd?.value ? { line: feat.macd.value.macd, signal: feat.macd.value.signal, histogram: feat.macd.value.histogram } : null,
            vwapUtc: feat.vwapUtc?.value ?? null,
            relativeVolume20: feat.relativeVolume20?.value ?? null,
            structure: {
              swingHigh: highs[highs.length - 1]?.price ?? null,
              swingLow: lows[lows.length - 1]?.price ?? null,
              bos: feat.structure?.bos ?? null,
              choch: feat.structure?.choch ?? null,
              rsiDivergence: feat.structure?.rsiDivergence ?? null
            },
            recentCandles
          };
        }

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
          liveNews: liveAnnouncementObservation(sym) ?? null
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
      maxLossPerTradePct: state.trading.values.maxLossPerTradePct,
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
    venueAccount: {
      name: state.venue?.name ?? null,
      mode: state.mode,
      equity: state.venueAccount?.equity ?? state.paper.equity ?? null,
      available: state.venueAccount?.available ?? state.paper.moneyTrade ?? null,
      freshness: classifyFreshness(state.venueAccount?.at, now)
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
    restingOrders: (state.paper.positions ?? [])
      .filter((p) => Boolean(p.entryStatus) && p.entryStatus !== 'confirmed')
      .map((p) => ({ symbol: p.symbol, side: p.side, status: String(p.entryStatus) })),
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
