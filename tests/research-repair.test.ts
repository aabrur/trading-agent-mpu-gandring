import { afterEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { loadConfig } from '../server/config.js';
import { runAgent } from '../server/agents/run.js';
import { makeCaller, type ModelCaller } from '../server/providers/index.js';
import { runLocalAgent } from '../server/providers/local.js';
import { researchArgs } from '../server/providers/research-policy.js';

vi.mock('../server/providers/local.js', async original => ({
  ...await original<typeof import('../server/providers/local.js')>(), runLocalAgent: vi.fn()
}));
afterEach(() => vi.restoreAllMocks());
const cfg = loadConfig({ TRADING_MODE: 'PAPER', DEFAULT_PROVIDER: 'mock' });
const input = { instruction: 'Research current sourced catalysts.', data: {}, context: {} };
const answer = { vote: 'LONG', confidence: .73, argument: 'A reported catalyst supports the thesis.', sources: ['Reuters'] };

describe('Research answer repair', () => {
  it('accepts valid Research JSON unchanged in one call', async () => {
    const call = vi.fn<ModelCaller>().mockResolvedValue(JSON.stringify(answer));
    expect(await runAgent(cfg, call, 'research', 'research', input)).toMatchObject({ fallback: false, attempts: 1, data: answer });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('keeps the full citation and unchanged reasoning when abbreviating an overlong label', async () => {
    const citation = `Reuters: ${'source headline '.repeat(16)}https://www.reuters.com/markets/example?source=fixture`;
    const call = vi.fn<ModelCaller>().mockResolvedValue(JSON.stringify({ ...answer, sources: [citation] }));
    const start = performance.now();
    const result = await runAgent(cfg, call, 'research', 'research', input);
    const durationMs = performance.now() - start;
    expect(result).toMatchObject({ fallback: false, attempts: 1, data: { vote: answer.vote, confidence: answer.confidence, argument: answer.argument } });
    expect(result.data.sources[0].length).toBeLessThanOrEqual(120);
    expect(result.data).toHaveProperty('sourceDetails', [{ label: result.data.sources[0], citation }]);
    expect(call).toHaveBeenCalledTimes(1);
    console.info(`Research normalization fixture: ${durationMs.toFixed(2)} ms; model calls=1; external tool calls=0`);
  });

  it('uses only the completed answer for format repair and disables local research tools', async () => {
    const localCfg = loadConfig({ TRADING_MODE: 'PAPER', DEFAULT_PROVIDER: 'local', LOCAL_MODEL: 'codex:default' });
    const invalid = { ...answer, sources: 'Reuters' };
    let toolCalls = 0;
    vi.mocked(runLocalAgent).mockImplementation(async (_selection, prompt, _signal, _effort, options) => {
      if (options?.allowResearch) toolCalls++;
      if (vi.mocked(runLocalAgent).mock.calls.length === 1) return JSON.stringify(invalid);
      expect(options?.allowResearch).toBe(false);
      expect(JSON.parse(prompt.split('<<<UNTRUSTED_DATA completed_research_answer>>>\n')[1].split('\n<<<END_UNTRUSTED_DATA')[0])).toBe(JSON.stringify(invalid));
      expect(prompt).not.toContain(input.instruction);
      expect(prompt).toMatch(/format.repair.only/i);
      return JSON.stringify(answer);
    });
    const start = performance.now();
    const result = await runAgent(localCfg, makeCaller(localCfg), 'research', 'research', input);
    const durationMs = performance.now() - start;
    expect(result).toMatchObject({ fallback: false, attempts: 2, data: answer });
    expect(runLocalAgent).toHaveBeenCalledTimes(2);
    expect(toolCalls).toBe(1);
    const disabled = researchArgs({ enabled: false, mcpTools: {} }, []);
    expect(disabled).toContain('web_search="disabled"');
    expect(disabled).toContain('mcp_servers={}');
    console.info(`Research format-repair fixture: ${durationMs.toFixed(2)} ms; model calls=2; simulated web searches=1 (initial=1, repair=0)`);
  });

  it.each(['vote', 'confidence', 'argument'] as const)('does not accept a format repair that changes %s', async field => {
    const changed = { ...answer, [field]: field === 'confidence' ? .9 : field === 'vote' ? 'SHORT' : 'A different thesis.' };
    const call = vi.fn<ModelCaller>().mockResolvedValueOnce(JSON.stringify({ ...answer, sources: 42 })).mockResolvedValueOnce(JSON.stringify(changed));
    expect(await runAgent(cfg, call, 'research', 'research', input)).toMatchObject({ fallback: true, failureKind: 'schema', data: { vote: 'ABSTAIN' } });
  });

  it.each([false, true])('preserves full provenance through format repair, citation tampered=%s', async tampered => {
    const sourceDetails = [{ label: 'Reuters', citation: 'https://www.reuters.com/markets/original-fixture' }];
    const call = vi.fn<ModelCaller>().mockResolvedValueOnce(JSON.stringify({ ...answer, sources: 'Reuters', sourceDetails }))
      .mockResolvedValueOnce(JSON.stringify({ ...answer, sourceDetails: tampered ? [{ label: 'Reuters', citation: 'https://example.com/different-source' }] : sourceDetails }));
    const result = await runAgent(cfg, call, 'research', 'research', input);
    expect(result.fallback).toBe(tampered);
    expect(result.data.vote).toBe(tampered ? 'ABSTAIN' : 'LONG');
    if (!tampered) expect(result.data).toHaveProperty('sourceDetails', sourceDetails);
  });

  it('does not truncate a substantive argument to pass validation', async () => {
    const original = { ...answer, argument: 'Evidence sentence. '.repeat(100) };
    const call = vi.fn<ModelCaller>().mockResolvedValue(JSON.stringify(original));
    expect(await runAgent(cfg, call, 'research', 'research', input)).toMatchObject({ fallback: true, data: { vote: 'ABSTAIN' } });
  });

  it('abstains on genuinely invalid evidence after one format-only repair', async () => {
    const call = vi.fn<ModelCaller>().mockResolvedValue(JSON.stringify({ ...answer, confidence: 4, sources: [null] }));
    expect(await runAgent(cfg, call, 'research', 'research', input)).toMatchObject({ fallback: true, failureKind: 'schema', attempts: 2, data: { vote: 'ABSTAIN', confidence: 0 } });
    expect(call.mock.calls[1][0].retryReason).toBe('format_repair');
  });
});
