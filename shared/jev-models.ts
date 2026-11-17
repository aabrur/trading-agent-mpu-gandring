export interface JevDecisionModelOption {
  id: string;
  label: string;
  tier: 'top_usage' | 'top_tier';
  weeklyTokens: string;
  latency: string;
  pricePerM: string;
}

export const JEV_DECISION_MODELS: readonly JevDecisionModelOption[] = [
  // 5 Top Token Usage on OpenRouter Decisions
  { id: 'typesafe/jev-1.13', label: 'TypeSafe: Jev 1.13 (3.09T tokens · 131ms · $0.042/M)', tier: 'top_usage', weeklyTokens: '3.09T', latency: '131ms', pricePerM: '$0.042' },
  { id: 'openai/gpt-6-luna-decisions', label: 'OpenAI: GPT-6 Luna Decisions (129B tokens · 683ms · $0.10/M)', tier: 'top_usage', weeklyTokens: '129B', latency: '683ms', pricePerM: '$0.10' },
  { id: 'microsoft/microsoft-decision-1', label: 'Microsoft: Microsoft-Decision-1 (38.3B tokens · 308ms · $0.042/M)', tier: 'top_usage', weeklyTokens: '38.3B', latency: '308ms', pricePerM: '$0.042' },
  { id: 'cloudflare/clef-flash', label: 'Cloudflare: Clef Flash (29.8B tokens · 402ms · $0.019/M)', tier: 'top_usage', weeklyTokens: '29.8B', latency: '402ms', pricePerM: '$0.019' },
  { id: 'liquid/d1', label: 'LiquidAI: d1 (27.1B tokens · 168ms · $0.02/M)', tier: 'top_usage', weeklyTokens: '27.1B', latency: '168ms', pricePerM: '$0.02' },
  // 5 Top Tier on OpenRouter Decisions
  { id: 'typesafe/jev-1.14', label: 'TypeSafe: Jev 1.14 (2.31T tokens · 127ms · $0.042/M)', tier: 'top_tier', weeklyTokens: '2.31T', latency: '127ms', pricePerM: '$0.042' },
  { id: 'nace-ai/drex-v1.5', label: 'Nace.AI: Drex v1.5 (26.2B tokens · 196ms · $0.04/M)', tier: 'top_tier', weeklyTokens: '26.2B', latency: '196ms', pricePerM: '$0.04' },
  { id: 'nace-ai/drex-v2.0', label: 'Nace.AI: Drex v2.0 (12.9B tokens · 337ms · $0.06/M)', tier: 'top_tier', weeklyTokens: '12.9B', latency: '337ms', pricePerM: '$0.06' },
  { id: 'cloudflare/clef', label: 'Cloudflare: Clef (12.4B tokens · 760ms · $0.192/M)', tier: 'top_tier', weeklyTokens: '12.4B', latency: '760ms', pricePerM: '$0.192' },
  { id: 'cloudflare/clef-omni', label: 'Cloudflare: Clef Omni (2.67B tokens · 211ms · $0.15/M)', tier: 'top_tier', weeklyTokens: '2.67B', latency: '211ms', pricePerM: '$0.15' }
] as const;

export const OPENROUTER_DECISION_MODEL_IDS = new Set<string>([
  ...JEV_DECISION_MODELS.map((m) => m.id),
  'respan/span-01-lite',
  'respan/span-01-lite:free',
  'respan/span-01',
  'scaledown/classify-1',
  'jaredpalmer/kev-4b',
  'upstage/solar-decide',
  'upstage/solar-decide-flash',
  'togethercomputer/tev1-4b-experimental'
]);

export function isOpenRouterDecisionsModel(model: string): boolean {
  const m = model.trim();
  return OPENROUTER_DECISION_MODEL_IDS.has(m) || m.startsWith('typesafe/jev');
}
