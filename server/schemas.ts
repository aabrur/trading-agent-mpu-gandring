import { z } from 'zod';

const conf = z.number().min(0).max(1);
const text = z.string().min(1).max(700);

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

export const RiskSchema = z.object({
  decision: z.enum(['APPROVE', 'REDUCE', 'REJECT']),
  sizeFactor: z.number().min(0).max(1),
  leverage: z.number().min(1).max(125),
  stopPct: z.preprocess((val) => {
    if (typeof val !== 'number' || !Number.isFinite(val)) return 1.5;
    if (val <= 0) return 0;
    if (val > 0 && val < 0.05) return val * 100;
    return val;
  }, z.number().min(0).max(50)),
  reason: text
});

export const ReviewSchema = z.object({
  lesson: text,
  grade: z.enum(['A', 'B', 'C', 'D', 'F'])
});

export const ChatSchema = z.object({ reply: text });

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
  risk: '{"decision":"APPROVE|REDUCE|REJECT","sizeFactor":0..1,"leverage":number,"stopPct":0..30,"reason":"max 2 sentences"}',
  review: '{"lesson":"one sentence","grade":"A|B|C|D|F"}',
  chat: '{"reply":"short answer in character"}'
};

// Pull the first JSON object out of a model reply (handles ```json fences and chatter).
export function extractJson(raw: string): unknown {
  const s = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(s); } catch { /* fall through */ }
  const start = s.indexOf('{');
  if (start < 0) throw new Error('no JSON object in reply');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return JSON.parse(s.slice(start, i + 1)); }
  }
  throw new Error('unterminated JSON object');
}
