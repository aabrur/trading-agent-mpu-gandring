import type { AppConfig, ProviderName } from '../config.js';
import type { AgentId } from '../types.js';
import type { TaskKind } from '../schemas.js';
import { mockReply } from './mock.js';
import { runLocalAgent } from './local.js';
import { publishActivity } from '../activity.js';

export interface ModelRequest {
  agent: AgentId;
  task: TaskKind;
  provider: ProviderName;
  model: string;
  system: string;
  user: string;
  context: Record<string, unknown>; // structured facts, used by the mock provider
  attempt: number;
}
export type ModelCaller = (req: ModelRequest) => Promise<string>;

async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs = 60000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    if (!res.ok) throw new Error(`provider HTTP ${res.status}`); // never echo the body, it can contain the key
    return await res.json();
  } finally { clearTimeout(t); }
}

export function makeCaller(cfg: AppConfig): ModelCaller {
  const call: ModelCaller = async (req) => {
    const { provider, model, system, user, task } = req;
    switch (provider) {
      case 'mock':
        return mockReply(req);
      case 'local':
        return runLocalAgent(model, `${system}\n\n${user}`);
      case 'xai':
      case 'openai':
      case 'deepseek':
      case 'openrouter':
      case 'groq':
      case 'mistral':
      case 'together':
      case 'fireworks': {
        const base = cfg.baseUrls[provider].replace(/\/$/, '');
        const extra: Record<string, string> = provider === 'openrouter' ? {
          'HTTP-Referer': 'https://github.com/aabrur/trading-agent-mpu-gandring',
          'X-Title': 'Trading Agent Mpu Gandring',
          'X-OpenRouter-Title': 'Trading Agent Mpu Gandring'
        } : {};
        // Reasoning models on OpenAI reject temperature and use the completion-token limit.
        const maxTokens = task === 'chat' ? 8192 : 2048;
        const generation = provider === 'openai' && /^(gpt-6|gpt-5|o1|o3|o4)/.test(model) ? { max_completion_tokens: maxTokens, reasoning_effort: 'low' } : { temperature: 0.6, max_tokens: maxTokens };
        const data = await post(`${base}/chat/completions`, { authorization: `Bearer ${cfg.keys[provider]}`, ...extra }, {
          model, ...generation,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
        });
        return String(data?.choices?.[0]?.message?.content ?? '');
      }
      case 'anthropic': {
        const data = await post('https://api.anthropic.com/v1/messages', { 'x-api-key': cfg.keys.anthropic, 'anthropic-version': '2023-06-01' }, {
          model, max_tokens: task === 'chat' ? 8192 : 1500, system, messages: [{ role: 'user', content: user }]
        });
        return String((data?.content ?? []).map((c: any) => c?.text ?? '').join(''));
      }
      case 'gemini': {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
        const data = await post(url, { 'x-goog-api-key': cfg.keys.gemini }, {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { temperature: 0.6, maxOutputTokens: task === 'chat' ? 8192 : 1500, responseMimeType: 'application/json' }
        });
        return String(data?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? '').join('') ?? '');
      }
      default:
        throw new Error(`unknown provider ${provider satisfies never}`);
    }
  };
  return async (req) => {
    const started = Date.now();
    const entry = { kind: 'tool' as const, source: `${req.provider}:${req.model}`, agent: req.agent };
    publishActivity({ ...entry, level: 'info', status: 'started', text: `${req.task} model request · attempt ${req.attempt}` });
    try {
      const reply = await call(req);
      publishActivity({ ...entry, level: 'info', status: 'completed', text: `${req.task} model request completed`, durationMs: Date.now() - started });
      return reply;
    } catch (error) {
      publishActivity({ ...entry, level: 'error', status: 'failed', text: `${req.task} model request failed: ${(error as Error).message}`, durationMs: Date.now() - started });
      throw error;
    }
  };
}
