import { z } from 'zod';
import type { AgentId } from '../types.js';
import type { TaskKind } from '../schemas.js';
import {
  OpinionSchema,
  ResearchSchema,
  RebuttalSchema,
  LeadSchema,
  ReviewSchema,
  ChatSchema
} from '../schemas.js';
import type { ProviderName } from '../config.js';

const text = z.string().min(1).max(1500);
const RiskSizing = z.object({
  decision: z.enum(['APPROVE', 'REDUCE']),
  sizeFactor: z.number().min(0).max(1),
  leverage: z.number().min(1).max(125),
  stopPct: z.number().finite().positive().max(50),
  reason: text
});

const RiskJsonSchema = z.discriminatedUnion('decision', [
  RiskSizing,
  z.object({
    decision: z.literal('REJECT'),
    sizeFactor: z.number().min(0).max(1).optional(),
    leverage: z.number().min(1).max(125).optional(),
    stopPct: z.number().finite().nonnegative().max(50).optional(),
    reason: text
  })
]);

export function getTaskJsonSchema(task: TaskKind): Record<string, unknown> {
  switch (task) {
    case 'opinion':
      return z.toJSONSchema(OpinionSchema);
    case 'research':
      return z.toJSONSchema(ResearchSchema);
    case 'rebuttal':
      return z.toJSONSchema(RebuttalSchema);
    case 'lead':
      return z.toJSONSchema(LeadSchema);
    case 'risk':
      return z.toJSONSchema(RiskJsonSchema);
    case 'review':
      return z.toJSONSchema(ReviewSchema);
    case 'chat':
      return z.toJSONSchema(ChatSchema);
  }
}

const OPENROUTER_STRUCTURED_MODELS = new Set([
  'anthropic/claude-opus-5.5',
  'anthropic/claude-sonnet-5.5',
  'anthropic/claude-haiku-5.5',
  'openai/gpt-6.1-sol',
  'openai/gpt-6-luna',
  'openai/gpt-6-astra',
  'google/gemini-4-argon',
  'deepseek/deepseek-v4.1-flash',
  'deepseek/deepseek-v4.1-flash-1017',
  'z-ai/glm-5.3',
  'z-ai/glm-5.3-flash',
  'moonshotai/kimi-k3',
  'xiaomi/mimo-v2.6-flash',
  'minimax/minimax-m3.1-flash',
  'stepfun/step-5-preview',
  'qwen/qwen-3.5-max',
  'mistralai/mistral-large-3'
]);

export function supportsStrictJsonSchema(provider: ProviderName, model: string): boolean {
  if (provider === 'openrouter') {
    return OPENROUTER_STRUCTURED_MODELS.has(model);
  }
  if (provider === 'openai') {
    return /^(gpt-6|gpt-5|gpt-4o|gpt-4\.1|o1|o3|o4)/.test(model);
  }
  return false;
}

export function supportsJsonObject(provider: ProviderName, _model: string): boolean {
  return provider === 'deepseek' || provider === 'groq' || provider === 'mistral' || provider === 'together' || provider === 'fireworks' || provider === 'xai';
}

export interface GenerationParams {
  maxTokens: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  temperature?: number;
  responseFormat?: { type: 'json_schema'; json_schema: { name: string; strict: boolean; schema: Record<string, unknown> } } | { type: 'json_object' };
}

export function getGenerationParams(agent: AgentId, task: TaskKind, provider: ProviderName, model: string): GenerationParams {
  const maxTokens = task === 'chat' ? 8192 : 2048;

  const isOpenAiReasoning = provider === 'openai' && /^(gpt-6|gpt-5|o1|o3|o4)/.test(model);
  const isOpenRouterReasoning = provider === 'openrouter' && /^(anthropic\/claude-(opus|sonnet|haiku)-5|openai\/gpt-6)/.test(model);

  let reasoningEffort: 'low' | 'medium' | 'high' | undefined;
  if (isOpenAiReasoning || isOpenRouterReasoning) {
    if (agent === 'lead') reasoningEffort = 'high';
    else if (agent === 'strategist') reasoningEffort = 'medium';
    else if (agent === 'market' || agent === 'research') reasoningEffort = 'medium';
    else reasoningEffort = 'low';
  }

  let temperature: number | undefined;
  if (provider === 'openai') {
    if (!isOpenAiReasoning) {
      temperature = 0.6; // Preserves existing test expectation for legacy OpenAI models
    }
  } else if (!isOpenRouterReasoning && provider !== 'mock' && provider !== 'local') {
    temperature = 0.2;
  }

  let responseFormat: GenerationParams['responseFormat'];
  if (supportsStrictJsonSchema(provider, model)) {
    responseFormat = {
      type: 'json_schema',
      json_schema: {
        name: `mpu_${task}`,
        strict: true,
        schema: getTaskJsonSchema(task)
      }
    };
  } else if (supportsJsonObject(provider, model)) {
    responseFormat = { type: 'json_object' };
  }

  return {
    maxTokens,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(responseFormat ? { responseFormat } : {})
  };
}
