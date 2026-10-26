/**
 * Dynamic ATR-Based Trailing Stop Engine for Mpu Gandring.
 *
 * Clean-room TypeScript implementation inspired by adaptive volatility trailing stops:
 * - Volatility-adjusted trail distance using Average True Range (ATR).
 * - Activation threshold: activates only after position enters profitable territory.
 * - One-way Ratchet: stop price moves only in the direction of profit, never retreating.
 */

export interface TrailingStopConfig {
  activationRoiPct?: number; // e.g. 1.2% profit before trailing engages
  atrMultiplier?: number; // e.g. 1.5x ATR distance
  fallbackDistancePct?: number; // e.g. 1.0% distance if ATR is unavailable
}

export interface TrailingPositionState {
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  currentStopPrice: number;
  extremePriceSeen: number; // Highest price for Long, Lowest price for Short
  isActivated: boolean;
}

export class DynamicTrailingStopEngine {
  private config: Required<TrailingStopConfig>;

  constructor(config: TrailingStopConfig = {}) {
    this.config = {
      activationRoiPct: config.activationRoiPct ?? 1.2,
      atrMultiplier: config.atrMultiplier ?? 1.5,
      fallbackDistancePct: config.fallbackDistancePct ?? 1.0,
    };
  }

  /**
   * Initializes state for a newly opened position.
   */
  public initializePosition(side: 'LONG' | 'SHORT', entryPrice: number, initialStopPrice: number): TrailingPositionState {
    return {
      side,
      entryPrice,
      currentStopPrice: initialStopPrice,
      extremePriceSeen: entryPrice,
      isActivated: false,
    };
  }

  /**
   * Updates position trailing state given current price and optional ATR.
   * Returns updated stop price if adjusted, or current stop price.
   */
  public updateStop(
    state: TrailingPositionState,
    currentPrice: number,
    currentAtr?: number
  ): { newStopPrice: number; updated: boolean } {
    let updated = false;

    if (state.side === 'LONG') {
      // Track highest price seen
      if (currentPrice > state.extremePriceSeen) {
        state.extremePriceSeen = currentPrice;
      }

      // Check activation
      const currentRoiPct = ((currentPrice - state.entryPrice) / state.entryPrice) * 100;
      if (!state.isActivated && currentRoiPct >= this.config.activationRoiPct) {
        state.isActivated = true;
      }

      if (state.isActivated) {
        const trailDistance = (typeof currentAtr === 'number' && currentAtr > 0)
          ? currentAtr * this.config.atrMultiplier
          : state.extremePriceSeen * (this.config.fallbackDistancePct / 100);

        const proposedStop = state.extremePriceSeen - trailDistance;
        // Ratchet: only move stop higher
        if (proposedStop > state.currentStopPrice) {
          state.currentStopPrice = proposedStop;
          updated = true;
        }
      }
    } else {
      // Short position
      // Track lowest price seen
      if (currentPrice < state.extremePriceSeen) {
        state.extremePriceSeen = currentPrice;
      }

      // Check activation
      const currentRoiPct = ((state.entryPrice - currentPrice) / state.entryPrice) * 100;
      if (!state.isActivated && currentRoiPct >= this.config.activationRoiPct) {
        state.isActivated = true;
      }

      if (state.isActivated) {
        const trailDistance = (typeof currentAtr === 'number' && currentAtr > 0)
          ? currentAtr * this.config.atrMultiplier
          : state.extremePriceSeen * (this.config.fallbackDistancePct / 100);

        const proposedStop = state.extremePriceSeen + trailDistance;
        // Ratchet: only move stop lower
        if (proposedStop < state.currentStopPrice) {
          state.currentStopPrice = proposedStop;
          updated = true;
        }
      }
    }

    return {
      newStopPrice: Number(state.currentStopPrice.toFixed(4)),
      updated,
    };
  }
}
