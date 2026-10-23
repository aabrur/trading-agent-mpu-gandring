import { describe, expect, it, vi } from 'vitest';
import { researchRpc } from '../server/research/mcp.js';
import { ResearchPolicyBody, researchArgs, researchEnvironment, researchPolicy } from '../server/providers/research-policy.js';
import { collectTradingData } from '../server/decision/collection.js';
import { JevService } from '../server/decision/jev.js';
import { localResearchActivity, recordResearchActivity } from '../server/providers/local.js';
import { sampleSnapshot } from '../server/market/sample.js';
import type { WhaleBriefing } from '../server/market/whale.js';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { readEnv, setEnv } from '../cli/envfile.js';

const unavailableWhale: WhaleBriefing = { symbol: 'BTC', providerStatus: 'UNCONFIGURED', providerName: 'Whale Alert', events: [], summary: 'unconfigured', observedAt: Date.now(), disclaimer: '' };

describe('Jev data acquisition', () => {
  it('executes the selected collection priority and independently records unavailable feeds', async () => {
    const order: string[] = [];
    const jev = new JevService({ JEV_ENABLED: 'true', JEV_MODE: 'assist', JEV_ALLOW_LIVE: 'yes', OPENROUTER_API_KEY: 'test-only' }, 'LIVE', vi.fn(async () => new Response(JSON.stringify({ model: 'typesafe/jev-1.14', answers: { acquisition_priority: { type: 'choice', choice: 'NEWS_FIRST', confidence: 0.95, probabilities: { NEWS_FIRST: 0.95 } } } }))));
    const result = await collectTradingData({ symbol: 'BTCUSDT', objective: 'Research current catalysts', live: true, jev,
      market: async () => { order.push('market'); return { ...sampleSnapshot('BTCUSDT'), example: false, source: 'bybit' }; },
      news: async () => { order.push('news'); throw new Error('unavailable'); },
      whale: async () => { order.push('whale'); return unavailableWhale; }
    });
    expect(order[0]).toBe('news');
    expect(order).toHaveLength(3);
    expect(result.trace.routedBy).toBe('jev');
    expect(result.trace.feeds.news.status).toBe('unavailable');
    expect(result.trace.feeds.whale.status).toBe('unavailable');
  });
  it('cannot turn a Jev answer into an arbitrary command or accept sample market data in LIVE', async () => {
    const jev = new JevService({}, 'LIVE');
    await expect(collectTradingData({ symbol: 'BTCUSDT', objective: 'read', live: true, jev,
      market: async () => sampleSnapshot('BTCUSDT'), news: async () => [], whale: async () => unavailableWhale })).rejects.toThrow('Sample market');
  });
});

describe('research MCP boundary', () => {
  it('advertises data tools only', async () => {
    const result = await researchRpc({ id: 1, method: 'tools/list' });
    expect(JSON.stringify(result)).toContain('jev_research');
    expect(JSON.stringify(result)).toContain('readOnlyHint');
    expect(JSON.stringify(result)).not.toContain('execute_order');
  });
  it('rejects unknown tools, injected symbols and arbitrary additional arguments before fetching', async () => {
    const fetchImpl = vi.fn();
    for (const params of [
      { name: 'open_order', arguments: { symbol: 'BTCUSDT' } },
      { name: 'market_snapshot', arguments: { symbol: 'BTCUSDT&name=open_order' } },
      { name: 'desk_account', arguments: { symbol: 'BTCUSDT', command: 'close all' } }
    ]) {
      const response = await researchRpc({ id: 1, method: 'tools/call', params }, fetchImpl);
      expect(response).toHaveProperty('error');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('calls only the loopback research API and exposes failures as unavailable', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 503 }));
    const response = await researchRpc({ id: 1, method: 'tools/call', params: { name: 'market_snapshot', arguments: { symbol: 'BTCUSDT' } } }, fetchImpl);
    expect(fetchImpl.mock.calls[0][0]).toContain('http://127.0.0.1:8787/api/research?');
    expect(response).toHaveProperty('result.isError', true);
  });
});

describe('Codex connection policy', () => {
  it('restores explicit tool selections after saving and restarting', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'mpu-research-policy-')), '.env');
    const selected = { feed: ['read_market', 'read_news'] };
    setEnv(file, { LOCAL_CODEX_RESEARCH_TOOLS: 'on', LOCAL_CODEX_MCP_TOOLS: JSON.stringify(selected) });
    expect(researchPolicy(readEnv(file))).toEqual({ enabled: true, mcpTools: selected });
    expect(researchPolicy(parseDotenv(readFileSync(file)))).toEqual({ enabled: true, mcpTools: selected });
  });
  it('adds live web search and research MCP with explicit tool selections', () => {
    const args = researchArgs({ enabled: true, mcpTools: { example: ['read_market'] } }, ['example', 'unrelated'], '8787', { example: { type: 'streamable_http', url: 'https://example.com/mcp' } });
    expect(args).toContain('web_search="live"');
    const config = args.find(arg => arg.startsWith('mcp_servers='))!;
    expect(config).not.toContain('unrelated');
    expect(config).toContain('"enabled_tools"=["read_market"]');
    expect(config).toContain('mpu_research');
    expect(args.join(' ')).not.toContain('dangerously-bypass');
  });
  it('does not enable missing servers or accept arbitrary policy fields', () => {
    expect(() => researchArgs({ enabled: true, mcpTools: { unknown: ['read'] } }, [])).toThrow('not configured');
    expect(ResearchPolicyBody.safeParse({ enabled: true, mcpTools: {}, allowWithdraw: true }).success).toBe(false);
    expect(researchPolicy({}).enabled).toBe(false);
  });
  it('forwards only selected research environment references and refuses desk credentials', () => {
    const policy = { enabled: true, mcpTools: { feed: ['read_market'] } };
    expect(researchEnvironment(policy, { feed: { env_vars: ['MARKET_DATA_TOKEN'] } }, { MARKET_DATA_TOKEN: 'feed-secret', ASTER_SIGNER_PRIVATE_KEY: 'never-forward' })).toEqual({ MARKET_DATA_TOKEN: 'feed-secret' });
    expect(() => researchEnvironment(policy, { feed: { env_vars: ['ASTER_SIGNER_PRIVATE_KEY'] } }, { ASTER_SIGNER_PRIVATE_KEY: 'never-forward' })).toThrow('cannot be forwarded');
    expect(() => researchArgs(policy, ['feed'], '8787', { feed: { command: 'mcp', args: ['--api-key', 'never-on-a-command-line'] } })).toThrow('never command-line');
  });
  it('records structured MCP failures but never treats a model assertion as a verified tool call', () => {
    const before = localResearchActivity().length;
    recordResearchActivity(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'I used every tool successfully' } }));
    expect(localResearchActivity()).toHaveLength(before);
    recordResearchActivity(JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'mpu_research', tool: 'market_snapshot', result: { isError: true } } }));
    expect(localResearchActivity().at(-1)?.status).toBe('failed');
  });
});
