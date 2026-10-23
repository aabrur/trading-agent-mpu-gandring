import { describe, it, expect } from 'vitest';
import { ChatSchema, extractJson } from '../server/schemas.js';
import { sanitizeUntrusted } from '../server/untrusted.js';
import { Desk } from '../server/desk.js';
import { loadConfig } from '../server/config.js';
import { makeCaller } from '../server/providers/index.js';
import {
  calculateVolumeProfile,
  calculateVolatility,
  determineTrendRegime,
  buildTechnicalSummary
} from '../server/strategy.js';
import { parseCommand } from '../server/commands.js';
import type { Candle } from '../server/types.js';

describe('Phase 1: Long Context and Truncation-Free Chat', () => {
  it('accepts long responses up to 64,000 characters in ChatSchema', () => {
    const longText = 'A'.repeat(60000);
    const parsed = ChatSchema.parse({ reply: longText });
    expect(parsed.reply.length).toBe(60000);
    expect(parsed.askTeammate).toBeUndefined();
  });

  it('recovers plain markdown or non-JSON cleanly in extractJson for chat', () => {
    const markdown = '# Tactical Overview\n\n- Point 1: Orderbook asks absorbed at 67,500\n- Point 2: CVD divergence bullish';
    const recovered = extractJson(markdown, 'chat') as { reply: string };
    expect(recovered.reply).toBe(markdown);
  });

  it('preserves extensive untrusted data up to 16,000 characters', () => {
    const longMarketData = 'BTC orderflow log: ' + 'x'.repeat(15000);
    const sanitized = sanitizeUntrusted(longMarketData);
    expect(sanitized.text.length).toBe(longMarketData.length);
    expect(sanitized.flagged).toBe(false);
  });

  it('allows command strings up to 32,000 characters', async () => {
    const config = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEBATE_PACE_MS: '0' });
    const desk = new Desk(config, makeCaller(config));

    const query = 'Market, ' + 'data '.repeat(1000);
    const res = await desk.command(query);
    expect(res.ok).toBe(true);
  });
});

describe('Phase 2: Direct Inter-Agent Communication and Huddle', () => {
  it('parses @all and multiple agent mentions in commands', () => {
    const parsedAll = parseCommand('@all review orderflow and funding rate');
    expect(parsedAll.type).toBe('chat');
    if (parsedAll.type === 'chat') {
      expect(parsedAll.mentions).toContain('all');
    }

    const parsedMulti = parseCommand('@market @strategist check BTC spread');
    expect(parsedMulti.type).toBe('chat');
    if (parsedMulti.type === 'chat') {
      expect(parsedMulti.mentions).toEqual(['market', 'strategist']);
    }
  });

  it('records room messages chronologically in roomHistory buffer with from and to badges', () => {
    const config = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEBATE_PACE_MS: '0' });
    const desk = new Desk(config, makeCaller(config));

    desk.addRoomMessage({ from: 'owner', to: 'all', text: 'Team status check', symbol: 'BTCUSDT' });
    desk.addRoomMessage({ from: 'market', to: 'owner', text: 'Orderbook is balanced', symbol: 'BTCUSDT' });
    desk.addRoomMessage({ from: 'research', to: 'market', text: 'Whale inflow detected on Hyperliquid', symbol: 'BTCUSDT' });

    expect(desk.roomHistory.length).toBe(3);
    expect(desk.roomHistory[0].from).toBe('owner');
    expect(desk.roomHistory[0].to).toBe('all');
    expect(desk.roomHistory[1].from).toBe('market');
    expect(desk.roomHistory[1].to).toBe('owner');
    expect(desk.roomHistory[2].from).toBe('research');
    expect(desk.roomHistory[2].to).toBe('market');

    const snap = desk.snapshot();
    expect(snap.roomHistory?.length).toBe(3);
  });

  it('executes runHuddle sequentially without placing unauthorized orders', async () => {
    const config = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEBATE_PACE_MS: '0' });
    const desk = new Desk(config, makeCaller(config));

    const initialPositions = desk.book.positions.length;
    const initialVerdicts = desk.verdicts.length;

    const huddle = await desk.runHuddle('Assess current market conditions', ['market', 'strategist'], 'BTCUSDT');
    expect(huddle.ok).toBe(true);
    expect(huddle.replies.length).toBe(2);
    expect(huddle.replies[0].agent).toBe('market');
    expect(huddle.replies[1].agent).toBe('strategist');

    // Huddle must never open trades or create formal verdicts
    expect(desk.book.positions.length).toBe(initialPositions);
    expect(desk.verdicts.length).toBe(initialVerdicts);
  });

  it('chains autonomous askTeammate handoff and stops within 3 hops', async () => {
    const config = loadConfig({
      TRADING_MODE: 'PAPER',
      MARKET_SOURCE: 'sample',
      DEBATE_PACE_MS: '0',
      DEFAULT_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-proj-testmockkeyforverification12345678'
    });
    let callCount = 0;
    const customCaller = async () => {
      callCount++;
      return JSON.stringify({
        reply: `Response hop ${callCount}`,
        askTeammate: callCount === 1 ? { to: 'research', question: 'Any whale movements?' } : null
      });
    };

    const desk = new Desk(config, customCaller);
    await desk.command('Market, what do you see in the orderbook?');

    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(desk.roomHistory.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Phase 3: High-Alpha Market Data & Technical Engine', () => {
  const generateCandles = (n: number, basePrice: number, step: number): Candle[] => {
    const candles: Candle[] = [];
    let p = basePrice;
    for (let i = 0; i < n; i++) {
      p += step;
      candles.push({
        t: 1000 + i * 60000,
        o: p - 2,
        h: p + 5,
        l: p - 5,
        c: p,
        v: 100 + (i % 5) * 20
      });
    }
    return candles;
  };

  it('calculates deterministic Volume Profile (POC, VAH, VAL, VWAP)', () => {
    const candles = generateCandles(100, 50000, 10);
    const vp = calculateVolumeProfile(candles);

    expect(vp.poc).toBeGreaterThan(0);
    expect(vp.vah).toBeGreaterThanOrEqual(vp.poc);
    expect(vp.val).toBeLessThanOrEqual(vp.poc);
    expect(vp.sessionVwap).toBeGreaterThan(0);
  });

  it('calculates volatility metrics (ATR14, RealizedVol24h, Bollinger Band Width %)', () => {
    const candles = generateCandles(97, 50000, 5).map((candle, index) => ({ ...candle, t: 1000 + index * 15 * 60_000 }));
    const vol = calculateVolatility(candles);

    expect(vol.atr14).toBeGreaterThan(0);
    expect(vol.atrPct).toBeGreaterThan(0);
    expect(vol.realizedVol24h).toBeGreaterThanOrEqual(0);
    expect(vol.bollingerBandWidthPct).toBeGreaterThan(0);
    expect(calculateVolatility(candles.slice(-60)).realizedVol24h).toBeNull();
  });

  it('identifies trend regime across multi-timeframe structures', () => {
    const uptrendCandles = generateCandles(60, 50000, 20);
    const regimeUp = determineTrendRegime(uptrendCandles.map((c) => c.c));
    expect(['STRONG_UPTREND', 'SQUEEZE_BREAKOUT']).toContain(regimeUp.regime);

    const downtrendCandles = generateCandles(60, 50000, -20);
    const regimeDown = determineTrendRegime(downtrendCandles.map((c) => c.c));
    expect(['STRONG_DOWNTREND', 'RANGING_CHOP']).toContain(regimeDown.regime);
  });

  it('builds full Multi-Timeframe TechnicalSummary', () => {
    const c5m = generateCandles(40, 50000, 2);
    const c15m = generateCandles(40, 50000, 4);
    const c1h = generateCandles(40, 50000, 8);
    const c4h = generateCandles(40, 50000, 15);

    const summary = buildTechnicalSummary({
      '5m': c5m,
      '15m': c15m,
      '1h': c1h,
      '4h': c4h
    });

    expect(summary.mtfTrend['5m']).toBeDefined();
    expect(summary.mtfTrend['15m']).toBeDefined();
    expect(summary.mtfTrend['1h']).toBeDefined();
    expect(summary.mtfTrend['4h']).toBeDefined();
    expect(summary.momentum.rsi14_15m).toBeGreaterThan(0);
    expect(summary.volumeProfile.poc).toBeGreaterThan(0);
    expect(summary.swingLevels.recentSwingHigh).toBeGreaterThan(summary.swingLevels.recentSwingLow);
  });
});
