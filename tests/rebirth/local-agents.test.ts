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
      await new Promise((r) => setTimeout(r, 60));
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

  it('reports installed_unverified instead of fake connected when verify is false', async () => {
    await withTestApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/setup/local-agents/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'codex', verify: false })
      });
      const data = (await res.json()) as { ok: boolean; installed: boolean; connected: boolean; state: string };
      expect(res.status).toBe(200);
      expect(data.ok).toBe(true);
      if (data.installed) {
        expect(data.connected).toBe(false);
        expect(data.state).toBe('installed_unverified');
      }
    });
  });

  it('returns 501 on settings endpoint to avoid fake persistence acknowledgements', async () => {
    await withTestApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/setup/local-agents/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'codex', settings: {} })
      });
      expect(res.status).toBe(501);
      const data = (await res.json()) as { ok: boolean; detail: string };
      expect(data.ok).toBe(false);
      expect(data.detail).toContain('not implemented');
    });
  });

  it('handles /api/setup/local-agents/test endpoint with validation', async () => {
    await withTestApp(async (baseUrl) => {
      const resEmpty = await fetch(`${baseUrl}/api/setup/local-agents/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      expect(resEmpty.status).toBe(400);

      const resUnknown = await fetch(`${baseUrl}/api/setup/local-agents/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'unknown-agent:default' })
      });
      expect(resUnknown.status).toBe(400);
      const data = (await resUnknown.json()) as { ok: boolean; detail: string };
      expect(data.detail).toContain('Unknown local agent');
    });
  });

  it('rejects unsupported explicit model flags with 422', async () => {
    await withTestApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/setup/local-agents/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'gemini', model: 'unsupported-custom-model' })
      });
      expect(res.status).toBe(422);
      const data = (await res.json()) as { ok: boolean; state: string; detail: string };
      expect(data.ok).toBe(false);
      expect(data.state).toBe('MODEL NOT VERIFIED');
    });
  });
});
