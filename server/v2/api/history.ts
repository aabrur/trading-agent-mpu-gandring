import type express from 'express';
import { isLocalLoopbackClient, ROLE_IDS, type OfficeRuntime, type RoleId } from '../contracts.js';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export class HistoryService {
  private historyByAgent = new Map<RoleId, Map<string, ChatMessage[]>>();

  constructor() {
    for (const role of ROLE_IDS) {
      this.historyByAgent.set(role, new Map());
    }
  }

  public getMessages(agent: RoleId, sessionId = 'default'): ChatMessage[] {
    const agentSessions = this.historyByAgent.get(agent);
    if (!agentSessions) return [];
    return agentSessions.get(sessionId) ?? [];
  }

  public deleteSession(agent: RoleId, sessionId: string): boolean {
    const agentSessions = this.historyByAgent.get(agent);
    if (!agentSessions) return false;
    return agentSessions.delete(sessionId);
  }
}

export function mountHistoryRoutes(
  app: express.Express,
  service: HistoryService,
  _runtime: OfficeRuntime
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

  app.get('/api/chat/history/:agent', (req, res) => {
    if (!verifyOwner(req, res)) return;

    const agentParam = req.params.agent.toLowerCase() as RoleId;
    if (!ROLE_IDS.includes(agentParam)) {
      res.status(400).json({ ok: false, error: `Unknown agent role: ${req.params.agent}` });
      return;
    }

    const messages = service.getMessages(agentParam);
    res.json({
      ok: true,
      agent: agentParam,
      messages
    });
  });

  app.get('/api/chat/history/:agent/:id', (req, res) => {
    if (!verifyOwner(req, res)) return;

    const agentParam = req.params.agent.toLowerCase() as RoleId;
    if (!ROLE_IDS.includes(agentParam)) {
      res.status(400).json({ ok: false, error: `Unknown agent role: ${req.params.agent}` });
      return;
    }

    const sessionId = req.params.id;
    const messages = service.getMessages(agentParam, sessionId);
    res.json({
      ok: true,
      agent: agentParam,
      sessionId,
      messages
    });
  });

  app.delete('/api/chat/history/:agent/:id', (req, res) => {
    if (!verifyOwner(req, res)) return;

    const agentParam = req.params.agent.toLowerCase() as RoleId;
    if (!ROLE_IDS.includes(agentParam)) {
      res.status(400).json({ ok: false, error: `Unknown agent role: ${req.params.agent}` });
      return;
    }

    const confirm = req.query.confirm === 'true';
    if (!confirm) {
      res.status(400).json({ ok: false, error: 'Deletion requires explicit confirm=true query parameter.' });
      return;
    }

    const sessionId = req.params.id;
    service.deleteSession(agentParam, sessionId);
    res.json({
      ok: true,
      deleted: true,
      agent: agentParam,
      sessionId
    });
  });
}
