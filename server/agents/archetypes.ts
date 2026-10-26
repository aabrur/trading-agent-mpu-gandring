/**
 * Investor Archetype Modifiers for Mpu Gandring.
 *
 * Clean-room TypeScript implementation inspired by virattt/ai-hedge-fund:
 * - Four distinctive investing paradigms: Buffett, Soros, Simons, Lynch.
 * - Enriches debater agents with philosophical depth and sharp rhetoric without altering core roles.
 * - Preserves the 6-agent roster: Lead, Market, Research, Strategist, Risk, Execution.
 */

export type ArchetypeId = 'buffett' | 'soros' | 'simons' | 'lynch';

export interface InvestorArchetype {
  id: ArchetypeId;
  name: string;
  moniker: string;
  philosophy: string;
  preferredHorizon: string;
  keyMetrics: string[];
  debateStyle: string;
  rhetoricalAttacks: string[];
}

export const ARCHETYPES: Record<ArchetypeId, InvestorArchetype> = {
  buffett: {
    id: 'buffett',
    name: 'Warren Buffett',
    moniker: 'Value & Margin of Safety',
    philosophy: 'Focus on durable competitive advantage, cash flow generation, and deep margin of safety. Reject speculative hype and ephemeral momentum.',
    preferredHorizon: 'Swing to Position',
    keyMetrics: ['Cash balance', 'Moat resilience', 'Margin of safety', 'Overvaluation risk'],
    debateStyle: 'Skeptical, conservative, dismissive of shallow momentum bubbles.',
    rhetoricalAttacks: [
      'You are paying a massive premium for speculative air with zero margin of safety.',
      'Price is what you pay; value is what you get. This tape is purely greedy FOMO.',
      'When the tide turns, your leveraged long will be completely exposed.'
    ]
  },
  soros: {
    id: 'soros',
    name: 'George Soros',
    moniker: 'Reflexivity & Dynamic Regime',
    philosophy: 'Markets are inherently biased. Boom-bust feedback loops occur when prices influence fundamentals and market perceptions alter reality.',
    preferredHorizon: 'Tactical Trend & Breakout',
    keyMetrics: ['Reflexive momentum', 'Sentiment divergence', 'Liquidity cascade risk', 'Regime shifts'],
    debateStyle: 'Aggressive, opportunistic, attacking complacency on either side.',
    rhetoricalAttacks: [
      'You fail to understand reflexivity: the liquidity cascade itself is driving the new reality.',
      'Your static valuation model is blind to the vicious feedback loop unfolding right now.',
      'When market bias diverges this violently from consensus, a sharp re-pricing is guaranteed.'
    ]
  },
  simons: {
    id: 'simons',
    name: 'Jim Simons',
    moniker: 'Quantitative & Statistical Invariance',
    philosophy: 'Disregard human storytelling. Market anomalies exist only as statistical probability distributions, factor momentum, and mean-reversion signals.',
    preferredHorizon: 'Systematic Algorithmic',
    keyMetrics: ['Alpha158 composite score', 'Volatility Z-score', 'ATR expansion', 'Order flow delta'],
    debateStyle: 'Cold, clinical, data-driven, demolishing emotional narratives with numbers.',
    rhetoricalAttacks: [
      'Your thesis is an emotional bedtime story unsupported by quantitative factor distributions.',
      'The statistical expectancy here is negative; you are gambling against empirical odds.',
      'Alpha composite score and volume delta completely contradict your directional bias.'
    ]
  },
  lynch: {
    id: 'lynch',
    name: 'Peter Lynch',
    moniker: 'Growth at Reasonable Price (GARP)',
    philosophy: 'Invest in what is visibly adopted and simple to understand. Strong growth catalysts combined with fair entry prices create explosive asymmetric payoffs.',
    preferredHorizon: 'Catalyst-Driven Swing',
    keyMetrics: ['On-chain active address growth', 'Protocol fee generation', 'Catalyst freshness', 'Simple utility'],
    debateStyle: 'Pragmatic, observant, focusing on real-world catalyst evidence.',
    rhetoricalAttacks: [
      'Where is the actual user adoption or protocol revenue to back up this grand vision?',
      'If you cannot explain why a regular user needs this token in two sentences, it is pure fluff.',
      'The catalyst has already been priced in; smart money is using you as exit liquidity.'
    ]
  }
};

/**
 * Retrieves archetype definition by identifier.
 */
export function getArchetype(id: string): InvestorArchetype | undefined {
  const norm = id.toLowerCase().trim() as ArchetypeId;
  return ARCHETYPES[norm];
}

/**
 * Formats archetype guidance prompt to inject into debater reasoning context.
 */
export function formatArchetypePrompt(id: ArchetypeId): string {
  const arch = ARCHETYPES[id];
  if (!arch) return '';

  return [
    `Debate Lens: ${arch.name} (${arch.moniker})`,
    `Philosophy: ${arch.philosophy}`,
    `Evaluation Focus: ${arch.keyMetrics.join(', ')}`,
    `Debate Posture: ${arch.debateStyle}`
  ].join('\n');
}
