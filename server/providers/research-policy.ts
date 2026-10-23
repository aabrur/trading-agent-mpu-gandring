import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { RESEARCH_TOOLS } from '../research/catalog.js';

const name = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).refine(value => !['__proto__', 'prototype', 'constructor'].includes(value));
export const ResearchPolicyBody = z.object({ enabled: z.boolean(), mcpTools: z.record(name, z.array(name).min(1).max(40)).default({}) }).strict();
export type ResearchPolicy = z.infer<typeof ResearchPolicyBody>;
export function researchPolicy(env: NodeJS.ProcessEnv = process.env): ResearchPolicy {
  let mcpTools: unknown = {};
  const raw = env.LOCAL_CODEX_MCP_TOOLS || '{}';
  try { mcpTools = JSON.parse(raw); } catch {
    // The shared .env writer quotes JSON strings; both startup and Setup retain the escaped quotes.
    try { mcpTools = JSON.parse(JSON.parse(`"${raw}"`)); } catch { throw new Error('Invalid research MCP tool selection'); }
  }
  return ResearchPolicyBody.parse({ enabled: env.LOCAL_CODEX_RESEARCH_TOOLS === 'on', mcpTools });
}
export function researchArgs(policy: ResearchPolicy, configuredServers: string[], port = '8787', transports: Record<string, Record<string, unknown>> = {}): string[] {
  if (!policy.enabled) return ['--disable', 'plugins', '-c', 'mcp_servers={}'];
  const js = fileURLToPath(new URL('../research/mcp.js', import.meta.url));
  const ts = fileURLToPath(new URL('../research/mcp.ts', import.meta.url));
  const brokerArgs = existsSync(js) ? [js] : ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href, ts];
  const overrides = ['--disable', 'plugins', '-c', 'web_search="live"'];
  const servers: Record<string, unknown> = {};
  for (const [server, tools] of Object.entries(policy.mcpTools)) {
    if (!configuredServers.includes(server)) throw new Error(`Selected MCP server is not configured: ${server}`);
    const transport = transports[server];
    if (!transport) throw new Error(`Selected MCP transport is unavailable: ${server}`);
    if (Array.isArray(transport.args) && transport.args.some(arg => typeof arg === 'string' && /(?:--?(?:api[-_]?key|token|secret|password)|\bsk-[a-zA-Z0-9]{12,})/i.test(arg))) throw new Error('MCP credentials must use OAuth or environment references, never command-line arguments');
    if (transport.http_headers && Object.keys(transport.http_headers as object).length) throw new Error('Use MCP OAuth or environment references instead of inline HTTP credentials');
    const inlineEnv = transport.env as Record<string, unknown> | undefined;
    if (inlineEnv && Object.keys(inlineEnv).some(key => !/^(PYTHONUTF8|PYTHONIOENCODING|LANG|LC_ALL|NO_COLOR)$/.test(key))) throw new Error('Use environment references instead of inline MCP credentials');
    if (typeof transport.url === 'string') {
      const url = new URL(transport.url);
      if (url.username || url.password || [...url.searchParams.keys()].some(key => /key|token|secret|auth/i.test(key))) throw new Error('MCP credentials must not appear in a transport URL');
    }
    const permitted = ['command', 'args', 'url', 'env', 'env_vars', 'cwd', 'bearer_token_env_var', 'env_http_headers', 'http_headers_helper'];
    servers[server] = { ...Object.fromEntries(Object.entries(transport).filter(([key, value]) => permitted.includes(key) && value !== null)), enabled: true, enabled_tools: tools };
  }
  servers.mpu_research = { command: process.execPath, args: brokerArgs, env: { MPU_RESEARCH_PORT: port }, enabled: true, enabled_tools: RESEARCH_TOOLS.map(tool => tool.name), startup_timeout_sec: 15, tool_timeout_sec: 45 };
  overrides.push('-c', `mcp_servers=${toml(servers)}`);
  return overrides;
}

export function researchEnvironment(policy: ResearchPolicy, transports: Record<string, Record<string, unknown>>, env: NodeJS.ProcessEnv): Record<string, string> {
  const selected: Record<string, string> = {};
  if (!policy.enabled) return selected;
  for (const server of Object.keys(policy.mcpTools)) {
    const transport = transports[server] ?? {};
    const references = [...(Array.isArray(transport.env_vars) ? transport.env_vars : []), transport.bearer_token_env_var,
      ...Object.values((transport.env_http_headers ?? {}) as Record<string, unknown>)];
    for (const reference of references) {
      if (typeof reference !== 'string' || !/^[A-Z_][A-Z0-9_]*$/i.test(reference)) continue;
      if (/^(BYBIT|BINANCE|ASTER|HYPERLIQUID|DYDX|PARADEX|ORDERLY|OPENAI|OPENROUTER|ANTHROPIC|GEMINI|XAI|DEEPSEEK|GROQ|MISTRAL|TOGETHER|FIREWORKS|TELEGRAM|AGENT_EVENT|GROKBOT|TRADINGVIEW)_/i.test(reference)) throw new Error('Desk exchange, model, and messaging credentials cannot be forwarded to research MCP servers');
      if (env[reference]) selected[reference] = env[reference]!;
    }
  }
  return selected;
}

function toml(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== null && item !== undefined).map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`).join(',')}}`;
  throw new Error('Unsupported MCP transport configuration');
}
