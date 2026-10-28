import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Desk } from '../server/desk.js';
import { loadConfig } from '../server/config.js';
import type { ModelCaller } from '../server/providers/index.js';

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
function file() { const dir = mkdtempSync(path.join(tmpdir(), 'mpu-private-')); dirs.push(dir); return path.join(dir, 'conversations.json'); }
function desk(file: string, run: string, caller: ModelCaller = async () => '{"reply":"A recorded answer."}') {
  return new Desk(loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEFAULT_PROVIDER: 'mock', LEARNING: 'off', DEBATE_PACE_MS: '0' }), caller, { conversationsPath: file, operationalSessionId: run, reportsDir: null, learningsPath: null, opportunityReviewsPath: null, killFile: null });
}

it('T7 retries one request without duplicate bubbles or model calls; identical intentional sends remain valid', async () => {
  const call = vi.fn<ModelCaller>(async () => '{"reply":"One answer."}');
  const d = desk(file(), 'run-one', call);
  await Promise.all([d.command('Hello', 'lead', 'office', undefined, 'send-one'), d.command('Hello', 'lead', 'office', undefined, 'send-one')]);
  expect(call).toHaveBeenCalledTimes(1);
  expect(d.chats.lead).toHaveLength(2);
  await d.command('Hello', 'lead', 'office', undefined, 'send-two');
  await d.command('Hello', 'lead', 'office', undefined, 'send-three');
  expect(d.chats.lead.filter(c => c.from === 'user')).toHaveLength(3);
  expect(call).toHaveBeenCalledTimes(3);
});

it('T8 archives only on full shutdown, recovers a crash, and permanently deletes only one role archive', async () => {
  const f = file(), d = desk(f, 'run-one');
  await d.command('Hello', 'lead', 'office', undefined, 'r1');
  await d.command('Hello', 'risk', 'office', undefined, 'r2');
  const crash = desk(f, 'run-two');
  expect(crash.chats.lead).toHaveLength(2);
  expect(crash.activeChatSession().recovered).toBe(true);
  crash.closeOperationalSession();
  const next = desk(f, 'run-three');
  expect(Object.values(next.snapshot().chats).every(c => c.length === 0)).toBe(true);
  const history = next.listChatHistory('lead');
  expect(history).toHaveLength(1);
  expect(next.readChatHistory('lead', history[0].id, 0, 1).messages).toHaveLength(1);
  next.deleteChatHistory('lead', history[0].id);
  const reload = desk(f, 'run-three');
  expect(reload.listChatHistory('lead')).toHaveLength(0);
  expect(reload.listChatHistory('risk')).toHaveLength(1);
});

it('migrates legacy private messages exactly once without truncating stored history', () => {
  const f = file();
  writeFileSync(f, JSON.stringify({ chats: { lead: Array.from({ length: 125 }, (_, i) => ({ from: 'user', text: `old ${i}`, at: i, conversationId: 'office' })) } }));
  const d = desk(f, 'run-one');
  expect(d.chats.lead).toHaveLength(0);
  const archives = d.listChatHistory('lead');
  expect(archives).toHaveLength(1);
  expect(archives[0].legacy).toBe(true);
  expect(d.readChatHistory('lead', archives[0].id, 100, 100).messages).toHaveLength(25);
  expect(desk(f, 'run-one').listChatHistory('lead')).toHaveLength(1);
});

it('cancellation persists one terminal result and cannot cancel an unrelated request', async () => {
  const call: ModelCaller = async req => req.context.message === 'Wait here' ? await new Promise((_, reject) => req.signal?.addEventListener('abort', () => reject(new Error('Model request cancelled')), { once: true })) : '{"reply":"Other request completed."}';
  const d = desk(file(), 'run-one', call), controller = new AbortController();
  const waiting = d.command('Wait here', 'lead', 'office', controller.signal, 'wait');
  await new Promise(r => setTimeout(r, 20));
  const other = await d.command('Hello', 'risk', 'office', undefined, 'other');
  controller.abort();
  expect((await waiting).ok).toBe(false);
  expect(other.ok).toBe(true);
  expect(d.chats.lead).toHaveLength(2);
  expect(d.chats.lead[1].status).toBe('cancelled');
});

it('never exposes another account active or archived transcript', async () => {
  const d = desk(file(), 'run-one');
  const scope = vi.spyOn(d, 'accountScope').mockReturnValue('LIVE:aster:mainnet:public-account-A');
  await d.command('Account A private message', 'lead', 'office', undefined, 'account-a');
  const a = d.activeChatSession().id;
  d.closeOperationalSession();
  scope.mockReturnValue('LIVE:aster:mainnet:public-account-B');
  expect(d.snapshot().chats.lead).toHaveLength(0);
  expect(JSON.stringify(d.snapshot().conversations)).not.toContain('Account A private message');
  expect(d.listChatHistory('lead')).toHaveLength(0);
  expect(() => d.readChatHistory('lead', a)).toThrow();
  expect(() => d.deleteChatHistory('lead', a)).toThrow();
});

it('conversation discovery never exposes a prior account reply preview', async () => {
  const d = desk(file(), 'run-one', async () => '{"reply":"PRIVATE ACCOUNT A"}');
  const scope = vi.spyOn(d, 'accountScope').mockReturnValue('LIVE:aster:mainnet:public-account-A');
  const conversation = d.createConversation();
  await d.command('Account A question', 'lead', conversation.id);
  scope.mockReturnValue('LIVE:aster:mainnet:public-account-B');
  expect(JSON.stringify(d.snapshot().conversations)).not.toContain('PRIVATE ACCOUNT A');
});

it('cancels only the five children owned by a team request', async () => {
  const aborted: string[] = [];
  const call: ModelCaller = async req => {
    if (req.context.message === 'Hello') return '{"reply":"Independent reply."}';
    return await new Promise((_, reject) => req.signal?.addEventListener('abort', () => { aborted.push(req.agent); reject(new Error('Model request cancelled')); }, { once: true }));
  };
  const d = desk(file(), 'run-one', call);
  const team = d.command('Ask all agents to explain readiness', 'lead', 'office', undefined, 'team');
  await new Promise(r => setTimeout(r, 25));
  expect((await d.command('Hello', 'risk', 'other', undefined, 'independent')).ok).toBe(true);
  d.cancelChatRequest('team');
  expect((await team).ok).toBe(false);
  expect(new Set(aborted).size).toBe(5);
});

it('a nonresponsive provider reaches one persisted timeout terminal state within the total chat budget', async () => {
  vi.useFakeTimers();
  const d = desk(file(), 'run-one', async () => await new Promise(() => {}));
  const result = d.command('Hello', 'lead', 'office', undefined, 'timeout');
  await vi.advanceTimersByTimeAsync(120_001);
  expect(await result).toMatchObject({ ok: false, failureKind: 'timeout' });
  expect(d.chats.lead).toHaveLength(2);
  expect(d.chats.lead[1].text).toContain('120s');
  expect(d.snapshot().chats.lead.every(line => line.status === 'failed')).toBe(true);
});
