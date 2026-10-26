/**
 * Minimal ROI Time-Decay Matrix for Mpu Gandring.
 *
 * Clean-room TypeScript implementation inspired by Freqtrade's minimal_roi table:
 * - Dynamically adjusts target profit requirements as trade duration increases.
 * - Secures quick wins during explosive momentum, while reducing target expectation
 *   over time to release capital from stagnant positions before reversals occur.
 */

export interface MinimalRoiTier {
  minutes: number;
  minRoiPct: number; // e.g. 3.0 for +3%
}

export type MinimalRoiTable = MinimalRoiTier[];

export const DEFAULT_MINIMAL_ROI_TABLE: MinimalRoiTable = [
  { minutes: 0, minRoiPct: 3.5 },
  { minutes: 15, minRoiPct: 2.2 },
  { minutes: 30, minRoiPct: 1.5 },
  { minutes: 60, minRoiPct: 0.8 },
  { minutes: 120, minRoiPct: 0.3 },
  { minutes: 240, minRoiPct: 0.0 }, // Breakeven exit after 4 hours of inactivity
];

export class MinimalRoiEngine {
  private table: MinimalRoiTable;

  constructor(table: MinimalRoiTable = DEFAULT_MINIMAL_ROI_TABLE) {
    // Sort descending by minutes so we can easily find the active tier
    this.table = [...table].sort((a, b) => b.minutes - a.minutes);
  }

  /**
   * Returns the minimum ROI percentage required for a trade of the given age (in minutes).
   */
  public getRequiredRoi(durationMinutes: number): number {
    for (const tier of this.table) {
      if (durationMinutes >= tier.minutes) {
        return tier.minRoiPct;
      }
    }
    // Default fallback to the lowest duration tier
    return this.table.length > 0 ? this.table[this.table.length - 1].minRoiPct : 1.0;
  }

  /**
   * Evaluates if a trade meets the time-decay take profit criteria.
   */
  public shouldTakeProfit(durationMinutes: number, currentRoiPct: number): boolean {
    const required = this.getRequiredRoi(durationMinutes);
    return currentRoiPct >= required;
  }
}
