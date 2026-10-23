// This stdio MCP exposes only the desk's read-only research routes; it has no trading or configuration tools.
import { createInterface } from 'node:readline';
import { RESEARCH_TOOLS, toolSchema } from './catalog.js';

const port = Number(process.env.MPU_RESEARCH_PORT || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local research port');

export async function researchRpc(message: Record<string, unknown>, fetchImpl: typeof fetch = fetch) {
  const id = message.id;
  if (id === undefined) return undefined;
  const result = (value: unknown) => ({ jsonrpc: '2.0', id, result: value });
  const error = (code: number, text: string) => ({ jsonrpc: '2.0', id, error: { code, message: text } });
  if (message.method === 'initialize') return result({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'Trading Agent Mpu Gandring research', version: '1.0.0' } });
  if (message.method === 'ping') return result({});
  if (message.method === 'tools/list') return result({ tools: RESEARCH_TOOLS.map(tool => ({ ...tool, inputSchema: toolSchema, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true } })) });
  if (message.method !== 'tools/call') return error(-32601, 'Method not supported');
  const params = message.params as { name?: string; arguments?: { symbol?: string; objective?: string } } | undefined;
  if (!RESEARCH_TOOLS.some(tool => tool.name === params?.name)) return error(-32602, 'Unsupported research tool');
  const args = params?.arguments;
  if (!args || !/^[A-Z0-9]{3,24}$/.test(args.symbol ?? '') || (args.objective !== undefined && (typeof args.objective !== 'string' || args.objective.length > 500)) || Object.keys(args).some(key => !['symbol', 'objective'].includes(key))) return error(-32602, 'Invalid research arguments');
  const query = new URLSearchParams({ name: params!.name!, symbol: args.symbol! });
  if (args.objective) query.set('objective', args.objective);
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/research?${query}`, { signal: AbortSignal.timeout(40_000) });
    if (!response.ok) throw new Error('Research unavailable');
    const body: unknown = await response.json();
    return result({ content: [{ type: 'text', text: JSON.stringify(body) }] });
  } catch { return result({ isError: true, content: [{ type: 'text', text: 'Live research unavailable. Missing data must remain unavailable.' }] }); }
}

if (process.argv[1] && /(?:^|[\\/])mcp\.(?:js|ts)$/.test(process.argv[1])) {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', line => {
    if (line.length > 65_536) return;
    void (async () => {
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        const response = await researchRpc(value);
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      } catch { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON-RPC request' } })}\n`); }
    })();
  });
}
