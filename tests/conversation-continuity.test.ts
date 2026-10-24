import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server/config.js';
import { Desk } from '../server/desk.js';
import { makeCaller } from '../server/providers/index.js';
import { createApp } from '../server/app.js';

const base = { TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEBATE_PACE_MS: '0', AUTO_TRADING: 'off' };
const tmpConv = () => path.join(mkdtempSync(path.join(tmpdir(), 'mg-conv-')), 'conversations.json');

describe('Conversation continuity and persistence', () => {
  it('persists conversations and restores them after backend restart', async () => {
    const convFile = tmpConv();
    const cfg = loadConfig(base);
    const caller = makeCaller(cfg);

    // Session 1: initial desk
    const desk1 = new Desk(cfg, caller, { reportsDir: null, conversationsPath: convFile, learningsPath: null });
    const convId = 'conv-session-1';

    // Add room message with conversationId
    const msg1 = desk1.addRoomMessage({
      from: 'owner',
      to: 'lead',
      text: 'Analyze ETHUSDT momentum',
      conversationId: convId,
      symbol: 'ETHUSDT'
    });
    expect(msg1.seq).toBe(1);
    expect(msg1.conversationId).toBe(convId);

    // Execute chat command in conversation
    const res = await desk1.command('lead: what is the trend?', undefined, convId);
    expect(res.ok).toBe(true);

    const snapshot1 = desk1.snapshot();
    expect(snapshot1.conversations?.some(c => c.id === convId)).toBe(true);
    expect(existsSync(convFile)).toBe(true);

    // Session 2: simulated restart by creating a new Desk with same persisted file
    const desk2 = new Desk(cfg, caller, { reportsDir: null, conversationsPath: convFile, learningsPath: null });
    const snapshot2 = desk2.snapshot();

    expect(snapshot2.conversations?.some(c => c.id === convId)).toBe(true);
    const restoredRoom = desk2.roomHistory.filter(m => m.conversationId === convId);
    expect(restoredRoom.length).toBeGreaterThanOrEqual(1);
    expect(restoredRoom[0].text).toBe('Analyze ETHUSDT momentum');

    // Next message in desk2 maintains monotonic seq
    const msg2 = desk2.addRoomMessage({
      from: 'owner',
      to: 'lead',
      text: 'Followup question on ETH',
      conversationId: convId
    });
    expect(msg2.seq).toBeGreaterThan(msg1.seq);
  });

  it('separates context between different conversations', async () => {
    const convFile = tmpConv();
    const cfg = loadConfig(base);
    const desk = new Desk(cfg, makeCaller(cfg), { reportsDir: null, conversationsPath: convFile, learningsPath: null });

    desk.addRoomMessage({ from: 'owner', to: 'all', text: 'Chat in Room A', conversationId: 'conv-A' });
    desk.addRoomMessage({ from: 'owner', to: 'all', text: 'Chat in Room B', conversationId: 'conv-B' });

    const roomA = desk.roomHistory.filter(m => m.conversationId === 'conv-A');
    const roomB = desk.roomHistory.filter(m => m.conversationId === 'conv-B');

    expect(roomA).toHaveLength(1);
    expect(roomA[0].text).toBe('Chat in Room A');

    expect(roomB).toHaveLength(1);
    expect(roomB[0].text).toBe('Chat in Room B');
  });

  it('deduplicates replayed or reconnected messages by messageId without creating duplicates', () => {
    const convFile = tmpConv();
    const cfg = loadConfig(base);
    const desk = new Desk(cfg, makeCaller(cfg), { reportsDir: null, conversationsPath: convFile, learningsPath: null });

    const msgId = 'msg-fixed-uuid-123';
    const first = desk.addRoomMessage({ id: msgId, from: 'owner', to: 'risk', text: 'Check risk caps' });
    const retry = desk.addRoomMessage({ id: msgId, from: 'owner', to: 'risk', text: 'Check risk caps' });

    expect(first.id).toBe(msgId);
    expect(retry.id).toBe(msgId);
    expect(desk.roomHistory.filter(m => m.id === msgId)).toHaveLength(1);
  });

  it('provides simple HTTP endpoints for conversation discovery and creation', async () => {
    const convFile = tmpConv();
    const cfg = loadConfig(base);
    const built = createApp(cfg, { reportsDir: null, conversationsPath: convFile, learningsPath: null });

    const server = built.server.listen(0);
    const addr = server.address() as { port: number };
    const baseUri = `http://127.0.0.1:${addr.port}`;

    try {
      const getRes = await fetch(`${baseUri}/api/conversations`);
      expect(getRes.status).toBe(200);
      const getBody = await getRes.json() as { ok: boolean; conversations: unknown[] };
      expect(getBody.ok).toBe(true);
      expect(Array.isArray(getBody.conversations)).toBe(true);

      const postRes = await fetch(`${baseUri}/api/conversations/new`, { method: 'POST' });
      expect(postRes.status).toBe(200);
      const postBody = await postRes.json() as { ok: boolean; conversationId?: string };
      expect(postBody.ok).toBe(true);
      expect(postBody.conversationId).toMatch(/^conv-/);
    } finally {
      server.close();
    }
  });
});
