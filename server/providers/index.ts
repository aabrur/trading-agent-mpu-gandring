import type { AppConfig, ProviderName } from '../config.js';
import type { AgentId } from '../types.js';
import type { TaskKind } from '../schemas.js';
import { mockReply } from './mock.js';

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

async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs = 30000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    if (!res.ok) throw new Error(`provider HTTP ${res.status}`); // never echo the body, it can contain the key
    return await res.json();
  } finally { clearTimeout(t); }
}

export function makeCaller(cfg: AppConfig): ModelCaller {
  return async (req) => {
    const { provider, model, system, user } = req;
    switch (provider) {
      case 'mock':
        return mockReply(req);
      case 'xai':
      case 'openai':
      case 'deepseek':
      case 'openrouter': {
        const base = cfg.baseUrls[provider].replace(/\/$/, '');
        const extra: Record<string, string> = provider === 'openrouter' ? { 'HTTP-Referer': 'https://github.com/trading-agent-mpu-gandring', 'X-Title': 'Trading Agent Mpu Gandring' } : {};
        const data = await post(`${base}/chat/completions`, { authorization: `Bearer ${cfg.keys[provider]}`, ...extra }, {
          model, temperature: 0.6, max_tokens: 400,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
        });
        return String(data?.choices?.[0]?.message?.content ?? '');
      }
      case 'anthropic': {
        const data = await post('https://api.anthropic.com/v1/messages', { 'x-api-key': cfg.keys.anthropic, 'anthropic-version': '2023-06-01' }, {
          model, max_tokens: 400, system, messages: [{ role: 'user', content: user }]
        });
        return String((data?.content ?? []).map((c: any) => c?.text ?? '').join(''));
      }
      case 'gemini': {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
        const data = await post(url, { 'x-goog-api-key': cfg.keys.gemini }, {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { temperature: 0.6, maxOutputTokens: 400, responseMimeType: 'application/json' }
        });
        return String(data?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? '').join('') ?? '');
      }
      default:
        throw new Error(`unknown provider ${provider satisfies never}`);
    }
  };
}
