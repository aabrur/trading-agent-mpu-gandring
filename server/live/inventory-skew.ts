/**
 * Microstructure Inventory Skew Quoting Engine for Mpu Gandring.
 *
 * Clean-room TypeScript implementation inspired by hummingbot/hummingbot:
 * - Dynamic inventory skew calculation based on current net open exposure vs total capital.
 * - Avellaneda-Stoikov reservation price shift:
 *     r(s) = midPrice - (skew * gamma * volatility^2 * midPrice)
 * - Asymmetric spread and sizing modulation:
 *     - Excess LONG inventory widens bid spread, tightens ask spread, and shrinks buy order sizes.
 *     - Excess SHORT inventory widens ask spread, tightens bid spread, and shrinks sell order sizes.
 * - Sizing multiplier ensures capital is never concentrated beyond risk tolerance.
 */

export interface InventoryPosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  notional: number; // in quote currency (USDT)
}

export interface InventorySkewConfig {
  riskAversionGamma?: number; // Avellaneda-Stoikov gamma (default 0.15)
  baseSpreadBps?: number; // Base half-spread in basis points (default 10 bps)
  maxSkewSpreadMultiplier?: number; // Maximum spread widening factor (default 2.5)
}

export interface InventorySkewQuote {
  skew: number; // -1.0 (100% short) to +1.0 (100% long)
  reservationPrice: number;
  bidPrice: number;
  askPrice: number;
  longSizeMultiplier: number; // 0.0 to 1.0
  shortSizeMultiplier: number; // 0.0 to 1.0
  regime: 'HEAVY_LONG' | 'HEAVY_SHORT' | 'BALANCED';
}

export class InventorySkewEngine {
  private gamma: number;
  private baseSpreadBps: number;
  private maxMultiplier: number;

  constructor(config: InventorySkewConfig = {}) {
    this.gamma = config.riskAversionGamma ?? 0.15;
    this.baseSpreadBps = config.baseSpreadBps ?? 10;
    this.maxMultiplier = config.maxSkewSpreadMultiplier ?? 2.5;
  }

  /**
   * Calculates inventory skew ratio [-1.0, 1.0].
   */
  public calculateSkew(positions: InventoryPosition[], totalCapital: number): number {
    if (totalCapital <= 0) return 0;

    let longNotional = 0;
    let shortNotional = 0;

    for (const pos of positions) {
      if (pos.side === 'LONG') longNotional += pos.notional;
      else if (pos.side === 'SHORT') shortNotional += pos.notional;
    }

    const netExposure = longNotional - shortNotional;
    const rawSkew = netExposure / totalCapital;

    // Clamp between -1.0 and +1.0
    return Number(Math.max(-1.0, Math.min(1.0, rawSkew)).toFixed(4));
  }

  /**
   * Generates inventory-skewed quoting parameters and order sizing multipliers.
   */
  public generateQuote(
    midPrice: number,
    volatility: number,
    positions: InventoryPosition[],
    totalCapital: number
  ): InventorySkewQuote {
    if (midPrice <= 0) {
      throw new Error(`Invalid midPrice: ${midPrice}`);
    }

    const skew = this.calculateSkew(positions, totalCapital);
    const vol = Math.max(0.001, volatility);

    // Avellaneda-Stoikov reservation price shift
    const reservationPriceShift = skew * this.gamma * Math.pow(vol, 2) * midPrice;
    const reservationPrice = Number((midPrice - reservationPriceShift).toFixed(4));

    const halfSpread = midPrice * (this.baseSpreadBps / 10_000);

    // Spread modulation based on skew
    // When skew > 0 (long-heavy): widen bid (less eager to buy), tighten ask (eager to sell)
    // When skew < 0 (short-heavy): tighten bid (eager to cover), widen ask (less eager to short)
    const bidSpreadMultiplier = 1 + Math.max(0, skew) * (this.maxMultiplier - 1);
    const askSpreadMultiplier = 1 + Math.max(0, -skew) * (this.maxMultiplier - 1);

    const bidPrice = Number((reservationPrice - (halfSpread * bidSpreadMultiplier)).toFixed(4));
    const askPrice = Number((reservationPrice + (halfSpread * askSpreadMultiplier)).toFixed(4));

    // Sizing multipliers:
    // If long-heavy (skew > 0), long orders are throttled proportionally (1 - skew)
    // If short-heavy (skew < 0), short orders are throttled proportionally (1 - |skew|)
    const longSizeMultiplier = Number(Math.max(0.0, 1.0 - Math.max(0, skew)).toFixed(2));
    const shortSizeMultiplier = Number(Math.max(0.0, 1.0 - Math.max(0, -skew)).toFixed(2));

    let regime: 'HEAVY_LONG' | 'HEAVY_SHORT' | 'BALANCED' = 'BALANCED';
    if (skew >= 0.30) regime = 'HEAVY_LONG';
    else if (skew <= -0.30) regime = 'HEAVY_SHORT';

    return {
      skew,
      reservationPrice,
      bidPrice,
      askPrice,
      longSizeMultiplier,
      shortSizeMultiplier,
      regime,
    };
  }
}
