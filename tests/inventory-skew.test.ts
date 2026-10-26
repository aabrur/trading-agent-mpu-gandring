import { describe, expect, it } from 'vitest';
import { InventorySkewEngine } from '../server/live/inventory-skew.js';

describe('Microstructure Inventory Skew Quoting Engine', () => {
  it('calculates balanced skew when portfolio has equal long and short notional', () => {
    const engine = new InventorySkewEngine();
    const positions = [
      { symbol: 'BTCUSDT', side: 'LONG' as const, notional: 500 },
      { symbol: 'ETHUSDT', side: 'SHORT' as const, notional: 500 },
    ];

    const skew = engine.calculateSkew(positions, 2000);
    expect(skew).toBe(0);

    const quote = engine.generateQuote(100, 0.02, positions, 2000);
    expect(quote.skew).toBe(0);
    expect(quote.regime).toBe('BALANCED');
    expect(quote.longSizeMultiplier).toBe(1.0);
    expect(quote.shortSizeMultiplier).toBe(1.0);
    expect(quote.reservationPrice).toBe(100);
  });

  it('widens bid spread and throttles buy sizing when heavily long', () => {
    const engine = new InventorySkewEngine({ riskAversionGamma: 0.2, baseSpreadBps: 10, maxSkewSpreadMultiplier: 2.5 });
    const positions = [
      { symbol: 'BTCUSDT', side: 'LONG' as const, notional: 1600 },
    ];

    const quote = engine.generateQuote(100, 0.05, positions, 2000);
    expect(quote.skew).toBe(0.8); // 80% long skew
    expect(quote.regime).toBe('HEAVY_LONG');

    // Reservation price drops below mid to encourage selling
    expect(quote.reservationPrice).toBeLessThan(100);

    // Buy sizing is heavily throttled
    expect(quote.longSizeMultiplier).toBeLessThanOrEqual(0.20);
    expect(quote.shortSizeMultiplier).toBe(1.0); // Can freely short to rebalance
  });

  it('widens ask spread and throttles short sizing when heavily short', () => {
    const engine = new InventorySkewEngine();
    const positions = [
      { symbol: 'BTCUSDT', side: 'SHORT' as const, notional: 1500 },
    ];

    const quote = engine.generateQuote(200, 0.03, positions, 2000);
    expect(quote.skew).toBe(-0.75); // 75% short skew
    expect(quote.regime).toBe('HEAVY_SHORT');

    // Reservation price rises above mid to encourage buying back
    expect(quote.reservationPrice).toBeGreaterThan(200);

    // Short sizing is heavily throttled
    expect(quote.shortSizeMultiplier).toBeLessThanOrEqual(0.25);
    expect(quote.longSizeMultiplier).toBe(1.0);
  });
});
