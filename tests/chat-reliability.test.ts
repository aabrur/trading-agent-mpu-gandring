import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Desk } from '../server/desk.js';
import { loadConfig } from '../server/config.js';
import type { ModelCaller, ModelRequest } from '../server/providers/index.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const config = () => loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEFAULT_PROVIDER: 'mock', DEBATE_PACE_MS: '0', LEARNING: 'off' });
function fixture(call: ModelCaller, conversationsPath: string | null = null) {
  return new Desk(config(), call, { conversationsPath, learningsPath: null, killFile: null, reportsDir: null, opportunityReviewsPath: null });
}

it('persists empty conversations before returning and survives a new Desk instance', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mpu-chat-')); dirs.push(dir);
  const file = path.join(dir, 'conversations.json');
  const call = vi.fn<ModelCaller>();
  const first = fixture(call, file);
  const created = first.createConversation();
  expect(created.messageCount).toBe(0);
  expect(fixture(call, file).listConversations().some(c => c.id === created.id)).toBe(true);
  expect(call).not.toHaveBeenCalled();
});

it('attributes direct and huddle speech to their conversation with one final event per message', async () => {
  const requests: ModelRequest[] = [];
  const desk = fixture(async request => { requests.push(request); return JSON.stringify({ reply: `${request.agent} answer` }); });
  const completed: Array<{ id: string; conversationId: string }> = [];
  desk.on('speech', (speech: { id: string; conversationId: string; done: boolean }) => { if (speech.done) completed.push(speech); });
  const result = await desk.command('Hello', 'lead', 'direct');
  await desk.runHuddle('Say hello', ['market', 'research'], undefined, 'huddle');
  expect(result.ok).toBe(true);
  expect(completed.map(s => s.conversationId)).toEqual(['direct', 'huddle', 'huddle']);
  expect(new Set(completed.map(s => s.id)).size).toBe(completed.length);
  for (const speech of completed) expect(desk.roomHistory.some(m => m.id === speech.id && m.conversationId === speech.conversationId)).toBe(true);
  expect(requests[0].context.requestId).toBe(result.requestId);
  expect(requests[1].context.requestId).toBe(requests[2].context.requestId);
  expect(requests[1].context.handoffId).not.toBe(requests[2].context.handoffId);
});

it('exposes actual provider failures in results and state without successful chat status', async () => {
  const desk = fixture(async () => { throw new Error('provider HTTP 401'); });
  const result = await desk.command('Hello', 'lead', 'failure');
  expect(result).toMatchObject({ ok: false, failureKind: 'auth' });
  expect(result.reply).toMatch(/authentication/i);
  expect(desk.snapshot().agents.lead.lastFailure).toMatchObject({ kind: 'auth', attempts: 1, requestId: result.requestId });
  const huddle = await desk.runHuddle('Hello', ['market'], undefined, 'failure');
  expect(huddle.results[0]).toMatchObject({ status: 'failed', failureKind: 'auth' });
});

it('does not persist a late cancelled provider answer or execute its proposed action', async () => {
  const controller = new AbortController();
  const desk = fixture(async () => { controller.abort(); return '{"reply":"Late answer","commandToExecute":"set leverage 1"}'; });
  const before = desk.cfg.risk.maxLeverage;
  const result = await desk.command('Hello', 'lead', 'cancelled', controller.signal);
  expect(result).toMatchObject({ ok: false, failureKind: 'cancelled' });
  expect(desk.roomHistory.some(m => m.from === 'lead')).toBe(false);
  expect(desk.cfg.risk.maxLeverage).toBe(before);
});

it('keeps a quiet conversation when another conversation exceeds the room cap', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mpu-chat-')); dirs.push(dir);
  const file = path.join(dir, 'conversations.json');
  const desk = fixture(async () => '{"reply":"ok"}', file);
  const kept = desk.addRoomMessage({ from: 'owner', text: 'keep-me', conversationId: 'quiet' });
  for (let i = 0; i < 205; i++) desk.addRoomMessage({ from: 'owner', text: `solo-${i}` });
  const office = desk.roomHistory.filter(m => m.conversationId === 'office');
  expect(office).toHaveLength(200);
  expect(office[0].text).toBe('solo-5');
  expect(office.at(-1)?.text).toBe('solo-204');
  expect(desk.snapshot().roomHistory.filter(m => (m.conversationId ?? 'office') === 'office')).toHaveLength(100);
  expect(desk.snapshot().roomHistory.some(m => m.id === kept.id)).toBe(true);
  expect(desk.roomHistory.filter(m => m.conversationId === 'busy')).toHaveLength(0);
  for (let i = 0; i < 201; i++) desk.addRoomMessage({ from: 'owner', text: `busy-${i}`, conversationId: 'busy' });
  expect(desk.roomHistory.some(m => m.id === kept.id)).toBe(true);
  expect(desk.roomHistory.filter(m => m.conversationId === 'busy')).toHaveLength(200);
  const snap = desk.snapshot();
  expect(snap.roomHistory.some(m => m.id === kept.id)).toBe(true);
  expect(snap.roomHistory.filter(m => m.conversationId === 'busy')).toHaveLength(100);
  const reloaded = fixture(async () => '{"reply":"ok"}', file);
  expect(reloaded.roomHistory.some(m => m.conversationId === 'quiet' && m.text === 'keep-me')).toBe(true);
  expect(reloaded.roomHistory.filter(m => m.conversationId === 'busy')).toHaveLength(200);
});

it('does not let one conversation evict another direct chat line', async () => {
  const desk = fixture(async () => JSON.stringify({ reply: 'ok' }));
  await desk.command('quiet', 'lead', 'quiet');
  for (let i = 0; i < 101; i++) await desk.command(`busy ${i}`, 'lead', 'busy');
  expect(desk.chats.lead.filter(c => c.conversationId === 'quiet')).toHaveLength(2);
  expect(desk.chats.lead.filter(c => c.conversationId === 'busy')).toHaveLength(202);
  expect(desk.snapshot().chats.lead.filter(c => c.conversationId === 'busy')).toHaveLength(100);
});
