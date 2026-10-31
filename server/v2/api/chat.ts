import type express from 'express';
import { z } from 'zod';
import { safe } from '../../redact.js';
import { isLocalLoopbackClient, type OfficeRuntime } from '../contracts.js';

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
      id: 'conv-default',
      title: 'General Trading Desk',
      createdAt: Date.now() - 3600000,
      updatedAt: Date.now(),
      messageCount: 0
    }
  ];
  private activeRequests = new Set<string>();

  public listConversations(): StudioConversation[] {
    return [...this.conversations];
  }

  public createConversation(title?: string): StudioConversation {
    const id = `conv-${Date.now().toString(36)}`;
    const conv: StudioConversation = {
      id,
      title: safe(title ?? 'New Discussion Session'),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: 0
    };
    this.conversations.unshift(conv);
    return conv;
  }

  public cancelRequest(requestId: string): boolean {
    this.activeRequests.delete(requestId);
    return true;
  }
}

export function mountChatRoutes(
  app: express.Express,
  service: ChatService,
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

  app.get('/api/conversations', (_req, res) => {
    res.json({
      ok: true,
      conversations: service.listConversations()
    });
  });

  app.post('/api/conversations/new', (req, res) => {
    if (!verifyOwner(req, res)) return;

    const parsed = newConversationSchema.safeParse(req.body ?? {});
    const conv = service.createConversation(parsed.success ? parsed.data.title : undefined);
    res.json({
      ok: true,
      conversation: conv
    });
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
