import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createReplacementRuntime } from '../../server/v2/runtime.js';
import { createReplacementApp } from '../../server/v2/app.js';

describe('T13 API Parity Contract Verification', () => {
  async function withTestApp(fn: (baseUrl: string) => Promise<void>) {
    const runtime = createReplacementRuntime();
    const app = createReplacementApp(runtime);
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      await fn(baseUrl);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it('desk_ops_size_open_close_auto_scan: covers sizing, manual execution, auto toggle, and scan', async () => {
    await withTestApp(async (baseUrl) => {
      // 1. Sizing: missing stop returns 400
      const badSizeRes = await fetch(`${baseUrl}/api/ops/size`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: 'BTCUSDT', side: 'LONG', entry: '65000' })
      });
      expect(badSizeRes.status).toBe(400);

      // Sizing: valid input calculates size
      const sizeRes = await fetch(`${baseUrl}/api/ops/size`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: 'BTCUSDT', side: 'LONG', entry: '65000', stop: '63000' })
      });
      expect(sizeRes.status).toBe(200);
      const sizeData = (await sizeRes.json()) as Record<string, unknown>;
      expect(sizeData.ok).toBe(true);
      expect(sizeData.qty).toBeDefined();

      // 2. Open: missing stop returns 400
      const badOpenRes = await fetch(`${baseUrl}/api/ops/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: 'BTCUSDT', side: 'LONG', qty: '0.01' })
      });
      expect(badOpenRes.status).toBe(400);

      // Open: valid input with stop
      const openRes = await fetch(`${baseUrl}/api/ops/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: 'BTCUSDT', side: 'LONG', qty: '0.01', stop: '63000' })
      });
      expect(openRes.status).toBe(200);
      const openData = (await openRes.json()) as Record<string, unknown>;
      expect(openData.ok).toBe(true);

      // 3. Close: missing symbol returns 400
      const badCloseRes = await fetch(`${baseUrl}/api/ops/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      expect(badCloseRes.status).toBe(400);

      const closeRes = await fetch(`${baseUrl}/api/ops/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: 'BTCUSDT' })
      });
      expect(closeRes.status).toBe(200);
      const closeData = (await closeRes.json()) as Record<string, unknown>;
      expect(closeData.ok).toBe(true);

      // 4. Auto toggle: invalid N outside 1..4 returns 400
      const badAutoRes = await fetch(`${baseUrl}/api/ops/auto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ on: true, n: 10 })
      });
      expect(badAutoRes.status).toBe(400);

      const autoRes = await fetch(`${baseUrl}/api/ops/auto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ on: true, intervalMin: 15, symbols: ['BTCUSDT'] })
      });
      expect(autoRes.status).toBe(200);

      // 5. Scan: returns findings
      const scanRes = await fetch(`${baseUrl}/api/ops/scan`, {
        method: 'POST'
      });
      expect(scanRes.status).toBe(200);
      const scanData = (await scanRes.json()) as Record<string, unknown>;
      expect(scanData.ok).toBe(true);
      expect(Array.isArray(scanData.findings)).toBe(true);
    });
  });

  it('reports_list_and_generate_now: returns immutable reports and generates on demand', async () => {
    await withTestApp(async (baseUrl) => {
      // 1. Initial reports list
      const listRes = await fetch(`${baseUrl}/api/reports`);
      expect(listRes.status).toBe(200);
      const listData = (await listRes.json()) as Record<string, unknown>;
      expect(listData.ok).toBe(true);
      expect(Array.isArray(listData.reports)).toBe(true);

      // 2. Generate report now
      const nowRes = await fetch(`${baseUrl}/api/reports/now`, {
        method: 'POST'
      });
      expect(nowRes.status).toBe(200);
      const nowData = (await nowRes.json()) as Record<string, unknown>;
      expect(nowData.ok).toBe(true);
      expect(nowData.report).toBeDefined();

      const rep = nowData.report as Record<string, unknown>;
      expect(rep.id).toBeDefined();
      expect(rep.at).toBeDefined();
      expect(rep.text).toBeDefined();
    });
  });

  it('chat_history_read_delete_and_cancel: manages agent sessions, aborts, and deletion', async () => {
    await withTestApp(async (baseUrl) => {
      // 1. History read for known agent
      const historyRes = await fetch(`${baseUrl}/api/chat/history/lead`);
      expect(historyRes.status).toBe(200);
      const histData = (await historyRes.json()) as Record<string, unknown>;
      expect(histData.ok).toBe(true);
      expect(Array.isArray(histData.messages)).toBe(true);

      // History read for unknown agent returns 400
      const badAgentRes = await fetch(`${baseUrl}/api/chat/history/unknown_agent`);
      expect(badAgentRes.status).toBe(400);

      // 2. Cancel in-flight prompt is idempotent
      const cancelRes = await fetch(`${baseUrl}/api/chat/cancel/req-nonexistent`, {
        method: 'POST'
      });
      expect(cancelRes.status).toBe(200);
      const cancelData = (await cancelRes.json()) as Record<string, unknown>;
      expect(cancelData.ok).toBe(true);

      // 3. Delete session requires confirm=true
      const deleteNoConfirm = await fetch(`${baseUrl}/api/chat/history/lead/sess-1`, {
        method: 'DELETE'
      });
      expect(deleteNoConfirm.status).toBe(400);

      const deleteRes = await fetch(`${baseUrl}/api/chat/history/lead/sess-1?confirm=true`, {
        method: 'DELETE'
      });
      expect(deleteRes.status).toBe(200);
    });
  });

  it('conversations_list_and_create: manages studio discussion sessions', async () => {
    await withTestApp(async (baseUrl) => {
      const listRes = await fetch(`${baseUrl}/api/conversations`);
      expect(listRes.status).toBe(200);
      const listData = (await listRes.json()) as Record<string, unknown>;
      expect(listData.ok).toBe(true);
      expect(Array.isArray(listData.conversations)).toBe(true);

      const createRes = await fetch(`${baseUrl}/api/conversations/new`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'BTC Breakdown Thesis' })
      });
      expect(createRes.status).toBe(200);
      const createData = (await createRes.json()) as Record<string, unknown>;
      expect(createData.ok).toBe(true);
      expect(createData.conversation).toBeDefined();
    });
  });

  it('owner_command_provenance_and_session_guard: processes loopback Owner command', async () => {
    await withTestApp(async (baseUrl) => {
      // Empty command rejected with 400
      const emptyRes = await fetch(`${baseUrl}/api/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '' })
      });
      expect(emptyRes.status).toBe(400);

      // Valid status command
      const cmdRes = await fetch(`${baseUrl}/api/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'status' })
      });
      expect(cmdRes.status).toBe(200);
      const cmdData = (await cmdRes.json()) as Record<string, unknown>;
      expect(cmdData.ok).toBe(true);
      expect(cmdData.reply).toBeDefined();
    });
  });
});
