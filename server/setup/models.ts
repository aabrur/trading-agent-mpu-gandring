// Curated setup choices, shared by the CLI and office.
import { AGENT_IDS, PROVIDERS, type ProviderName, type ApiProviderName } from '../config.js';
import type { AgentId } from '../types.js';
import { LOCAL_AGENTS, localModels, localSelection } from '../providers/local.js';

export const MODEL_CATALOG_DATE = '2026-10-17';
export const USAGE_SOURCE = { url: 'https://openrouter.ai/rankings', asOf: '2026-10-16', period: '7 days' };
export const MODEL_KEY_ENV: Record<ApiProviderName, string> = {
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
export interface ModelChoice { id: string; label: string; tags: string[] }
export interface ModelSelection { provider: ProviderName; model: string }
export interface ModelSetupInput { defaultProvider: ProviderName; defaultModel: string; agents?: Partial<Record<AgentId, ModelSelection>>; keys?: Partial<Record<ApiProviderName, string>> }
const m = (id: string, label: string, ...tags: string[]): ModelChoice => ({ id, label, tags });

// 10 API providers, each with 20 curated AI models.
export const MODEL_CHOICES: Record<ProviderName, ModelChoice[]> = {
  mock: [m('mock-desk-v1', 'Offline demo', 'Free, offline')],
  local: LOCAL_AGENTS.flatMap((a) => a.models.map((model) => m(`${a.id}:${model}`, `${a.label}: ${model === 'default' ? 'configured model' : model}`, 'Existing agent account'))),
  xai: [
    m('grok-4.7', 'Grok 4.7', 'Frontier'),
    m('grok-4.6', 'Grok 4.6', 'Frontier'),
    m('grok-4.5', 'Grok 4.5', 'Frontier'),
    m('grok-4.5-mini', 'Grok 4.5 Mini', 'Fast'),
    m('grok-4.2', 'Grok 4.2', 'Reasoning'),
    m('grok-4.1', 'Grok 4.1', 'General'),
    m('grok-4', 'Grok 4', 'General'),
    m('grok-4-mini', 'Grok 4 Mini', 'Fast'),
    m('grok-4-heavy', 'Grok 4 Heavy', 'Deep reasoning'),
    m('grok-3.5', 'Grok 3.5', 'General'),
    m('grok-3.5-mini', 'Grok 3.5 Mini', 'Fast'),
    m('grok-3', 'Grok 3', 'General'),
    m('grok-3-fast', 'Grok 3 Fast', 'Low latency'),
    m('grok-3-mini', 'Grok 3 Mini', 'Reasoning'),
    m('grok-3-mini-fast', 'Grok 3 Mini Fast', 'Low latency'),
    m('grok-code-fast-1', 'Grok Code Fast 1', 'Coding'),
    m('grok-2-latest', 'Grok 2 Latest', 'General'),
    m('grok-2-1212', 'Grok 2 1212', 'Stable'),
    m('grok-2-mini', 'Grok 2 Mini', 'Compact'),
    m('grok-beta', 'Grok Beta', 'Preview')
  ],
  openai: [
    m('gpt-6-astra', 'GPT-6 Astra', 'Frontier'),
    m('gpt-6.1-sol', 'GPT-6.1 Sol', 'Frontier'),
    m('gpt-6-luna', 'GPT-6 Luna', 'Token usage #6 on OpenRouter'),
    m('gpt-6-mini', 'GPT-6 Mini', 'Fast'),
    m('gpt-6-nano', 'GPT-6 Nano', 'Ultra fast'),
    m('gpt-5.5', 'GPT-5.5', 'Frontier'),
    m('gpt-5.4', 'GPT-5.4', 'General'),
    m('gpt-5.4-mini', 'GPT-5.4 Mini', 'Fast'),
    m('gpt-5.3-codex', 'GPT-5.3 Codex', 'Coding'),
    m('gpt-5.2', 'GPT-5.2', 'General'),
    m('gpt-5.1', 'GPT-5.1', 'General'),
    m('gpt-5', 'GPT-5', 'General'),
    m('gpt-5-mini', 'GPT-5 Mini', 'Fast'),
    m('gpt-5-nano', 'GPT-5 Nano', 'Compact'),
    m('o4-mini', 'o4 Mini', 'Reasoning'),
    m('o3', 'o3', 'Deep reasoning'),
    m('o3-mini', 'o3 Mini', 'Reasoning'),
    m('gpt-4.1', 'GPT-4.1', 'Stable'),
    m('gpt-4.1-mini', 'GPT-4.1 Mini', 'Fast'),
    m('gpt-4o-mini', 'GPT-4o Mini', 'Compact')
  ],
  anthropic: [
    m('claude-opus-5-5', 'Claude Opus 5.5', 'Frontier', 'Token usage #8 on OpenRouter'),
    m('claude-sonnet-5-5', 'Claude Sonnet 5.5', 'Frontier'),
    m('claude-fable-5-1', 'Claude Fable 5.1', 'Frontier'),
    m('claude-haiku-5-5', 'Claude Haiku 5.5', 'Fast'),
    m('claude-opus-5-0', 'Claude Opus 5.0', 'Frontier'),
    m('claude-sonnet-5-0', 'Claude Sonnet 5.0', 'General'),
    m('claude-haiku-5-0', 'Claude Haiku 5.0', 'Fast'),
    m('claude-opus-4-6', 'Claude Opus 4.6', 'Reasoning'),
    m('claude-sonnet-4-6', 'Claude Sonnet 4.6', 'General'),
    m('claude-haiku-4-5', 'Claude Haiku 4.5', 'Fast'),
    m('claude-opus-4-5', 'Claude Opus 4.5', 'Reasoning'),
    m('claude-sonnet-4-5', 'Claude Sonnet 4.5', 'General'),
    m('claude-opus-4-1', 'Claude Opus 4.1', 'Reasoning'),
    m('claude-opus-4-0', 'Claude Opus 4.0', 'General'),
    m('claude-sonnet-4-0', 'Claude Sonnet 4.0', 'General'),
    m('claude-3-7-sonnet-latest', 'Claude 3.7 Sonnet', 'Hybrid reasoning'),
    m('claude-3-5-sonnet-latest', 'Claude 3.5 Sonnet', 'Stable'),
    m('claude-3-5-haiku-latest', 'Claude 3.5 Haiku', 'Fast'),
    m('claude-3-opus-latest', 'Claude 3 Opus', 'Legacy'),
    m('claude-3-haiku-20240307', 'Claude 3 Haiku', 'Compact')
  ],
  gemini: [
    m('gemini-4-argon', 'Gemini 4 Argon', 'Frontier'),
    m('gemini-4-pro', 'Gemini 4 Pro', 'Frontier'),
    m('gemini-4-flash', 'Gemini 4 Flash', 'Fast'),
    m('gemini-4-flash-lite', 'Gemini 4 Flash-Lite', 'Free tier'),
    m('gemini-3.8-pro', 'Gemini 3.8 Pro', 'Frontier'),
    m('gemini-3.8-flash', 'Gemini 3.8 Flash', 'Frontier', 'Free tier'),
    m('gemini-3.5-pro', 'Gemini 3.5 Pro', 'Reasoning'),
    m('gemini-3.5-flash', 'Gemini 3.5 Flash', 'Fast'),
    m('gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite', 'Free tier'),
    m('gemini-3.1-pro', 'Gemini 3.1 Pro', 'Reasoning'),
    m('gemini-3.1-flash', 'Gemini 3.1 Flash', 'Fast'),
    m('gemini-3.1-flash-lite', 'Gemini 3.1 Flash-Lite', 'Free tier'),
    m('gemini-3.0-pro', 'Gemini 3.0 Pro', 'General'),
    m('gemini-3.0-flash', 'Gemini 3.0 Flash', 'Fast'),
    m('gemini-2.5-pro', 'Gemini 2.5 Pro', 'Reasoning'),
    m('gemini-2.5-flash', 'Gemini 2.5 Flash', 'Free tier'),
    m('gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite', 'Free tier'),
    m('gemini-2.0-flash', 'Gemini 2.0 Flash', 'Fast'),
    m('gemini-2.0-flash-lite', 'Gemini 2.0 Flash-Lite', 'Compact'),
    m('gemini-1.5-pro', 'Gemini 1.5 Pro', 'Stable')
  ],
  deepseek: [
    m('deepseek-v4-pro', 'DeepSeek V4 Pro', 'Frontier'),
    m('deepseek-flash', 'DeepSeek V4.1 Flash 1017', 'Frontier'),
    m('deepseek-v4', 'DeepSeek V4', 'Frontier'),
    m('deepseek-v4-lite', 'DeepSeek V4 Lite', 'Fast'),
    m('deepseek-r2', 'DeepSeek R2', 'Deep reasoning'),
    m('deepseek-r2-lite', 'DeepSeek R2 Lite', 'Reasoning'),
    m('deepseek-r1', 'DeepSeek R1', 'Reasoning'),
    m('deepseek-r1-0528', 'DeepSeek R1 0528', 'Reasoning'),
    m('deepseek-r1-distill-qwen-32b', 'DeepSeek R1 Distill Qwen 32B', 'Distilled'),
    m('deepseek-r1-distill-llama-70b', 'DeepSeek R1 Distill Llama 70B', 'Distilled'),
    m('deepseek-v3.2', 'DeepSeek V3.2', 'General'),
    m('deepseek-v3.1', 'DeepSeek V3.1', 'General'),
    m('deepseek-v3-0324', 'DeepSeek V3 0324', 'General'),
    m('deepseek-chat', 'DeepSeek Chat', 'Default chat'),
    m('deepseek-reasoner', 'DeepSeek Reasoner', 'Default reasoner'),
    m('deepseek-coder-v3', 'DeepSeek Coder V3', 'Coding'),
    m('deepseek-coder', 'DeepSeek Coder', 'Coding'),
    m('deepseek-math-v2', 'DeepSeek Math V2', 'Quantitative'),
    m('deepseek-v2.5', 'DeepSeek V2.5', 'Stable'),
    m('deepseek-vl2', 'DeepSeek VL2', 'Multimodal')
  ],
  openrouter: [
    m('anthropic/claude-opus-5.5', 'Claude Opus 5.5', 'Frontier', 'Token usage #8 on OpenRouter'),
    m('anthropic/claude-sonnet-5.5', 'Claude Sonnet 5.5', 'Frontier'),
    m('anthropic/claude-haiku-5.5', 'Claude Haiku 5.5', 'Fast'),
    m('openai/gpt-6.1-sol', 'GPT-6.1 Sol', 'Frontier'),
    m('openai/gpt-6-luna', 'GPT-6 Luna', 'Frontier'),
    m('google/gemini-4-argon', 'Gemini 4 Argon', 'Frontier'),
    m('deepseek/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', 'Token usage #1 on OpenRouter'),
    m('deepseek/deepseek-v4.1-flash-1017', 'DeepSeek V4.1 Flash 1017', 'Frontier snapshot'),
    m('stepfun/step-5-preview', 'Step 5 Preview', 'Token usage #2 on OpenRouter'),
    m('z-ai/glm-5.3', 'GLM 5.3', 'General'),
    m('z-ai/glm-5.3-flash', 'GLM 5.3 Flash', 'Token usage #3 on OpenRouter'),
    m('moonshotai/kimi-k3', 'Kimi K3', 'Reasoning'),
    m('xiaomi/mimo-v2.6-flash', 'Mimo V2.6 Flash', 'Fast'),
    m('minimax/minimax-m3.1-flash', 'MiniMax M3.1 Flash', 'Fast'),
    m('x-ai/grok-4.7', 'Grok 4.7', 'Frontier'),
    m('openai/gpt-6-astra', 'GPT-6 Astra', 'Frontier'),
    m('qwen/qwen-3.5-max', 'Qwen 3.5 Max', 'Frontier'),
    m('meta-llama/llama-4-maverick', 'Llama 4 Maverick', 'Open weights'),
    m('mistralai/mistral-large-3', 'Mistral Large 3', 'Frontier'),
    m('nvidia/nemotron-3-ultra-550b-a55b:free', 'Nemotron 3 Ultra', 'Free', 'Token usage #7 on OpenRouter')
  ],
  groq: [
    m('llama-3.3-70b-versatile', 'Llama 3.3 70B Versatile', 'Fast LPU'),
    m('llama-3.3-70b-specdec', 'Llama 3.3 70B SpecDec', 'Speculative decoding'),
    m('llama-3.1-8b-instant', 'Llama 3.1 8B Instant', 'Ultra fast'),
    m('llama-4-scout-17b-16e-instruct', 'Llama 4 Scout 17B', 'MoE'),
    m('llama-4-maverick-17b-128e-instruct', 'Llama 4 Maverick 17B', 'Frontier MoE'),
    m('deepseek-r1-distill-llama-70b', 'DeepSeek R1 Distill Llama 70B', 'Reasoning'),
    m('deepseek-r1-distill-qwen-32b', 'DeepSeek R1 Distill Qwen 32B', 'Reasoning'),
    m('qwen-qwq-32b', 'Qwen QwQ 32B', 'Reasoning'),
    m('qwen-2.5-72b-instruct', 'Qwen 2.5 72B Instruct', 'General'),
    m('qwen-2.5-32b', 'Qwen 2.5 32B', 'General'),
    m('qwen-2.5-coder-32b', 'Qwen 2.5 Coder 32B', 'Coding'),
    m('moonshotai-kimi-k2-instruct', 'Kimi K2 Instruct', 'Reasoning'),
    m('gemma2-9b-it', 'Gemma 2 9B IT', 'Compact'),
    m('mixtral-8x7b-32768', 'Mixtral 8x7B', 'MoE'),
    m('llama3-70b-8192', 'Llama 3 70B', 'Stable'),
    m('llama3-8b-8192', 'Llama 3 8B', 'Compact'),
    m('compound-beta', 'Groq Compound Beta', 'Agentic system'),
    m('compound-beta-mini', 'Groq Compound Beta Mini', 'Fast agentic'),
    m('allam-2-7b', 'ALLaM 2 7B', 'Multilingual'),
    m('mistral-saba-24b', 'Mistral Saba 24B', 'Regional')
  ],
  mistral: [
    m('mistral-large-latest', 'Mistral Large Latest', 'Frontier'),
    m('mistral-large-2411', 'Mistral Large 2411', 'Stable'),
    m('mistral-medium-latest', 'Mistral Medium Latest', 'Balanced'),
    m('mistral-small-latest', 'Mistral Small Latest', 'Fast'),
    m('mistral-small-2503', 'Mistral Small 2503', 'Fast'),
    m('magistral-medium-latest', 'Magistral Medium', 'Reasoning'),
    m('magistral-small-latest', 'Magistral Small', 'Fast reasoning'),
    m('codestral-latest', 'Codestral Latest', 'Coding'),
    m('codestral-2501', 'Codestral 2501', 'Coding'),
    m('devstral-small-latest', 'Devstral Small', 'Agentic code'),
    m('ministral-8b-latest', 'Ministral 8B', 'Edge fast'),
    m('ministral-3b-latest', 'Ministral 3B', 'Ultra compact'),
    m('pixtral-large-latest', 'Pixtral Large', 'Multimodal'),
    m('pixtral-12b-2409', 'Pixtral 12B', 'Multimodal'),
    m('mistral-saba-latest', 'Mistral Saba', 'Regional'),
    m('open-mistral-nemo', 'Mistral Nemo 12B', 'Open weights'),
    m('open-mixtral-8x22b', 'Mixtral 8x22B', 'Open MoE'),
    m('open-mixtral-8x7b', 'Mixtral 8x7B', 'Open MoE'),
    m('open-mistral-7b', 'Mistral 7B', 'Compact'),
    m('mistral-tiny', 'Mistral Tiny', 'Legacy fast')
  ],
  together: [
    m('meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Llama 3.3 70B Turbo', 'Fast'),
    m('meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8', 'Llama 4 Maverick FP8', 'Frontier'),
    m('meta-llama/Llama-4-Scout-17B-16E-Instruct', 'Llama 4 Scout', 'Fast MoE'),
    m('meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo', 'Llama 3.1 405B Turbo', 'Flagship'),
    m('meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo', 'Llama 3.1 70B Turbo', 'Balanced'),
    m('meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', 'Llama 3.1 8B Turbo', 'Fast'),
    m('deepseek-ai/DeepSeek-R1', 'DeepSeek R1', 'Reasoning'),
    m('deepseek-ai/DeepSeek-V3', 'DeepSeek V3', 'Frontier'),
    m('deepseek-ai/DeepSeek-R1-Distill-Llama-70B', 'DeepSeek R1 Distill 70B', 'Reasoning'),
    m('deepseek-ai/DeepSeek-R1-Distill-Qwen-14B', 'DeepSeek R1 Distill 14B', 'Compact reasoning'),
    m('Qwen/Qwen2.5-72B-Instruct-Turbo', 'Qwen 2.5 72B Turbo', 'General'),
    m('Qwen/Qwen2.5-Coder-32B-Instruct', 'Qwen 2.5 Coder 32B', 'Coding'),
    m('Qwen/QwQ-32B', 'Qwen QwQ 32B', 'Reasoning'),
    m('Qwen/Qwen3-235B-A22B-fp8-tput', 'Qwen 3 235B A22B', 'Frontier MoE'),
    m('mistralai/Mixtral-8x22B-Instruct-v0.1', 'Mixtral 8x22B Instruct', 'MoE'),
    m('mistralai/Mixtral-8x7B-Instruct-v0.1', 'Mixtral 8x7B Instruct', 'MoE'),
    m('mistralai/Mistral-Small-24B-Instruct-2501', 'Mistral Small 24B', 'Fast'),
    m('google/gemma-2-27b-it', 'Gemma 2 27B IT', 'General'),
    m('nvidia/Llama-3.1-Nemotron-70B-Instruct-HF', 'Nemotron 70B Instruct', 'Aligned'),
    m('NousResearch/Hermes-3-Llama-3.1-405B-Turbo', 'Hermes 3 405B Turbo', 'Uncensored reasoning')
  ],
  fireworks: [
    m('accounts/fireworks/models/llama-v3p3-70b-instruct', 'Llama 3.3 70B Instruct', 'Fast'),
    m('accounts/fireworks/models/llama4-maverick-instruct-basic', 'Llama 4 Maverick', 'Frontier'),
    m('accounts/fireworks/models/llama4-scout-instruct-basic', 'Llama 4 Scout', 'Fast MoE'),
    m('accounts/fireworks/models/llama-v3p1-405b-instruct', 'Llama 3.1 405B Instruct', 'Flagship'),
    m('accounts/fireworks/models/llama-v3p1-70b-instruct', 'Llama 3.1 70B Instruct', 'Balanced'),
    m('accounts/fireworks/models/llama-v3p1-8b-instruct', 'Llama 3.1 8B Instruct', 'Fast'),
    m('accounts/fireworks/models/deepseek-r1', 'DeepSeek R1', 'Reasoning'),
    m('accounts/fireworks/models/deepseek-v3', 'DeepSeek V3', 'Frontier'),
    m('accounts/fireworks/models/deepseek-r1-0528', 'DeepSeek R1 0528', 'Reasoning'),
    m('accounts/fireworks/models/qwen3-235b-a22b', 'Qwen 3 235B A22B', 'Frontier MoE'),
    m('accounts/fireworks/models/qwen3-30b-a3b', 'Qwen 3 30B A3B', 'Fast MoE'),
    m('accounts/fireworks/models/qwen2p5-72b-instruct', 'Qwen 2.5 72B Instruct', 'General'),
    m('accounts/fireworks/models/qwen2p5-coder-32b-instruct', 'Qwen 2.5 Coder 32B', 'Coding'),
    m('accounts/fireworks/models/qwq-32b', 'Qwen QwQ 32B', 'Reasoning'),
    m('accounts/fireworks/models/mixtral-8x22b-instruct', 'Mixtral 8x22B Instruct', 'MoE'),
    m('accounts/fireworks/models/mixtral-8x7b-instruct', 'Mixtral 8x7B Instruct', 'MoE'),
    m('accounts/fireworks/models/mistral-small-24b-instruct-2501', 'Mistral Small 24B', 'Fast'),
    m('accounts/fireworks/models/gemma2-9b-it', 'Gemma 2 9B IT', 'Compact'),
    m('accounts/fireworks/models/kimi-k2-instruct', 'Kimi K2 Instruct', 'Reasoning'),
    m('accounts/fireworks/models/glm-4p5', 'GLM 4.5', 'General')
  ]
};
export interface ModelPreset {
  id: string;
  label: string;
  description: string;
  defaultProvider: ProviderName;
  defaultModel: string;
  agents: Record<AgentId, ModelSelection>;
}

export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: 'performance_first',
    label: 'Performance-First Candidate',
    description: 'Claude Opus 5.5 Lead, Sonnet 5.5 Market, Gemini 4 Argon Research, GPT-6 Luna Strategist/Execution, Haiku 5.5 Risk via OpenRouter.',
    defaultProvider: 'openrouter',
    defaultModel: 'anthropic/claude-opus-5.5',
    agents: {
      lead: { provider: 'openrouter', model: 'anthropic/claude-opus-5.5' },
      market: { provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5' },
      research: { provider: 'openrouter', model: 'google/gemini-4-argon' },
      strategist: { provider: 'openrouter', model: 'openai/gpt-6-luna' },
      risk: { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5' },
      execution: { provider: 'openrouter', model: 'openai/gpt-6-luna' }
    }
  },
  {
    id: 'cost_optimized',
    label: 'Cost-Optimized Challenger',
    description: 'Claude Sonnet 5.5 Lead, DeepSeek V4.1 Flash Market/Research/Strategist, Claude Haiku 5.5 Risk/Execution via OpenRouter.',
    defaultProvider: 'openrouter',
    defaultModel: 'anthropic/claude-sonnet-5.5',
    agents: {
      lead: { provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5' },
      market: { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' },
      research: { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' },
      strategist: { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' },
      risk: { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5' },
      execution: { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5' }
    }
  }
];

export const MODEL_SOURCES: Record<ProviderName, string> = {
  mock: '',
  local: 'https://developers.openai.com/codex/cli',
  xai: 'https://docs.x.ai/developers/models',
  openai: 'https://developers.openai.com/api/docs/models',
  anthropic: 'https://platform.claude.com/docs/en/models/overview',
  gemini: 'https://ai.google.dev/gemini-api/docs/pricing',
  deepseek: 'https://api-docs.deepseek.com/quick_start/pricing/',
  openrouter: 'https://openrouter.ai/api/v1/models',
  groq: 'https://console.groq.com/docs/models',
  mistral: 'https://docs.mistral.ai/getting-started/models/models_overview/',
  together: 'https://docs.together.ai/docs/serverless-models',
  fireworks: 'https://fireworks.ai/models'
};
export const providerModelEnv = (p: ProviderName) => `${p.toUpperCase()}_MODEL`;
export const isProvider = (p: unknown): p is ProviderName => typeof p === 'string' && PROVIDERS.includes(p as ProviderName);
export const defaultModel = (env: NodeJS.ProcessEnv, p: ProviderName) => env[providerModelEnv(p)] || MODEL_CHOICES[p][0].id;

/** Preserve a previously configured model without expanding the picker into a full provider directory. */
export function modelChoices(env: NodeJS.ProcessEnv, p: ProviderName): ModelChoice[] {
  const choices = p === 'local' ? LOCAL_AGENTS.flatMap((agent) => localModels(agent.id).map((model) => m(`${agent.id}:${model}`, `${agent.label}: ${model === 'default' ? 'configured model' : model}`, 'CLI model; account access required'))) : [...MODEL_CHOICES[p]];
  const saved = [env[providerModelEnv(p)], ...AGENT_IDS.filter((a) => (env[`AGENT_${a.toUpperCase()}_PROVIDER`] || env.DEFAULT_PROVIDER || 'mock') === p).map((a) => env[`AGENT_${a.toUpperCase()}_MODEL`])];
  for (const id of saved) if (id && !choices.some((v) => v.id === id)) choices.push(m(id, id, 'Saved model'));
  return choices;
}

export function modelSetupInfo(env: NodeJS.ProcessEnv) {
  const p = isProvider(env.DEFAULT_PROVIDER) ? env.DEFAULT_PROVIDER : 'mock';
  return {
    checkedOn: MODEL_CATALOG_DATE, usageSource: USAGE_SOURCE,
    presets: MODEL_PRESETS,
    providers: PROVIDERS.map((provider) => ({ provider, keyEnv: provider === 'mock' || provider === 'local' ? null : MODEL_KEY_ENV[provider], keySet: provider === 'mock' || provider === 'local' || !!env[MODEL_KEY_ENV[provider]], source: MODEL_SOURCES[provider], models: modelChoices(env, provider), defaultModel: defaultModel(env, provider) })),
    defaultProvider: p, defaultModel: defaultModel(env, p),
    agents: AGENT_IDS.map((id) => {
      const raw = env[`AGENT_${id.toUpperCase()}_PROVIDER`] || p;
      const provider = isProvider(raw) ? raw : p;
      return { id, provider, model: env[`AGENT_${id.toUpperCase()}_MODEL`] || defaultModel(env, provider), custom: !!(env[`AGENT_${id.toUpperCase()}_PROVIDER`] || env[`AGENT_${id.toUpperCase()}_MODEL`]) };
    })
  };
}

/** Validate the entire selection before producing any .env updates. Never returns a secret in an error. */
export function modelUpdates(env: NodeJS.ProcessEnv, input: ModelSetupInput): Record<string, string | null> {
  const valid = (p: ProviderName, model: string) => {
    if (!isProvider(p)) return false;
    if (p === 'local') { try { localSelection(model); return true; } catch { return false; } }
    return modelChoices(env, p).some((v) => v.id === model);
  };
  if (!valid(input.defaultProvider, input.defaultModel)) throw new Error('Choose a model from the selected provider.');
  const up: Record<string, string | null> = { DEFAULT_PROVIDER: input.defaultProvider, [providerModelEnv(input.defaultProvider)]: input.defaultModel };
  for (const a of AGENT_IDS) {
    const selection = input.agents?.[a];
    if (selection && !valid(selection.provider, selection.model)) throw new Error(`Choose a model from the selected provider for ${a}.`);
    up[`AGENT_${a.toUpperCase()}_PROVIDER`] = selection?.provider ?? null;
    up[`AGENT_${a.toUpperCase()}_MODEL`] = selection?.model ?? null;
  }
  for (const [p, key] of Object.entries(input.keys ?? {})) {
    if (!isProvider(p) || p === 'mock' || p === 'local' || (key && !/^\S{1,400}$/.test(key))) throw new Error('Invalid model API key input.');
    if (key) up[MODEL_KEY_ENV[p]] = key;
  }
  return up;
}
