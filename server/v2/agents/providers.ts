import { registerSecrets, safe } from '../../redact.js';
import type { RoleId } from '../contracts.js';
import { runLocalCliInference, type LocalCliInferenceOptions, type LocalCliInferenceResult } from './local.js';

export type RolePhase = 'observe' | 'challenge' | 'final';

export interface ProviderAssignment {
  provider: string;
  model: string;
  apiKey: string | null;
  baseUrl?: string;
  reasoningEffort?: string | null;
  provenOsSandbox?: boolean;
}

export interface ProviderCallRequest {
  cycleId: string;
  role: RoleId;
  phase: RolePhase;
  taskAttempt: number;
  turn: number;
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  system: string;
  user: string;
  retryReason?: 'format_repair' | 'output_limit';
  signal?: AbortSignal;
  timeoutMs?: number;
  reasoningEffort?: string | null;
  provenOsSandbox?: boolean;
}

export type ProviderCaller = (req: ProviderCallRequest) => Promise<string>;

const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  xai: 'https://api.x.ai/v1',
  deepseek: 'https://api.deepseek.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  mistral: 'https://api.mistral.ai/v1',
  together: 'https://api.together.xyz/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1'
};

function extractOpenAiContent(data: unknown): string {
  if (!data || typeof data !== 'object') {
    throw new Error('Provider returned invalid payload');
  }
  const obj = data as {
    error?: unknown;
    choices?: Array<{ finish_reason?: string; message?: { content?: unknown } }>;
  };
  if (obj.error) {
    throw new Error('Provider returned structured error');
  }
  const choice = obj.choices?.[0];
  if (choice?.finish_reason === 'length') {
    throw new Error('Provider output token limit reached');
  }
  const raw = choice?.message?.content;
  let text = '';
  if (typeof raw === 'string') {
    text = raw;
  } else if (Array.isArray(raw)) {
    text = raw
      .flatMap((part) =>
        part && typeof part === 'object' && 'text' in part && typeof (part as { text: unknown }).text === 'string'
          ? [(part as { text: string }).text]
          : []
      )
      .join('');
  }
  if (!text.trim()) {
    throw new Error('Provider returned empty output');
  }
  return text.trim();
}

export interface OfficialProviderCallerOptions {
  fetchImpl?: typeof fetch;
  localRunner?: (opts: LocalCliInferenceOptions) => Promise<LocalCliInferenceResult>;
  openrouterReferer?: string;
}

export function createOfficialProviderCaller(
  options: OfficialProviderCallerOptions = {}
): ProviderCaller {
  const fetchImpl = options.fetchImpl ?? fetch;
  const localRunner = options.localRunner ?? runLocalCliInference;

  return async (req: ProviderCallRequest): Promise<string> => {
    const provider = req.provider.trim().toLowerCase();
    if (provider === 'mock') {
      throw new Error('Mock provider is prohibited in replacement runtime');
    }

    if (req.apiKey) {
      registerSecrets([req.apiKey]);
    }

    if (provider === 'local') {
      const cliRes = await localRunner({
        agentSpec: req.model,
        prompt: `${req.system}\n\n${req.user}`,
        signal: req.signal,
        timeoutMs: req.timeoutMs ?? 120_000,
        provenOsSandbox: req.provenOsSandbox
      });
      if (!cliRes.ok) {
        throw new Error(safe(cliRes.error ?? 'Local CLI unavailable'));
      }
      return cliRes.output;
    }

    if (!req.apiKey) {
      throw new Error(`Missing API key for provider ${provider}`);
    }

    const timeoutMs = req.timeoutMs ?? 60_000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, ctrl.signal]) : ctrl.signal;

    const postJson = async (url: string, headers: Record<string, string>, body: unknown): Promise<unknown> => {
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...headers
          },
          body: JSON.stringify(body),
          signal
        });
        if (!res.ok) {
          throw new Error(`Provider ${provider} HTTP ${res.status}`);
        }
        return await res.json();
      } catch (err) {
        if (req.signal?.aborted) {
          throw new Error('Model request cancelled');
        }
        if (ctrl.signal.aborted) {
          throw new Error(`Provider ${provider} timed out after ${Math.round(timeoutMs / 1000)}s`);
        }
        throw new Error(safe(err instanceof Error ? err.message : `Provider ${provider} failed`));
      }
    };

    try {
      if (provider === 'anthropic') {
        const url = `${(req.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`;
        const data = (await postJson(
          url,
          {
            'x-api-key': req.apiKey,
            'anthropic-version': '2023-06-01'
          },
          {
            model: req.model,
            max_tokens: 8192,
            system: req.system,
            messages: [{ role: 'user', content: req.user }]
          }
        )) as { content?: Array<{ text?: string }> };
        const text = (data.content ?? []).map((c) => c.text ?? '').join('').trim();
        if (!text) throw new Error('Anthropic returned empty output');
        return text;
      }

      if (provider === 'gemini') {
        const base = (req.baseUrl ?? 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
        const url = `${base}/v1beta/models/${encodeURIComponent(req.model)}:generateContent`;
        const data = (await postJson(
          url,
          { 'x-goog-api-key': req.apiKey },
          {
            systemInstruction: { parts: [{ text: req.system }] },
            contents: [{ role: 'user', parts: [{ text: req.user }] }],
            generationConfig: {
              temperature: 0.4,
              maxOutputTokens: 8192,
              responseMimeType: 'application/json'
            }
          }
        )) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
        const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
        if (!text) throw new Error('Gemini returned empty output');
        return text;
      }

      const defaultBase = DEFAULT_BASE_URLS[provider];
      if (!defaultBase && !req.baseUrl) {
        throw new Error(`Unsupported remote provider: ${provider}`);
      }
      const base = (req.baseUrl ?? defaultBase!).replace(/\/$/, '');
      const extraHeaders: Record<string, string> =
        provider === 'openrouter'
          ? {
              'HTTP-Referer': options.openrouterReferer ?? 'https://github.com/trading-agent-mpu-gandring',
              'X-Title': 'Trading Agent Mpu Gandring'
            }
          : {};

      const isOpenAiReasoning = provider === 'openai' && /^(gpt-6|gpt-5|o1|o3|o4)/.test(req.model);
      const maxTokens = req.retryReason === 'output_limit' ? 16_384 : 8_192;
      const body: Record<string, unknown> = {
        model: req.model,
        ...(isOpenAiReasoning ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user }
        ]
      };
      if (req.reasoningEffort) {
        if (provider === 'openrouter') {
          body.reasoning = { effort: req.reasoningEffort };
        } else {
          body.reasoning_effort = req.reasoningEffort;
        }
      }

      const data = await postJson(
        `${base}/chat/completions`,
        {
          authorization: `Bearer ${req.apiKey}`,
          ...extraHeaders
        },
        body
      );
      return extractOpenAiContent(data);
    } finally {
      clearTimeout(timer);
    }
  };
}
