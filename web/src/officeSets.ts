import type { AgentId } from './types';

interface DeskProp { asset: string; x: number; y: number; width: number }
interface DeskSet { base: string; width?: number; monitor?: { x: number; y: number; width: number }; props: DeskProp[] }

// Full furniture bundles retain the owner's canonical names. Only loose accessories are layered.
export const DESK_SETS: Record<AgentId, DeskSet> = {
  lead: { base: 'mg_prop_lead_desk', monitor: { x: 13, y: -32, width: 39 }, props: [{ asset: 'mg_item_leadership_journal', x: 70, y: -4, width: 15 }] },
  market: { base: 'mg_prop_market_workstation', props: [] },
  research: { base: 'mg_prop_research_desk', monitor: { x: 38, y: -44, width: 28 }, props: [] },
  strategist: { base: 'mg_prop_strategy_workbench', monitor: { x: 35, y: -12, width: 30 }, props: [] },
  risk: { base: 'mg_prop_risk_desk', monitor: { x: 56, y: -42, width: 30 }, props: [] },
  execution: { base: 'mg_prop_execution_terminal', width: 13, props: [] }
};
