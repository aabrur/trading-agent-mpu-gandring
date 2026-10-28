import type { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { AgentId } from '../types.js';
import { SCHEMAS, SCHEMA_HINTS, extractJson, type TaskKind, type Schemas } from '../schemas.js';
import type { ModelCaller } from '../providers/index.js';
import { systemPrompt } from './roles.js';
import { fenceData } from '../untrusted.js';
import { log, safe } from '../redact.js';

export type Out<K extends TaskKind> = z.infer<Schemas[K]>;

export const FALLBACK: { [K in TaskKind]: Out<K> } = {
  opinion: { stance: 'NEUTRAL', confidence: 0, argument: 'My reply did not pass validation twice, so I sit this one out (safe HOLD).' },
  research: { vote: 'ABSTAIN', confidence: 0, argument: 'My reply did not pass validation twice, so I abstain.', sources: [] },
  rebuttal: { stance: 'NEUTRAL', confidence: 0, target: 'none', rebuttal: 'Pass. My reply failed validation, counting me as neutral.' },
  lead: { action: 'HOLD', confidence: 0, reason: 'Verdict failed validation twice. Safe default: HOLD.' },
  risk: { decision: 'REJECT', sizeFactor: 0, leverage: 1, stopPct: 1, reason: 'Risk reply failed validation twice. Safe default: REJECT.' },
  review: { lesson: 'Review failed validation, nothing logged.', grade: 'C' },
  chat: { reply: 'I could not put together a valid answer just now. Try again.' }
};

export type AgentFailureKind = 'schema' | 'parse' | 'empty_output' | 'provider' | 'timeout' | 'rate_limit' | 'quota' | 'auth' | 'cancelled';
export interface RunResult<K extends TaskKind> { data: Out<K>; fallback: boolean; example: boolean; provider: string; model: string; attempts: number; failureKind?: AgentFailureKind | null; lastError?: string }

const failureMessages: Record<AgentFailureKind, string> = {
  schema: 'The model returned an invalid response after one repair attempt. Check the model response format.',
  parse: 'The model response could not be parsed after one repair attempt. Check the model response format.',
  empty_output: 'The model returned empty output after one repair attempt. Check model output settings and diagnostics.',
  provider: 'The model provider failed to return a usable response. Check provider availability and diagnostics.',
  timeout: 'The model request timed out. Check provider health or queue load before trying again.',
  rate_limit: 'The model provider rate limit was reached. Wait for the provider limit to reset before trying again.',
  quota: 'The model provider quota is exhausted. Check provider credits or quota before trying again.',
  auth: 'The model provider rejected authentication or access. Check the provider connection and model permissions.',
  cancelled: 'The model request was cancelled. No completed answer is available.',
};

export async function runAgent<K extends TaskKind>(
  cfg: AppConfig, call: ModelCaller, agent: AgentId, task: K,
  input: { instruction: string; data: Record<string, unknown>; context: Record<string, unknown>; extraSystem?: string; signal?: AbortSignal }
): Promise<RunResult<K>> {
  const { provider, model } = cfg.agents[agent];
  const system = systemPrompt(agent, input.extraSystem);
  const baseUser = [input.instruction, fenceData('desk', input.data), `Respond with JSON only: ${SCHEMA_HINTS[task]}`].join('\n\n');
  const schema = SCHEMAS[task] as Schemas[K];
  let lastErr = '';
  let lastFailureKind: AgentFailureKind = 'provider';
  let attempts = 0;
  let outputLimit = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (input.signal?.aborted) { lastFailureKind = 'cancelled'; lastErr = 'Model request cancelled'; break; }
    attempts = attempt;
    const user = attempt === 1 ? baseUser : `${baseUser}\n\nYour previous reply was invalid (${lastErr}). Send only the JSON object.`;
    let parsing = false;
    try {
      const raw = await call({ agent, task, provider, model, system, user, context: input.context, attempt, signal: input.signal, ...(outputLimit ? { retryReason: 'output_limit' as const } : {}) });
      if (input.signal?.aborted) { lastFailureKind = 'cancelled'; lastErr = 'Model request cancelled'; break; }
      parsing = true;
      if (!raw.trim()) { lastFailureKind = 'empty_output'; lastErr = 'Empty model output'; continue; }
      const parsed = schema.safeParse(extractJson(raw, task));
      if (parsed.success) return { data: parsed.data as Out<K>, fallback: false, example: provider === 'mock', provider, model, attempts: attempt, failureKind: null };
      lastFailureKind = 'schema';
      lastErr = parsed.error.issues.slice(0, 2).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      outputLimit = /output token limit/i.test(msg);
      if (input.signal?.aborted || (e instanceof Error && e.name === 'AbortError') || /\bcancelled\b|\bcanceled\b/i.test(msg)) lastFailureKind = 'cancelled';
      else if (parsing) lastFailureKind = 'parse';
      else if (/timeout|timed out/i.test(msg)) lastFailureKind = 'timeout';
      else if (/quota|insufficient_quota|insufficient credits|credit balance|billing limit/i.test(msg)) lastFailureKind = 'quota';
      else if (/\b429\b|rate[ _-]?limit/i.test(msg)) lastFailureKind = 'rate_limit';
      else if (/\b401\b|\b403\b|unauthori[sz]ed|authentication|invalid api[ _-]?key|not (?:logged|signed) in|access denied/i.test(msg)) lastFailureKind = 'auth';
      else lastFailureKind = 'provider';
      lastErr = safe(msg).slice(0, 120);
    }
    log(`[agent:${agent}] ${task} attempt ${attempt} invalid: ${lastErr}`);
    if (['timeout', 'rate_limit', 'quota', 'auth', 'cancelled'].includes(lastFailureKind)) break;
  }
  const reason = failureMessages[lastFailureKind];
  const validationDetail = lastErr && lastFailureKind === 'schema' ? ` Validation: ${lastErr}.` : '';
  const fallbacks: { [T in TaskKind]: Out<T> } = {
    opinion: { ...FALLBACK.opinion, argument: `${reason} Counting this opinion as neutral.` },
    research: { ...FALLBACK.research, argument: `${reason} Abstaining.` },
    rebuttal: { ...FALLBACK.rebuttal, rebuttal: `${reason} Counting this rebuttal as neutral.` },
    lead: { ...FALLBACK.lead, reason: `${reason} Safe default: HOLD.` },
    risk: { ...FALLBACK.risk, reason: `${reason}${validationDetail} Safe default: REJECT.` },
    review: { ...FALLBACK.review, lesson: `${reason} No model review completed.` },
    chat: { reply: reason },
  };
  return { data: fallbacks[task] as Out<K>, fallback: true, example: provider === 'mock', provider, model, attempts, failureKind: lastFailureKind, lastError: lastErr };
}
