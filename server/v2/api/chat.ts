import type express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { safe } from '../../redact.js';
import { isLocalLoopbackClient, type OfficeRuntime } from '../contracts.js';
import type { RuntimeStore } from '../store/database.js';

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
