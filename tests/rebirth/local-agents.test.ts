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

describe('Local CLI Agents Integration', () => {
  async function withTestApp(fn: (baseUrl: string) => Promise<void>) {
    const dbFile = path.join(os.tmpdir(), `test-la-${Date.now()}-${randomUUID()}.sqlite`);
    const store = await RuntimeStore.open(dbFile);
    const secrets = new SecretStore({ allowWrite: false });
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

  it('lists registered local CLI agents with installation status', async () => {
    await withTestApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/setup/local-agents`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { ok: boolean; agents: Array<{ id: string; bin: string; installed: boolean }> };
      expect(data.ok).toBe(true);
      expect(data.agents).toBeInstanceOf(Array);
      expect(data.agents.some((a) => a.id === 'claude')).toBe(true);
      expect(data.agents.some((a) => a.id === 'codex')).toBe(true);
      expect(data.agents.some((a) => a.id === 'gemini')).toBe(true);
    });
  });

  it('checks status of specific local agent', async () => {
    await withTestApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/setup/local-agents/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'codex' })
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { ok: boolean; installed: boolean; state: string };
      expect(data.ok).toBe(true);
      expect(typeof data.installed).toBe('boolean');
      expect(data.state).toBeDefined();
    });
  });

  it('provides codex research policy status and update endpoint', async () => {
    await withTestApp(async (baseUrl) => {
      const getRes = await fetch(`${baseUrl}/api/setup/local-agents/research`);
      expect(getRes.status).toBe(200);
      const getData = (await getRes.json()) as { ok: boolean; policy: Record<string, unknown> };
      expect(getData.ok).toBe(true);
      expect(getData.policy).toBeDefined();

      const postRes = await fetch(`${baseUrl}/api/setup/local-agents/research`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoResearch: true, maxDepth: 2 })
      });
      expect(postRes.status).toBe(200);
      const postData = (await postRes.json()) as { ok: boolean; policy: { autoResearch: boolean } };
      expect(postData.ok).toBe(true);
      expect(postData.policy.autoResearch).toBe(true);
    });
  });
});
