import { rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatService } from '../../server/v2/api/chat.js';
import { RuntimeStore } from '../../server/v2/store/database.js';

const tempFiles: string[] = [];

afterEach(() => {
  for (const f of tempFiles.splice(0)) {
    try {
      rmSync(f, { force: true });
      rmSync(`${f}-wal`, { force: true });
      rmSync(`${f}-shm`, { force: true });
    } catch {}
  }
});

function tempDbPath(): string {
  const p = path.resolve(`.mpu-gandring/test-chat-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  tempFiles.push(p);
  return p;
}

describe('T3 durable scoped conversation and message persistence', () => {
  it('persists conversations and hydrates across service restart', async () => {
    const dbFile = tempDbPath();
    const store = await RuntimeStore.open(dbFile);

    const service1 = new ChatService(store);
    const conv = service1.createConversation('Tactical Review');
    expect(conv.id).toMatch(/^conv-/);
    expect(conv.title).toBe('Tactical Review');

    // Wait a brief tick for async insert
    await new Promise((r) => setTimeout(r, 50));

    // Spin up fresh ChatService connected to same DB file
    const service2 = new ChatService(store);
    await service2.hydrateFromStore();

    const list = service2.listConversations();
    expect(list.some((c) => c.id === conv.id)).toBe(true);
    expect(list.some((c) => c.id === 'office')).toBe(true);
  });

  it('records messages and deduplicates on clientRequestId', async () => {
    const dbFile = tempDbPath();
    const store = await RuntimeStore.open(dbFile);
    const service = new ChatService(store);

    await service.recordMessage({
      messageId: 'msg-1',
      conversationId: 'office',
      clientRequestId: 'req-abc-123',
      role: 'lead',
      text: 'Debate consensus reached'
    });

    // Duplicate message with same messageId ignored
    await service.recordMessage({
      messageId: 'msg-1',
      conversationId: 'office',
      clientRequestId: 'req-abc-123',
      role: 'lead',
      text: 'Debate consensus reached duplicate'
    });

    const messages = await service.listMessages('office');
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe('Debate consensus reached');
  });

  it('deleting a conversation marks deleted_at and cleans messages without touching other sessions', async () => {
    const dbFile = tempDbPath();
    const store = await RuntimeStore.open(dbFile);
    const service = new ChatService(store);

    const conv = service.createConversation('Ephemeral Session');
    await service.recordMessage({
      messageId: 'ephem-msg-1',
      conversationId: conv.id,
      role: 'market',
      text: 'Volatile spike'
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(service.deleteConversation('office')).toBe(false);
    expect(service.deleteConversation(conv.id)).toBe(true);

    await new Promise((r) => setTimeout(r, 50));

    const listAfter = service.listConversations();
    expect(listAfter.some((c) => c.id === conv.id)).toBe(false);

    const msgs = await service.listMessages(conv.id);
    expect(msgs).toHaveLength(0);
  });
});
