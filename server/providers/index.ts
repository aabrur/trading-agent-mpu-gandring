import type { AppConfig, ProviderName } from '../config.js';
import type { AgentId } from '../types.js';
import type { TaskKind } from '../schemas.js';
import { mockReply } from './mock.js';
import { runLocalAgent } from './local.js';
import { publishActivity } from '../activity.js';
import { getGenerationParams } from './capabilities.js';

export interface ModelRequest {
  signal?: AbortSignal;
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

async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs = 60000, signal?: AbortSignal): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal });
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
        return runLocalAgent(model, `${system}\n\n${user}`, req.signal);
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
        const params = getGenerationParams(req.agent, req.task, provider, model);
        const isOpenAiReasoning = provider === 'openai' && /^(gpt-6|gpt-5|o1|o3|o4)/.test(model);
        const tokenField = isOpenAiReasoning ? { max_completion_tokens: params.maxTokens } : { max_tokens: params.maxTokens };
        const body: Record<string, unknown> = {
          model,
          ...tokenField,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
        };
        if (params.reasoningEffort) body.reasoning_effort = params.reasoningEffort;
        if (params.temperature !== undefined) body.temperature = params.temperature;
        if (params.responseFormat) body.response_format = params.responseFormat;

        try {
          const data = await post(`${base}/chat/completions`, { authorization: `Bearer ${cfg.keys[provider]}`, ...extra }, body, 60000, req.signal);
          return String(data?.choices?.[0]?.message?.content ?? '');
        } catch (err) {
          if (body.response_format && String((err as Error).message).includes('400')) {
            delete body.response_format;
            const retry = await post(`${base}/chat/completions`, { authorization: `Bearer ${cfg.keys[provider]}`, ...extra }, body, 60000, req.signal);
            return String(retry?.choices?.[0]?.message?.content ?? '');
          }
          throw err;
        }
      }
      case 'anthropic': {
        const data = await post('https://api.anthropic.com/v1/messages', { 'x-api-key': cfg.keys.anthropic, 'anthropic-version': '2023-06-01' }, {
          model, max_tokens: task === 'chat' ? 8192 : 1500, system, messages: [{ role: 'user', content: user }]
        }, 60000, req.signal);
        return String((data?.content ?? []).map((c: any) => c?.text ?? '').join(''));
      }
      case 'gemini': {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
        const data = await post(url, { 'x-goog-api-key': cfg.keys.gemini }, {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { temperature: 0.6, maxOutputTokens: task === 'chat' ? 8192 : 1500, responseMimeType: 'application/json' }
        }, 60000, req.signal);
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
