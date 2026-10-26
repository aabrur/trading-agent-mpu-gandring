import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../server/config.js';
import { Desk } from '../server/desk.js';
import { makeCaller } from '../server/providers/index.js';
import * as market from '../server/market/index.js';
import { sampleSnapshot } from '../server/market/sample.js';

describe('Autonomous Exits and Trading Freedom', () => {
  afterEach(() => vi.restoreAllMocks());

  it('allows autonomous CLOSE to lock in profits on strong momentum or pump exhaustion', async () => {
    const snap = sampleSnapshot('ETHUSDT');
    snap.candles = Array.from({ length: 70 }, (_, i) => {
      const c = 2000 + i * 5;
      return { t: Date.now() - (71 - i) * 900_000, o: c, h: c + 2, l: c - 2, c, v: 200 };
    });
    snap.last = 2345;
    snap.bid = 2344;
    snap.ask = 2346;
    snap.fetchedAt = Date.now();
    const spy = vi.spyOn(market, 'getSnapshot').mockResolvedValue(snap);
    const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEBATE_PACE_MS: '0', DEBATE_ROUNDS: '1' });
    const base = makeCaller(cfg);
    const d = new Desk(cfg, (r) => r.task === 'lead'
      ? Promise.resolve(JSON.stringify({ action: 'CLOSE', confidence: 0.9, reason: 'Take profit on surging momentum and target reached.' }))
      : base(r), { reportsDir: null, killFile: null, jevEnv: { JEV_ENABLED: 'false' } });

    d.book.open({ symbol: 'ETHUSDT', side: 'LONG', qty: 1, entry: 2100, stop: 2000, tp: 2500, margin: 210, leverage: 10 });
    try {
      const verdict = await d.runDebate('ETHUSDT');
      expect(verdict.action).toBe('CLOSE');
      expect(verdict.executed).toBe(true);
      expect(d.book.positions.filter((p) => p.symbol === 'ETHUSDT')).toHaveLength(0);
    } finally {
      d.stop();
      spy.mockRestore();
    }
  });

  it('allows autonomous CLOSE to cut risk immediately on market anomaly or adverse divergence', async () => {
    const snap = sampleSnapshot('SOLUSDT');
    snap.candles = Array.from({ length: 70 }, (_, i) => {
      const c = 150 + (i % 5);
      return { t: Date.now() - (71 - i) * 900_000, o: c, h: c + 1, l: c - 1, c, v: 100 };
    });
    snap.last = 152;
    snap.bid = 151.9;
    snap.ask = 152.1;
    snap.fetchedAt = Date.now();
    const spy = vi.spyOn(market, 'getSnapshot').mockResolvedValue(snap);
    const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEBATE_PACE_MS: '0', DEBATE_ROUNDS: '1' });
    const base = makeCaller(cfg);
    const d = new Desk(cfg, (r) => r.task === 'lead'
      ? Promise.resolve(JSON.stringify({ action: 'CLOSE', confidence: 0.85, reason: 'Market anomaly detected with adverse divergence; exit to protect capital.' }))
      : base(r), { reportsDir: null, killFile: null, jevEnv: { JEV_ENABLED: 'false' } });

    d.book.open({ symbol: 'SOLUSDT', side: 'LONG', qty: 10, entry: 151, stop: 140, tp: 170, margin: 151, leverage: 10 });
    try {
      const verdict = await d.runDebate('SOLUSDT');
      expect(verdict.action).toBe('CLOSE');
      expect(verdict.executed).toBe(true);
      expect(d.book.positions.filter((p) => p.symbol === 'SOLUSDT')).toHaveLength(0);
    } finally {
      d.stop();
      spy.mockRestore();
    }
  });

  it('enriches market analyst and other debaters with JEV context when assist is active', async () => {
    const snap = sampleSnapshot('BTCUSDT');
    const spy = vi.spyOn(market, 'getSnapshot').mockResolvedValue(snap);
    const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEBATE_PACE_MS: '0', DEBATE_ROUNDS: '1' });
    const calls: { agent?: string; task: string; user?: string }[] = [];
    const base = makeCaller(cfg);
    const okJevBody = {
      model: 'typesafe/jev-1.14',
      answers: {
        market_regime: { type: 'choice', choice: 'TREND_UP', probabilities: { TREND_UP: 0.9 }, confidence: 0.85 },
        news_relevant: { type: 'noul', noul: 0.8 },
        news_needs_research: { type: 'noul', noul: 0.2 },
        news_false_critical: { type: 'noul', noul: 0.05 },
        whale_significant: { type: 'noul', noul: 0.1 },
        material_conflict: { type: 'noul', noul: 0.0 }
      }
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(okJevBody), { status: 200 }));
    const d = new Desk(cfg, (r) => {
      calls.push({ agent: r.agent, task: r.task, user: r.user });
      return base(r);
    }, {
      reportsDir: null,
      killFile: null,
      jevFetch: fetchImpl as unknown as typeof fetch,
      jevEnv: { JEV_ENABLED: 'true', JEV_MODE: 'assist', OPENROUTER_API_KEY: 'test-key' }
    });

    try {
      await d.runDebate('BTCUSDT');
      const marketCall = calls.find((c) => c.agent === 'market');
      expect(marketCall).toBeDefined();
      expect(marketCall?.user).toContain('TREND_UP');

      const leadCall = calls.find((c) => c.agent === 'lead');
      expect(leadCall).toBeDefined();
      expect(leadCall?.user).toContain('TREND_UP');
    } finally {
      d.stop();
      spy.mockRestore();
    }
  });

  it('releases kill switch in-memory when unkill is called', () => {
    const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample' });
    const d = new Desk(cfg, makeCaller(cfg), { reportsDir: null, killFile: null });
    d.killed = true;
    d.paused = true;
    d.stopFlag = true;

    expect(d.killed).toBe(true);
    const released = d.unkill();
    expect(released).toBe(true);
    expect(d.killed).toBe(false);
    expect(d.paused).toBe(false);
    expect(d.stopFlag).toBe(false);
  });

  it('supports unkill and kill toggle via HTTP API', async () => {
    const { createApp } = await import('../server/app.js');
    const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample' });
    const { app, desk } = createApp(cfg, { reportsDir: null, killFile: null });
    const server = app.listen(0);
    const port = (server.address() as any).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      await fetch(`${base}/api/kill`, { method: 'POST' });
      expect(desk.killed).toBe(true);

      const res1 = await fetch(`${base}/api/kill`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ on: false })
      });
      const data1 = await res1.json();
      expect(data1.ok).toBe(true);
      expect(data1.killed).toBe(false);
      expect(desk.killed).toBe(false);

      await fetch(`${base}/api/kill`, { method: 'POST' });
      expect(desk.killed).toBe(true);

      const res2 = await fetch(`${base}/api/unkill`, { method: 'POST' });
      const data2 = await res2.json();
      expect(data2.ok).toBe(true);
      expect(data2.killed).toBe(false);
      expect(desk.killed).toBe(false);
    } finally {
      server.close();
      desk.stop();
    }
  });
});
