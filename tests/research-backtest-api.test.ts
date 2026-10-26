import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mountResearchRoutes } from '../server/research/routes.js';
import { Desk } from '../server/desk.js';
import { loadConfig } from '../server/config.js';
import { makeCaller } from '../server/providers/index.js';

describe('Research Backtest HTTP API', () => {
  const cfg = loadConfig();
  const desk = new Desk(cfg, makeCaller(cfg), { reportsDir: null });
  const app = express();
  mountResearchRoutes(app, desk);

  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('rejects external or unauthenticated host origins', async () => {
    const res = await fetch(`${base}/api/research/backtest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://malicious-site.com',
      },
      body: JSON.stringify({ symbol: 'BTCUSDT' }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it('runs a backtest via POST /api/research/backtest with custom candles and returns metrics', async () => {
    const baseTime = 1700000000000;
    const candles = [
      { timestamp: baseTime, open: 100, high: 102, low: 99, close: 101, volume: 100 },
      { timestamp: baseTime + 60_000, open: 101, high: 105, low: 100, close: 104, volume: 150 },
      { timestamp: baseTime + 120_000, open: 104, high: 107, low: 103, close: 106, volume: 200 },
      { timestamp: baseTime + 180_000, open: 106, high: 108, low: 105, close: 107, volume: 250 },
      { timestamp: baseTime + 240_000, open: 107, high: 110, low: 106, close: 109, volume: 300 },
    ];

    const res = await fetch(`${base}/api/research/backtest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        symbol: 'BTCUSDT',
        initialCapital: 1000,
        slippageBps: 5,
        candles,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.symbol).toBe('BTCUSDT');
    expect(body.metrics).toBeDefined();
    expect(body.metrics.initialCapital).toBe(1000);
    expect(typeof body.metrics.finalEquity).toBe('number');
    expect(typeof body.metrics.netPnL).toBe('number');
  });
});
