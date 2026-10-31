import type express from 'express';
import { safe } from '../../redact.js';
import { isLocalLoopbackClient, type OfficeRuntime } from '../contracts.js';
import { verifyCallback, type KeyRegistry } from '../connectors/grok/auth.js';
import type { GrokBridge } from '../connectors/grok/bridge.js';

export function mountGrokRoutes(
  app: express.Express,
  bridge: GrokBridge,
  registry: KeyRegistry,
  _runtime: OfficeRuntime
): void {
  function verifyOwner(req: express.Request, res: express.Response): boolean {
    const check = isLocalLoopbackClient({
      remoteAddress: req.socket.remoteAddress,
      hostHeader: req.headers.host,
      origin: req.get('origin')
    });
    if (!check.ok) {
      res.status(403).json({ ok: false, error: check.reason });
      return false;
    }
    return true;
  }

  app.post('/api/bridge/probe', async (req, res) => {
    if (!verifyOwner(req, res)) return;

    try {
      const receipt = await bridge.enqueue({
        protocol: 'mpu.grok.v2',
        kind: 'peer.heartbeat',
        eventId: `evt-probe-${Date.now()}`,
        peerId: 'local-probe',
        timestamp: Date.now()
      });

      res.json({
        ok: true,
        receipt,
        status: bridge.status()
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: safe((err as Error).message)
      });
    }
  });

  app.post('/api/grok/callback', async (req, res) => {
    try {
      const rawBody = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}));

      const headers = {
        keyId: String(req.headers['x-mpu-key-id'] ?? ''),
        timestamp: Number(req.headers['x-mpu-timestamp'] ?? 0),
        nonce: String(req.headers['x-mpu-nonce'] ?? ''),
        signature: String(req.headers['x-mpu-signature'] ?? '')
      };

      const verified = await verifyCallback({
        rawBody,
        method: req.method,
        path: req.path,
        headers,
        registry
      });

      const receipt = await bridge.ingest(verified);
      res.json({
        ok: true,
        receipt
      });
    } catch (err) {
      const msg = safe((err as Error).message);
      const isAuthError = /signature|unauthorized|missing independent grant|revoked|key/i.test(msg);
      res.status(isAuthError ? 401 : 400).json({
        ok: false,
        error: msg
      });
    }
  });
}
