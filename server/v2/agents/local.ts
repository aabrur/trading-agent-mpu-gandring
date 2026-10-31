import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
  { id: 'hermes', bin: 'hermes', label: 'Hermes Agent', login: ['setup'], docs: 'https://hermes-agent.nousresearch.com', models: ['default', 'ornith/ornith-1.5-122b:free', 'anthropic/claude-sonnet-4.6', 'nous/hermes-3-llama-3.1-405b'] },
  { id: 'openclaw', bin: 'openclaw', label: 'OpenClaw', login: ['configure'], docs: 'https://docs.openclaw.ai', models: ['default', 'openai/gpt-5.5', 'anthropic/claude-sonnet-5-5'] },
  { id: 'copilot', bin: 'copilot', label: 'GitHub Copilot', login: ['login'], docs: 'https://github.com/features/copilot', models: ['default', 'auto', 'claude-3.5-sonnet', 'gpt-4o'] },
  { id: 'cursor', bin: 'cursor-agent', label: 'Cursor Agent', login: ['login'], docs: 'https://docs.cursor.com/agent', models: ['default', 'auto', 'claude-3.5-sonnet', 'gpt-5'] },
  { id: 'qwen', bin: 'qwen', label: 'Qwen Code', login: ['login'], docs: 'https://qwenlm.github.io/qwen-code', models: ['default', 'qwen-2.5-coder-32b', 'qwen-max'] },
  { id: 'opencode', bin: 'opencode', label: 'OpenCode', login: ['login'], docs: 'https://opencode.ai', models: ['default', 'anthropic/claude-sonnet-5-5', 'openai/gpt-5'] },
  { id: 'muse', bin: 'muse', label: 'Muse Code', login: ['login'], docs: 'https://dev.meta.ai', models: ['default', 'muse-spark-1.3'] }
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

function findExecutableOnPath(bin: string, env: Record<string, string>): string | null {
  const pathVal = env.PATH ?? env.Path ?? '';
  const dirs = pathVal.split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${bin}${ext}`);
      if (existsSync(candidate)) {
        return candidate;
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
  const binPath = findExecutableOnPath(def.bin, cleanEnv);
  if (!binPath) {
    return {
      ok: false,
      output: '',
      sandboxStatus: sandbox.sandboxStatus,
      error: `Local CLI ${def.label} (${def.bin}) is not installed on PATH.`
    };
  }

  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'mpu-cli-infer-'));
  const timeoutMs = options.timeoutMs ?? 120_000;

  try {
    const args: string[] = [];
    if (id === 'claude') {
      args.push('-p', options.prompt);
      if (model !== 'default') args.push('--model', model);
    } else if (id === 'codex') {
      args.push('exec', '--skip-git-repo-check', options.prompt);
      if (model !== 'default') args.push('-m', model);
    } else {
      args.push(options.prompt);
    }

    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(binPath, args, {
        cwd: tempDir,
        env: cleanEnv,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        child.kill();
        reject(new Error(`Local CLI ${id} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);

      const onAbort = () => {
        killed = true;
        child.kill();
        clearTimeout(timer);
        reject(new Error('Model request cancelled'));
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length + chunk.length <= 1_000_000) {
          stdout += chunk.toString('utf8');
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
        if (code === 0 && stdout.trim()) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`Local CLI ${id} exited with code ${code ?? 'unknown'}`));
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
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Preserve successful output even when Windows locks temporary directory briefly.
    }
  }
}
