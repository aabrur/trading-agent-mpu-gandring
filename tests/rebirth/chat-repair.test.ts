import { createServer } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatService, mountChatRoutes } from '../../server/v2/api/chat.js';
import type { OfficeRuntime, OfficeState } from '../../server/v2/contracts.js';

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function fixture() {
  const app = express();
  app.use(express.json());
  const draft = {
    conversations: [],
    roomHistory: [],
    chats: { lead: [], market: [], research: [], strategist: [], risk: [], execution: [] }
  } as unknown as OfficeState;
  const runtime = {
    updateState: (mutate: (s: OfficeState) => OfficeState | void) => {
      mutate(draft);
      return draft;
    }
  } as OfficeRuntime;
  mountChatRoutes(app, new ChatService(), runtime);
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('No bound port');
  return { root: `http://127.0.0.1:${addr.port}`, draft };
}

describe('Office conversation lifecycle contract', () => {
  it('creates a selectable session and syncs room state', async () => {
    const { root, draft } = await fixture();
    const response = await fetch(`${root}/api/conversations/new`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    });
    const result = await response.json() as { ok: boolean; conversationId: string; conversation: { id: string } };
    expect(response.status).toBe(200);
    expect(result.conversationId).toBe(result.conversation.id);
    expect(result.conversationId).toMatch(/^conv-/);
    expect(draft.conversations?.some(item => item.id === result.conversationId)).toBe(true);
  });

  it('requires explicit deletion and does not delete default office or trading state', async () => {
    const { root, draft } = await fixture();
    const created = await fetch(`${root}/api/conversations/new`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    });
    const { conversationId } = await created.json() as { conversationId: string };
    const denied = await fetch(`${root}/api/conversations/${conversationId}`, { method: 'DELETE' });
    expect(denied.status).toBe(400);
    const deleted = await fetch(`${root}/api/conversations/${conversationId}`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true })
    });
    expect(deleted.status).toBe(200);
    expect(draft.conversations?.some(item => item.id === conversationId)).toBe(false);
    const defaultDelete = await fetch(`${root}/api/conversations/office?confirm=true`, { method: 'DELETE' });
    expect(defaultDelete.status).toBe(404);
    expect(draft.conversations?.some(item => item.id === 'office')).toBe(true);
  });
});
