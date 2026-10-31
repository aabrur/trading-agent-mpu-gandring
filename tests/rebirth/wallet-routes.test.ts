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
import { WalletService } from '../../server/v2/wallet.js';

describe('Wallet Routes and Challenge API Parity', () => {
  async function withTestApp(fn: (baseUrl: string) => Promise<void>) {
    const dbFile = path.join(os.tmpdir(), `test-wr-${Date.now()}-${randomUUID()}.sqlite`);
    const store = await RuntimeStore.open(dbFile);
    const secrets = new SecretStore({ allowWrite: false });
    const settings = await SettingsService.initialize(store, secrets, {});
    const accounts = new AccountRegistry();
    const runtime = createReplacementRuntime();
    const walletService = new WalletService({
      persistDelegatedSecret: async () => {}
    });
    const app = createReplacementApp(runtime, {
      setupDeps: { settings, secrets, accounts },
      walletDeps: { settings, secrets, walletService }
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

  it('GET /api/wallet returns available venues and loopback access status', async () => {
    await withTestApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/wallet`, {
        headers: { host: '127.0.0.1' }
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { available: boolean; venues: Array<{ venue: string; support: string }> };
      expect(data.available).toBe(true);
      expect(data.venues).toBeInstanceOf(Array);
      expect(data.venues.some((v) => v.venue === 'hyperliquid' && v.support === 'signature')).toBe(true);
      expect(data.venues.some((v) => v.venue === 'aster' && v.support === 'signature')).toBe(true);
      expect(data.venues.some((v) => v.venue === 'bybit' && v.support === 'cex')).toBe(true);
    });
  });

  it('POST /api/wallet/start generates challenge with both id and challengeId', async () => {
    await withTestApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/wallet/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host: '127.0.0.1' },
        body: JSON.stringify({
          venue: 'hyperliquid',
          network: 'testnet',
          mainAddress: '0x1111111111111111111111111111111111111111',
          chainId: 421614
        })
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { ok: boolean; id: string; challengeId: string; agentAddress: string; typedData: unknown };
      expect(data.ok).toBe(true);
      expect(data.id).toBeDefined();
      expect(data.challengeId).toBeDefined();
      expect(data.id).toBe(data.challengeId);
      expect(data.agentAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(data.typedData).toBeDefined();
    });
  });

  it('rejects payload containing secret-like data', async () => {
    await withTestApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/wallet/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host: '127.0.0.1' },
        body: JSON.stringify({
          venue: 'hyperliquid',
          network: 'testnet',
          mainAddress: '0x1111111111111111111111111111111111111111',
          chainId: 421614,
          forbiddenSecret: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
        })
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { ok: boolean; error: string };
      expect(data.ok).toBe(false);
      expect(data.error).toContain('Refusing payload containing secret');
    });
  });

  it('GET /api/wallet/balance reads public or configured balance', async () => {
    await withTestApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/wallet/balance?venue=aster&network=testnet&address=0x1111111111111111111111111111111111111111`, {
        headers: { host: '127.0.0.1' }
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { ok: boolean; venue: string; configured: boolean };
      expect(data.ok).toBe(true);
      expect(data.venue).toBe('aster');
    });
  });
});
