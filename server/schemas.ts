import { z } from 'zod';

const conf = z.number().min(0).max(1).default(0.65);
const boundedText = (limit: number) => z.string().transform((s) => s.slice(0, limit)).pipe(z.string().min(1).max(limit));
const text = boundedText(1500);

export const OpinionSchema = z.object({
  stance: z.enum(['LONG', 'SHORT', 'NEUTRAL']),
  confidence: conf,
  argument: text
});

export const ResearchSchema = z.object({
  vote: z.enum(['LONG', 'SHORT', 'ABSTAIN', 'VETO']),
  confidence: conf,
  argument: text,
  sources: z.array(z.string().max(120)).max(10).default([])
});

export const RebuttalSchema = z.object({
  stance: z.enum(['LONG', 'SHORT', 'NEUTRAL']),
  confidence: conf,
  target: z.enum(['lead', 'market', 'research', 'strategist', 'risk', 'execution', 'none']).default('none'),
  rebuttal: text
});

export const LeadSchema = z.object({
  action: z.enum(['OPEN_LONG', 'OPEN_SHORT', 'CLOSE', 'HOLD']),
  confidence: conf,
  reason: text
});

const RiskSizing = z.object({
  decision: z.enum(['APPROVE', 'REDUCE']),
  sizeFactor: z.number().min(0).max(1),
  leverage: z.number().min(1).max(125),
  stopPct: z.number().finite().positive().max(50),
  reason: text
});

export const RiskSchema = z.discriminatedUnion('decision', [
  RiskSizing,
  z.object({
    decision: z.literal('REJECT'),
    sizeFactor: z.number().min(0).max(1).default(0),
    leverage: z.number().min(1).max(125).default(1),
    stopPct: z.number().finite().nonnegative().max(50).default(0),
    reason: text
  }).transform((reply) => ({ ...reply, sizeFactor: 0 }))
]);

export const ReviewSchema = z.object({
  lesson: text,
  grade: z.enum(['A', 'B', 'C', 'D', 'F'])
});

export const ChatSchema = z.object({
  reply: boundedText(64000),
  commandToExecute: z.string().min(1).max(200).optional(),
  askTeammate: z.object({
    to: z.enum(['lead', 'market', 'research', 'strategist', 'risk', 'execution']),
    question: z.string().min(1).max(2000)
  }).nullable().optional()
});

export type Schemas = {
  opinion: typeof OpinionSchema;
  research: typeof ResearchSchema;
  rebuttal: typeof RebuttalSchema;
  lead: typeof LeadSchema;
  risk: typeof RiskSchema;
  review: typeof ReviewSchema;
  chat: typeof ChatSchema;
};
export const SCHEMAS: Schemas = { opinion: OpinionSchema, research: ResearchSchema, rebuttal: RebuttalSchema, lead: LeadSchema, risk: RiskSchema, review: ReviewSchema, chat: ChatSchema };
export type TaskKind = keyof Schemas;

export const SCHEMA_HINTS: Record<TaskKind, string> = {
  opinion: '{"stance":"LONG|SHORT|NEUTRAL","confidence":0..1,"argument":"max 2 sentences"}',
  research: '{"vote":"LONG|SHORT|ABSTAIN|VETO","confidence":0..1,"argument":"max 2 sentences","sources":["id or source name"]}',
  rebuttal: '{"stance":"LONG|SHORT|NEUTRAL","confidence":0..1,"target":"agent id you answer or none","rebuttal":"max 2 sentences, direct and in character"}',
  lead: '{"action":"OPEN_LONG|OPEN_SHORT|CLOSE|HOLD","confidence":0..1,"reason":"max 2 sentences"}',
  risk: '{"decision":"APPROVE|REDUCE|REJECT","sizeFactor":0..1,"leverage":1..125,"stopPct":positive percentage points up to 50 (2 means 2%),"reason":"1..1500 characters"}. APPROVE/REDUCE require all numeric fields as JSON numbers. REJECT may omit sizing. Never substitute null or strings for numbers.',
  review: '{"lesson":"one sentence","grade":"A|B|C|D|F"}',
  chat: '{"reply":"answer in character, up to 64000 characters","commandToExecute":"optional exact supported command explicitly requested by Boss","askTeammate":{"to":"lead|market|research|strategist|risk|execution","question":"question"} or null}'
};

// Pull the first JSON object out of a model reply (handles ```json fences and chatter).
export function extractJson(raw: string, task?: TaskKind): unknown {
  const s = raw.trim().replace(/^```(?:json|markdown)?/i, '').replace(/```$/, '').trim();
  try {
    const parsed: unknown = JSON.parse(s);
    return task === 'chat' && typeof parsed === 'string' ? { reply: parsed } : parsed;
  } catch { /* fall through */ }
  const start = s.indexOf('{');
  if (start < 0) {
    if (task === 'chat') return { reply: s };
    throw new Error('no JSON object in reply');
  }
  const closing: string[] = [];
  let inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') closing.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') {
      if (closing.pop() !== ch) {
        if (task === 'chat') return { reply: s };
        throw new Error('mismatched JSON delimiter');
      }
      if (!closing.length) {
        try { return JSON.parse(s.slice(start, i + 1)); }
        catch (e) { if (task === 'chat') return { reply: s }; throw e; }
      }
    }
  }
  // Repair missing delimiters only. Required decisions and numeric fields still pass their schemas.
  let candidate = s.slice(start);
  if (esc) candidate = candidate.slice(0, -1);
  candidate += inStr ? '"' : '';
  if (!inStr) candidate = candidate.replace(/,\s*$/, '');
  try { return JSON.parse(candidate + closing.reverse().join('')); }
  catch { if (task === 'chat') return { reply: s }; throw new Error('unterminated JSON object'); }
}
