import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { SessionLogger } from '../session-log.js';
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

export interface ReplacementAppOptions {
  instanceId?: string;
  sessionLogger?: SessionLogger | null;
  sessionLogRoot?: string;
  staticWebDir?: string | null;
  reportsService?: ReportsService;
  chatService?: ChatService;
  historyService?: HistoryService;
  setupDeps?: SetupApiDeps;
  grokBridge?: GrokBridge;
  grokKeyRegistry?: KeyRegistry;
  researchDeps?: ResearchRouteDeps;
  mountAdditionalRoutes?: (app: express.Express, runtime: OfficeRuntime) => void;
}

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
  }

  if (options.grokBridge && options.grokKeyRegistry) {
    mountGrokRoutes(app, options.grokBridge, options.grokKeyRegistry, runtime);
  }

  if (options.researchDeps) {
    mountResearchRoutesV2(app, options.researchDeps);
  }

  const reportsService = options.reportsService ?? new ReportsService();
  mountReportRoutes(app, reportsService, runtime);

  const chatService = options.chatService ?? new ChatService();
  mountChatRoutes(app, chatService, runtime);

  const historyService = options.historyService ?? new HistoryService();
  mountHistoryRoutes(app, historyService, runtime);

  options.mountAdditionalRoutes?.(app, runtime);

  app.use('/api', (_req, res) => {
    res.status(503).json({
      ok: false,
      code: 'SERVICE_UNAVAILABLE',
      availability: 'UNAVAILABLE',
      error: 'Endpoint service is not configured or initialized in the active runtime.'
    });
  });

  const webRoot = options.staticWebDir === undefined
    ? path.resolve('dist/web')
    : options.staticWebDir;

  if (webRoot && existsSync(webRoot)) {
    app.use(express.static(webRoot));
    app.get(/^\/(?!api|ws).*/, (_req, res) => {
      res.sendFile(path.join(webRoot, 'index.html'));
    });
  }

  return app;
}
