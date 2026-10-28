import { z } from 'zod';

const conf = z.number().min(0).max(1).default(0.65);
const boundedText = (limit: number) => z.string().transform((s) => s.slice(0, limit)).pipe(z.string().min(1).max(limit));
const text = boundedText(1500);
const nullToUndefined = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((val) => (val === null ? undefined : val), schema.optional());

const entryFields = {
  entryScenarioId: nullToUndefined(z.string().min(1).max(120)),
  entryZone: nullToUndefined(z.object({ low: z.number().finite().positive(), high: z.number().finite().positive(), basis: z.string().min(1).max(500) })),
  invalidationLevel: nullToUndefined(z.number().finite().positive()),
};
export const CloseTriggerSchema = z.enum(['INVALIDATION_HIT', 'MOMENTUM_REVERSAL', 'SENTIMENT_REVERSAL', 'OPPOSING_NEWS', 'WHALE_EXIT', 'EXCHANGE_STOP_OR_TP', 'EARLY_TAKE_PROFIT', 'DATA_ANOMALY_OR_CONFLICT', 'GUARD_THREATENED']);
const exitSignal = nullToUndefined(z.object({ kind: z.enum(['MOMENTUM_EXHAUSTION', 'TARGET_COMPLETE']), evidenceRefs: z.array(z.string().min(1).max(160)).min(1).max(10) }));

export const OpinionSchema = z.object({
  stance: z.enum(['LONG', 'SHORT', 'NEUTRAL']),
  confidence: conf,
  argument: text,
  ...entryFields,
  exitSignal
});

export const ResearchSchema = z.object({
  vote: z.enum(['LONG', 'SHORT', 'ABSTAIN', 'VETO']),
  confidence: conf,
  argument: z.string().min(1).max(1500),
  sources: z.array(z.string().max(120)).max(10).default([]),
  sourceDetails: z.array(z.object({ label: z.string().max(120), citation: z.string().min(1).max(8192) })).max(10).optional()
});

/** An explicit abbreviation map retains the exact citation, including long URLs. */
export function normalizeResearchSources(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const reply = value as Record<string, unknown>;
  if (!Array.isArray(reply.sources) || !reply.sources.every(source => typeof source === 'string' && source.length <= 8192)) return value;
  const sources = reply.sources as string[];
  if (!sources.some(source => source.length > 120) || reply.sourceDetails !== undefined) return value;
  const labels = sources.map(source => source.length <= 120 ? source : source.slice(0, 119).replace(/[\uD800-\uDBFF]$/, '') + '…');
  // Do not collapse distinct source identities onto the same abbreviated label.
  if (new Set(labels).size !== new Set(sources).size) return value;
  return { ...reply, sources: labels, sourceDetails: sources.flatMap((citation, i) => citation.length > 120 ? [{ label: labels[i], citation }] : []) };
}

export const RebuttalSchema = z.object({
  stance: z.enum(['LONG', 'SHORT', 'NEUTRAL']),
  confidence: conf,
  target: z.enum(['lead', 'market', 'research', 'strategist', 'risk', 'execution', 'none']).default('none'),
  rebuttal: text
});

export const LeadSchema = z.object({
  action: z.enum(['OPEN_LONG', 'OPEN_SHORT', 'CLOSE', 'HOLD']),
  confidence: conf,
  reason: text,
  ...entryFields,
  closeTrigger: nullToUndefined(CloseTriggerSchema),
  exitSignal
});

const RiskSizing = z.object({
  decision: z.enum(['APPROVE', 'REDUCE']),
  sizeFactor: z.number().min(0).max(1),
  leverage: z.number().min(1).max(125),
  stopPct: z.number().finite().positive().max(50),
  reason: text
});

export const RiskAssessmentSchema = z.object({ decision: z.enum(['APPROVE', 'REJECT', 'VETO']).transform(value => value === 'VETO' ? 'REJECT' as const : value), reason: text });

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

export const ChatSchema = z.preprocess((val) => {
  if (typeof val === 'string') return { reply: val };
  if (val && typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    if (obj.reply === undefined || obj.reply === null) {
      const alias = obj.message ?? obj.text ?? obj.response ?? obj.content ?? obj.answer;
      if (alias !== undefined && alias !== null) {
        return { ...obj, reply: String(alias) };
      }
    }
  }
  return val;
}, z.object({
  reply: boundedText(64000),
  commandToExecute: z.preprocess(value => value === null || typeof value === 'string' && !value.trim() ? undefined : value, z.string().trim().min(1).max(200).optional()),
  askTeammates: z.array(z.object({
    to: z.enum(['lead', 'market', 'research', 'strategist', 'risk', 'execution']),
    question: z.string().trim().min(1).max(2000),
    symbol: z.string().regex(/^[A-Z0-9]{2,24}$/).nullable().optional()
  })).max(5).nullable().optional(),
  askTeammate: z.object({
    to: z.enum(['lead', 'market', 'research', 'strategist', 'risk', 'execution']),
    question: z.string().min(1).max(2000)
  }).nullable().optional()
}));

export type Schemas = {
  opinion: typeof OpinionSchema;
  research: typeof ResearchSchema;
  rebuttal: typeof RebuttalSchema;
  lead: typeof LeadSchema;
  risk_assessment: typeof RiskAssessmentSchema;
  risk: typeof RiskSchema;
  review: typeof ReviewSchema;
  chat: typeof ChatSchema;
};
export const SCHEMAS: Schemas = { opinion: OpinionSchema, research: ResearchSchema, rebuttal: RebuttalSchema, lead: LeadSchema, risk: RiskSchema, risk_assessment: RiskAssessmentSchema, review: ReviewSchema, chat: ChatSchema };
export type TaskKind = keyof Schemas;

export const SCHEMA_HINTS: Record<TaskKind, string> = {
  opinion: '{"stance":"LONG|SHORT|NEUTRAL","confidence":0..1,"argument":"max 2 sentences","entryScenarioId":"Strategist: supplied scenario id","entryZone":{"low":number,"high":number,"basis":"verified structure"},"invalidationLevel":number,"exitSignal":{"kind":"MOMENTUM_EXHAUSTION|TARGET_COMPLETE","evidenceRefs":["supplied evidence id"]}}. Entry fields are required for a Strategist directional setup. Market/Strategist may supply exitSignal only from observed evidence.',
  research: '{"vote":"LONG|SHORT|ABSTAIN|VETO","confidence":0..1,"argument":"max 2 sentences, <=1500 characters","sources":["concise supplied source id or name, <=120 characters each; at most 10"],"sourceDetails":[{"label":"matching sources[] label","citation":"full original citation or URL, <=8192 characters"}]}. Preserve full citations and URLs in sourceDetails when a concise label is used. Never invent a source or change its identity.',
  rebuttal: '{"stance":"LONG|SHORT|NEUTRAL","confidence":0..1,"target":"agent id you answer or none","rebuttal":"max 2 sentences, direct and in character"}',
  lead: '{"action":"OPEN_LONG|OPEN_SHORT|CLOSE|HOLD","confidence":0..1,"reason":"max 2 sentences","entryScenarioId":"selected supplied scenario id","entryZone":{"low":number,"high":number,"basis":"supplied setup"},"invalidationLevel":number,"closeTrigger":"one supplied verified CloseTriggerReason","exitSignal":{"kind":"MOMENTUM_EXHAUSTION|TARGET_COMPLETE","evidenceRefs":["supplied evidence id"]}}. Entry zones are recommendations unless explicitly binding in the Owner settings. A final OPEN means execute now; use HOLD explicitly to wait for a pullback. Preserve valid structural invalidation. CLOSE must identify one supplied verified trigger; free-text reasoning alone cannot authorize a close.',
  risk_assessment: '{"decision":"APPROVE|REJECT","reason":"specific risk assessment from the supplied evidence"}. Owner sizing, leverage and SL/TP are fixed inputs, not model outputs.',
  risk: '{"decision":"APPROVE|REDUCE|REJECT","sizeFactor":0..1,"leverage":1..125,"stopPct":positive percentage points up to 50 (2 means 2%),"reason":"1..1500 characters"}. APPROVE/REDUCE require all numeric fields as JSON numbers. REJECT may omit sizing. Never substitute null or strings for numbers.',
  review: '{"lesson":"one sentence","grade":"A|B|C|D|F"}',
  chat: '{"reply":"answer in character, up to 64000 characters","commandToExecute":"optional exact supported command explicitly requested by Boss","askTeammates":[{"to":"lead|market|research|strategist|risk|execution","question":"one assigned question","symbol":"optional symbol"}],"askTeammate":"legacy single request object or null"}. Use structured askTeammates for real consultation. Never claim completed handoffs before receiving their results.'
};

// Pull the first JSON object out of a model reply (handles ```json fences and chatter).
export function extractJson(raw: string, task?: TaskKind): unknown {
  let s = raw.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced && fenced[1]) {
    const candidate = fenced[1].trim();
    try {
      const parsed = JSON.parse(candidate);
      return task === 'chat' && typeof parsed === 'string' ? { reply: parsed } : parsed;
    } catch {
      const subStart = candidate.indexOf('{');
      if (subStart >= 0) {
        try {
          const subParsed = JSON.parse(candidate.slice(subStart));
          return task === 'chat' && typeof subParsed === 'string' ? { reply: subParsed } : subParsed;
        } catch { /* continue */ }
      }
    }
  }
  s = s.replace(/^```(?:json|markdown)?/i, '').replace(/```$/, '').trim();
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
