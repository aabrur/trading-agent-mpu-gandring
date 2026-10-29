import type { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { AgentId } from '../types.js';
import { SCHEMAS, SCHEMA_HINTS, extractJson, normalizeResearchSources, type TaskKind, type Schemas } from '../schemas.js';
import type { ModelCaller } from '../providers/index.js';
import { systemPrompt } from './roles.js';
import { fenceData } from '../untrusted.js';
import { log, safe } from '../redact.js';
import { normalizeAgentSpeech } from './speech.js';

export type Out<K extends TaskKind> = z.infer<Schemas[K]>;

export const FALLBACK: { [K in TaskKind]: Out<K> } = {
  opinion: { stance: 'NEUTRAL', confidence: 0, argument: 'My reply did not pass validation twice, so I sit this one out (safe HOLD).' },
  research: { vote: 'ABSTAIN', confidence: 0, argument: 'My reply did not pass validation twice, so I abstain.', sources: [] },
  rebuttal: { stance: 'NEUTRAL', confidence: 0, target: 'none', rebuttal: 'Pass. My reply failed validation, counting me as neutral.' },
  lead: { action: 'HOLD', confidence: 0, reason: 'Verdict failed validation twice. Safe default: HOLD.' },
  risk_assessment: { decision: 'REJECT', reason: 'Risk assessment failed validation; no AI approval.' },
  risk: { decision: 'REJECT', sizeFactor: 0, leverage: 1, stopPct: 1, reason: 'Risk reply failed validation twice. Safe default: REJECT.' },
  review: { lesson: 'Review failed validation, nothing logged.', grade: 'C' },
  chat: { reply: 'I could not put together a valid answer just now. Try again.' }
};

export type AgentFailureKind = 'schema' | 'parse' | 'empty_output' | 'provider' | 'timeout' | 'rate_limit' | 'quota' | 'auth' | 'cancelled';
export interface RunResult<K extends TaskKind> { data: Out<K>; fallback: boolean; example: boolean; provider: string; model: string; attempts: number; failureKind?: AgentFailureKind | null; lastError?: string; speechNormalization?: { fields: string[]; originalResponse: string } }

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
  let researchAnswer: string | undefined;
  let researchOriginal: Record<string, unknown> | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (input.signal?.aborted) { lastFailureKind = 'cancelled'; lastErr = 'Model request cancelled'; break; }
    attempts = attempt;
    const formatRepair = task === 'research' && researchAnswer !== undefined;
    const user = formatRepair
      ? `Format-repair-only. Correct the JSON shape of this completed answer. Preserve vote, confidence, argument and all source identities exactly. Do not research, browse, call tools, add evidence or redo reasoning. If a field cannot be repaired without inventing content, leave it invalid. Validation: ${lastErr}. Return JSON only: ${SCHEMA_HINTS[task]}\n\n${fenceData('completed_research_answer', researchAnswer)}`
      : attempt === 1 ? baseUser : `${baseUser}\n\nYour previous reply was invalid (${lastErr}). Send only the JSON object.`;
    let parsing = false;
    try {
      const pending = call({ agent, task, provider, model, system: formatRepair ? 'Format-repair-only. Use only the supplied completed answer. All external tools and new research are forbidden. Preserve substantive content exactly.' : system, user, context: formatRepair ? { allowResearch: false } : input.context, attempt, signal: input.signal, ...(formatRepair ? { retryReason: 'format_repair' as const } : outputLimit ? { retryReason: 'output_limit' as const } : {}) });
      let onAbort: (() => void) | undefined;
      const raw = await (input.signal ? Promise.race([pending, new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error('Model request cancelled'));
        if (input.signal!.aborted) onAbort(); else input.signal!.addEventListener('abort', onAbort, { once: true });
      })]).finally(() => { if (onAbort) input.signal!.removeEventListener('abort', onAbort); }) : pending);
      if (input.signal?.aborted) { lastFailureKind = 'cancelled'; lastErr = 'Model request cancelled'; break; }
      parsing = true;
      if (!raw.trim()) { lastFailureKind = 'empty_output'; lastErr = 'Empty model output'; continue; }
      if (task === 'research' && !formatRepair) researchAnswer = raw;
      const extracted = extractJson(raw, task);
      if (task === 'research' && !formatRepair && extracted && typeof extracted === 'object' && !Array.isArray(extracted)) researchOriginal = extracted as Record<string, unknown>;
      const candidate = task === 'research' ? normalizeResearchSources(extracted) : extracted;
      const parsed = schema.safeParse(candidate);
      if (formatRepair && parsed.success) {
        const repaired = parsed.data as Out<'research'>;
        const originalLabels = typeof researchOriginal?.sources === 'string' ? [researchOriginal.sources] : researchOriginal?.sources;
        const originalDetails = Array.isArray(researchOriginal?.sourceDetails) ? researchOriginal.sourceDetails as Array<{ label?: unknown; citation?: unknown }> : [];
        const originalSources = Array.isArray(originalLabels) ? originalLabels.map(label => originalDetails.find(detail => detail?.label === label)?.citation ?? label) : originalLabels;
        const fullSources = repaired.sources.map(label => repaired.sourceDetails?.find(detail => detail.label === label)?.citation ?? label);
        if (!researchOriginal || ['vote', 'confidence', 'argument'].some(key => researchOriginal![key] !== repaired[key as 'vote' | 'confidence' | 'argument']) || JSON.stringify(originalSources) !== JSON.stringify(fullSources)) {
          lastFailureKind = 'schema'; lastErr = 'Format repair changed research content or source identity, or the original content could not be verified';
          break;
        }
      }
      if (parsed.success) {
        const data = parsed.data as Out<K>;
        const fields: string[] = [];
        for (const field of ['reply', 'argument', 'rebuttal', 'reason', 'lesson'] as const) {
          if (!(field in data)) continue;
          const record = data as Record<string, unknown>;
          const original = record[field];
          if (typeof original !== 'string') continue;
          const normalized = normalizeAgentSpeech(original);
          if (normalized !== original) { record[field] = normalized; fields.push(field); }
        }
        return { data, fallback: false, example: provider === 'mock', provider, model, attempts: attempt, failureKind: null,
          ...(fields.length ? { speechNormalization: { fields, originalResponse: safe(raw) } } : {}) };
      }
      lastFailureKind = 'schema';
      lastErr = parsed.error.issues.slice(0, 2).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      outputLimit = /output token limit/i.test(msg);
      if (input.signal?.aborted || (e instanceof Error && e.name === 'AbortError') || /\bcancelled\b|\bcanceled\b/i.test(msg)) lastFailureKind = 'cancelled';
      else if (parsing) lastFailureKind = 'parse';
      else if (/timeout|timed out/i.test(msg)) lastFailureKind = 'timeout';
      else if (/quota|insufficient_quota|insufficient credits|credit balance|billing limit|usage limit|hit your usage limit/i.test(msg)) lastFailureKind = 'quota';
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
    risk_assessment: { decision: 'REJECT', reason: `${reason}${validationDetail} No completed AI risk approval.` },
    risk: { ...FALLBACK.risk, reason: `${reason}${validationDetail} Safe default: REJECT.` },
    review: { ...FALLBACK.review, lesson: `${reason} No model review completed.` },
    chat: { reply: reason },
  };
  return { data: fallbacks[task] as Out<K>, fallback: true, example: provider === 'mock', provider, model, attempts, failureKind: lastFailureKind, lastError: lastErr };
}
