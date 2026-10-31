import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createReplacementRuntime } from '../../server/v2/runtime.js';
import { createReplacementApp } from '../../server/v2/app.js';
import { SettingsService } from '../../server/v2/settings/service.js';
import { SecretStore } from '../../server/v2/settings/secrets.js';
import { RuntimeStore } from '../../server/v2/store/database.js';
import { AccountRegistry } from '../../server/v2/accounts/registry.js';

describe('TradingView Webhook Integration', () => {
  async function withTestApp(
    setupSecret: string | null,
    fn: (baseUrl: string) => Promise<void>
  ) {
    const dbFile = path.join(os.tmpdir(), `test-tv-${Date.now()}-${randomUUID()}.sqlite`);
    const store = await RuntimeStore.open(dbFile);
    const secrets = new SecretStore({
      allowWrite: false,
      initialSecrets: setupSecret ? { TRADINGVIEW_PASSPHRASE: setupSecret } : {}
    });
    const settings = await SettingsService.initialize(store, secrets, {
      TRADINGVIEW_WEBHOOK: setupSecret ? 'true' : 'false',
      TRADINGVIEW_PASSPHRASE: setupSecret ?? undefined
    });
    const accounts = new AccountRegistry();
    const runtime = createReplacementRuntime({
      env: setupSecret ? { TRADINGVIEW_PASSPHRASE: setupSecret, TRADINGVIEW_WEBHOOK: 'true' } : {}
    });
    const app = createReplacementApp(runtime, {
      setupDeps: { settings, secrets, accounts }
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      await fn(baseUrl);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.close();
      try { rmSync(dbFile, { force: true }); } catch {}
    }
  }

  it('rejects with 404 when webhook is disabled or passphrase unconfigured', async () => {
    await withTestApp(null, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/tradingview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          passphrase: 'wrong',
          symbol: 'BTCUSDT',
          action: 'buy'
        })
      });
      expect(res.status).toBe(404);
      const data = (await res.json()) as { ok: boolean; error: string };
      expect(data.ok).toBe(false);
      expect(data.error).toContain('TradingView webhook is off');
    });
  });

  it('rejects with 401 when passphrase does not match', async () => {
    await withTestApp('secret123', async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/tradingview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          passphrase: 'wrong-passphrase',
          symbol: 'BTCUSDT',
          action: 'buy'
        })
      });
      expect(res.status).toBe(401);
      const data = (await res.json()) as { ok: boolean; error: string };
      expect(data.ok).toBe(false);
      expect(data.error).toContain('bad request or passphrase');
    });
  });

  it('accepts valid alert and sanitizes prefix like BYBIT:BTCUSDT.P', async () => {
    await withTestApp('secret123', async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/tradingview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          passphrase: 'secret123',
          symbol: 'BYBIT:BTCUSDT.P',
          action: 'OPEN_LONG',
          price: 91500,
          note: 'Breakout above range'
        })
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { ok: boolean; symbol: string; action: string; price: number };
      expect(data.ok).toBe(true);
      expect(data.symbol).toBe('BTCUSDT');
      expect(data.action).toBe('open_long');
      expect(data.price).toBe(91500);
    });
  });

  it('enforces rate limiting per symbol', async () => {
    await withTestApp('secret123', async (baseUrl) => {
      const callAlert = () =>
        fetch(`${baseUrl}/api/tradingview`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            passphrase: 'secret123',
            symbol: 'ETHUSDT',
            action: 'buy'
          })
        });

      const first = await callAlert();
      expect(first.status).toBe(200);

      const second = await callAlert();
      expect(second.status).toBe(429);
      const data = (await second.json()) as { ok: boolean; error: string };
      expect(data.error).toContain('one alert per symbol per minute');
    });
  });
});
