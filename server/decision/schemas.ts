import { z } from 'zod';

export const JEV_MODEL = 'typesafe/jev-1.14';
export const JEV_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
export const JEV_PROVIDER = 'openrouter' as const;

export const NoulQuestionSchema = z.object({
  type: z.literal('noul'),
  instructions: z.string().min(1).max(2000),
  criteria: z.object({ true: z.string().max(400).optional(), false: z.string().max(400).optional() }).optional()
});
export const ChoiceQuestionSchema = z.object({
  type: z.literal('choice'),
  instructions: z.string().min(1).max(2000),
  criteria: z.record(z.string(), z.string().nullable())
});
export const ScoreQuestionSchema = z.object({
  type: z.literal('score'),
  instructions: z.string().min(1).max(2000),
  criteria: z.array(z.string().min(1)).min(2).max(10)
});
export const QuestionSchema = z.discriminatedUnion('type', [NoulQuestionSchema, ChoiceQuestionSchema, ScoreQuestionSchema]);

export const DecisionsRequestSchema = z.object({
  model: z.string().min(1),
  state: z.unknown(),
  questions: z.record(z.string().min(1).max(80), QuestionSchema)
});

export const NoulAnswerSchema = z.object({ type: z.literal('noul'), noul: z.number() });
export const ChoiceAnswerSchema = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number()
});
export const ScoreAnswerSchema = z.object({
  type: z.literal('score'),
  score: z.number(),
  legend: z.record(z.string(), z.string()).optional(),
  probabilities: z.record(z.string(), z.number()).optional(),
  confidence: z.number().optional()
});
export const AnswerSchema = z.discriminatedUnion('type', [NoulAnswerSchema, ChoiceAnswerSchema, ScoreAnswerSchema]);

export const DecisionsResponseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), AnswerSchema),
  usage: z.object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cost: z.number().optional()
  }).optional(),
  id: z.string().optional(),
  provider: z.string().optional()
});

export type Question = z.infer<typeof QuestionSchema>;
export type DecisionsRequest = z.infer<typeof DecisionsRequestSchema>;
export type DecisionsResponse = z.infer<typeof DecisionsResponseSchema>;
export type Answer = z.infer<typeof AnswerSchema>;

export type JevHealth =
  | 'DISABLED'
  | 'MISSING_KEY'
  | 'READY'
  | 'AUTH_ERROR'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'PROVIDER_ERROR';

export type JevMode = 'off' | 'shadow' | 'assist';
export type JevKeySource = 'none' | 'openrouter' | 'jev';
