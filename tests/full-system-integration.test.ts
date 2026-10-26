import { describe, expect, it } from 'vitest';
import { PointInTimeFeed } from '../server/research/pit.js';
import { calculateAlphaFactors } from '../server/market/alpha-factors.js';
import { analyzeSMC } from '../server/market/smc.js';
import { conductAdversarialDebate, type DebaterPitch } from '../server/decision/adversarial-debate.js';
import { STANDARD_CONTRACTS, evaluateContract } from '../server/decision/jev-contracts.js';
import { simulateMonteCarlo } from '../server/market/monte-carlo.js';
import { TypedEventBus } from '../server/events/event-bus.js';
import { InventorySkewEngine } from '../server/live/inventory-skew.js';
import { quantizePrice, quantizeAmount, validateNotional } from '../server/exchange/precision.js';
import { verifyRestingStopProtection } from '../server/live/resting-stop.js';
import type { ExchangeAdapter } from '../server/exchange/types.js';

describe('Full System Zero-Regression End-to-End Pipeline (Stages 1 through 5)', () => {
  it('seamlessly chains all five development stages into a unified predictive execution pipeline', async () => {
    // 1. Stage 1: Point-In-Time Market Data
    const rawCandles = Array.from({ length: 20 }, (_, i) => ({
      timestamp: (i + 1) * 1000,
      open: 100 + i * 0.5,
      high: 102 + i * 0.5,
      low: 99 + i * 0.5,
      close: 101 + i * 0.5,
      volume: 1000 + i * 50,
      closedAt: (i + 1) * 1000,
    }));
    const pitFeed = new PointInTimeFeed(rawCandles, []);
    const pitCandles = pitFeed.asOf(20000);
    expect(pitCandles.length).toBe(20);

    // 2. Stage 2: Quant Alpha158 Factors & SMC Geometry
    const alphaFactors = calculateAlphaFactors(pitCandles);
    expect(alphaFactors.compositeScore).toBeGreaterThanOrEqual(-1.0);
    expect(alphaFactors.compositeScore).toBeLessThanOrEqual(1.0);

    const smc = analyzeSMC(pitCandles);
    expect(smc).not.toBeNull();
    expect(smc?.timestamp).toBe(20000);
    expect(['BULLISH', 'BEARISH', 'RANGING']).toContain(smc?.marketTrend);

    // 3. Stage 3: Bull vs Bear Adversarial Debate & Jev Calibration
    const pitches: DebaterPitch[] = [
      { agent: 'market', name: 'Market Analyst', stance: 'LONG', confidence: 0.85, argument: 'Positive volume delta and Alpha expansion' },
      { agent: 'research', name: 'Research Analyst', stance: 'LONG', confidence: 0.75, argument: 'Protocol TVL growing organically' },
      { agent: 'strategist', name: 'Strategist', stance: 'LONG', confidence: 0.90, argument: 'Bullish BOS confirmed' },
    ];
    const debateVerdict = conductAdversarialDebate('BTCUSDT', pitches);
    expect(debateVerdict.consensus).toBe('BULL_CONSENSUS');
    expect(debateVerdict.recommendedAction).toBe('OPEN_LONG');

    const contractEvaluation = evaluateContract(STANDARD_CONTRACTS.market_regime, {
      type: 'choice',
      choice: 'TREND_UP',
      probabilities: { TREND_UP: 0.9 },
      confidence: 0.9,
    });
    expect(contractEvaluation.valid).toBe(true);

    // 4. Stage 4: Kronos Monte Carlo Forward Path Forecast
    const forecast = simulateMonteCarlo({
      candles: pitCandles,
      horizon: 6,
      numPaths: 100,
      tpPrice: 115,
      slPrice: 100,
    });
    expect(forecast.p10.length).toBe(7);
    expect(forecast.p90.length).toBe(7);
    expect(forecast.probTpFirst).toBeGreaterThanOrEqual(0);

    // 5. Stage 5: Typed Event Bus, Inventory Skew, Decimal Precision & Resting Stop Guarantee
    const bus = new TypedEventBus();
    const publishedEvents: string[] = [];
    bus.subscribeAll((ev) => publishedEvents.push(ev.type));

    // Inventory skew adjustment
    const skewEngine = new InventorySkewEngine();
    const quote = skewEngine.generateQuote(107, forecast.volatility, [], 1000);
    expect(quote.longSizeMultiplier).toBe(1.0);

    // Order execution parameters
    const tickSize = 0.01;
    const qtyStep = 0.001;
    const entryPrice = quantizePrice(107.004, tickSize);
    expect(entryPrice).toBe(107.00);

    const targetQty = quantizeAmount(0.09345, qtyStep, 0.001, 100);
    expect(targetQty.valid).toBe(true);
    expect(targetQty.amount).toBe(0.093);

    const notionalCheck = validateNotional(entryPrice, targetQty.amount, 5.0);
    expect(notionalCheck.valid).toBe(true);

    // Publish execution event
    bus.publish('ORDER', {
      symbol: 'BTCUSDT',
      side: 'LONG',
      price: entryPrice,
      qty: targetQty.amount,
      notional: notionalCheck.notional,
    });
    expect(publishedEvents).toContain('ORDER');

    // Exchange resting stop loss guarantee
    const mockLiveAdapter: Partial<ExchangeAdapter> = {
      name: 'bybit' as any,
      network: 'mainnet',
      exchangeStops: true,
      protection: async () => ({
        stop: 100.0,
        tp: 115.0,
      }),
    };
    const restingStop = await verifyRestingStopProtection(mockLiveAdapter as ExchangeAdapter, 'BTCUSDT', 'LONG', 100.0);
    expect(restingStop.status).toBe('CONFIRMED_RESTING');
  });
});
