import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import { z } from 'zod';
import type { SessionLogger } from '../session-log.js';
import { sanitizeUntrusted } from '../untrusted.js';
import type { OfficeRuntime } from './contracts.js';
import { mountStateRoutes } from './api/state.js';
import { mountOperationsRoutes } from './api/operations.js';
import { ChatService, mountChatRoutes } from './api/chat.js';
import { HistoryService, mountHistoryRoutes } from './api/history.js';
import { ReportsService, mountReportRoutes } from './reports.js';
import { mountSetupApiRoutes, type SetupApiDeps } from './api/setup.js';
import { mountGrokRoutes } from './api/grok.js';
import type { GrokBridge } from './connectors/grok/bridge.js';
import type { KeyRegistry } from './connectors/grok/auth.js';
import { mountResearchRoutesV2, type ResearchRouteDeps } from './api/research.js';
import { mountWalletRoutes, type WalletRouteDeps } from './api/wallet.js';
import { mountLocalAgentsRoutes } from './api/local-agents.js';

export interface ReplacementAppOptions {
  instanceId?: string;
  sessionLogger?: SessionLogger | null;
  sessionLogRoot?: string;
  staticWebDir?: string | null;
  reportsService?: ReportsService;
  chatService?: ChatService;
  historyService?: HistoryService;
  setupDeps?: SetupApiDeps;
  walletDeps?: WalletRouteDeps;
  grokBridge?: GrokBridge;
  grokKeyRegistry?: KeyRegistry;
  researchDeps?: ResearchRouteDeps;
  mountAdditionalRoutes?: (app: express.Express, runtime: OfficeRuntime) => void;
}

const sameSecret = (given: string, want: string): boolean => {
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
};

function createEventDeduplicator(ttlMs = 10 * 60_000) {
  const seen = new Map<string, number>();
  return {
    isDuplicate: (key: string): boolean => {
      const now = Date.now();
      for (const [k, ts] of seen) {
        if (now - ts > ttlMs) seen.delete(k);
      }
      if (seen.has(key)) return true;
      seen.set(key, now);
      return false;
    }
  };
}

const TradingViewSchema = z.object({
  passphrase: z.string().max(200),
  symbol: z.string().min(2).max(40),
  action: z.string().max(20),
  price: z.union([z.number(), z.string()]).optional(),
  note: z.string().max(500).optional(),
  eventId: z.string().max(100).optional()
});

export function createReplacementApp(
  runtime: OfficeRuntime,
  options: ReplacementAppOptions = {}
): express.Express {
  const app = express();
  const instanceId = options.instanceId ?? randomUUID();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  mountStateRoutes(app, runtime, {
    instanceId,
    sessionLogger: options.sessionLogger,
    sessionLogRoot: options.sessionLogRoot
  });

  mountOperationsRoutes(app, runtime);

  if (options.setupDeps) {
    mountSetupApiRoutes(app, options.setupDeps);
    mountLocalAgentsRoutes(app, options.setupDeps);
  }

  const walletDeps =
    options.walletDeps ??
    (options.setupDeps
      ? { settings: options.setupDeps.settings, secrets: options.setupDeps.secrets }
      : undefined);

  if (walletDeps) {
    mountWalletRoutes(app, walletDeps);
  }

  if (options.grokBridge && options.grokKeyRegistry) {
    mountGrokRoutes(app, options.grokBridge, options.grokKeyRegistry, runtime);
  }

  if (options.researchDeps) {
    mountResearchRoutesV2(app, options.researchDeps);
  }

  const reportsService = options.reportsService ?? new ReportsService();
  const reportInterval = options.setupDeps?.settings.current().effective.auto.reportIntervalMin ?? 60;
  reportsService.start(runtime, reportInterval);
  mountReportRoutes(app, reportsService, runtime);

  const chatService = options.chatService ?? new ChatService();
  mountChatRoutes(app, chatService, runtime);

  const historyService = options.historyService ?? new HistoryService();
  mountHistoryRoutes(app, historyService, runtime);

  const tvDedupe = createEventDeduplicator();
  app.post('/api/tradingview', async (req, res) => {
    const expectedPass =
      options.setupDeps?.secrets.getSecret('TRADINGVIEW_PASSPHRASE') ??
      process.env.TRADINGVIEW_PASSPHRASE;
    const tvEnabled =
      options.setupDeps?.settings.current().effective.preferences.tradingviewWebhook ??
      Boolean(expectedPass);

    if (!tvEnabled || !expectedPass) {
      res.status(404).json({
        ok: false,
        error: 'TradingView webhook is off (set TRADINGVIEW_PASSPHRASE)'
      });
      return;
    }

    const parsed = TradingViewSchema.safeParse(req.body);
    if (!parsed.success || !sameSecret(parsed.data.passphrase, expectedPass)) {
      res.status(401).json({ ok: false, error: 'bad request or passphrase' });
      return;
    }

    const rawSym = parsed.data.symbol
      .replace(/^[A-Z0-9]+:/i, '')
      .replace(/\.P$/i, '')
      .trim()
      .toUpperCase();
    if (rawSym.length < 2) {
      res.status(400).json({ ok: false, error: 'unknown symbol' });
      return;
    }

    const price = Number(parsed.data.price);
    const action = sanitizeUntrusted(parsed.data.action, 20).text.toLowerCase();
    const note = sanitizeUntrusted(parsed.data.note ?? '', 300).text;

    const dedupeKey = parsed.data.eventId
      ? `id:${parsed.data.eventId}`
      : `${rawSym}:${action}:${parsed.data.price ?? ''}:${note}`;

    if (tvDedupe.isDuplicate(dedupeKey)) {
      res.json({
        ok: true,
        duplicate: true,
        symbol: rawSym,
        action,
        note: 'Duplicate alert acknowledged without re-triggering cycle.',
        at: Date.now()
      });
      return;
    }

    void runtime.triggerCycle?.(rawSym, 'signal')?.catch(console.error);

    res.json({
      ok: true,
      symbol: rawSym,
      action,
      price: Number.isFinite(price) && price > 0 ? price : null,
      note,
      at: Date.now()
    });
  });

  options.mountAdditionalRoutes?.(app, runtime);

  app.use('/api', (_req, res) => {
    res.status(503).json({
      ok: false,
      code: 'SERVICE_UNAVAILABLE',
      availability: 'UNAVAILABLE',
      error: 'Endpoint service is not configured or initialized in the active runtime.'
    });
  });

  const webRoot =
    options.staticWebDir === undefined ? path.resolve('dist/web') : options.staticWebDir;

  if (webRoot && existsSync(webRoot)) {
    app.use(express.static(webRoot));
    app.get(/^\/(?!api|ws).*/, (_req, res) => {
      res.sendFile(path.join(webRoot, 'index.html'));
    });
  }

  return app;
}
