import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server/config.js';
import { sendToGrokBot } from '../server/bridge.js';

const KEY = 'test-sender-key-1234567890';
const cfgOn = () => loadConfig({ TRADING_MODE: 'PAPER', GROKBOT_WEBHOOK_URL: 'https://example.invalid/automations/webhook/abc', GROKBOT_WEBHOOK_KEY: KEY });

describe('Grok Bot bridge', () => {
  it('is off without URL and key', async () => {
    expect(await sendToGrokBot(loadConfig({ TRADING_MODE: 'PAPER' }), 'probe', {})).toBe('off');
  });
  it('POSTs once with both auth headers', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('ok', { status: 200 }); }) as unknown as typeof fetch;
    const r = await sendToGrokBot(cfgOn(), 'verdict', { action: 'HOLD' }, path.join(mkdtempSync(path.join(tmpdir(), 'mg-')), 'outbox.jsonl'), fake);
    expect(r).toBe('sent');
    expect(calls).toHaveLength(1);
    const h = calls[0].init.headers as Record<string, string>;
    expect(h['Content-Type']).toBe('application/json');
    expect(h.Authorization).toBe(`Bearer ${KEY}`);
    expect(h['X-Automation-Key']).toBe(KEY);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ kind: 'verdict', mode: 'PAPER', data: { action: 'HOLD' } });
  });
  it('on failure appends to the outbox once, no retry, no key in the file', async () => {
    let n = 0;
    const fake = (async () => { n++; throw new Error('network down'); }) as unknown as typeof fetch;
    const outbox = path.join(mkdtempSync(path.join(tmpdir(), 'mg-')), 'outbox.jsonl');
    const r = await sendToGrokBot(cfgOn(), 'command', { note: `leak ${KEY}` }, outbox, fake);
    expect(r).toBe('queued');
    expect(n).toBe(1);
    expect(existsSync(outbox)).toBe(true);
    const text = readFileSync(outbox, 'utf8');
    expect(text.trim().split('\n')).toHaveLength(1);
    expect(text).not.toContain(KEY);
  });
});
