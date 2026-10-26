import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server/config.js';
import { makeCaller, type ModelRequest } from '../server/providers/index.js';
import { runAgent } from '../server/agents/run.js';
import { runLocalAgent } from '../server/providers/local.js';

const cleanup = vi.hoisted(() => ({ locked: false, folders: [] as string[] }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, rmSync: (...args: Parameters<typeof fs.rmSync>) => {
    if (cleanup.locked && String(args[0]).includes('mpu-agent-')) {
      cleanup.folders.push(String(args[0]));
      throw Object.assign(new Error('EPERM, Permission denied: temporary CLI directory'), { code: 'EPERM' });
    }
    return fs.rmSync(...args);
  } };
});
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, rm: async (...args: Parameters<typeof fs.rm>) => {
    if (cleanup.locked && String(args[0]).includes('mpu-agent-')) {
      cleanup.folders.push(String(args[0]));
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    }
    return fs.rm(...args);
  } };
});
afterEach(async () => {
  cleanup.locked = false;
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  for (const folder of cleanup.folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
});

it('keeps a valid CLI answer and does not rerun the model when Windows cleanup is locked', async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'mpu-cleanup-cli-'));
  const script = `process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({reply:'Hello Boss'})));`;
  if (process.platform === 'win32') {
    writeFileSync(path.join(folder, 'claude.cmd'), '@"%dp0%\\fake.js"');
    writeFileSync(path.join(folder, 'fake.js'), script);
  } else writeFileSync(path.join(folder, 'claude'), `#!${process.execPath}\n${script}`, { mode: 0o755 });
  vi.stubEnv('PATH', folder);
  cleanup.locked = true;
  const cfg = loadConfig({ DEFAULT_PROVIDER: 'local', LOCAL_MODEL: 'claude:default' });
  const call = vi.fn(makeCaller(cfg));
  const result = await runAgent(cfg, call, 'lead', 'chat', { instruction: 'Say hello', data: {}, context: {} });
  expect(result).toMatchObject({ fallback: false, attempts: 1, data: { reply: 'Hello Boss' } });
  expect(call).toHaveBeenCalledTimes(1);
});

it('bounds a connection check even while all local CLI slots are occupied', async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'mpu-queue-cli-'));
  const script = `process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>console.log('{"reply":"ready"}'),500));`;
  if (process.platform === 'win32') {
    writeFileSync(path.join(folder, 'claude.cmd'), '@"%dp0%\\fake.js"');
    writeFileSync(path.join(folder, 'fake.js'), script);
  } else writeFileSync(path.join(folder, 'claude'), `#!${process.execPath}\n${script}`, { mode: 0o755 });
  vi.stubEnv('PATH', folder);
  const occupied = Promise.allSettled(Array.from({ length: 3 }, () => runLocalAgent('claude:default', 'hello')));
  try {
    await expect(runLocalAgent('claude:default', 'test', undefined, undefined, { timeoutMs: 20 })).rejects.toThrow(/timed out waiting/i);
  } finally { await occupied; }
});

describe('OpenRouter response recovery', () => {
  const request: ModelRequest = { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash-1017', agent: 'lead', task: 'lead', system: 'Return JSON', user: 'Decide', context: {}, attempt: 1 };
  const call = () => makeCaller(loadConfig({ OPENROUTER_API_KEY: 'fixture-only' }));
  const json = (body: unknown) => new Response(JSON.stringify(body));

  it('decodes text blocks after falling back from unsupported JSON schema', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 400 }))
      .mockResolvedValueOnce(json({ choices: [{ message: { content: [{ type: 'text', text: '{"action":"HOLD","reason":"No setup"}' }] } }] }));
    expect(await call()(request)).toBe('{"action":"HOLD","reason":"No setup"}');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not downgrade again or hide authentication errors during format fallback', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 400 }))
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(json({ choices: [{ message: { content: '{}' } }] }));
    await expect(call()(request)).rejects.toThrow('provider HTTP 401');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reports exhausted output tokens and increases the budget on the existing second attempt', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ choices: [{ finish_reason: 'length', message: { content: null, reasoning: 'private reasoning is not an answer' } }] }));
    const caller = call();
    await expect(caller(request)).rejects.toThrow(/output token limit/i);
    await expect(caller({ ...request, attempt: 2, retryReason: 'output_limit' })).rejects.toThrow(/output token limit/i);
    const first = JSON.parse(String(fetcher.mock.calls[0][1]?.body)) as { max_tokens: number };
    const second = JSON.parse(String(fetcher.mock.calls[1][1]?.body)) as { max_tokens: number };
    expect(second.max_tokens).toBeGreaterThan(first.max_tokens);
  });

  it('keeps the original token budget for an ordinary schema retry', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ choices: [{ message: { content: '{}' } }] }));
    await call()(request);
    await call()({ ...request, attempt: 2 });
    const budgets = fetcher.mock.calls.map(([, init]) => (JSON.parse(String(init?.body)) as { max_tokens: number }).max_tokens);
    expect(budgets[1]).toBe(budgets[0]);
  });

  it('recovers an exhausted lead response through the normal agent retry path', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ choices: [{ finish_reason: 'length', message: { content: null } }] }))
      .mockResolvedValueOnce(json({ choices: [{ finish_reason: 'stop', message: { content: '{"action":"HOLD","confidence":0.7,"reason":"No setup"}' } }] }));
    const cfg = loadConfig({ DEFAULT_PROVIDER: 'openrouter', OPENROUTER_MODEL: request.model, OPENROUTER_API_KEY: 'fixture-only' });
    const result = await runAgent(cfg, makeCaller(cfg), 'lead', 'lead', { instruction: 'Decide', data: {}, context: {} });
    expect(result).toMatchObject({ fallback: false, attempts: 2, data: { action: 'HOLD' } });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((JSON.parse(String(fetcher.mock.calls[1][1]?.body)) as { max_tokens: number }).max_tokens).toBe(8192);
  });

  it('labels a provider deadline as a timeout instead of a generic abort', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')), { once: true });
    }));
    try {
      const pending = call()(request).then(() => null, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(60_001);
      expect(await pending).toBeInstanceOf(Error);
      expect(String(await pending)).toMatch(/provider timed out/i);
    } finally { vi.useRealTimers(); }
  });
});
