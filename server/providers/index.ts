import { refreshRouterReasoning, requireReasoning } from './reasoning.js';
import type { AppConfig, ProviderName } from '../config.js';
import type { AgentId } from '../types.js';
import type { TaskKind } from '../schemas.js';
import { mockReply } from './mock.js';
import { runLocalAgent, discoverLocalModels, localSelection } from './local.js';
import { publishActivity } from '../activity.js';
import { getGenerationParams } from './capabilities.js';
import { recordDiagnostic } from '../session-log.js';

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
  retryReason?: 'output_limit';
}
export type ModelCaller = (req: ModelRequest) => Promise<string>;

async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs = 60000, signal?: AbortSignal): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal });
    if (!res.ok) throw new Error(`provider HTTP ${res.status}`); // never echo the body, it can contain the key
    return await res.json();
  } catch (error) {
    if (signal?.aborted) throw new Error('Model request cancelled');
    if (ctrl.signal.aborted) throw new Error(`Model provider timed out after ${timeoutMs / 1000}s`);
    throw error;
  } finally { clearTimeout(t); }
}

function modelContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.flatMap((chunk: unknown) => chunk && typeof chunk === 'object' && 'type' in chunk && chunk.type === 'text' && 'text' in chunk && typeof chunk.text === 'string' ? [chunk.text] : []).join('');
  return '';
}

function completionText(data: { error?: unknown; choices?: Array<{ finish_reason?: string; message?: { content?: unknown } }> }): string {
  if (data.error) throw new Error('Model provider returned an error response');
  const choice = data.choices?.[0];
  if (choice?.finish_reason === 'length') throw new Error('Model provider output token limit reached before a complete answer');
  const text = modelContent(choice?.message?.content);
  if (!text.trim()) throw new Error('Model provider returned no answer text');
  return text;
}

export function makeCaller(cfg: AppConfig): ModelCaller {
  const call: ModelCaller = async (req) => {
    const { provider, model, system, user, task } = req;
    const requested = cfg.reasoning?.[req.agent] ?? cfg.defaultReasoning;
    if (requested && provider === 'local') await discoverLocalModels(localSelection(model).id);
    if (requested && provider === 'openrouter') await refreshRouterReasoning();
    const effort = requested ? requireReasoning(provider, model, requested) : undefined;
    switch (provider) {
      case 'mock':
        return mockReply(req);
      case 'local':
        return runLocalAgent(model, `${system}\n\n${user}`, req.signal, effort, { allowResearch: req.task !== 'chat' || req.context.allowResearch === true });
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
          'HTTP-Referer': cfg.openrouterHttpReferer,
          'X-Title': 'Trading Agent Mpu Gandring',
          'X-OpenRouter-Title': 'Trading Agent Mpu Gandring'
        } : {};
        const params = getGenerationParams(req.agent, req.task, provider, model);
        const isOpenAiReasoning = provider === 'openai' && /^(gpt-6|gpt-5|o1|o3|o4)/.test(model);
        const maxTokens = provider === 'openrouter' && req.attempt > 1 && req.retryReason === 'output_limit' ? Math.min(65536, params.maxTokens * 2) : params.maxTokens;
        const tokenField = isOpenAiReasoning ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens };
        const body: Record<string, unknown> = {
          model,
          ...tokenField,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
        };
        const effectiveEffort = effort ?? params.reasoningEffort;
        if (effectiveEffort) {
          if (provider === 'openrouter') body.reasoning = { effort: effectiveEffort };
          else if (provider === 'openai' || provider === 'xai' || effort && ['deepseek', 'groq', 'mistral', 'together', 'fireworks'].includes(provider)) body.reasoning_effort = effectiveEffort;
          if (provider === 'deepseek' && effort) body.thinking = {type: 'enabled'};
        }
        if (params.temperature !== undefined) body.temperature = params.temperature;
        if (params.responseFormat) {
          body.response_format = params.responseFormat;
          if (provider === 'openrouter') {
            body.provider = { ...((body.provider as Record<string, unknown>) || {}), require_parameters: true };
          }
        }

        const providerTimeoutMs = Number(process.env.PROVIDER_TIMEOUT_MS) || 180000;
        try {
          const data = await post(`${base}/chat/completions`, { authorization: `Bearer ${cfg.keys[provider]}`, ...extra }, body, providerTimeoutMs, req.signal);
          return completionText(data);
        } catch (err) {
          if (body.response_format && String((err as Error).message).includes('400')) {
            // First attempt graceful downgrade to json_object before stripping format entirely
            if (typeof body.response_format === 'object' && 'type' in body.response_format && body.response_format.type === 'json_schema') {
              body.response_format = { type: 'json_object' };
              try {
                const retryJson = await post(`${base}/chat/completions`, { authorization: `Bearer ${cfg.keys[provider]}`, ...extra }, body, providerTimeoutMs, req.signal);
                return completionText(retryJson);
              } catch (fallbackError) {
                if ((fallbackError as Error).message !== 'provider HTTP 400') throw fallbackError;
                // If json_object also rejects with 400, proceed to prompt-only fallback
              }
            }
            delete body.response_format;
            if (body.provider && typeof body.provider === 'object') {
              delete (body.provider as Record<string, unknown>).require_parameters;
            }
            const retry = await post(`${base}/chat/completions`, { authorization: `Bearer ${cfg.keys[provider]}`, ...extra }, body, providerTimeoutMs, req.signal);
            return completionText(retry);
          }
          throw err;
        }
      }
      case 'anthropic': {
        const providerTimeoutMs = Number(process.env.PROVIDER_TIMEOUT_MS) || 180000;
        const data = await post('https://api.anthropic.com/v1/messages', { 'x-api-key': cfg.keys.anthropic, 'anthropic-version': '2023-06-01' }, {
          model, ...(effort ? { output_config: { effort } } : {}), max_tokens: 20000, system, messages: [{ role: 'user', content: user }]
        }, providerTimeoutMs, req.signal);
        return String((data?.content ?? []).map((c: any) => c?.text ?? '').join(''));
      }
      case 'gemini': {
        const providerTimeoutMs = Number(process.env.PROVIDER_TIMEOUT_MS) || 180000;
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
        const data = await post(url, { 'x-goog-api-key': cfg.keys.gemini }, {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { temperature: 0.6, maxOutputTokens: 20000, responseMimeType: 'application/json' }
        }, providerTimeoutMs, req.signal);
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
      recordDiagnostic({ source: `${req.provider}:${req.model}`, category: 'PROVIDER', eventName: 'provider.error', level: 'ERROR', status: 'failed', durationMs: Date.now() - started, message: 'Model provider request failed', details: { agent: req.agent, task: req.task, attempt: req.attempt, error } });
      publishActivity({ ...entry, level: 'error', status: 'failed', text: `${req.task} model request failed: ${(error as Error).message}`, durationMs: Date.now() - started });
      throw error;
    }
  };
}
