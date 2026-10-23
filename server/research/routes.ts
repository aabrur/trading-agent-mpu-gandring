import type express from 'express';
import { z } from 'zod';
import type { Desk } from '../desk.js';
import { getNewsFor, getWhaleBriefing, getSnapshot, getWhaleOnChainSummary, liveNewsStatus } from '../market/index.js';
import { localClient } from '../setup/routes.js';
import { RESEARCH_TOOLS } from './catalog.js';
import { normSymbol } from '../commands.js';

const Input = z.object({ name: z.enum(RESEARCH_TOOLS.map(tool => tool.name) as [string, ...string[]]), symbol: z.string().regex(/^[A-Z0-9]{3,24}$/), objective: z.string().max(500).optional() }).strict();
export function mountResearchRoutes(app: express.Express, desk: Desk) {
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
      if (name === 'market_snapshot') {
        const snapshot = await getSnapshot(symbol, desk.cfg.marketSource, true);
        data = { ...snapshot, candles: snapshot.candles.slice(-60) };
      } else if (name === 'market_news') {
        const news = await getNewsFor(symbol, { ...desk.cfg, tradingMode: 'LIVE' });
        data = { status: liveNewsStatus(news), items: news };
      } else if (name === 'onchain_briefing') {
        const [briefing, observations] = await Promise.all([getWhaleBriefing(symbol), getWhaleOnChainSummary(symbol)]);
        data = { briefing, observations };
      } else if (name === 'desk_account') {
        data = { observedAt: desk.venueAccount?.at ?? null, source: desk.venueAccount ? 'exchange' : 'desk book',
          balance: desk.book.balance, equity: desk.book.balance + desk.book.unrealized, safetyNet: desk.book.safetyNet,
          positions: desk.book.positions.map(p => ({ symbol: p.symbol, side: p.side, qty: p.qty, entry: p.entry, stop: p.stop, tp: p.tp, pnl: p.unrealizedPnl, protectionStatus: p.protectionStatus })) };
      } else {
        const collected = await desk.collectResearchData(symbol, objective);
        data = { ...collected, market: { ...collected.market, candles: collected.market.candles.slice(-60) } };
      }
      desk.recordActivity({ kind: 'tool', source: 'mpu_research', level: 'info', status: 'completed', text: `${name} · ${symbol}`, durationMs: Date.now() - started });
      return res.json({ ok: true, observedAt: Date.now(), tool: name, data });
    } catch (error) {
      desk.recordActivity({ kind: 'tool', source: 'mpu_research', level: 'error', status: 'failed', text: `${name} · ${symbol}: ${error instanceof Error ? error.message : 'Research unavailable'}`, durationMs: Date.now() - started });
      return res.status(503).json({ ok: false, error: 'Research data currently unavailable. Do not substitute invented or sample values.' });
    }
  });
}
