import { z } from 'zod';
import type { ProviderName } from '../config.js';

export const REASONING_LEVELS = ['low', 'med', 'high', 'xhigh', 'max'] as const;
export const ReasoningSchema = z.enum(REASONING_LEVELS);
export type ReasoningLevel = typeof REASONING_LEVELS[number];
export const normalizeReasoning = (value: string | undefined): ReasoningLevel | undefined => value ? ReasoningSchema.parse(value === 'medium' ? 'med' : value) : undefined;
export const nativeReasoning = (value: ReasoningLevel) => value === 'med' ? 'medium' : value;
export interface ReasoningStatus {
  requested: ReasoningLevel | null;
  supported: ReasoningLevel[];
  effective: ReasoningLevel | null;
  status: 'native_default' | 'supported' | 'unsupported_or_unverified';
}
const metadata = new Map<string, ReasoningLevel[]>();
let routerRefresh: Promise<void> | null = null;
let routerAt = 0;
export async function refreshRouterReasoning(fetchImpl: typeof fetch = fetch) {
  if (Date.now() - routerAt < 300_000) return;
  if (routerRefresh) return routerRefresh;
  routerRefresh = (async () => {
    const response = await fetchImpl('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('OpenRouter reasoning metadata unavailable');
    const body = z.object({data: z.array(z.object({id: z.string(), reasoning: z.object({supported_efforts: z.array(z.string()).nullable().optional()}).optional()}))}).parse(await response.json());
    for (const model of body.data) registerReasoning('openrouter', model.id, model.reasoning?.supported_efforts === null ? [...REASONING_LEVELS] : model.reasoning?.supported_efforts ?? []);
    routerAt = Date.now();
  })();
  try { await routerRefresh; } finally { routerRefresh = null; }
}
export function registerReasoning(provider: ProviderName, model: string, levels: string[]) {
  metadata.set(`${provider}:${model}`, levels.flatMap(level => { const result = ReasoningSchema.safeParse(level === 'medium' ? 'med' : level); return result.success ? [result.data] : []; }));
}

/** Exact known families only. Missing metadata never implies reasoning support. */
export function reasoningStatus(provider: ProviderName, model: string, requested?: ReasoningLevel): ReasoningStatus {
  let supported = metadata.get(`${provider}:${model}`) ?? [];
  const claude = model.replace(/^claude:/, '').replace(/^anthropic\//, '');
  if ((provider === 'anthropic' || provider === 'local' && model.startsWith('claude:')) && /claude-(opus|sonnet)-(4[.-][678]|5(?:[.-]5)?)|claude-haiku-5[.-]5/.test(claude)) {
    supported = /4[.-]6/.test(claude) ? ['low', 'med', 'high', 'max'] : [...REASONING_LEVELS];
  }
  if (provider === 'openai' && /^(o3|o4-mini|gpt-5)(?:$|[.-])/.test(model)) supported = /gpt-5\.[234]/.test(model) ? ['low', 'med', 'high', 'xhigh'] : ['low', 'med', 'high'];
  if (provider === 'xai' && /^grok-3-mini(?:-fast)?(?:-beta)?$/.test(model)) supported = ['low', 'high'];
  if (provider === 'deepseek' && /^(deepseek-(flash|v4-(flash|pro)))$/.test(model)) supported = ['low', 'high', 'max'];
  if ((provider === 'groq' || provider === 'together') && /^openai\/gpt-oss-(20b|120b)$/.test(model)) supported = ['low', 'med', 'high'];
  if (provider === 'mistral' && model === 'zai-glm-5-3') supported = ['low', 'high', 'max'];
  if (provider === 'mistral' && model === 'mistral-large-4-0') supported = ['high'];
  return { requested: requested ?? null, supported, effective: requested && supported.includes(requested) ? requested : null,
    status: !requested ? 'native_default' : supported.includes(requested) ? 'supported' : 'unsupported_or_unverified' };
}

export function requireReasoning(provider: ProviderName, model: string, requested?: ReasoningLevel) {
  const result = reasoningStatus(provider, model, requested);
  if (result.status === 'unsupported_or_unverified') throw new Error(`Reasoning ${requested} is unsupported or unverified for ${provider}:${model}. Supported: ${result.supported.join(', ') || 'native default only'}.`);
  return result.effective ? nativeReasoning(result.effective) : undefined;
}
