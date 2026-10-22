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

export interface RunResult<K extends TaskKind> { data: Out<K>; fallback: boolean; example: boolean; provider: string; model: string; attempts: number }

export async function runAgent<K extends TaskKind>(
  cfg: AppConfig, call: ModelCaller, agent: AgentId, task: K,
  input: { instruction: string; data: Record<string, unknown>; context: Record<string, unknown>; extraSystem?: string }
): Promise<RunResult<K>> {
  const { provider, model } = cfg.agents[agent];
  const system = systemPrompt(agent, input.extraSystem);
  const baseUser = [input.instruction, fenceData('desk', input.data), `Respond with JSON only: ${SCHEMA_HINTS[task]}`].join('\n\n');
  const schema = SCHEMAS[task] as Schemas[K];
  let lastErr = '';
  let lastRaw = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const user = attempt === 1 ? baseUser : `${baseUser}\n\nYour previous reply was invalid (${lastErr}). Send only the JSON object.`;
    try {
      const raw = await call({ agent, task, provider, model, system, user, context: input.context, attempt });
      lastRaw = raw;
      const parsed = schema.safeParse(extractJson(raw, task));
      if (parsed.success) return { data: parsed.data as Out<K>, fallback: false, example: provider === 'mock', provider, model, attempts: attempt };
      lastErr = parsed.error.issues.slice(0, 2).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    } catch (e) {
      lastErr = safe((e as Error).message).slice(0, 120);
    }
    log(`[agent:${agent}] ${task} attempt ${attempt} invalid: ${lastErr}`);
  }
  if (task === 'chat' && lastRaw.trim()) {
    const clean = lastRaw.trim().replace(/^```(?:json|markdown)?/i, '').replace(/```$/, '').trim();
    return { data: { reply: clean, askTeammate: null } as Out<K>, fallback: false, example: provider === 'mock', provider, model, attempts: 2 };
  }
  const fallback = task === 'risk'
    ? { ...FALLBACK.risk, reason: `${FALLBACK.risk.reason} Validation: ${safe(lastErr).slice(0, 240)}` }
    : FALLBACK[task];
  return { data: fallback as Out<K>, fallback: true, example: provider === 'mock', provider, model, attempts: 2 };
}
