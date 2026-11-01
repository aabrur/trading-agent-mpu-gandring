import { API_PROVIDERS, type ApiProviderId } from './schema.js';
import { LOCAL_CLI_AGENTS } from '../agents/local.js';

export const MODEL_CATALOG_DATE = '2026-11-01';
export const USAGE_SOURCE = { url: 'https://openrouter.ai/rankings', asOf: '2026-11-01', period: '7 days' };

export const MODEL_KEY_ENV: Record<ApiProviderId, string> = {
  xai: 'XAI_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  together: 'TOGETHER_API_KEY',
  fireworks: 'FIREWORKS_API_KEY'
};

export const MODEL_SOURCES: Record<string, string> = {
  mock: 'Built-in Demo',
  local: 'Local CLI Tools',
  xai: 'xAI API',
  openai: 'OpenAI API',
  anthropic: 'Anthropic API',
  gemini: 'Google Gemini API',
  deepseek: 'DeepSeek API',
  openrouter: 'OpenRouter Aggregator',
  groq: 'Groq Cloud API',
  mistral: 'Mistral AI API',
  together: 'Together AI API',
  fireworks: 'Fireworks AI API'
};

export interface ModelChoice {
  id: string;
  label: string;
  tags: string[];
  reasoningLevels?: string[];
  source?: 'verified_api' | 'provider_documented' | 'static_fallback' | 'manual';
  available?: boolean | null;
  usable?: boolean | null;
}

const m = (id: string, label: string, tags: string[] = [], reasoningLevels?: string[]): ModelChoice => ({
  id,
  label,
  tags,
  reasoningLevels,
  source: 'provider_documented',
  available: true,
  usable: true
});

/**
 * Verified documented models per provider.
 * Does not invent placeholders or fabricate names to reach arbitrary counts.
 * Up to 25 verified real models are provided when available.
 */
export const MODEL_CHOICES: Record<string, ModelChoice[]> = {
  mock: [
    m('mock-desk-v1', 'Offline demo', ['offline', 'free'])
  ],
  local: LOCAL_CLI_AGENTS.flatMap((a) =>
    a.models.map((model) => ({
      id: `${a.id}:${model}`,
      label: `${a.label}: ${model === 'default' ? 'configured model' : model}`,
      tags: ['installed account required'],
      source: 'static_fallback' as const,
      available: true,
      usable: true
    }))
  ),
  xai: [
    m('grok-4.7', 'Grok 4.7', ['frontier']),
    m('grok-4.6', 'Grok 4.6', ['frontier']),
    m('grok-4.5', 'Grok 4.5', ['frontier']),
    m('grok-4.5-mini', 'Grok 4.5 Mini', ['fast']),
    m('grok-2-latest', 'Grok 2 Latest', ['general', 'reasoning']),
    m('grok-2', 'Grok 2', ['general']),
    m('grok-2-mini', 'Grok 2 Mini', ['fast', 'compact']),
    m('grok-beta', 'Grok Beta', ['preview']),
    m('grok-vision-beta', 'Grok Vision Beta', ['multimodal'])
  ],
  openai: [
    m('gpt-6-astra', 'GPT-6 Astra', ['frontier']),
    m('gpt-6.1-sol', 'GPT-6.1 Sol', ['frontier', 'token-usage #18']),
    m('gpt-6-luna', 'GPT-6 Luna', ['frontier', 'token-usage #6']),
    m('gpt-6-mini', 'GPT-6 Mini', ['fast']),
    m('gpt-5.6-luna', 'GPT-5.6 Luna', ['token-usage #20']),
    m('gpt-5.5', 'GPT-5.5', ['frontier']),
    m('gpt-4o', 'GPT-4o', ['flagship', 'multimodal']),
    m('gpt-4o-mini', 'GPT-4o Mini', ['fast', 'compact']),
    m('o3-mini', 'o3-mini', ['reasoning'], ['low', 'medium', 'high']),
    m('o1', 'o1', ['deep-reasoning']),
    m('o1-mini', 'o1-mini', ['fast-reasoning']),
    m('chatgpt-4o-latest', 'ChatGPT-4o Latest', ['dynamic'])
  ],
  anthropic: [
    m('claude-opus-5-5', 'Claude Opus 5.5', ['frontier', 'token-usage #8']),
    m('claude-sonnet-5-5', 'Claude Sonnet 5.5', ['frontier', 'token-usage #19']),
    m('claude-haiku-5-5', 'Claude Haiku 5.5', ['fast']),
    m('claude-fable-5-1', 'Claude Fable 5.1', ['frontier']),
    m('claude-3-7-sonnet-latest', 'Claude 3.7 Sonnet', ['flagship', 'hybrid-thinking']),
    m('claude-3-5-sonnet-latest', 'Claude 3.5 Sonnet', ['general', 'coding']),
    m('claude-3-5-haiku-latest', 'Claude 3.5 Haiku', ['fast']),
    m('claude-3-opus-latest', 'Claude 3 Opus', ['deep-reasoning'])
  ],
  gemini: [
    m('gemini-4-argon', 'Gemini 4 Argon', ['frontier']),
    m('gemini-4-pro', 'Gemini 4 Pro', ['frontier']),
    m('gemini-4-flash', 'Gemini 4 Flash', ['fast']),
    m('gemini-4-flash-lite', 'Gemini 4 Flash-Lite', ['free tier']),
    m('gemini-2.5-pro', 'Gemini 2.5 Pro', ['deep-reasoning', 'multimodal']),
    m('gemini-2.5-flash', 'Gemini 2.5 Flash', ['fast', 'multimodal']),
    m('gemini-2.0-flash', 'Gemini 2.0 Flash', ['frontier', 'low-latency']),
    m('gemini-1.5-pro', 'Gemini 1.5 Pro', ['long-context'])
  ],
  deepseek: [
    m('deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', ['token-usage #1', 'fast']),
    m('deepseek-v4.1-flash-1017', 'DeepSeek V4.1 Flash 1017', ['token-usage #2', 'frontier-snapshot']),
    m('deepseek-v4-flash-0731', 'DeepSeek V4 Flash 0731', ['token-usage #11']),
    m('deepseek-v4-flash-0423', 'DeepSeek V4 Flash 0423', ['token-usage #15']),
    m('deepseek-chat', 'DeepSeek Chat', ['general', 'coding']),
    m('deepseek-reasoner', 'DeepSeek Reasoner', ['reasoning', 'math'])
  ],
  openrouter: [
    // 1. Top Token Usage (openrouter.ai/rankings live snapshot)
    m('deepseek/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash (OpenRouter)', ['top-token-usage #1', '116T tokens', 'fast']),
    m('deepseek/deepseek-v4.1-flash-1017', 'DeepSeek V4.1 Flash 1017 (OpenRouter)', ['top-token-usage #2', '79.4T tokens', 'frontier snapshot']),
    m('z-ai/glm-5.3-flash', 'GLM 5.3 Flash (OpenRouter)', ['top-token-usage #3', '55.3T tokens', 'fast']),
    m('tencent/hy4-preview', 'Hy4 preview (OpenRouter)', ['top-token-usage #4', '35.5T tokens', 'preview']),
    m('xiaomi/mimo-v2.6-flash', 'MiMo-V2.6-Flash (OpenRouter)', ['top-token-usage #5', '34.1T tokens', 'fast']),
    m('openai/gpt-6-luna', 'GPT-6 Luna (OpenRouter)', ['top-token-usage #6', '32.8T tokens', 'frontier']),
    m('stepfun/step-5-preview', 'Step 5 Preview (OpenRouter)', ['top-token-usage #7', '29.4T tokens', 'preview']),
    m('anthropic/claude-opus-5.5', 'Claude Opus 5.5 (OpenRouter)', ['top-token-usage #8', '26.6T tokens', 'frontier flagship']),
    m('stealth/space-bunny-alpha', 'Space Bunny Alpha (OpenRouter)', ['top-token-usage #9', '22.8T tokens', 'alpha']),
    m('nvidia/nemotron-3-ultra-550b-a55b:free', 'Nemotron 3 Ultra Free (OpenRouter)', ['top-token-usage #10', '22.8T tokens', 'free tier']),
    m('deepseek/deepseek-v4-flash-0731', 'DeepSeek V4 Flash 0731 (OpenRouter)', ['top-token-usage #11', '19.3T tokens']),
    m('z-ai/glm-5.3', 'GLM 5.3 (OpenRouter)', ['top-token-usage #12', '19.1T tokens', 'general']),
    m('minimax/minimax-m3.1-flash:free', 'MiniMax M3.1 Flash Free (OpenRouter)', ['top-token-usage #13', '13.7T tokens', 'free tier']),
    m('typesafe/jev-1.13', 'Jev 1.13 (OpenRouter)', ['top-token-usage #14', '13.4T tokens', 'jev']),
    m('deepseek/deepseek-v4-flash-0423', 'DeepSeek V4 Flash 0423 (OpenRouter)', ['top-token-usage #15', '12.6T tokens']),
    m('tencent/hy3', 'Hy3 (OpenRouter)', ['top-token-usage #16', '12T tokens']),
    m('meta/muse-spark-1.3-contributor', 'Muse Spark 1.3 Contributor (OpenRouter)', ['top-token-usage #17', '11.1T tokens', 'muse']),
    m('openai/gpt-6.1-sol', 'GPT-6.1 Sol (OpenRouter)', ['top-token-usage #18', '10.6T tokens', 'frontier flagship']),
    m('anthropic/claude-sonnet-5.5', 'Claude Sonnet 5.5 (OpenRouter)', ['top-token-usage #19', '10.1T tokens', 'frontier']),
    m('openai/gpt-5.6-luna', 'GPT-5.6 Luna (OpenRouter)', ['top-token-usage #20', '9.76T tokens']),

    // 2. Additional Frontier Flagships & Core Tiers
    m('anthropic/claude-haiku-5.5', 'Claude Haiku 5.5 (OpenRouter)', ['frontier', 'fast']),
    m('openai/gpt-6-astra', 'GPT-6 Astra (OpenRouter)', ['frontier']),
    m('google/gemini-4-argon', 'Gemini 4 Argon (OpenRouter)', ['frontier']),
    m('x-ai/grok-4.7', 'Grok 4.7 (OpenRouter)', ['frontier']),
    m('qwen/qwen-3.5-max', 'Qwen 3.5 Max (OpenRouter)', ['frontier', 'open weights'])
  ],
  groq: [
    m('llama-3.3-70b-versatile', 'Llama 3.3 70B Versatile', ['groq-lpu', 'fast']),
    m('llama-3.1-8b-instant', 'Llama 3.1 8B Instant', ['ultra-low-latency']),
    m('deepseek-r1-distill-llama-70b', 'DeepSeek R1 Distill 70B', ['reasoning']),
    m('mixtral-8x7b-32768', 'Mixtral 8x7B 32k', ['fast']),
    m('gemma2-9b-it', 'Gemma 2 9B IT', ['compact'])
  ],
  mistral: [
    m('mistral-large-latest', 'Mistral Large Latest', ['flagship']),
    m('mistral-medium-latest', 'Mistral Medium Latest', ['balanced']),
    m('mistral-small-latest', 'Mistral Small Latest', ['fast']),
    m('codestral-latest', 'Codestral Latest', ['coding']),
    m('ministral-8b-latest', 'Ministral 8B', ['edge', 'fast']),
    m('ministral-3b-latest', 'Ministral 3B', ['ultra-compact']),
    m('open-mistral-nemo', 'Mistral Nemo', ['open-weights'])
  ],
  together: [
    m('meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Llama 3.3 70B Turbo', ['fast']),
    m('meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo', 'Llama 3.1 70B Turbo', ['balanced']),
    m('meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', 'Llama 3.1 8B Turbo', ['ultra-fast']),
    m('deepseek-ai/DeepSeek-R1', 'DeepSeek R1 (Together)', ['reasoning']),
    m('deepseek-ai/DeepSeek-V3', 'DeepSeek V3 (Together)', ['general']),
    m('Qwen/Qwen2.5-72B-Instruct-Turbo', 'Qwen 2.5 72B Turbo', ['coding'])
  ],
  fireworks: [
    m('accounts/fireworks/models/deepseek-r1', 'DeepSeek R1 (Fireworks)', ['reasoning']),
    m('accounts/fireworks/models/deepseek-v3', 'DeepSeek V3 (Fireworks)', ['general']),
    m('accounts/fireworks/models/llama-v3p3-70b-instruct', 'Llama 3.3 70B (Fireworks)', ['fast']),
    m('accounts/fireworks/models/llama-v3p1-70b-instruct', 'Llama 3.1 70B (Fireworks)', ['balanced']),
    m('accounts/fireworks/models/llama-v3p1-8b-instruct', 'Llama 3.1 8B (Fireworks)', ['ultra-fast']),
    m('accounts/fireworks/models/qwen2p5-72b-instruct', 'Qwen 2.5 72B (Fireworks)', ['coding'])
  ]
};

/**
 * Fetch live model listing from provider API if an API key is available.
 * Returns verified models or falls back to documented models.
 */
export async function fetchLiveProviderModels(
  provider: ApiProviderId,
  apiKey?: string
): Promise<{ models: ModelChoice[]; source: 'verified_api' | 'provider_documented' }> {
  if (!apiKey || !apiKey.trim()) {
    return {
      models: MODEL_CHOICES[provider] ?? [],
      source: 'provider_documented'
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    let endpoint: string | null = null;
    let headers: Record<string, string> = { 'Content-Type': 'application/json' };

    switch (provider) {
      case 'openai':
        endpoint = 'https://api.openai.com/v1/models';
        headers['Authorization'] = `Bearer ${apiKey.trim()}`;
        break;
      case 'anthropic':
        endpoint = 'https://api.anthropic.com/v1/models';
        headers['x-api-key'] = apiKey.trim();
        headers['anthropic-version'] = '2023-06-01';
        break;
      case 'xai':
        endpoint = 'https://api.x.ai/v1/models';
        headers['Authorization'] = `Bearer ${apiKey.trim()}`;
        break;
      case 'openrouter':
        endpoint = 'https://openrouter.ai/api/v1/models';
        headers['Authorization'] = `Bearer ${apiKey.trim()}`;
        break;
      case 'groq':
        endpoint = 'https://api.groq.com/openai/v1/models';
        headers['Authorization'] = `Bearer ${apiKey.trim()}`;
        break;
      case 'mistral':
        endpoint = 'https://api.mistral.ai/v1/models';
        headers['Authorization'] = `Bearer ${apiKey.trim()}`;
        break;
      case 'together':
        endpoint = 'https://api.together.xyz/v1/models';
        headers['Authorization'] = `Bearer ${apiKey.trim()}`;
        break;
      case 'fireworks':
        endpoint = 'https://api.fireworks.ai/inference/v1/models';
        headers['Authorization'] = `Bearer ${apiKey.trim()}`;
        break;
      case 'gemini':
        endpoint = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey.trim())}`;
        break;
      default:
        endpoint = null;
    }

    if (!endpoint) {
      clearTimeout(timeout);
      return { models: MODEL_CHOICES[provider] ?? [], source: 'provider_documented' };
    }

    const response = await fetch(endpoint, { method: 'GET', headers, signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      return { models: MODEL_CHOICES[provider] ?? [], source: 'provider_documented' };
    }

    const data = (await response.json()) as any;
    const rawList = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];

    if (!Array.isArray(rawList) || rawList.length === 0) {
      return { models: MODEL_CHOICES[provider] ?? [], source: 'provider_documented' };
    }

    const discovered: ModelChoice[] = rawList
      .map((item: any) => {
        const id = String(item.id || item.name || '').replace(/^models\//, '');
        return {
          id,
          label: id,
          tags: ['verified_api'],
          source: 'verified_api' as const,
          available: true,
          usable: true
        };
      })
      .filter((item: ModelChoice) => item.id.length > 0)
      .slice(0, 25);

    return {
      models: discovered.length > 0 ? discovered : (MODEL_CHOICES[provider] ?? []),
      source: discovered.length > 0 ? 'verified_api' : 'provider_documented'
    };
  } catch {
    return { models: MODEL_CHOICES[provider] ?? [], source: 'provider_documented' };
  }
}
