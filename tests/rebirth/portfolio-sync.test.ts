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
import { availableFinancialField, unavailableFinancialField } from '../../server/v2/contracts.js';

describe('Portfolio Balance and Safety Net Synchronization', () => {
  async function withTestApp(fn: (baseUrl: string, runtime: any, settings: SettingsService) => Promise<void>) {
    const dbFile = path.join(os.tmpdir(), `test-port-${Date.now()}-${randomUUID()}.sqlite`);
    const store = await RuntimeStore.open(dbFile);
    const secrets = new SecretStore({ allowWrite: false });
    const settings = await SettingsService.initialize(store, secrets, {});
    const accounts = new AccountRegistry();
    const runtime = createReplacementRuntime({
      initialMode: 'LIVE',
      settings
    });
    const app = createReplacementApp(runtime, {
      setupDeps: { settings, secrets, accounts }
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      await fn(baseUrl, runtime, settings);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.close();
      try { rmSync(dbFile, { force: true }); } catch {}
    }
  }

  it('initializes LIVE runtime with venue financial balance and confirmed venueAccount', () => {
    const runtime = createReplacementRuntime({
      initialMode: 'LIVE',
      initialFinancial: {
        balance: availableFinancialField(8.64),
        equity: availableFinancialField(8.64),
        availableBalance: availableFinancialField(8.64),
        realizedPnl: unavailableFinancialField(),
        unrealizedPnl: unavailableFinancialField()
      }
    });

    const snap = runtime.snapshot();
    expect(snap.mode).toBe('LIVE');
    expect(snap.paper.balance).toBe(8.64);
    expect(snap.paper.equity).toBe(8.64);
    expect(snap.venueAccount).not.toBeNull();
    expect(snap.venueAccount?.status).toBe('confirmed');
    expect(snap.venueAccount?.equity).toBe(8.64);
    expect(snap.venueAccount?.available).toBe(8.64);
  });

  it('updates balance, equity, and venueAccount on "set balance 8.64"', async () => {
    await withTestApp(async (_baseUrl, runtime) => {
      const res = await runtime.handleCommand({ text: 'set balance 8.64' });
      expect(res.ok).toBe(true);

      const snap = runtime.snapshot();
      expect(snap.paper.balance).toBe(8.64);
      expect(snap.paper.equity).toBe(8.64);
      expect(snap.venueAccount).not.toBeNull();
      expect(snap.venueAccount?.status).toBe('confirmed');
      expect(snap.venueAccount?.equity).toBe(8.64);
      expect(snap.financial.balance.value).toBe(8.64);
    });
  });

  it('updates safety net and recalculates money trade on "set safety 1"', async () => {
    await withTestApp(async (_baseUrl, runtime) => {
      await runtime.handleCommand({ text: 'set balance 8.64' });
      const res = await runtime.handleCommand({ text: 'set safety 1' });
      expect(res.ok).toBe(true);

      const snap = runtime.snapshot();
      expect(snap.paper.safetyNet).toBe(1);
      expect(snap.paper.moneyTrade).toBe(7.64);
      expect(snap.paper.canOpen).toBe(true);
    });
  });

  it('updates slots N and recalculates per order on "set n 1"', async () => {
    await withTestApp(async (_baseUrl, runtime) => {
      await runtime.handleCommand({ text: 'set balance 8.64' });
      await runtime.handleCommand({ text: 'set safety 1' });
      const res = await runtime.handleCommand({ text: 'set n 1' });
      expect(res.ok).toBe(true);

      const snap = runtime.snapshot();
      expect(snap.paper.n).toBe(1);
      expect(snap.paper.perOrder).toBe(7.64);
      expect(snap.accountState?.maxPositions).toBe(1);
    });
  });

  it('processes command over HTTP POST /api/command for "set balance 8.64"', async () => {
    await withTestApp(async (baseUrl, runtime) => {
      const res = await fetch(`${baseUrl}/api/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host: '127.0.0.1' },
        body: JSON.stringify({ text: 'set balance 8.64' })
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { ok: boolean; command: string };
      expect(data.ok).toBe(true);

      const snap = runtime.snapshot();
      expect(snap.paper.balance).toBe(8.64);
    });
  });
});
