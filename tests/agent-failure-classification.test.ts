import { expect, it, vi } from 'vitest';
import { loadConfig } from '../server/config.js';
import { runAgent, type AgentFailureKind } from '../server/agents/run.js';
import type { ModelCaller, ModelRequest } from '../server/providers/index.js';

const cfg = loadConfig({ TRADING_MODE: 'PAPER', DEFAULT_PROVIDER: 'mock' });
const input = { instruction: 'Answer the current question.', data: {}, context: {} };

it.each<{ message: string; kind: AgentFailureKind; guidance: RegExp }>([
  { message: 'Model provider timed out after 60s', kind: 'timeout', guidance: /timed out.*health/i },
  { message: 'provider HTTP 429', kind: 'rate_limit', guidance: /rate limit.*wait/i },
  { message: 'provider HTTP 429 insufficient_quota', kind: 'quota', guidance: /quota.*credits/i },
  { message: 'provider HTTP 401', kind: 'auth', guidance: /authentication.*connection/i },
  { message: 'provider HTTP 403', kind: 'auth', guidance: /authentication.*permissions/i },
  { message: 'Model request cancelled', kind: 'cancelled', guidance: /cancelled.*no completed answer/i },
])('reports $kind without automatic retry or a fabricated successful answer', async ({ message, kind, guidance }) => {
  const call = vi.fn<ModelCaller>().mockRejectedValue(new Error(message));
  const result = await runAgent(cfg, call, 'lead', 'chat', input);
  expect(result).toMatchObject({ fallback: true, failureKind: kind, attempts: 1 });
  expect(result.data.reply).toMatch(guidance);
  expect(result.data.commandToExecute).toBeUndefined();
  expect(call).toHaveBeenCalledTimes(1);
});

it('returns structured cancellation without invoking the provider for a pre-aborted request', async () => {
  const controller = new AbortController(); controller.abort();
  const call = vi.fn<ModelCaller>();
  const result = await runAgent(cfg, call, 'lead', 'chat', { ...input, signal: controller.signal });
  expect(result).toMatchObject({ fallback: true, failureKind: 'cancelled', attempts: 0 });
  expect(call).not.toHaveBeenCalled();
});

it('rejects a late successful reply when cancellation occurred while the provider was running', async () => {
  const controller = new AbortController();
  const call = vi.fn<ModelCaller>(async () => {
    controller.abort();
    return '{"reply":"Late answer","commandToExecute":"buy BTC"}';
  });
  const result = await runAgent(cfg, call, 'lead', 'chat', { ...input, signal: controller.signal });
  expect(result).toMatchObject({ fallback: true, failureKind: 'cancelled', attempts: 1 });
  expect(result.data.commandToExecute).toBeUndefined();
  expect(call).toHaveBeenCalledTimes(1);
});

it('classifies malformed JSON as parse failure and attempts only one repair', async () => {
  const call = vi.fn<ModelCaller>().mockResolvedValue('not JSON');
  const result = await runAgent(cfg, call, 'lead', 'lead', input);
  expect(result).toMatchObject({ fallback: true, failureKind: 'parse', attempts: 2, data: { action: 'HOLD' } });
  expect(call).toHaveBeenCalledTimes(2);
});

it('distinguishes empty output from a schema mismatch', async () => {
  const empty = await runAgent(cfg, vi.fn<ModelCaller>().mockResolvedValue('  '), 'lead', 'chat', input);
  const schema = await runAgent(cfg, vi.fn<ModelCaller>().mockResolvedValue('{"reply":42}'), 'lead', 'chat', input);
  expect(empty).toMatchObject({ fallback: true, failureKind: 'empty_output', attempts: 2 });
  expect(schema).toMatchObject({ fallback: true, failureKind: 'schema', attempts: 2 });
});

it('keeps the bounded output-token repair and signals the increased output budget', async () => {
  const calls: ModelRequest[] = [];
  const call = vi.fn<ModelCaller>(async (request) => {
    calls.push(request);
    if (calls.length === 1) throw new Error('Model provider output token limit reached before a complete answer');
    return '{"reply":"Completed answer"}';
  });
  const result = await runAgent(cfg, call, 'lead', 'chat', input);
  expect(result).toMatchObject({ fallback: false, failureKind: null, attempts: 2 });
  expect(calls[1].retryReason).toBe('output_limit');
  expect(call).toHaveBeenCalledTimes(2);
});

it('retains the two-attempt bound for other provider failures and keeps raw errors out of chat', async () => {
  const call = vi.fn<ModelCaller>().mockRejectedValue(new Error('provider HTTP 500 with private response body'));
  const result = await runAgent(cfg, call, 'lead', 'chat', input);
  expect(result).toMatchObject({ fallback: true, failureKind: 'provider', attempts: 2 });
  expect(result.data.reply).toMatch(/provider.*availability/i);
  expect(result.data.reply).not.toContain('private response body');
  expect(call).toHaveBeenCalledTimes(2);
});
