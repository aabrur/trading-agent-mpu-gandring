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

// The base is painted in diagonal projection; the eastern sprite is mirrored,
// while labels and live monitor content keep their reading direction.
export const DESK_SETS: Record<AgentId, DeskSet> = {
  lead: { base: 'mg_desk_diagonal_v3', aspect: '16 / 9', width: 27,
    monitor: { x: 46, y: 19, width: 24 },
    props: [{ asset: 'mg_item_desk_lantern', x: 17, y: 5, width: 12 }] },
  market: { base: 'mg_desk_diagonal_v3', aspect: '16 / 9', width: 27,
    monitor: { x: 28, y: 19, width: 28 },
    props: [{ asset: 'mg_item_analyst_headset', x: 60, y: 29, width: 12 }] },
  research: { base: 'mg_desk_diagonal_v3', aspect: '16 / 9', width: 27,
    monitor: { x: 46, y: 19, width: 24 },
    props: [{ asset: 'mg_item_strategy_notebook', x: 33, y: 28, width: 13 }] },
  strategist: { base: 'mg_desk_diagonal_v3', aspect: '16 / 9', width: 27,
    monitor: { x: 28, y: 19, width: 28 },
    props: [{ asset: 'mg_item_rolled_chart', x: 57, y: 30, width: 16 }] },
  risk: { base: 'mg_desk_diagonal_v3', aspect: '16 / 9', width: 27,
    monitor: { x: 46, y: 19, width: 24 },
    props: [{ asset: 'mg_item_approval_stamp', x: 34, y: 28, width: 9 }] },
  execution: { base: 'mg_desk_diagonal_v3', aspect: '16 / 9', width: 27,
    monitor: { x: 28, y: 19, width: 28 },
    props: [{ asset: 'mg_item_execution_stopwatch', x: 60, y: 25, width: 10 }] },
};
