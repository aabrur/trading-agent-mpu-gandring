import express from 'express';
import { z } from 'zod';
import type { Desk } from '../desk.js';
import { getNewsFor, getWhaleBriefing, getSnapshot, getWhaleOnChainSummary, liveNewsStatus } from '../market/index.js';
import { localClient } from '../setup/routes.js';
import { RESEARCH_TOOLS } from './catalog.js';
import { normSymbol } from '../commands.js';
import { buildTacticalTradePlan } from '../market/tactical.js';
import { getSuiEventBriefing } from '../market/sui.js';
import type { CapabilityStatus } from './catalog.js';
import { PerpBacktestEngine, type StrategyFn } from './backtest.js';
import type { PITCandle } from './pit.js';
import { runCommand } from '../channels/commands.js';
import { CloseTriggerSchema } from '../schemas.js';

const Input = z.object({ name: z.enum(RESEARCH_TOOLS.map(tool => tool.name) as [string, ...string[]]), symbol: z.string().regex(/^[A-Z0-9]{3,24}$/), objective: z.string().max(500).optional() }).strict();

const BacktestInput = z.object({
  symbol: z.string().regex(/^[A-Z0-9]{3,24}$/),
  initialCapital: z.number().min(10).max(1000000).optional(),
  slippageBps: z.number().min(0).max(100).optional(),
  maxLeverage: z.number().min(1).max(50).optional(),
  strategy: z.enum(['simple_momentum', 'mean_reversion', 'buy_and_hold']).optional(),
  candles: z.array(z.object({
    timestamp: z.number(),
    open: z.number(),
    high: z.number(),
    low: z.number(),
    close: z.number(),
    volume: z.number(),
    closedAt: z.number().optional()
  })).min(3).optional()
}).strict();
export function mountResearchRoutes(app: express.Express, desk: Desk) {
  app.get('/api/research/close-review', async (req, res) => {
    const access = localClient({ remoteAddress: req.socket.remoteAddress, hostHeader: req.headers.host, origin: req.get('origin') });
    if (!access.ok) return res.status(403).json({ ok: false, error: access.reason });
    const input = z.object({ symbol: z.string().regex(/^[A-Z0-9]{3,24}$/), trigger: CloseTriggerSchema.optional() }).strict().safeParse(req.query);
    if (!input.success) return res.status(400).json({ ok: false, error: 'A supported symbol and optional typed trigger are required.' });
    try { res.json(await desk.closeReview(input.data.symbol, input.data.trigger)); }
    catch { res.status(503).json({ ok: false, error: 'CLOSE evidence unavailable; no authorization inferred.' }); }
  });
  app.get('/api/research/summary', async (req, res) => {
    const access = localClient({ remoteAddress: req.socket.remoteAddress, hostHeader: req.headers.host, origin: req.get('origin') });
    if (!access.ok) return res.status(403).json({ ok: false, error: access.reason });
    const command = z.enum(['status', 'positions', 'scan', 'scorecard']).safeParse(req.query.command);
    if (!command.success) return res.status(400).json({ ok: false, error: 'Choose status, positions, scan or scorecard.' });
    res.json({ ok: true, text: await runCommand(desk, { ok: true, cmd: command.data, confirm: false }) });
  });
  app.get('/api/research/capabilities', (req, res) => {
    const access = localClient({ remoteAddress: req.socket.remoteAddress, hostHeader: req.headers.host, origin: req.get('origin') });
    if (!access.ok) return res.status(403).json({ ok: false, error: access.reason });
    return res.json({ ok: true, observedAt: Date.now(), capabilities: desk.capabilities() });
  });
  app.get('/api/research', async (req, res) => {
    const access = localClient({ remoteAddress: req.socket.remoteAddress, hostHeader: req.headers.host, origin: req.get('origin') });
    if (!access.ok) return res.status(403).json({ ok: false, error: access.reason });
    const parsed = Input.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ ok: false, error: 'Choose a supported research tool and symbol.' });
    const { name, objective } = parsed.data;
    const symbol = normSymbol(parsed.data.symbol);
    const started = Date.now();
    desk.recordActivity({ kind: 'tool', source: 'mpu_research', level: 'info', status: 'started', text: `${name} · ${symbol}` });
    try {
      let data: unknown;
      let dataStatus: CapabilityStatus = 'DATA_AVAILABLE';
      if (name === 'desk_capabilities') {
        data = { capabilities: desk.capabilities() };
      } else if (name === 'market_snapshot') {
        const snapshot = await getSnapshot(symbol, desk.cfg.marketSource, true);
        data = { ...snapshot, tacticalTradePlan: buildTacticalTradePlan(snapshot), candles: snapshot.candles.slice(-60) };
      } else if (name === 'market_news') {
        const news = await getNewsFor(symbol, { ...desk.cfg, tradingMode: 'LIVE' });
        dataStatus = news.length ? 'DATA_AVAILABLE' : 'UNAVAILABLE';
        data = { status: liveNewsStatus(news), items: news };
      } else if (name === 'onchain_briefing') {
        const [briefing, observations, sui] = await Promise.all([getWhaleBriefing(symbol), getWhaleOnChainSummary(symbol), symbol === 'SUIUSDT' ? getSuiEventBriefing(symbol) : Promise.resolve(null)]);
        dataStatus = briefing.dataStatus ?? (briefing.providerStatus === 'UNCONFIGURED' ? 'UNCONFIGURED' : briefing.providerStatus === 'UNAVAILABLE' ? 'UNAVAILABLE' : briefing.events.length ? 'DATA_AVAILABLE' : 'NO_RELEVANT_EVENTS');
        data = { briefing, observations, sui };
      } else if (name === 'desk_account') {
        data = { observedAt: desk.venueAccount?.at ?? null, source: desk.venueAccount ? 'exchange' : 'desk book',
          balance: desk.book.balance, equity: desk.book.balance + desk.book.unrealized, safetyNet: desk.book.safetyNet, accountState: desk.accountState(),
          positions: desk.book.positions.map(p => ({ symbol: p.symbol, side: p.side, qty: p.qty, entry: p.entry, stop: p.stop, tp: p.tp, pnl: p.unrealizedPnl, protectionStatus: p.protectionStatus })) };
      } else {
        const collected = await desk.collectResearchData(symbol, objective);
        data = { ...collected, market: { ...collected.market, candles: collected.market.candles.slice(-60) } };
      }
      desk.researchObservations[name] = { status: dataStatus, symbol, at: Date.now(), durationMs: Date.now() - started };
      desk.recordActivity({ kind: 'tool', source: 'mpu_research', level: 'info', status: 'completed', text: `${name} · ${symbol} · ${dataStatus}`, durationMs: Date.now() - started });
      return res.json({ ok: true, observedAt: Date.now(), tool: name, dataStatus, data });
    } catch (error) {
      desk.researchObservations[name] = { status: 'ERROR', symbol, at: Date.now(), durationMs: Date.now() - started };
      desk.recordActivity({ kind: 'tool', source: 'mpu_research', level: 'error', status: 'failed', text: `${name} · ${symbol}: ${error instanceof Error ? error.message : 'Research unavailable'}`, durationMs: Date.now() - started });
      return res.status(503).json({ ok: false, error: 'Research data currently unavailable. Do not substitute invented or sample values.' });
    }
  });

  app.post('/api/research/backtest', express.json({ limit: '2mb' }), async (req, res) => {
    const access = localClient({ remoteAddress: req.socket.remoteAddress, hostHeader: req.headers.host, origin: req.get('origin') });
    if (!access.ok) return res.status(403).json({ ok: false, error: access.reason });

    const parsed = BacktestInput.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: 'Invalid backtest parameters.', details: parsed.error.issues });
    }

    const { symbol, initialCapital, slippageBps, maxLeverage, strategy, candles: customCandles } = parsed.data;
    const normSym = normSymbol(symbol);

    let candlesToUse: PITCandle[] = [];
    if (customCandles && customCandles.length > 0) {
      candlesToUse = customCandles.map(c => ({
        timestamp: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        closedAt: c.closedAt ?? c.timestamp + 60_000
      }));
    } else {
      try {
        const snapshot = await getSnapshot(normSym, desk.cfg.marketSource, true);
        candlesToUse = snapshot.candles.map(c => ({
          timestamp: c.t,
          open: c.o,
          high: c.h,
          low: c.l,
          close: c.c,
          volume: c.v,
          closedAt: c.t + 60_000
        }));
      } catch {
        return res.status(503).json({ ok: false, error: 'Could not fetch market candles for backtest.' });
      }
    }

    if (candlesToUse.length < 3) {
      return res.status(400).json({ ok: false, error: 'Insufficient candle data for backtest (minimum 3 required).' });
    }

    const engine = new PerpBacktestEngine({
      initialCapital: initialCapital ?? 1000,
      slippageBps: slippageBps ?? 5,
      maxLeverage: maxLeverage ?? 5
    });

    const strategyFn: StrategyFn = (feed, bar, openPositions) => {
      const history = feed.asOf(bar.closedAt);
      if (history.length < 5) return null;

      if (strategy === 'buy_and_hold') {
        if (openPositions.length === 0) {
          return {
            action: 'OPEN_LONG',
            symbol: normSym,
            stopPrice: bar.close * 0.90,
            tpPrice: bar.close * 1.50
          };
        }
        return null;
      }

      // Simple Momentum: SMA 5 vs SMA 20
      const closes = history.map(c => c.close);
      const sma5 = closes.slice(-5).reduce((a, b) => a + b, 0) / 5;
      const sma20 = closes.length >= 20
        ? closes.slice(-20).reduce((a, b) => a + b, 0) / 20
        : sma5;

      if (openPositions.length === 0) {
        if (sma5 > sma20) {
          return {
            action: 'OPEN_LONG',
            symbol: normSym,
            stopPrice: bar.close * 0.98,
            tpPrice: bar.close * 1.04
          };
        } else if (sma5 < sma20) {
          return {
            action: 'OPEN_SHORT',
            symbol: normSym,
            stopPrice: bar.close * 1.02,
            tpPrice: bar.close * 0.96
          };
        }
      }
      return null;
    };

    const metrics = engine.run(candlesToUse, [], strategyFn);
    return res.json({
      ok: true,
      observedAt: Date.now(),
      symbol: normSym,
      metrics
    });
  });
}
