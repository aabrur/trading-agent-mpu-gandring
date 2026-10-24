import type { AgentId } from './types';

export interface DeskProp {
  asset: string;
  x: number;
  y: number;
  width: number;
  rotate?: number;
}

export interface DeskScreen {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DeskSet {
  base: string;
  aspect: string;
  width?: number;
  monitor?: { x: number; y: number; width: number };
  screen?: DeskScreen;
  props: DeskProp[];
}

export const DESK_SETS: Record<AgentId, DeskSet> = {
  lead: {
    base: 'mg_prop_lead_desk',
    aspect: '1584 / 927',
    width: 20.6,
    props: [
      { asset: 'mg_item_leadership_journal', x: 14, y: 10, width: 19 },
      { asset: 'mg_item_desk_lantern', x: 34, y: 4, width: 13 },
      { asset: 'mg_item_desk_bell', x: 49, y: 16, width: 13 },
      { asset: 'mg_item_coffee_mug_terracotta', x: 64, y: 14, width: 12 },
    ],
  },
  market: {
    base: 'mg_prop_market_workstation',
    aspect: '519 / 451',
    width: 17.6,
    screen: { x: 25, y: 11, width: 29, height: 18 },
    props: [
      { asset: 'mg_item_analyst_headset', x: 64, y: 40, width: 18 },
      { asset: 'mg_item_coffee_mug_dustyblue', x: 82, y: 32, width: 13 },
    ],
  },
  research: {
    base: 'mg_prop_research_desk',
    aspect: '698 / 459',
    width: 20.6,
    props: [
      { asset: 'mg_item_reading_glasses', x: 8, y: 40, width: 17 },
      { asset: 'mg_item_coffee_mug_sage', x: 25, y: 30, width: 13 },
      { asset: 'mg_item_bookmarks', x: 44, y: 40, width: 12 },
    ],
  },
  strategist: {
    base: 'mg_prop_strategy_workbench',
    aspect: '568 / 412',
    width: 19.6,
    props: [
      { asset: 'mg_item_rolled_chart', x: 18, y: 40, width: 20, rotate: -8 },
      { asset: 'mg_item_token_medallion', x: 38, y: 44, width: 12 },
    ],
  },
  risk: {
    base: 'mg_prop_risk_desk',
    aspect: '679 / 521',
    width: 20.2,
    props: [
      { asset: 'mg_item_cactus_ornament', x: 38, y: 38, width: 12 },
      { asset: 'mg_item_approval_stamp', x: 64, y: 34, width: 11 },
    ],
  },
  execution: {
    base: 'mg_prop_execution_terminal',
    aspect: '496 / 471',
    width: 16.8,
    screen: { x: 24, y: 17, width: 41, height: 22 },
    props: [
      { asset: 'mg_item_execution_stopwatch', x: 64, y: 58, width: 12 },
      { asset: 'mg_item_trading_ticket', x: 78, y: 60, width: 15, rotate: 6 },
    ],
  },
};
