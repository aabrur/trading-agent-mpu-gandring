// Native agent accounts stay in their own CLIs. The desk receives text replies through its existing schema/risk gate.
import { spawn } from 'node:child_process';
import { publishActivity } from '../activity.js';
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { researchArgs, researchEnvironment, researchPolicy, type ResearchPolicy } from './research-policy.js';

export const LOCAL_AGENTS = [
  { id: 'codex', label: 'Codex', login: ['login'], docs: 'https://developers.openai.com/codex/cli', models: ['default', 'gpt-6-astra', 'gpt-6.1-sol'] },
  { id: 'claude', label: 'Claude Code', login: ['auth', 'login'], docs: 'https://code.claude.com/docs/en/cli-reference', models: ['default', 'opus', 'sonnet'] },
  { id: 'pi', label: 'Pi', login: [], docs: 'https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent', models: ['default'] },
  { id: 'kimi', label: 'Kimi Code', login: ['login'], docs: 'https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html', models: ['default'] },
  { id: 'kilo', label: 'Kilo', login: ['auth', 'login'], docs: 'https://kilo.ai/docs/code-with-ai/platforms/cli', models: ['default'] },
  { id: 'cline', label: 'Cline', login: ['auth'], docs: 'https://docs.cline.bot/cline-cli/overview', models: ['default'] },
  { id: 'grok', label: 'Grok Build', login: ['login'], docs: 'https://docs.x.ai/build/cli/headless-scripting', models: ['default'] },
  {
    id: 'antigravity',
    label: 'Antigravity',
    login: [],
    docs: 'https://antigravity.google',
    models: [
      'default',
      'gemini-3.8-flash-high',
      'gemini-3.8-flash-medium',
      'gemini-3.8-flash-low',
      'gemini-4-argon-high',
      'gemini-4-argon-medium',
      'gemini-4-argon-low',
      'claude-opus-5-5-high',
      'claude-sonnet-5-5-high',
      'claude-opus-5-5-medium',
      'claude-sonnet-5-5-medium',
      'gpt-oss-120b-medium'
    ]
  }
] as const;
export type LocalAgentId = (typeof LOCAL_AGENTS)[number]['id'];
const modelIdOk = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,159}$/.test(value);
/** Read model metadata only. Authentication files remain owned by the CLI. */
export function localModels(id: LocalAgentId): string[] {
  const models: string[] = [...LOCAL_AGENTS.find((agent) => agent.id === id)!.models];
  if (id === 'codex') {
    try {
      const raw = readFileSync(path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'models_cache.json'), 'utf8');
      if (raw.length <= 2_000_000) {
        const cache: { models?: { slug?: unknown; visibility?: string }[] } = JSON.parse(raw);
        if (Array.isArray(cache.models)) for (const model of cache.models.slice(0, 1000)) {
          if (model.visibility === 'list' && modelIdOk(model.slug)) models.push(model.slug);
        }
      }
    } catch { /* The configured default and manual model ID remain available without a cache. */ }
  }
  return [...new Set(models)];
}
const allowedEnv = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|LANG|LC_ALL|TERM|CODEX_HOME|CLAUDE_CONFIG_DIR|PI_CODING_AGENT_DIR|KIMI_CODE_HOME|ANTIGRAVITY_HOME|GEMINI_HOME|GEMINI_API_KEY)$/i;
export const localEnvironment = (env: NodeJS.ProcessEnv) => Object.fromEntries(Object.entries(env).filter(([k]) => allowedEnv.test(k)));

/** Resolve native binaries or the JS entry in an npm shim. Never pass prompts through a shell. */
export function localExecutable(id: string, env: NodeJS.ProcessEnv = process.env): { file: string; prefix: string[] } | null {
  const normId = id === 'agy' ? 'antigravity' : id;
  if (!LOCAL_AGENTS.some((a) => a.id === normId)) return null;
  const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const candidates = normId === 'antigravity' ? ['agy', 'antigravity'] : [normId];
  for (const name of candidates) {
    for (const dir of dirs) for (const ext of process.platform === 'win32' ? ['.exe', '.cmd'] : ['']) {
      const file = path.join(dir.replace(/^"|"$/g, ''), name + ext);
      if (!existsSync(file)) continue;
      if (ext !== '.cmd') return { file, prefix: [] };
      const match = readFileSync(file, 'utf8').match(/"%dp0%[\\/]([^"\r\n]+\.(?:c?js|mjs))"/i);
      if (match) { const entry = path.resolve(dir, match[1]); if (existsSync(entry)) return { file: process.execPath, prefix: [entry] }; }
    }
  }
  return null;
}
export function localAgentStatus() { return LOCAL_AGENTS.map((a) => ({ ...a, installed: !!localExecutable(a.id), loginCommand: [a.id === 'antigravity' ? 'agy' : a.id, ...a.login].join(' '), hint: a.id === 'pi' ? 'Open Pi and use /login. Its configured provider and model are reused.' : a.id === 'antigravity' ? 'Run agy to connect your account. Its active models are reused.' : 'Sign in with the agent’s own account. Then test the connection.' })); }
export function localSelection(value: string) {
  const [rawId, ...parts] = value.split(':'); const id = rawId === 'agy' ? 'antigravity' : rawId; const model = parts.join(':') || 'default';
  const agent = LOCAL_AGENTS.find((a) => a.id === id);
  if (!agent || !modelIdOk(model)) throw new Error('Choose a local agent and a valid CLI model ID.');
  return { id: agent.id, model };
}
export function localArgs(id: LocalAgentId, model: string, folder: string, prompt = '', policy: ResearchPolicy = { enabled: false, mcpTools: {} }, configuredServers: string[] = [], transports: Record<string, Record<string, unknown>> = {}): { args: string[]; env: Record<string, string> } {
  let args: string[] = [], env: Record<string, string> = {};
  switch (id) {
    case 'codex': args = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--json', '--disable', 'shell_tool', '--disable', 'unified_exec', ...researchArgs(policy, configuredServers, process.env.PORT || '8787', transports), '-']; break;
    case 'claude': args = ['--print', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--no-session-persistence']; break;
    case 'pi': args = ['--print', '--mode', 'text', '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-session']; break;
    case 'kimi': args = ['--agent-file', path.join(folder, 'reasoner.md'), '--output-format', 'text', '-p', 'Respond to the input provided on stdin with JSON only.']; break;
    case 'kilo': args = ['--pure', 'run', '--format', 'json']; env = { KILO_CONFIG_CONTENT: JSON.stringify({ permission: { '*': 'deny' }, plugin: [] }) }; break;
    case 'cline': args = ['--json', '--plan', '--auto-approve', 'false', '--timeout', '110']; break;
    case 'grok': args = ['--prompt-file', path.join(folder, 'prompt.txt'), '--deny', '*', '--disable-web-search', '--permission-mode', 'dontAsk', '--output-format', 'plain']; break;
    case 'antigravity':
      args = ['--dangerously-skip-permissions', '--disable-slash-commands', '--output-format', 'json'];
      if (model !== 'default') args.push('--model', model);
      args.push('--print', prompt);
      return { args, env };
  }
  if (model !== 'default') args.push('--model', model);
  return { args, env };
}
export function localReply(output: string): string {
  const texts: string[] = [];
  try { const obj = JSON.parse(output); if (typeof obj.result === 'string') return obj.result; if (typeof obj.response === 'string') return obj.response; if (!obj.type) return output.trim(); } catch { /* JSON event streams are read one line at a time. */ }
  for (const line of output.split(/\r?\n/)) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'item.completed' && obj.item?.type === 'agent_message') texts.push(obj.item.text);
      else if (obj.type === 'text' && typeof obj.part?.text === 'string') texts.push(obj.part.text);
      else if (obj.type === 'say' && obj.say === 'text' && typeof obj.text === 'string') texts.push(obj.text);
      else if (obj.type === 'run_result' && typeof obj.text === 'string') return obj.text;
      else if (obj.type === 'result' && typeof obj.result === 'string') return obj.result;
    } catch { /* Plain text replies are returned unchanged below. */ }
  }
  return texts.length ? texts.join('\n') : output.trim();
}

let tail = Promise.resolve();
const researchActivity: { server: string; tool: string; status: string; at: number }[] = [];
export const localResearchActivity = () => researchActivity.slice(-20);
export function recordResearchActivity(output: string) {
  for (const line of output.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as { type?: string; item?: { type?: string; server?: string; tool?: string; status?: string; error?: unknown; result?: { isError?: boolean } } };
      const item = event.item;
      if (event.type !== 'item.completed' || !item?.type) continue;
      const status = item.error || item.result?.isError || item.status === 'failed' ? 'failed' : 'completed';
      if (item.type !== 'mcp_tool_call') {
        if (['web_search', 'command_execution', 'function_call', 'dynamic_tool_call', 'plugin_call'].includes(item.type)) publishActivity({ kind: item.type === 'plugin_call' ? 'plugin' : 'tool', source: 'codex', level: status === 'failed' ? 'error' : 'info', status, text: `${item.type}: ${status}` });
        continue;
      }
      if (!item.server || !item.tool) continue;
      researchActivity.push({ server: item.server.slice(0, 100), tool: item.tool.slice(0, 100), status, at: Date.now() });
      publishActivity({ kind: 'mcp', source: item.server, level: status === 'failed' ? 'error' : 'info', status, text: `${item.server}/${item.tool}: ${status}` });
      if (researchActivity.length > 100) researchActivity.splice(0, researchActivity.length - 100);
    } catch { /* Only structured CLI tool events establish tool usage. */ }
  }
}
export async function runLocalAgent(selection: string, prompt: string): Promise<string> {
  const { id, model } = localSelection(selection);
  const executable = localExecutable(id);
  if (!executable) throw new Error(`${id} is not installed on PATH. Open Setup to connect it.`);
  const prior = tail; let release!: () => void; tail = new Promise<void>((r) => { release = r; });
  await prior;
  const folder = mkdtempSync(path.join(tmpdir(), 'mpu-agent-'));
  const started = Date.now();
  publishActivity({ kind: 'process', source: id, level: 'info', text: `${id} model process started`, status: 'started' });
  try {
    writeFileSync(path.join(folder, 'prompt.txt'), prompt, { mode: 0o600 });
    writeFileSync(path.join(folder, 'reasoner.md'), '---\nname: desk-reasoner\ndescription: Return a structured trading desk opinion\ntools: []\nsubagents: []\n---\nUse only the supplied facts. Return JSON only.\n', { mode: 0o600 });
    const policy = id === 'codex' ? researchPolicy() : { enabled: false, mcpTools: {} };
    const inventory = policy.enabled ? await loadMcpInventory() : [];
    const transports = Object.fromEntries(inventory.map(server => [server.name, server.transport]));
    const plan = localArgs(id, model, folder, prompt, policy, inventory.map(server => server.name), transports);
    Object.assign(plan.env, researchEnvironment(policy, transports, process.env));
    const reply = await new Promise<string>((resolve, reject) => {
      const child = spawn(executable.file, [...executable.prefix, ...plan.args], { cwd: folder, env: { ...localEnvironment(process.env), ...plan.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
      let output = '', eventBuffer = '', size = 0, stopped = false, failure = '';
      const stop = () => {
        if (stopped) return; stopped = true;
        if (process.platform === 'win32' && child.pid) { const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); killer.on('error', () => child.kill()); }
        else if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      };
      const timer = setTimeout(() => { failure = `${id} timed out. Check its sign-in and permission settings in Setup.`; stop(); }, 120_000);
      const collect = (chunk: Buffer, keep: boolean) => { size += chunk.length; if (size > 1_000_000) { failure = `${id} returned too much output.`; stop(); } else if (keep) {
        const text = chunk.toString(); output += text; eventBuffer += text;
        const lines = eventBuffer.split('\n'); eventBuffer = lines.pop() || '';
        for (const line of lines) recordResearchActivity(line);
      } };
      child.stdout.on('data', (v: Buffer) => collect(v, true)); child.stderr.on('data', (v: Buffer) => collect(v, false));
      child.stdin.on('error', () => {}); child.stdin.end(prompt);
      child.on('error', () => { clearTimeout(timer); reject(new Error(`${id} could not start. Check its installation.`)); });
      child.on('close', (code) => { clearTimeout(timer); recordResearchActivity(eventBuffer); if (stopped || code !== 0) reject(new Error(failure || `${id} did not return a reply. Sign in and test it from Setup.`)); else resolve(localReply(output)); });
    });
    publishActivity({ kind: 'process', source: id, level: 'info', status: 'completed', text: `${id} model process completed`, durationMs: Date.now() - started });
    return reply;
  } catch (error) {
    publishActivity({ kind: 'process', source: id, level: 'error', status: 'failed', text: `${id} process failed: ${(error as Error).message}`, durationMs: Date.now() - started });
    throw error;
  } finally { try { rmSync(folder, { recursive: true, force: true }); } finally { release(); } }
}

/** Return metadata only; server headers and transport environments remain inside the CLI. */
async function loadMcpInventory(): Promise<{ name: string; enabled: boolean; authStatus: string; transport: Record<string, unknown> }[]> {
  const executable = localExecutable('codex');
  if (!executable) return [];
  return new Promise((resolve, reject) => {
    const child = spawn(executable.file, [...executable.prefix, 'mcp', 'list', '--json'], { env: localEnvironment(process.env), stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let output = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Codex MCP inventory timed out')); }, 10_000);
    child.stdout.on('data', (chunk: Buffer) => { if (output.length < 2_000_000) output += chunk.toString(); });
    child.once('error', () => { clearTimeout(timeout); reject(new Error('Codex MCP inventory unavailable')); });
    child.once('close', code => {
      clearTimeout(timeout);
      try {
        const items: unknown = JSON.parse(output);
        if (code !== 0 || !Array.isArray(items)) throw new Error();
        resolve(items.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && typeof item.name === 'string')
          .map(item => ({ name: String(item.name), enabled: item.enabled === true, authStatus: String(item.auth_status ?? 'unknown'), transport: item.transport as Record<string, unknown> })));
      } catch { reject(new Error('Codex MCP inventory could not be verified')); }
    });
  });
}

export async function localMcpInventory() {
  return (await loadMcpInventory()).map(({ name, enabled, authStatus }) => ({ name, enabled, authStatus, status: 'configured_only' as const }));
}

export async function validateResearchConnections(policy: ResearchPolicy) {
  if (!policy.enabled) return;
  const inventory = await loadMcpInventory();
  const transports = Object.fromEntries(inventory.map(server => [server.name, server.transport]));
  researchArgs(policy, inventory.map(server => server.name), process.env.PORT || '8787', transports);
  researchEnvironment(policy, transports, process.env);
}

const loginProcesses = new Map<string, 'pending' | 'finished' | 'failed'>();
const connectionChecks = new Map<string, { at: number; result: Promise<{ connected: boolean; state: string }> }>();
/** Ask the CLI for authentication status without reading or returning credentials. */
export async function localLoginStatus(id: string, verify = false) {
  id = id === 'agy' ? 'antigravity' : id;
  const executable = localExecutable(id);
  if (!executable) return { connected: false, state: 'missing' };
  const loginState = loginProcesses.get(id);
  if (loginState === 'pending' || loginState === 'failed') return { connected: false, state: loginState };
  if (id !== 'codex' && id !== 'claude') {
    if (!verify) return { connected: false, state: loginProcesses.get(id) || 'unknown' };
    const previous = connectionChecks.get(id);
    if (previous && Date.now() - previous.at < 15_000) return previous.result;
    const result = (async () => {
      try {
        const reply = await runLocalAgent(`${id}:default`, 'Reply with exactly this JSON object: {"reply":"connected"}. Use no tools.');
        const connected = JSON.parse(reply).reply === 'connected';
        return { connected, state: connected ? 'connected' : 'pending' };
      } catch { return { connected: false, state: 'pending' }; }
    })();
    const check = { at: Number.POSITIVE_INFINITY, result };
    connectionChecks.set(id, check);
    void result.finally(() => { check.at = Date.now(); });
    return result;
  }
  const connected = await new Promise<boolean>((resolve) => {
    const args = id === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status'];
    const child = spawn(executable.file, [...executable.prefix, ...args], { env: localEnvironment(process.env), stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { if (output.length < 16_384) output += chunk.toString(); });
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 5000);
    child.once('error', () => { clearTimeout(timer); resolve(false); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (id !== 'claude') return resolve(code === 0);
      try { resolve(code === 0 && JSON.parse(output).loggedIn === true); } catch { resolve(false); }
    });
  });
  return { connected, state: connected ? 'connected' : loginState === 'finished' ? 'failed' : 'signed-out' };
}

/** Only a fixed, locally discovered login command can open an interactive terminal. No tokens are read or returned. */
export async function openAgentLogin(id: string) {
  const normId = id === 'agy' ? 'antigravity' : id;
  const agent = LOCAL_AGENTS.find((a) => a.id === normId); const executable = localExecutable(normId);
  if (!agent || !executable) throw new Error('Install the agent on PATH first.');
  connectionChecks.delete(normId);
  if (loginProcesses.get(normId) === 'pending') return 'Sign-in is already open. Complete it in the browser or terminal.';
  let child;
  if (process.platform === 'win32') {
    const command = [executable.file, ...executable.prefix, ...agent.login].map((s) => `"${s}"`).join(' ');
    child = spawn('cmd.exe', ['/d', '/s', '/c', `"${command}"`], { cwd: tmpdir(), detached: true, stdio: 'ignore', windowsHide: false });
  } else if (process.platform === 'darwin') {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'mpu-login-')), 'sign-in.command');
    const quote = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
    writeFileSync(file, `#!/bin/sh\nexec ${[executable.file, ...executable.prefix, ...agent.login].map(quote).join(' ')}\n`, { mode: 0o700 });
    child = spawn('open', ['-a', 'Terminal', file], { detached: true, stdio: 'ignore' });
  } else child = spawn('x-terminal-emulator', ['-e', executable.file, ...executable.prefix, ...agent.login], { cwd: tmpdir(), detached: true, stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
  loginProcesses.set(normId, 'pending');
  if (process.platform !== 'darwin') child.once('close', (code) => loginProcesses.set(normId, code === 0 ? 'finished' : 'failed'));
  return `Sign-in terminal opened. ${agent.id === 'pi' ? 'Type /login in Pi, choose your provider, then exit Pi after sign-in.' : agent.id === 'antigravity' ? 'Complete sign-in in Antigravity, then exit the agent terminal.' : 'Finish the agent’s own sign-in flow.'} Connection is checked after the login process finishes; a model check may use your account quota.`;
}
