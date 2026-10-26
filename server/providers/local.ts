import { registerReasoning } from './reasoning.js';
// Native agent accounts stay in their own CLIs. The desk receives text replies through its existing schema/risk gate.
import { spawn } from 'node:child_process';
import { publishActivity } from '../activity.js';
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { AgentWorkQueue } from './work-queue.js';
import { researchArgs, researchEnvironment, researchPolicy, type ResearchPolicy } from './research-policy.js';

export const LOCAL_AGENTS = [
  { id: 'codex', bin: 'codex', label: 'Codex', login: ['login'], docs: 'https://developers.openai.com/codex/cli', models: ['default', 'gpt-6-astra', 'gpt-6.1-sol'] },
  { id: 'claude', bin: 'claude', label: 'Claude Code', login: ['auth', 'login'], docs: 'https://code.claude.com/docs/en/cli-reference', models: ['default', 'opus', 'sonnet'] },
  { id: 'pi', bin: 'pi', label: 'Pi', login: [], docs: 'https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent', models: ['default'] },
  { id: 'kimi', bin: 'kimi', label: 'Kimi Code', login: ['login'], docs: 'https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html', models: ['default'] },
  { id: 'kilo', bin: 'kilo', label: 'Kilo', login: ['auth', 'login'], docs: 'https://kilo.ai/docs/code-with-ai/platforms/cli', models: ['default'] },
  { id: 'cline', bin: 'cline', label: 'Cline', login: ['auth'], docs: 'https://docs.cline.bot/cline-cli/overview', models: ['default'] },
  { id: 'grok', bin: 'grok', label: 'Grok Build', login: ['login'], docs: 'https://docs.x.ai/build/cli/headless-scripting', models: ['default'] },
  {
    id: 'antigravity',
    bin: 'agy',
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
  },
  {
    id: 'hermes',
    bin: 'hermes',
    label: 'Hermes Agent',
    login: ['setup'],
    docs: 'https://hermes-agent.nousresearch.com',
    models: ['default', 'ornith/ornith-1.5-122b:free', 'anthropic/claude-sonnet-4.6', 'nous/hermes-3-llama-3.1-405b']
  },
  {
    id: 'openclaw',
    bin: 'openclaw',
    label: 'OpenClaw',
    login: ['configure'],
    docs: 'https://docs.openclaw.ai',
    models: ['default', 'openai/gpt-5.5', 'anthropic/claude-sonnet-5-5']
  },
  {
    id: 'copilot',
    bin: 'copilot',
    label: 'GitHub Copilot',
    login: ['login'],
    docs: 'https://github.com/features/copilot',
    models: ['default', 'auto', 'claude-3.5-sonnet', 'gpt-4o']
  },
  {
    id: 'cursor',
    bin: 'cursor-agent',
    label: 'Cursor Agent',
    login: ['login'],
    docs: 'https://docs.cursor.com/agent',
    models: ['default', 'auto', 'claude-3.5-sonnet', 'gpt-5']
  },
  {
    id: 'qwen',
    bin: 'qwen',
    label: 'Qwen Code',
    login: ['login'],
    docs: 'https://qwenlm.github.io/qwen-code',
    models: ['default', 'qwen-2.5-coder-32b', 'qwen-max']
  },
  {
    id: 'opencode',
    bin: 'opencode',
    label: 'OpenCode',
    login: ['login'],
    docs: 'https://opencode.ai',
    models: ['default', 'anthropic/claude-sonnet-5-5', 'openai/gpt-5']
  },
  {
    id: 'muse',
    bin: 'muse',
    label: 'Muse Code',
    login: ['login'],
    docs: 'https://dev.meta.ai',
    models: ['default', 'muse-spark-1.3']
  }
] as const;
export type LocalAgentId = (typeof LOCAL_AGENTS)[number]['id'];
export interface LocalModelDiscovery {
  agentId: LocalAgentId;
  installed: boolean;
  version: string | null;
  authentication: 'authenticated' | 'not_authenticated' | 'unknown';
  configuredModel: string;
  models: Array<{ id: string; provider?: string; reasoningLevels: string[]; source: 'cli' | 'metadata' | 'configured' | 'curated' }>;
  source: string;
  refreshedAt: number;
  completeness: 'partial' | 'unsupported' | 'unavailable';
  error: string | null;
}
const discoveryCache = new Map<LocalAgentId, LocalModelDiscovery>();
const discoveries = new Map<LocalAgentId, Promise<LocalModelDiscovery>>();

// Native CLI values, not a universal scale. A model can support a smaller subset.
export const LOCAL_EFFORTS: Partial<Record<LocalAgentId, readonly string[]>> = {
  codex: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  pi: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  cline: ['none', 'low', 'medium', 'high', 'xhigh'],
  kilo: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  opencode: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  grok: ['low', 'high'],
  antigravity: ['low', 'medium', 'high', 'xhigh', 'max'],
  hermes: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  copilot: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  openclaw: ['off', 'minimal', 'low', 'medium', 'high']
};

function effortArgs(id: LocalAgentId, effort?: string): string[] {
  if (!effort) return [];
  if (!LOCAL_EFFORTS[id]?.includes(effort)) throw new Error(`Unsupported native reasoning ${effort} for ${id}.`);
  if (id === 'codex') return ['-c', `model_reasoning_effort="${effort}"`];
  if (id === 'kilo' || id === 'opencode') return ['--variant', effort];
  const flag = id === 'pi' || id === 'cline' || id === 'openclaw' ? '--thinking'
    : id === 'hermes' ? '--reasoning' : id === 'copilot' || id === 'grok' ? '--reasoning-effort' : '--effort';
  return [flag, effort];
}

/** Bounded metadata commands only. Only help may read stderr; credential files are never returned. */
async function discoveryCommand(id: LocalAgentId, args: string[], timeoutMs = 10_000): Promise<string> {
  const executable = localExecutable(id);
  if (!executable) throw new Error('CLI not installed');
  return new Promise((resolve, reject) => {
    const child = spawn(executable.file, [...executable.prefix, ...args], { env: localEnvironment(process.env), cwd: tmpdir(), windowsHide: true, stdio: ['ignore', 'pipe', args.includes('--help') ? 'pipe' : 'ignore'] });
    let output = '', failed = false;
    const timer = setTimeout(() => { failed = true; child.kill(); reject(new Error('Metadata command timed out')); }, timeoutMs);
    const collect = (chunk: Buffer) => { if (output.length + chunk.length > 2_000_000) { failed = true; child.kill(); } else output += chunk.toString(); };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.once('error', () => { clearTimeout(timer); reject(new Error('Metadata command failed')); });
    child.once('close', code => { clearTimeout(timer); if (code === 0 && !failed) resolve(output); else reject(new Error('Metadata command unavailable')); });
  });
}

export async function discoverLocalModels(id: LocalAgentId, refresh = false): Promise<LocalModelDiscovery> {
  const pending = discoveries.get(id);
  if (pending) return pending;
  const result = discoverModels(id, refresh);
  discoveries.set(id, result);
  try { return await result; } finally { discoveries.delete(id); }
}

async function discoverModels(id: LocalAgentId, refresh: boolean): Promise<LocalModelDiscovery> {
  const agent = LOCAL_AGENTS.find(a => a.id === id);
  if (!agent) throw new Error('Unknown local agent');
  const cached = discoveryCache.get(id);
  if (!refresh && cached && Date.now() - cached.refreshedAt < 300_000) return cached;
  let configuredModel = localAgentSettings()[id]?.model || 'default';
  if (configuredModel === 'default' && id === 'codex') {
    try {
      const config = readFileSync(path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'config.toml'), 'utf8');
      const model = config.split(/^\[/m)[0].match(/^model\s*=\s*"([^"]+)"/m)?.[1];
      if (modelIdOk(model)) configuredModel = model;
    } catch { /* Native default remains authoritative. */ }
  }
  const result: LocalModelDiscovery = { agentId: id, installed: !!localExecutable(id), version: null, authentication: 'unknown', configuredModel,
    models: [], source: agent.docs, refreshedAt: Date.now(), completeness: 'unsupported', error: 'No verified catalog enumeration for this CLI version. Curated entries are suggestions, not account access evidence.' };
  const add = (model: LocalModelDiscovery['models'][number]) => { if (!result.models.some(m => m.id === model.id)) result.models.push(model); };
  if (result.installed) {
    try { result.version = (await discoveryCommand(id, ['--version'])).trim().split('\n')[0].slice(0, 200); } catch { /* Explicitly unknown. */ }
    if (id !== 'codex' && id !== 'kilo' && id !== 'opencode' && LOCAL_EFFORTS[id]) {
      try {
        const help = await discoveryCommand(id, id === 'hermes' ? ['chat', '--help'] : id === 'openclaw' ? ['agent', '--help'] : ['--help']);
        const flag = effortArgs(id, 'high')[0];
        const lines = help.split(/\r?\n/);
        const start = lines.findIndex(line => line.trimStart().startsWith(`${flag} `));
        const section = start < 0 ? '' : lines.slice(start).join('\n').split(/\n\s+-[a-z-]/i)[0];
        const levels = help.includes(flag) ? LOCAL_EFFORTS[id]!.filter(level => new RegExp(`\\b${level}\\b`).test(section)) : [];
        registerReasoning('local', `${id}:*`, [...levels]);
      } catch { registerReasoning('local', `${id}:*`, []); }
    }
    const auth = await localLoginStatus(id);
    result.authentication = auth.connected ? 'authenticated' : auth.state === 'signed-out' ? 'not_authenticated' : 'unknown';
    if (id === 'opencode' || id === 'kilo' || id === 'antigravity') {
      try {
        const output = await discoveryCommand(id, id === 'antigravity' ? ['models'] : ['models', '--verbose']);
        const lines = output.split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index];
          const model = line.trim().split(/\s+/)[0];
          if (!modelIdOk(model) || !(model.includes('/') || id === 'antigravity' && line.includes('\t'))) continue;
          let levels: string[] = [];
          if (id === 'antigravity') levels = [...LOCAL_EFFORTS.antigravity!];
          else if (lines[index + 1] === '{') {
            const end = lines.findIndex((entry, next) => next > index && entry === '}');
            if (end > index) {
              try {
                const metadata: { variants?: Record<string, unknown> } = JSON.parse(lines.slice(index + 1, end + 1).join('\n'));
                levels = Object.keys(metadata.variants ?? {});
              } catch { /* A model without verified variants keeps its native default. */ }
              index = end;
            }
          }
          add({ id: model, provider: model.includes('/') ? model.split('/')[0] : undefined, reasoningLevels: levels, source: 'cli' });
        }
        result.completeness = 'partial'; result.error = 'CLI catalog does not prove account entitlement or reasoning capability.';
      } catch { result.error = `Installed ${agent.label} could not enumerate models.`; result.completeness = 'unavailable'; }
    }
    if (id === 'pi') {
      try {
        const output = await discoveryCommand(id, ['--list-models']);
        for (const line of output.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.toLowerCase().startsWith('provider')) continue;
          const parts = trimmed.split(/\s+/);
          if (parts.length >= 2) {
            const provider = parts[0];
            const model = parts[1];
            if (modelIdOk(model)) {
              add({ id: `${provider}/${model}`, provider, reasoningLevels: parts[4] === 'yes' ? [...LOCAL_EFFORTS.pi!] : [], source: 'cli' });
            }
          }
        }
        result.completeness = 'partial';
        result.error = 'CLI catalog does not prove account entitlement.';
      } catch {
        result.error = 'Installed Pi could not enumerate models.';
        result.completeness = 'unavailable';
      }
    }
    if (id === 'openclaw') {
      try {
        const output = await discoveryCommand(id, ['models', 'list', '--all', '--json'], 30_000);
        const catalog: { models?: Array<{key?: unknown; tags?: string[]}> } = JSON.parse(output);
        for (const model of catalog.models ?? []) if (modelIdOk(model.key)) {
          add({id: model.key, provider: model.key.split('/')[0], reasoningLevels: [], source: 'cli'});
          if (configuredModel === 'default' && model.tags?.includes('default')) configuredModel = model.key;
        }
        result.configuredModel = configuredModel;
        result.completeness = 'partial';
        result.error = 'CLI catalog does not prove account entitlement or per-model thinking support.';
      } catch { result.error = 'Installed OpenClaw could not enumerate models.'; result.completeness = 'unavailable'; }
    }
    if (id === 'grok') {
      try {
        const output = await discoveryCommand(id, ['models']);
        if (/not authenticated/i.test(output)) {
          result.authentication = 'not_authenticated';
        } else if (/logged in/i.test(output)) {
          result.authentication = 'authenticated';
        }
        for (const line of output.split(/\r?\n/)) {
          const trimmed = line.trim();
          const match = trimmed.match(/^[*-]\s+([a-zA-Z0-9._:/+-]+)/);
          if (match && modelIdOk(match[1])) {
            add({ id: match[1], source: 'cli', reasoningLevels: [] });
          }
        }
        result.completeness = 'partial';
        result.error = 'CLI catalog does not prove account entitlement.';
      } catch {
        result.error = 'Installed Grok could not enumerate models.';
        result.completeness = 'unavailable';
      }
    }
    if (id === 'codex') {
      try {
        const raw = readFileSync(path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'models_cache.json'), 'utf8');
        if (raw.length > 2_000_000) throw new Error('Metadata too large');
        const cache: { models?: Array<{ slug?: string; visibility?: string; supported_reasoning_levels?: Array<{ effort?: string }> }> } = JSON.parse(raw);
        for (const model of cache.models ?? []) if (model.visibility === 'list' && modelIdOk(model.slug)) add({ id: model.slug, source: 'metadata', reasoningLevels: (model.supported_reasoning_levels ?? []).flatMap(level => typeof level.effort === 'string' ? [level.effort] : []) });
        result.completeness = 'partial'; result.error = 'Cached metadata does not prove current account entitlement.';
      } catch { result.error = 'Codex model metadata unavailable.'; }
    }
  } else { result.completeness = 'unavailable'; result.error = 'CLI not installed.'; }
  if (configuredModel !== 'default') add({ id: configuredModel, source: 'configured', reasoningLevels: [] });
  const hasCatalog = result.models.some(model => model.source === 'cli' || model.source === 'metadata');
  for (const model of agent.models) if (model === 'default' || !hasCatalog) add({ id: model, source: 'curated', reasoningLevels: [] });
  for (const model of result.models) {
    if (model.source === 'metadata' || model.source === 'cli') registerReasoning('local', `${id}:${model.id}`, model.reasoningLevels);
  }
  const nativeDefault = result.models.find(model => model.id === configuredModel && (model.source === 'metadata' || model.source === 'cli'));
  if (id === 'codex' || nativeDefault) registerReasoning('local', `${id}:default`, nativeDefault?.reasoningLevels ?? []);
  discoveryCache.set(id, result);
  return result;
}
const modelIdOk = (value: unknown): value is string => typeof value === 'string' && /^[~]?[a-zA-Z0-9][a-zA-Z0-9._:/+~-]{0,159}$/.test(value);

export interface AgentExtraSettings {
  model?: string;
  effort?: string;
  provider?: string;
}
export type LocalAgentSettingsMap = Partial<Record<LocalAgentId, AgentExtraSettings>>;

export function localAgentSettings(env: NodeJS.ProcessEnv = process.env): LocalAgentSettingsMap {
  const raw = env.LOCAL_AGENT_SETTINGS;
  if (!raw || typeof raw !== 'string') return {};
  try {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { parsed = JSON.parse(JSON.parse(`"${raw}"`)); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: LocalAgentSettingsMap = {};
    for (const [key, val] of Object.entries(parsed)) {
      const agent = LOCAL_AGENTS.find((a) => a.id === key);
      if (!agent || !val || typeof val !== 'object' || Array.isArray(val)) continue;
      const s = val as AgentExtraSettings;
      let valid = true;
      if (s.model !== undefined) {
        if (s.model !== 'default' && !modelIdOk(s.model)) valid = false;
      }
      if (s.effort !== undefined) {
        if (!LOCAL_EFFORTS[agent.id]?.includes(s.effort)) valid = false;
      }
      if (s.provider !== undefined) {
        if (agent.id !== 'hermes' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(s.provider)) valid = false;
      }
      if (valid && (s.model !== undefined || s.effort !== undefined || s.provider !== undefined)) {
        result[agent.id] = { ...s };
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function localAgentSettingsUpdate(id: string, updates: AgentExtraSettings, env: NodeJS.ProcessEnv = process.env): string {
  const normId = id === 'agy' ? 'antigravity' : id;
  const agent = LOCAL_AGENTS.find((a) => a.id === normId);
  if (!agent) throw new Error(`Unknown agent: ${id}`);
  if (!updates || typeof updates !== 'object') throw new Error('Invalid updates');

  if (updates.model !== undefined) {
    if (updates.model !== 'default' && !modelIdOk(updates.model)) {
      throw new Error(`Invalid model ID: ${updates.model}`);
    }
  }

  if (updates.effort !== undefined) {
    if (updates.effort && !LOCAL_EFFORTS[agent.id]?.includes(updates.effort)) throw new Error(`Unsupported native reasoning for ${agent.label}.`);
  }

  if (updates.provider !== undefined) {
    if (agent.id !== 'hermes') {
      throw new Error(`Agent ${agent.label} does not support provider override.`);
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(updates.provider)) {
      throw new Error(`Invalid provider name: ${updates.provider}`);
    }
  }

  const current = localAgentSettings(env);
  const next: LocalAgentSettingsMap = { ...current };

  const merged: AgentExtraSettings = {};
  if (updates.model && updates.model !== 'default') merged.model = updates.model;
  if (updates.effort) merged.effort = updates.effort;
  if (updates.provider) merged.provider = updates.provider;

  if (Object.keys(merged).length === 0) {
    delete next[agent.id];
  } else {
    next[agent.id] = merged;
  }

  return JSON.stringify(next);
}
/** Read model metadata only. Authentication files remain owned by the CLI. */
export function localModels(id: LocalAgentId): string[] {
  const discovered = discoveryCache.get(id);
  if (discovered) return discovered.models.map(m => m.id);
  const models: string[] = [...LOCAL_AGENTS.find((agent) => agent.id === id)!.models];
  if (id === 'codex') {
    try {
      const raw = readFileSync(path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'models_cache.json'), 'utf8');
      if (raw.length <= 2_000_000) {
        const cache: { models?: { slug?: unknown; visibility?: string }[] } = JSON.parse(raw);
        if (Array.isArray(cache.models)) for (const model of cache.models) {
          if (model.visibility === 'list' && modelIdOk(model.slug)) models.push(model.slug);
        }
      }
    } catch { /* The configured default and manual model ID remain available without a cache. */ }
  }
  return [...new Set(models)];
}
const allowedEnv = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|LANG|LC_ALL|TERM|CODEX_HOME|CLAUDE_CONFIG_DIR|PI_CODING_AGENT_DIR|KIMI_CODE_HOME|ANTIGRAVITY_HOME|GEMINI_HOME|GEMINI_API_KEY|HERMES_HOME|OPENCLAW_CONFIG_PATH|OPENCLAW_STATE_DIR|COPILOT_HOME|OPENCODE_CONFIG_CONTENT|META_API_KEY)$/i;
export const localEnvironment = (env: NodeJS.ProcessEnv) => Object.fromEntries(Object.entries(env).filter(([k]) => allowedEnv.test(k)));

/** Resolve native binaries or the JS entry in an npm shim. Never pass prompts through a shell. */
export function localExecutable(id: string, env: NodeJS.ProcessEnv = process.env): { file: string; prefix: string[] } | null {
  const normId = id === 'agy' ? 'antigravity' : id;
  const agent = LOCAL_AGENTS.find((a) => a.id === normId || a.bin === normId);
  if (!agent) return null;
  const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const candidates: string[] = [agent.bin, agent.id];
  if (normId === 'antigravity' || agent.id === 'antigravity') candidates.push('agy', 'antigravity');
  if (normId === 'cursor' || agent.id === 'cursor') candidates.push('cursor-agent', 'agent', 'cursor');
  if (normId === 'kilo' || agent.id === 'kilo') candidates.push('kilo', 'kilocode');
  if (normId === 'qwen' || agent.id === 'qwen') candidates.push('qwen', 'qwen-code');
  const unique = [...new Set(candidates)];
  for (const name of unique) {
    for (const dir of dirs) for (const ext of process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']) {
      const file = path.join(dir.replace(/^"|"$/g, ''), name + ext);
      // "agent" is also shipped by Grok. Only accept Cursor's generic alias in a Cursor directory.
      if (agent.id === 'cursor' && name === 'agent' && !/cursor/i.test(dir)) continue;
      if (!existsSync(file)) continue;
      if (ext !== '.cmd') return { file, prefix: [] };
      const content = readFileSync(file, 'utf8');
      const matches = [...content.matchAll(/"%dp0%[\\/]([^"\r\n]+)"/gi)];
      for (const m of matches) {
        const sub = m[1].trim();
        if (sub.toLowerCase().endsWith('.exe')) continue;
        const entry = path.resolve(dir, sub);
        if (existsSync(entry)) {
          if (/\.(?:c?js|mjs)$/i.test(entry) || /^#!.*node/i.test(readFileSync(entry, 'utf8').slice(0, 100))) {
            return { file: process.execPath, prefix: [entry] };
          }
        }
      }
    }
  }
  return null;
}
export function localAgentStatus() {
  return LOCAL_AGENTS.map((a) => ({
    ...a,
    effortLevels: a.id === 'codex' ? [...new Set(discoveryCache.get(a.id)?.models.flatMap(model => model.reasoningLevels) ?? [])] : LOCAL_EFFORTS[a.id] ?? [],
    models: localModels(a.id),
    discovery: discoveryCache.get(a.id) ?? null,
    installed: !!localExecutable(a.id),
    loginCommand: [a.bin, ...a.login].join(' '),
    hint: a.id === 'pi'
      ? 'Open Pi and use /login. Its configured provider and model are reused.'
      : a.id === 'antigravity'
      ? 'Run agy to connect your account. Its active models are reused.'
      : a.id === 'hermes'
      ? 'Run hermes setup or hermes auth to connect. Provider and reasoning effort are configurable.'
      : a.id === 'openclaw'
      ? 'Run openclaw configure to connect providers and channels.'
      : a.id === 'copilot'
      ? 'Run copilot login with your GitHub account.'
      : a.id === 'cursor'
      ? 'Run cursor-agent login or sign in to your Cursor account.'
      : a.id === 'qwen'
      ? 'Sign in with Qwen Code CLI.'
      : a.id === 'opencode'
      ? 'Sign in with OpenCode CLI.'
      : a.id === 'muse'
      ? 'Sign in with Meta account via muse login.'
      : 'Sign in with the agent’s own account. Then test the connection.'
  }));
}
export function localSelection(value: string) {
  const [rawId, ...parts] = value.split(':'); const id = rawId === 'agy' ? 'antigravity' : rawId; const model = parts.join(':') || 'default';
  const agent = LOCAL_AGENTS.find((a) => a.id === id);
  if (!agent || !modelIdOk(model)) throw new Error('Choose a local agent and a valid CLI model ID.');
  return { id: agent.id, model };
}
export function localArgs(id: LocalAgentId, model: string, folder: string, prompt = '', policy: ResearchPolicy = { enabled: false, mcpTools: {} }, configuredServers: string[] = [], transports: Record<string, Record<string, unknown>> = {}, extra: AgentExtraSettings = {}): { args: string[]; env: Record<string, string> } {
  let args: string[] = [], env: Record<string, string> = {};
  const effort = effortArgs(id, extra.effort);
  switch (id) {
    case 'codex': args = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--json', '--disable', 'shell_tool', '--disable', 'unified_exec', ...researchArgs(policy, configuredServers, process.env.PORT || '8787', transports), '-']; break;
    case 'claude': args = ['--print', '--safe-mode', '--disable-slash-commands', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', 'user', '--settings', '{"disableAllHooks":true}', '--no-session-persistence']; break;
    case 'pi': args = ['--print', '--mode', 'text', '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-session']; break;
    case 'kimi': args = ['--agent-file', path.join(folder, 'reasoner.md'), '--output-format', 'text', '-p', 'Respond to the input provided on stdin with JSON only.']; break;
    case 'kilo': args = ['--pure', 'run', '--format', 'json']; env = { KILO_CONFIG_CONTENT: JSON.stringify({ permission: { '*': 'deny' }, plugin: [] }) }; break;
    case 'cline': args = ['--json', '--plan', '--auto-approve', 'false', '--timeout', '110']; break;
    case 'grok': args = ['--prompt-file', path.join(folder, 'prompt.txt'), '--deny', '*', '--disable-web-search', '--permission-mode', 'dontAsk', '--output-format', 'plain']; break;
    case 'antigravity':
      args = ['--print=', '--sandbox', '--mode', 'plan', '--disable-slash-commands', '--input-format', 'stream-json', '--output-format', 'stream-json', ...effort];
      if (model !== 'default') args.push('--model', model);
      return { args, env };
    case 'hermes':
      args = ['chat', '--query-file', path.join(folder, 'prompt.txt'), '-Q', '--safe-mode', '-t', 'todo'];
      args.push(...effort);
      if (extra.provider) args.push('--provider', extra.provider);
      if (model !== 'default') args.push('--model', model);
      return { args, env };
    case 'openclaw':
      args = ['agent', '--message-file', path.join(folder, 'prompt.txt'), '--local', '--json'];
      args.push(...effort);
      if (model !== 'default') args.push('--model', model);
      return { args, env };
    case 'copilot':
      args = ['-p', '-', '-s', '--available-tools', '--disable-builtin-mcps'];
      args.push(...effort);
      if (model !== 'default') args.push('--model', model);
      return { args, env };
    case 'cursor':
      args = ['-p', '-', '--mode', 'ask', '--output-format', 'json'];
      if (model !== 'default') args.push('--model', model);
      return { args, env };
    case 'qwen':
      args = ['--approval-mode', 'plan', '-p', '-'];
      if (model !== 'default') args.push('--model', model);
      return { args, env };
    case 'opencode':
      args = ['run', '--format', 'json', ...effort];
      env = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { '*': 'deny' } }) };
      if (model !== 'default') args.push('--model', model);
      return { args, env };
    case 'muse':
      args = ['exec', '--prompt-file', path.join(folder, 'prompt.txt')];
      if (model !== 'default') args.push('--model', model);
      return { args, env };
  }
  args.push(...effort);
  if (model !== 'default') args.push('--model', model);
  return { args, env };
}
export function localReply(output: string): string {
  const texts: string[] = [];
  try {
    const obj = JSON.parse(output);
    if (obj.event === 'result' && typeof obj.result?.response === 'string') return obj.result.response.trim();
    if (typeof obj.result === 'string') return obj.result;
    if (typeof obj.response === 'string') return obj.response;
    if (!obj.type && !obj.event) return output.trim();
  } catch { /* JSON event streams are read one line at a time. */ }
  for (const line of output.split(/\r?\n/)) {
    try {
      const obj = JSON.parse(line);
      if (obj.event === 'result' && typeof obj.result?.response === 'string') return obj.result.response.trim();
      if (obj.type === 'item.completed' && obj.item?.type === 'agent_message') texts.push(obj.item.text);
      else if (obj.type === 'text' && typeof obj.part?.text === 'string') texts.push(obj.part.text);
      else if (obj.type === 'say' && obj.say === 'text' && typeof obj.text === 'string') texts.push(obj.text);
      else if (obj.type === 'run_result' && typeof obj.text === 'string') return obj.text;
      else if (obj.type === 'result' && typeof obj.result === 'string') return obj.result;
    } catch { /* Plain text replies are returned unchanged below. */ }
  }
  return texts.length ? texts.join('\n') : output.trim();
}

function processFailure(id: LocalAgentId, diagnostic: string): string {
  if (/not logged in|not authenticated|authentication required|please (?:run )?\/login|\b401\b|user not found/i.test(diagnostic)) return `${id} needs native CLI sign-in. Environment-only model tokens are not forwarded to the desk subprocess.`;
  if (/unknown (?:option|argument)|unrecognized (?:option|argument)|unexpected argument/i.test(diagnostic)) return `${id} rejected a CLI option. Refresh its installed version and model metadata in Setup.`;
  if (/unsupported.*(?:effort|thinking|reasoning)|invalid.*(?:effort|thinking|reasoning)/i.test(diagnostic)) return `${id} rejected the reasoning level for this model. Select a supported native level.`;
  return `${id} did not return a reply. Sign in and test it from Setup.`;
}

const workQueue = new AgentWorkQueue(3);
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
export async function runLocalAgent(selection: string, prompt: string, signal?: AbortSignal, reasoningEffort?: string, options: { timeoutMs?: number } = {}): Promise<string> {
  const { id, model } = localSelection(selection);
  const executable = localExecutable(id);
  if (!executable) throw new Error(`${id} is not installed on PATH. Open Setup to connect it.`);
  const timeoutMs = options.timeoutMs ?? 120_000;
  const deadline = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let release: () => void;
  try { release = await workQueue.acquire(requestSignal); }
  catch (error) {
    if (deadline.aborted && !signal?.aborted) throw new Error(`${id} timed out waiting for a model process slot.`);
    throw error;
  }
  let folder = '';
  const started = Date.now();
  publishActivity({ kind: 'process', source: id, level: 'info', text: `${id} model process started`, status: 'started' });
  try {
    folder = mkdtempSync(path.join(tmpdir(), 'mpu-agent-'));
    writeFileSync(path.join(folder, 'prompt.txt'), prompt, { mode: 0o600 });
    writeFileSync(path.join(folder, 'reasoner.md'), '---\nname: desk-reasoner\ndescription: Return a structured trading desk opinion\ntools: []\nsubagents: []\n---\nUse only the supplied facts. Return JSON only.\n', { mode: 0o600 });
    const policy = id === 'codex' ? researchPolicy() : { enabled: false, mcpTools: {} };
    const inventory = policy.enabled ? await loadMcpInventory() : [];
    const transports = Object.fromEntries(inventory.map(server => [server.name, server.transport]));
    const extra = { ...(localAgentSettings(process.env)[id] || {}), ...(reasoningEffort ? { effort: reasoningEffort } : {}) };
    const effectiveModel = model === 'default' && extra.model && extra.model !== 'default'
      ? extra.model
      : model;
    const plan = localArgs(id, effectiveModel, folder, prompt, policy, inventory.map(server => server.name), transports, extra);
    Object.assign(plan.env, researchEnvironment(policy, transports, process.env));
    const reply = await new Promise<string>((resolve, reject) => {
      const child = spawn(executable.file, [...executable.prefix, ...plan.args], { cwd: folder, env: { ...localEnvironment(process.env), ...plan.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
      let output = '', diagnostic = '', eventBuffer = '', size = 0, stopped = false, failure = '';
      const stop = () => {
        if (stopped) return; stopped = true;
        if (process.platform === 'win32' && child.pid) { const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); killer.on('error', () => child.kill()); }
        else if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      };
      const timer = setTimeout(() => { failure = `${id} timed out. Check its sign-in and permission settings in Setup.`; stop(); }, timeoutMs);
      const abort = () => { failure = signal?.aborted ? 'Model request cancelled' : `${id} timed out after ${timeoutMs / 1000}s. Check its sign-in and model settings in Setup.`; stop(); };
      requestSignal.addEventListener('abort', abort, { once: true });
      if (requestSignal.aborted) abort();
      const collect = (chunk: Buffer, keep: boolean) => { size += chunk.length; if (size > 1_000_000) { failure = `${id} returned too much output.`; stop(); } else if (keep) {
        const text = chunk.toString(); output += text; eventBuffer += text;
        const lines = eventBuffer.split('\n'); eventBuffer = lines.pop() || '';
        for (const line of lines) recordResearchActivity(line);
      } };
      child.stdout.on('data', (v: Buffer) => collect(v, true)); child.stderr.on('data', (v: Buffer) => { if (diagnostic.length < 4000) diagnostic += v.toString().slice(0, 4000 - diagnostic.length); collect(v, false); });
      child.stdin.on('error', () => {});
      if (id === 'antigravity') {
        child.stdin.end(JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n');
      } else {
        child.stdin.end(prompt);
      }
      child.on('error', () => { clearTimeout(timer); requestSignal.removeEventListener('abort', abort); reject(new Error(`${id} could not start. Check its installation.`)); });
      child.on('close', (code) => { clearTimeout(timer); requestSignal.removeEventListener('abort', abort); recordResearchActivity(eventBuffer); if (stopped || code !== 0) reject(new Error(failure || processFailure(id, `${diagnostic}\n${output}`))); else resolve(localReply(output)); });
    });
    publishActivity({ kind: 'process', source: id, level: 'info', status: 'completed', text: `${id} model process completed`, durationMs: Date.now() - started });
    return reply;
  } catch (error) {
    publishActivity({ kind: 'process', source: id, level: 'error', status: 'failed', text: `${id} process failed: ${(error as Error).message}`, durationMs: Date.now() - started });
    throw error;
  } finally {
    release();
    // Native CLIs can retain the working directory briefly after returning a reply on Windows.
    if (folder) void rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {
      publishActivity({ kind: 'process', source: id, level: 'warn', status: 'cleanup_pending', text: `${id} temporary directory is still in use; model result preserved.` });
    });
  }
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

interface LoginProcessRecord {
  state: 'pending' | 'finished' | 'failed';
  startedAt: number;
  dir?: string;
  exitFile?: string;
}

const loginProcesses = new Map<string, LoginProcessRecord>();
const connectionChecks = new Map<string, { at: number; result: Promise<{ connected: boolean; state: string }> }>();

/** Ask the CLI for authentication status without reading or returning credentials. */
export async function localLoginStatus(id: string, verify = false) {
  id = id === 'agy' ? 'antigravity' : id;
  const executable = localExecutable(id);
  if (!executable) return { connected: false, state: 'missing' };

  const record = loginProcesses.get(id);
  const recordState = record?.state;
  const now = Date.now();
  const isPending = record?.state === 'pending' && now - record.startedAt < 300_000;
  const isRecentFailure = record?.state === 'failed' && now - record.startedAt < 15_000;

  // If a login process is actively pending in an open terminal, it is not connected yet
  if (isPending) {
    return { connected: false, state: 'pending' };
  }
  // A fresh explicit failure from a closed terminal is honored immediately without hanging test mocks
  if (isRecentFailure) {
    return { connected: false, state: 'failed' };
  }

  if (id === 'codex' || id === 'claude') {
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

    if (connected) {
      loginProcesses.delete(id);
      return { connected: true, state: 'connected' };
    }
    return { connected: false, state: recordState === 'failed' ? 'failed' : 'signed-out' };
  }

  if (!verify) {
    return { connected: false, state: recordState || 'unknown' };
  }

  const previous = connectionChecks.get(id);
  if (previous && Date.now() - previous.at < 15_000) return previous.result;

  const result = (async () => {
    try {
      const reply = await runLocalAgent(`${id}:default`, 'Reply with exactly this JSON object: {"reply":"connected"}. Use no tools.');
      const connected = JSON.parse(reply).reply === 'connected';
      if (connected) {
        loginProcesses.delete(id);
        return { connected: true, state: 'connected' };
      }
      return { connected: false, state: recordState === 'failed' ? 'failed' : 'signed-out' };
    } catch {
      return { connected: false, state: recordState === 'failed' ? 'failed' : 'signed-out' };
    }
  })();

  const check = { at: Number.POSITIVE_INFINITY, result };
  connectionChecks.set(id, check);
  void result.finally(() => { check.at = Date.now(); });
  return result;
}

/** Only a fixed, locally discovered login command can open an interactive terminal. No tokens are read or returned. */
export async function openAgentLogin(id: string) {
  const normId = id === 'agy' ? 'antigravity' : id;
  const agent = LOCAL_AGENTS.find((a) => a.id === normId);
  const executable = localExecutable(normId);
  if (!agent || !executable) throw new Error('Install the agent on PATH first.');
  connectionChecks.delete(normId);

  const existing = loginProcesses.get(normId);
  if (existing?.state === 'pending' && Date.now() - existing.startedAt < 300_000) {
    return 'Sign-in is already open. Complete it in the browser or terminal.';
  }

  let child: ReturnType<typeof spawn>;
  let dir = '';
  let exitFile = '';

  if (process.platform === 'win32') {
    dir = mkdtempSync(path.join(tmpdir(), 'mpu-login-win-'));
    const scriptPath = path.join(dir, 'sign-in.cmd');
    exitFile = path.join(dir, 'exitcode.txt');
    const quoteWin = (s: string) => (s.includes(' ') || s.includes('"')) ? `"${s.replace(/"/g, '""')}"` : s;
    const fullCmd = [executable.file, ...executable.prefix, ...agent.login].map(quoteWin).join(' ');
    const batchContent = [
      '@echo off',
      'chcp 65001 >nul',
      `title Mpu Gandring - Sign in ${agent.label}`,
      'echo ========================================================',
      `echo  Trading Agent Mpu Gandring - Sign in ${agent.label}`,
      'echo ========================================================',
      'echo.',
      fullCmd,
      'set EXIT_CODE=%ERRORLEVEL%',
      `echo %EXIT_CODE% > "${exitFile}"`,
      'echo.',
      'if %EXIT_CODE% equ 0 (',
      '  echo Sign-in command completed successfully.',
      ') else (',
      '  echo Sign-in exited with code %EXIT_CODE%.',
      ')',
      'echo You can close this window now.',
      'pause',
      'exit /b %EXIT_CODE%'
    ].join('\r\n') + '\r\n';
    writeFileSync(scriptPath, batchContent, { mode: 0o700, encoding: 'utf8' });

    child = spawn(process.env.ComSpec || 'cmd.exe', ['/c', 'start', `Sign-in - ${agent.label}`, process.env.ComSpec || 'cmd.exe', '/c', scriptPath], {
      cwd: dir,
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
  } else if (process.platform === 'darwin') {
    dir = mkdtempSync(path.join(tmpdir(), 'mpu-login-'));
    const file = path.join(dir, 'sign-in.command');
    exitFile = path.join(dir, 'exitcode.txt');
    const quote = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
    const fullCmd = [executable.file, ...executable.prefix, ...agent.login].map(quote).join(' ');
    writeFileSync(file, `#!/bin/sh\n${fullCmd}\nEXIT_CODE=$?\necho $EXIT_CODE > "${exitFile}"\nexit $EXIT_CODE\n`, { mode: 0o700 });
    child = spawn('open', ['-a', 'Terminal', file], { detached: true, stdio: 'ignore' });
  } else {
    child = spawn('x-terminal-emulator', ['-e', executable.file, ...executable.prefix, ...agent.login], { cwd: tmpdir(), detached: true, stdio: 'ignore' });
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    child.once('spawn', () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    child.once('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.once('close', (code) => {
      if (!settled) {
        settled = true;
        if (code !== 0) {
          reject(new Error(`Login launcher exited with code ${code}. Check CLI installation.`));
        } else {
          resolve();
        }
      }
    });
  });

  child.unref();

  loginProcesses.set(normId, {
    state: 'pending',
    startedAt: Date.now(),
    dir,
    exitFile
  });

  child.once('close', (code) => {
    loginProcesses.set(normId, {
      state: code === 0 ? 'finished' : 'failed',
      startedAt: Date.now(),
      dir,
      exitFile
    });
  });

  return `Sign-in terminal opened. ${agent.id === 'pi' ? 'Type /login in Pi, choose your provider, then exit Pi after sign-in.' : agent.id === 'antigravity' ? 'Complete sign-in in Antigravity, then exit the agent terminal.' : 'Finish the agent’s own sign-in flow.'} Connection is checked after the login process finishes; a model check may use your account quota.`;
}
