import { describe, it, expect } from 'vitest';
import { loadConfig } from '../server/config.js';
import { runAgent } from '../server/agents/run.js';
import { extractJson } from '../server/schemas.js';
import type { ModelCaller } from '../server/providers/index.js';

const cfg = loadConfig({ TRADING_MODE: 'PAPER' });
const input = { instruction: 'x', data: {}, context: {} };

describe('agent output validation', () => {
  it.each([null, '', '   '])('treats an absent optional chat command %s as no action', async command => {
    const r = await runAgent(cfg, async () => JSON.stringify({ reply: 'My own verified answer', commandToExecute: command }), 'lead', 'chat', input);
    expect(r.attempts).toBe(1);
    expect(r.data.reply).toBe('My own verified answer');
    expect(r.data.commandToExecute).toBeUndefined();
  });
  it('does not report two schema-invalid JSON replies as a completed teammate answer', async () => {
    const r = await runAgent(cfg, async () => '{"reply":7,"commandToExecute":"set leverage 1"}', 'lead', 'chat', input);
    expect(r.fallback).toBe(true);
    expect(r.data.commandToExecute).toBeUndefined();
  });
  it('extracts JSON wrapped in chatter and fences', () => {
    expect(extractJson('Sure!\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('blah {"reply":"hi {there}"} trailing')).toEqual({ reply: 'hi {there}' });
  });
  it('retries once, then succeeds', async () => {
    let n = 0;
    const call: ModelCaller = async () => (++n === 1 ? 'not json' : '{"action":"OPEN_LONG","confidence":0.7,"reason":"trend"}');
    const r = await runAgent(cfg, call, 'lead', 'lead', input);
    expect(r.attempts).toBe(2);
    expect(r.fallback).toBe(false);
    expect(r.data.action).toBe('OPEN_LONG');
  });
  it('falls back to a safe HOLD after two bad replies', async () => {
    const call: ModelCaller = async () => '{"action":"BUY_EVERYTHING","confidence":9}';
    const r = await runAgent(cfg, call, 'lead', 'lead', input);
    expect(r.fallback).toBe(true);
    expect(r.data.action).toBe('HOLD');
  });
  it('risk falls back to REJECT, and provider errors count as invalid', async () => {
    const call: ModelCaller = async () => { throw new Error('provider HTTP 500'); };
    const r = await runAgent(cfg, call, 'risk', 'risk', input);
    expect(r.data.decision).toBe('REJECT');
    expect(r.data.sizeFactor).toBe(0);
  });
});
