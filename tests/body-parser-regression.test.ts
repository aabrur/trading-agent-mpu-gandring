import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import zlib from 'node:zlib';

function makeRequest(
  port: number,
  path: string,
  options: {
    headers?: Record<string, string | number>;
    body?: Buffer | string;
  } = {}
): Promise<{ statusCode: number; data: string; json?: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const body = options.body ? (Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body)) : undefined;
    const headers: Record<string, string | number> = {
      ...(options.headers || {})
    };
    if (body && !headers['Content-Length'] && !headers['content-length']) {
      headers['Content-Length'] = body.length;
    }

    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          let parsed: Record<string, unknown> | undefined;
          try {
            parsed = JSON.parse(data);
          } catch {
            // non-json response
          }
          resolve({ statusCode: res.statusCode || 0, data, json: parsed });
        });
      }
    );

    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

describe('body-parser security and compression regression', () => {
  let child: ChildProcess;
  let port = 0;
  let childExited = false;
  let exitCode: number | null = null;

  beforeAll(async () => {
    const serverScript = `
const express = require('express');
const app = express();

app.use('/verify', express.json({
  limit: '32kb',
  verify: (req, _res, buf) => { req.rawBody = Buffer.from(buf).toString('hex'); }
}));
app.use('/large', express.json({ limit: '256kb' }));
app.use(express.json({ limit: '32kb' }));

app.post('/test', (req, res) => {
  res.json({ ok: true, received: req.body });
});
app.post('/verify', (req, res) => {
  res.json({ ok: true, rawHex: req.rawBody, received: req.body });
});
app.post('/large', (req, res) => {
  res.json({ ok: true, size: JSON.stringify(req.body).length });
});

const server = app.listen(0, '127.0.0.1', () => {
  console.log('PORT:' + server.address().port);
});
`;

    port = await new Promise<number>((resolve, reject) => {
      child = spawn(process.execPath, ['-e', serverScript], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NODE_ENV: 'test' }
      });

      child.on('exit', (code) => {
        childExited = true;
        exitCode = code;
      });

      child.stdout?.on('data', (d) => {
        const text = d.toString();
        const m = text.match(/PORT:(\d+)/);
        if (m) resolve(Number(m[1]));
      });

      child.stderr?.on('data', (d) => {
        // capture child stderr
      });

      setTimeout(() => reject(new Error('Child server startup timed out')), 5000);
    });
  });

  afterAll(async () => {
    if (child && !child.killed) {
      child.kill();
    }
  });

  it('parses valid uncompressed JSON requests', async () => {
    const res = await makeRequest(port, '/test', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'BUY', symbol: 'BTCUSDT' })
    });

    expect(res.statusCode).toBe(200);
    expect(res.json).toEqual({
      ok: true,
      received: { action: 'BUY', symbol: 'BTCUSDT' }
    });
  });

  it('parses valid gzip compressed JSON requests', async () => {
    const payload = JSON.stringify({ action: 'BUY', symbol: 'ETHUSDT', compressed: true });
    const compressed = zlib.gzipSync(Buffer.from(payload));

    const res = await makeRequest(port, '/test', {
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip'
      },
      body: compressed
    });

    expect(res.statusCode).toBe(200);
    expect(res.json).toEqual({
      ok: true,
      received: { action: 'BUY', symbol: 'ETHUSDT', compressed: true }
    });
  });

  it('parses valid deflate compressed JSON requests', async () => {
    const payload = JSON.stringify({ action: 'SELL', symbol: 'SOLUSDT', compressed: true });
    const compressed = zlib.deflateSync(Buffer.from(payload));

    const res = await makeRequest(port, '/test', {
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'deflate'
      },
      body: compressed
    });

    expect(res.statusCode).toBe(200);
    expect(res.json).toEqual({
      ok: true,
      received: { action: 'SELL', symbol: 'SOLUSDT', compressed: true }
    });
  });

  it('enforces request body size limits (rejects >32kb on default route)', async () => {
    const bigData = { padding: 'X'.repeat(35 * 1024) };
    const res = await makeRequest(port, '/test', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bigData)
    });

    expect(res.statusCode).toBe(413);
  });

  it('preserves raw-body capture in verification hook', async () => {
    const raw = JSON.stringify({ webhook: 'discord', id: '123' });
    const res = await makeRequest(port, '/verify', {
      headers: { 'Content-Type': 'application/json' },
      body: raw
    });

    expect(res.statusCode).toBe(200);
    expect(res.json?.rawHex).toBe(Buffer.from(raw).toString('hex'));
    expect(res.json?.received).toEqual({ webhook: 'discord', id: '123' });
  });

  it('does not crash on malformed compressed request with trailing bytes (GHSA-27r3-jxmh-p828)', async () => {
    const validPart = zlib.gzipSync(Buffer.from(JSON.stringify({ token: 'test' })));
    const trailingGarbage = Buffer.alloc(1024, 0x58); // 1kb of trailing bytes
    const malformedPayload = Buffer.concat([validPart, trailingGarbage]);

    const res = await makeRequest(port, '/test', {
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip'
      },
      body: malformedPayload
    });

    // The request will either be handled with 400 or 200, but crucially:
    // the server process must NOT crash.
    expect([200, 400]).toContain(res.statusCode);
    expect(childExited).toBe(false);
  });

  it('remains alive and answers subsequent requests after delayed decompression errors', async () => {
    // Wait 200ms to allow any delayed event loop / stream error to surface
    await new Promise((r) => setTimeout(r, 200));

    expect(childExited).toBe(false);
    expect(exitCode).toBeNull();

    // Verify service continuity: server can answer a fresh request
    const followUp = await makeRequest(port, '/test', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alive: true, check: 'ok' })
    });

    expect(followUp.statusCode).toBe(200);
    expect(followUp.json).toEqual({
      ok: true,
      received: { alive: true, check: 'ok' }
    });
    expect(childExited).toBe(false);
  });
});
