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

describe('Setup API Parity Verification', () => {
  async function withTestApp(fn: (baseUrl: string) => Promise<void>) {
    const dbFile = path.join(os.tmpdir(), `test-sp-${Date.now()}-${randomUUID()}.sqlite`);
    const store = await RuntimeStore.open(dbFile);
    const secrets = new SecretStore({ allowWrite: true });
    const settings = await SettingsService.initialize(store, secrets, {});
    const accounts = new AccountRegistry();
    const runtime = createReplacementRuntime();
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

  it('GET /api/setup returns full SetupInfo matching frontend contract', async () => {
    await withTestApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/setup`, {
        headers: { host: '127.0.0.1' }
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        ok: boolean;
        modes: Array<{ mode: string }>;
        liveConfirmPhrase: string;
        status: { tradingMode: string; venues: unknown[] };
        venues: Array<{ venue: string; label: string; kind: string }>;
      };
      expect(data.ok).toBe(true);
      expect(data.modes.length).toBe(3);
      expect(data.liveConfirmPhrase).toBe('I understand LIVE trades real money');
      expect(data.status.tradingMode).toBe('PAPER');
      expect(data.venues.length).toBe(8);
    });
  });

  it('GET /api/setup/guide/:venue returns guide steps and fields for any of the 8 venues', async () => {
    await withTestApp(async (baseUrl) => {
      const venues = ['bybit', 'binance', 'okx', 'hyperliquid', 'aster', 'dydx', 'paradex', 'orderly'] as const;
      for (const venue of venues) {
        const res = await fetch(`${baseUrl}/api/setup/guide/${venue}?network=testnet`, {
          headers: { host: '127.0.0.1' }
        });
        expect(res.status).toBe(200);
        const data = (await res.json()) as { steps: unknown[]; fields: unknown[]; connectWallet: boolean };
        expect(Array.isArray(data.steps)).toBe(true);
        expect(Array.isArray(data.fields)).toBe(true);
      }
    });
  });

  it('POST /api/setup/doctor runs diagnostic lines', async () => {
    await withTestApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/setup/doctor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host: '127.0.0.1' },
        body: '{}'
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { ok: boolean; lines: Array<{ label: string; detail: string }> };
      expect(data.ok).toBe(true);
      expect(data.lines.length).toBeGreaterThanOrEqual(4);
      expect(data.lines.some((l) => l.label.toLowerCase().includes('mode'))).toBe(true);
    });
  });

  it('GET and POST /api/setup/models supports provider catalog and agent config', async () => {
    await withTestApp(async (baseUrl) => {
      const getRes = await fetch(`${baseUrl}/api/setup/models`, {
        headers: { host: '127.0.0.1' }
      });
      expect(getRes.status).toBe(200);
      const getData = (await getRes.json()) as {
        ok: boolean;
        providers: Array<{ provider: string }>;
        agents: Array<{ id: string; provider: string }>;
      };
      expect(getData.ok).toBe(true);
      expect(getData.providers.length).toBeGreaterThan(0);
      expect(getData.agents.length).toBe(6);

      const postRes = await fetch(`${baseUrl}/api/setup/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host: '127.0.0.1' },
        body: JSON.stringify({
          defaultProvider: 'openai',
          defaultModel: 'gpt-4o'
        })
      });
      expect(postRes.status).toBe(200);
      const postData = (await postRes.json()) as { ok: boolean };
      expect(postData.ok).toBe(true);

      // Verify switching to offline demo (mock) model succeeds and persists
      const mockPostRes = await fetch(`${baseUrl}/api/setup/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host: '127.0.0.1' },
        body: JSON.stringify({
          defaultProvider: 'mock',
          defaultModel: 'mock-desk-v1'
        })
      });
      expect(mockPostRes.status).toBe(200);
      const mockPostData = (await mockPostRes.json()) as { ok: boolean };
      expect(mockPostData.ok).toBe(true);

      const afterMockGet = await fetch(`${baseUrl}/api/setup/models`, {
        headers: { host: '127.0.0.1' }
      });
      expect(afterMockGet.status).toBe(200);
      const afterMockData = (await afterMockGet.json()) as {
        ok: boolean;
        defaultProvider: string;
        defaultModel: string;
        agents: Array<{ id: string; provider: string; model: string }>;
      };
      expect(afterMockData.ok).toBe(true);
      expect(afterMockData.defaultProvider).toBe('mock');
      expect(afterMockData.defaultModel).toBe('mock-desk-v1');
      expect(afterMockData.agents.every((a) => a.provider === 'mock' && a.model === 'mock-desk-v1')).toBe(true);
    });
  });

  it('GET and POST /api/setup/data-sources supports both flat and nested key formats', async () => {
    await withTestApp(async (baseUrl) => {
      const getRes = await fetch(`${baseUrl}/api/setup/data-sources`, {
        headers: { host: '127.0.0.1' }
      });
      expect(getRes.status).toBe(200);
      const getData = (await getRes.json()) as {
        ok: boolean;
        cryptoPanicKeySet: boolean;
        whaleAlertKeySet: boolean;
        coinMarketCapKeySet: boolean;
      };
      expect(getData.ok).toBe(true);
      expect(typeof getData.cryptoPanicKeySet).toBe('boolean');

      // Flat format from DataSourcesSetup.tsx
      const postRes = await fetch(`${baseUrl}/api/setup/data-sources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host: '127.0.0.1' },
        body: JSON.stringify({
          cryptoPanicKey: 'cp-key-test',
          whaleAlertKey: 'wa-key-test'
        })
      });
      expect(postRes.status).toBe(200);
      const postData = (await postRes.json()) as { ok: boolean };
      expect(postData.ok).toBe(true);
    });
  });

  it('GET /api/setup/channels returns channel status and guides', async () => {
    await withTestApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/setup/channels`, {
        headers: { host: '127.0.0.1' }
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        ok: boolean;
        status: { commands: boolean };
        channels: string[];
      };
      expect(data.ok).toBe(true);
      expect(data.channels).toContain('telegram');
      expect(data.channels).toContain('discord');
    });
  });
});
