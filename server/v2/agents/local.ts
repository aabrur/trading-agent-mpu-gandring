import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface LocalCliAgentSpec {
  id: string;
  bin: string;
  label: string;
  login: readonly string[];
  docs: string;
  models: readonly string[];
}

export const LOCAL_CLI_AGENTS: readonly LocalCliAgentSpec[] = [
  {
    id: 'codex',
    bin: 'codex',
    label: 'Codex',
    login: ['login'],
    docs: 'https://developers.openai.com/codex/cli',
    models: ['default', 'gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna']
  },
  {
    id: 'claude',
    bin: 'claude',
    label: 'Claude Code',
    login: ['auth', 'login'],
    docs: 'https://code.claude.com/docs/en/cli-reference',
    models: ['default', 'opus', 'sonnet', 'haiku', 'fable', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2']
  },
  {
    id: 'gemini',
    bin: 'gemini',
    label: 'Gemini CLI',
    login: ['auth', 'login'],
    docs: 'https://ai.google.dev/gemini-api/docs',
    models: ['default', 'auto', 'gemini-4-hydrogen', 'gemini-4-neon', 'gemini-4-carbon', 'gemini-3-pro-preview', 'gemini-2.5-pro']
  },
  {
    id: 'pi',
    bin: 'pi',
    label: 'Pi',
    login: [],
    docs: 'https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent',
    models: [
      'default',
      'openrouter/~anthropic/claude-opus-latest',
      'openrouter/~anthropic/claude-sonnet-latest',
      'openrouter/~anthropic/claude-fable-latest',
      'openrouter/~openai/gpt-astra-latest',
      'openrouter/~openai/gpt-sol-latest',
      'openrouter/~openai/gpt-luna-latest',
      'openrouter/~google/gemini-pro-latest',
      'openrouter/~deepseek/deepseek-pro-latest',
      'openrouter/~x-ai/grok-latest'
    ]
  },
  {
    id: 'kimi',
    bin: 'kimi',
    label: 'Kimi Code',
    login: ['login'],
    docs: 'https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html',
    models: ['default', 'kimi-k3.1-pro', 'kimi-k3', 'kimi-for-coding', 'kimi-k2.8-preview']
  },
  {
    id: 'kilo',
    bin: 'kilo',
    label: 'Kilo',
    login: ['auth', 'login'],
    docs: 'https://kilo.ai/docs/code-with-ai/platforms/cli',
    models: [
      'default',
      'kilo/~anthropic/claude-opus-latest',
      'kilo/~anthropic/claude-sonnet-latest',
      'kilo/~anthropic/claude-fable-latest',
      'kilo/~openai/gpt-sol-latest',
      'kilo/~openai/gpt-luna-latest',
      'kilo/anthropic/claude-opus-5.5',
      'kilo/anthropic/claude-sonnet-5.5',
      'kilo/anthropic/claude-fable-5.2',
      'kilo/google/gemini-4-hydrogen',
      'kilo/google/gemini-4-neon',
      'kilo/google/gemini-4-carbon',
      'kilo/openai/gpt-6.1-sol',
      'kilo/openai/gpt-6-astra',
      'kilo/openai/gpt-6-luna',
      'kilo/moonshotai/kimi-k3.1-pro'
    ]
  },
  {
    id: 'cline',
    bin: 'cline',
    label: 'Cline',
    login: ['auth'],
    docs: 'https://docs.cline.bot/cline-cli/overview',
    models: [
      'default',
      'anthropic/claude-opus-5.5',
      'anthropic/claude-sonnet-5.5',
      'anthropic/claude-fable-5.2',
      'openai/gpt-6.1-sol',
      'openai/gpt-6-luna',
      'google/gemini-4-hydrogen',
      'google/gemini-4-neon',
      'deepseek/deepseek-v4.1-flash'
    ]
  },
  {
    id: 'grok',
    bin: 'grok',
    label: 'Grok Build',
    login: ['login'],
    docs: 'https://docs.x.ai/build/cli/headless-scripting',
    models: ['default', 'grok-4.7', 'grok-4.6', 'grok-4.5']
  },
  {
    id: 'antigravity',
    bin: 'agy',
    label: 'Antigravity',
    login: [],
    docs: 'https://antigravity.google',
    models: [
      'default',
      'gemini-4-hydrogen-xhigh',
      'gemini-4-hydrogen-high',
      'gemini-4-hydrogen-medium',
      'gemini-4-hydrogen-low',
      'gemini-4-neon-xhigh',
      'gemini-4-neon-high',
      'gemini-4-neon-medium',
      'gemini-4-neon-low',
      'gemini-4-carbon-high',
      'gemini-4-carbon-medium',
      'gemini-4-carbon-low',
      'claude-opus-5-5-high',
      'claude-opus-5-5-medium',
      'claude-opus-5-5-low',
      'claude-sonnet-5-5-high',
      'claude-sonnet-5-5-medium',
      'claude-sonnet-5-5-low'
    ]
  },
  {
    id: 'hermes',
    bin: 'hermes',
    label: 'Hermes Agent',
    login: ['setup'],
    docs: 'https://hermes-agent.nousresearch.com',
    models: [
      'default',
      'nousresearch/hermes-4-405b',
      'nousresearch/hermes-4-70b',
      'anthropic/claude-opus-5.5',
      'anthropic/claude-sonnet-5.5',
      'anthropic/claude-fable-5.2',
      'openai/gpt-6-astra',
      'openai/gpt-6.1-sol',
      'openai/gpt-6-luna',
      'deepseek/deepseek-v4.1-flash'
    ]
  },
  {
    id: 'openclaw',
    bin: 'openclaw',
    label: 'OpenClaw',
    login: ['configure'],
    docs: 'https://docs.openclaw.ai',
    models: [
      'default',
      'anthropic/claude-opus-5.5',
      'anthropic/claude-sonnet-5',
      'anthropic/claude-fable-5',
      'anthropic/claude-opus-4-8',
      'openai/gpt-6.1-sol',
      'openai/gpt-6-luna',
      'openai/gpt-5.6-sol',
      'together/deepseek-ai/DeepSeek-V4-Pro'
    ]
  },
  {
    id: 'copilot',
    bin: 'copilot',
    label: 'GitHub Copilot',
    login: ['login'],
    docs: 'https://github.com/features/copilot',
    models: ['default', 'auto', 'claude-opus-5.5', 'claude-sonnet-5.5', 'claude-fable-5.2', 'claude-haiku-5.5', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.4']
  },
  {
    id: 'cursor',
    bin: 'cursor-agent',
    label: 'Cursor Agent',
    login: ['login'],
    docs: 'https://docs.cursor.com/agent',
    models: ['default', 'auto', 'composer-2.5', 'claude-opus-5.5', 'claude-sonnet-5.5', 'claude-fable-5.2', 'gpt-6.1-sol', 'gpt-5.6-sol', 'grok-4.7']
  },
  {
    id: 'qwen',
    bin: 'qwen',
    label: 'Qwen Code',
    login: ['login'],
    docs: 'https://qwenlm.github.io/qwen-code',
    models: ['default', 'qwen4-max', 'qwen3.5-plus', 'qwen3-coder-plus', 'qwen3-coder-480b-a35b-instruct', 'qwen3-coder-next']
  },
  {
    id: 'opencode',
    bin: 'opencode',
    label: 'OpenCode',
    login: ['login'],
    docs: 'https://opencode.ai',
    models: [
      'default',
      'anthropic/claude-opus-5-5',
      'anthropic/claude-sonnet-5-5',
      'anthropic/claude-fable-5-2',
      'openai/gpt-6.2-astra',
      'openai/gpt-6.1-sol',
      'openai/gpt-6-luna',
      'google/gemini-4-hydrogen',
      'google/gemini-4-neon',
      'deepseek/deepseek-v4.1-flash'
    ]
  },
  {
    id: 'muse',
    bin: 'muse',
    label: 'Muse Code',
    login: ['login'],
    docs: 'https://dev.meta.ai',
    models: ['default', 'muse-spark-1.3', 'muse-spark-1.3-contributor', 'muse-ember']
  }
];

export type SandboxStatus = 'ISOLATED_OS_SANDBOX' | 'UNSANDBOXED';

export interface LocalCliCapability {
  agentId: string;
  sandboxStatus: SandboxStatus;
  arbitraryShellAllowed: boolean;
  reason: string;
}

const EXECUTION_OR_BRIDGE_SECRET_RE =
  /^(BYBIT_|BINANCE_|OKX_|HYPERLIQUID_|ASTER_|DYDX_|PARADEX_|ORDERLY_|AGENT_EVENT_SECRET|GROKBOT_WEBHOOK_KEY|CRYPTOPANIC_|WHALE_ALERT_|CMC_|JEV_)/i;
const GENERIC_SECRET_RE = /(API_SECRET|PRIVATE_KEY|MNEMONIC|SEED_PHRASE|WEBHOOK_KEY|EVENT_SECRET)/i;

export function buildLocalCliEnv(sourceEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(sourceEnv)) {
    if (typeof val !== 'string') continue;
    if (EXECUTION_OR_BRIDGE_SECRET_RE.test(key)) continue;
    if (GENERIC_SECRET_RE.test(key)) continue;
    out[key] = val;
  }
  return out;
}

export function describeLocalCliSandbox(
  agentId: string,
  options: { provenOsSandbox?: boolean } = {}
): LocalCliCapability {
  if (options.provenOsSandbox === true) {
    return {
      agentId,
      sandboxStatus: 'ISOLATED_OS_SANDBOX',
      arbitraryShellAllowed: true,
      reason: 'Proven OS-level execution sandbox verified for CLI invocation.'
    };
  }
  return {
    agentId,
    sandboxStatus: 'UNSANDBOXED',
    arbitraryShellAllowed: false,
    reason: 'Same-user CLI process is UNSANDBOXED; autonomous arbitrary-shell execution requires proven OS isolation.'
  };
}

export function parseLocalAgentSpec(spec: string): { id: string; model: string } {
  const idx = spec.indexOf(':');
  if (idx === -1) {
    return { id: spec.trim() || 'codex', model: 'default' };
  }
  return {
    id: spec.slice(0, idx).trim() || 'codex',
    model: spec.slice(idx + 1).trim() || 'default'
  };
}

export interface LocalExecutableTarget {
  file: string;
  prefix: string[];
}

export function findExecutableOnPath(bin: string, env: Record<string, string>): string | null {
  const target = resolveLocalCliExecutable(bin, env);
  return target?.file ?? null;
}

export function resolveLocalCliExecutable(bin: string, env: Record<string, string>): LocalExecutableTarget | null {
  const pathVal = env.PATH ?? env.Path ?? '';
  const dirs = pathVal.split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir.replace(/^"|"$/g, ''), `${bin}${ext}`);
      if (existsSync(candidate)) {
        if (ext !== '.cmd') return { file: candidate, prefix: [] };
        try {
          const content = readFileSync(candidate, 'utf8');
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
        } catch {}
        return { file: candidate, prefix: [] };
      }
    }
  }
  return null;
}

export interface LocalCliInferenceOptions {
  agentSpec: string;
  prompt: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  requireArbitraryShell?: boolean;
  provenOsSandbox?: boolean;
}

export interface LocalCliInferenceResult {
  ok: boolean;
  output: string;
  sandboxStatus: SandboxStatus;
  error: string | null;
}

export function parseLocalCliReply(output: string): string {
  const texts: string[] = [];
  try {
    const obj = JSON.parse(output);
    if (obj.event === 'result' && typeof obj.result?.response === 'string') return obj.result.response.trim();
    if (typeof obj.result === 'string') return obj.result.trim();
    if (typeof obj.response === 'string') return obj.response.trim();
    if (!obj.type && !obj.event) return output.trim();
  } catch {}
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.event === 'result' && typeof obj.result?.response === 'string') return obj.result.response.trim();
      if (obj.type === 'item.completed' && obj.item?.type === 'agent_message') texts.push(obj.item.text);
      else if (obj.type === 'text' && typeof obj.part?.text === 'string') texts.push(obj.part.text);
      else if (obj.type === 'say' && obj.say === 'text' && typeof obj.text === 'string') texts.push(obj.text);
      else if (obj.type === 'run_result' && typeof obj.text === 'string') return obj.text.trim();
      else if (obj.type === 'result' && typeof obj.result === 'string') return obj.result.trim();
      else if (obj.event === 'content' && typeof obj.message?.content === 'string') texts.push(obj.message.content);
      else if (obj.type === 'message' && typeof obj.content === 'string') texts.push(obj.content);
    } catch {}
  }
  return texts.length ? texts.join('\n').trim() : output.trim();
}

class LocalCliQueue {
  private active = 0;
  private readonly waiting: Array<{ signal?: AbortSignal; run: () => void; cancel: () => void }> = [];
  constructor(private readonly maxConcurrent = 3) {}

  acquire(signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Model request cancelled'));
        return;
      }
      const entry = {
        signal,
        run: () => {
          signal?.removeEventListener('abort', entry.cancel);
          this.active++;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            this.active--;
            const next = this.waiting.shift();
            if (next) next.run();
          });
        },
        cancel: () => {
          const idx = this.waiting.indexOf(entry);
          if (idx !== -1) this.waiting.splice(idx, 1);
          signal?.removeEventListener('abort', entry.cancel);
          reject(new Error('Model request cancelled'));
        }
      };
      if (this.active < this.maxConcurrent) {
        entry.run();
      } else {
        this.waiting.push(entry);
        signal?.addEventListener('abort', entry.cancel, { once: true });
      }
    });
  }
}

const localCliQueue = new LocalCliQueue(Number(process.env.LOCAL_AGENT_MAX_CONCURRENCY) || 3);

export async function runLocalCliInference(
  options: LocalCliInferenceOptions
): Promise<LocalCliInferenceResult> {
  const { id, model } = parseLocalAgentSpec(options.agentSpec);
  const sandbox = describeLocalCliSandbox(id, { provenOsSandbox: options.provenOsSandbox });

  if (options.requireArbitraryShell && !sandbox.arbitraryShellAllowed) {
    return {
      ok: false,
      output: '',
      sandboxStatus: sandbox.sandboxStatus,
      error: sandbox.reason
    };
  }

  const def = LOCAL_CLI_AGENTS.find((a) => a.id === id);
  if (!def) {
    return {
      ok: false,
      output: '',
      sandboxStatus: sandbox.sandboxStatus,
      error: `Unknown local CLI agent: ${id}`
    };
  }

  const cleanEnv = buildLocalCliEnv(process.env);
  const execTarget = resolveLocalCliExecutable(def.bin, cleanEnv);
  if (!execTarget) {
    return {
      ok: false,
      output: '',
      sandboxStatus: sandbox.sandboxStatus,
      error: `Local CLI ${def.label} (${def.bin}) is not installed on PATH.`
    };
  }

  let releaseQueue: (() => void) | null = null;
  try {
    releaseQueue = await localCliQueue.acquire(options.signal);
  } catch (err) {
    return {
      ok: false,
      output: '',
      sandboxStatus: sandbox.sandboxStatus,
      error: err instanceof Error ? err.message : 'Local CLI queue cancelled'
    };
  }

  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'mpu-cli-infer-'));
  const timeoutMs = options.timeoutMs ?? 120_000;

  try {
    const args: string[] = [];
    let stdinInput: string | null = null;
    const usesPromptFile = ['grok', 'hermes', 'openclaw', 'muse'].includes(id);
    let promptFilePath = '';
    if (usesPromptFile) {
      promptFilePath = path.join(tempDir, 'prompt.txt');
      try {
        writeFileSync(promptFilePath, options.prompt, 'utf8');
      } catch (err) {
        return {
          ok: false,
          output: '',
          sandboxStatus: sandbox.sandboxStatus,
          error: `Failed to write prompt file: ${err instanceof Error ? err.message : String(err)}`
        };
      }
    }

    if (id === 'claude') {
      args.push(
        '-p',
        '--output-format',
        'text',
        '--disable-slash-commands',
        '--tools',
        '',
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{}}',
        '--settings',
        '{"disableAllHooks":true}',
        '--model',
        model && model !== 'default' ? model : 'sonnet'
      );
      stdinInput = options.prompt;
    } else if (id === 'codex') {
      args.push(
        'exec',
        '--skip-git-repo-check',
        '--color',
        'never',
        '--sandbox',
        'read-only',
        '--disable',
        'shell_tool',
        '--disable',
        'unified_exec',
        '-c',
        'mcp_servers={}'
      );
      if (model !== 'default') args.push('-m', model);
      args.push('-');
      stdinInput = options.prompt;
    } else if (id === 'antigravity') {
      args.push(
        '--print=',
        '--sandbox',
        '--mode',
        'plan',
        '--disable-slash-commands',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--dangerously-skip-permissions'
      );
      if (model !== 'default') args.push('--model', model);
      stdinInput = JSON.stringify({ event: 'user', message: { content: options.prompt } }) + '\n';
    } else if (id === 'gemini') {
      args.push('-p', '-');
      if (model !== 'default') args.push('--model', model);
      stdinInput = options.prompt;
    } else if (id === 'pi') {
      args.push('--print', '--mode', 'text', '--no-tools', '--no-extensions', '--no-skills', '--no-session');
      if (model !== 'default') args.push('--model', model);
      stdinInput = options.prompt;
    } else if (id === 'kimi') {
      args.push('--output-format', 'text', '-p', '-');
      if (model !== 'default') args.push('--model', model);
      stdinInput = options.prompt;
    } else if (id === 'kilo') {
      args.push('--pure', 'run', '--format', 'json');
      if (model !== 'default') args.push('--model', model);
      stdinInput = options.prompt;
    } else if (id === 'cline') {
      args.push('--json', '--plan', '--auto-approve', 'false', '--timeout', '300');
      if (model !== 'default') args.push('-m', model);
      args.push(options.prompt.slice(0, 16000));
      stdinInput = null;
    } else if (id === 'grok') {
      args.push('--prompt-file', promptFilePath, '--deny', '*', '--disable-web-search', '--permission-mode', 'dontAsk', '--output-format', 'plain');
      if (model !== 'default') args.push('--model', model);
    } else if (id === 'hermes') {
      args.push('chat', '--query-file', promptFilePath, '-Q', '--safe-mode', '-t', 'todo');
      if (model !== 'default') args.push('--model', model);
    } else if (id === 'openclaw') {
      args.push('agent', '--message-file', promptFilePath, '--local', '--json');
      if (model !== 'default') args.push('--model', model);
    } else if (id === 'copilot') {
      args.push('-p', '-', '-s');
      if (model !== 'default') args.push('--model', model);
      stdinInput = options.prompt;
    } else if (id === 'cursor') {
      args.push('-p', '-', '--mode', 'ask', '--output-format', 'json');
      if (model !== 'default') args.push('--model', model);
      stdinInput = options.prompt;
    } else if (id === 'qwen') {
      args.push('--approval-mode', 'plan', '-p', '-');
      if (model !== 'default') args.push('--model', model);
      stdinInput = options.prompt;
    } else if (id === 'opencode') {
      args.push('run', '--format', 'json');
      if (model !== 'default') args.push('--model', model);
      stdinInput = options.prompt;
    } else if (id === 'muse') {
      args.push('exec', '--prompt-file', promptFilePath);
      if (model !== 'default') args.push('--model', model);
    } else {
      stdinInput = options.prompt;
    }

    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(execTarget.file, [...execTarget.prefix, ...args], {
        cwd: tempDir,
        env: cleanEnv,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      let killed = false;

      const killProcessTree = () => {
        if (killed) return;
        killed = true;
        if (process.platform === 'win32' && child.pid) {
          try {
            const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
              stdio: 'ignore',
              windowsHide: true
            });
            killer.on('error', () => child.kill());
          } catch {
            child.kill();
          }
        } else if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        } else {
          child.kill();
        }
      };

      if (stdinInput) {
        child.stdin?.write(stdinInput);
        child.stdin?.end();
      } else {
        child.stdin?.end();
      }

      const timer = setTimeout(() => {
        killProcessTree();
        reject(new Error(`Local CLI ${id} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);

      const onAbort = () => {
        killProcessTree();
        clearTimeout(timer);
        reject(new Error('Model request cancelled'));
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length + chunk.length <= 1_000_000) {
          stdout += chunk.toString('utf8');
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < 4000) {
          stderr += chunk.toString('utf8').slice(0, 4000 - stderr.length);
        }
      });

      child.once('error', (err) => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        reject(err);
      });

      child.once('close', (code) => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        if (killed) return;
        const cleaned = parseLocalCliReply(stdout);
        if (code === 0 && cleaned) {
          resolve(cleaned);
        } else {
          const detail = stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : '';
          reject(new Error(`Local CLI ${id} exited with code ${code ?? 'unknown'}${detail}`));
        }
      });
    });

    return {
      ok: true,
      output,
      sandboxStatus: sandbox.sandboxStatus,
      error: null
    };
  } catch (err) {
    return {
      ok: false,
      output: '',
      sandboxStatus: sandbox.sandboxStatus,
      error: err instanceof Error ? err.message : 'Local CLI inference failed'
    };
  } finally {
    if (releaseQueue) releaseQueue();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Preserve successful output even when Windows locks temporary directory briefly.
    }
  }
}
