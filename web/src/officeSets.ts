import type { AgentId } from './types';

interface DeskProp { asset: string; x: number; y: number; width: number }
interface DeskSet { base: string; aspect: number; width?: number; monitor?: { x: number; y: number; width: number }; props: DeskProp[] }

// Full furniture bundles retain the owner's canonical names. Only loose accessories are layered.
export const DESK_SETS: Record<AgentId, DeskSet> = {
  lead: { base: 'mg_prop_lead_desk', aspect: 186 / 106, monitor: { x: 13, y: -12, width: 32 }, props: [{ asset: 'mg_item_leadership_journal', x: 70, y: 16, width: 13 }] },
  market: { base: 'mg_prop_market_workstation', aspect: 158 / 162, props: [] },
  research: { base: 'mg_prop_research_desk', aspect: 186 / 154, monitor: { x: 38, y: 20, width: 26 }, props: [] },
  strategist: { base: 'mg_prop_strategy_workbench', aspect: 189 / 167, monitor: { x: 35, y: 22, width: 26 }, props: [] },
  risk: { base: 'mg_prop_risk_desk', aspect: 174 / 145, monitor: { x: 56, y: 20, width: 26 }, props: [] },
  execution: { base: 'mg_prop_execution_terminal', aspect: 156 / 184, width: 13, props: [] }
};
