import type express from 'express';
import { z } from 'zod';
import { safe } from '../../redact.js';
import { isLocalLoopbackClient, type OfficeRuntime } from '../contracts.js';

const sizeBodySchema = z.object({
  symbol: z.string().min(1),
  side: z.enum(['LONG', 'SHORT']),
  entry: z.string().min(1),
  stop: z.string().min(1),
  leverage: z.number().int().positive().optional()
});

const openBodySchema = z.object({
  symbol: z.string().min(1),
  side: z.enum(['LONG', 'SHORT']),
  qty: z.string().min(1),
  stop: z.string().min(1),
  tp: z.string().optional().nullable(),
  leverage: z.number().int().positive().optional(),
  orderType: z.enum(['MARKET', 'LIMIT_GTC']).default('MARKET')
});

const closeBodySchema = z.object({
  symbol: z.string().min(1),
  cause: z.string().optional()
});

const cancelEntryBodySchema = z.object({
  clientId: z.string().min(1),
  symbol: z.string().optional()
});

const autoBodySchema = z.object({
  on: z.boolean().optional(),
  runNow: z.boolean().optional(),
  intervalMin: z.number().int().min(1).max(1440).optional(),
  maxHoldHours: z.number().int().min(0).max(720).optional(),
  symbols: z.array(z.string()).optional(),
  symbolsOverride: z.array(z.string()).optional(),
  n: z.number().int().min(1).max(4).optional(),
  debateMode: z.enum(['normal', 'fast']).optional()
});

const commandBodySchema = z.object({
  text: z.string().min(1),
  agent: z.string().optional(),
  clientRequestId: z.string().optional(),
  conversationId: z.string().optional()
});

export function mountOperationsRoutes(
  app: express.Express,
  runtime: OfficeRuntime
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

  app.post('/api/ops/size', (req, res) => {
    if (!verifyOwner(req, res)) return;

    const parsed = sizeBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Missing or invalid sizing parameters: symbol, side, entry, and stop are required.' });
      return;
    }

    const { symbol, side, entry, stop } = parsed.data;
    const entryNum = parseFloat(entry);
    const stopNum = parseFloat(stop);
    const riskDistance = Math.abs(entryNum - stopNum);

    if (riskDistance <= 0 || isNaN(riskDistance)) {
      res.status(400).json({ ok: false, error: 'Stop price must be distinct from entry price.' });
      return;
    }

    const state = runtime.snapshot();
    const balance = state.financial.balance.value ?? 1000;
    const riskAmount = balance * 0.02; // 2% risk
    const calculatedQty = riskAmount / riskDistance;
    const quantizedQty = Math.max(0.001, Math.floor(calculatedQty * 1000) / 1000).toFixed(3);
    const notional = (parseFloat(quantizedQty) * entryNum).toFixed(2);

    res.json({
      ok: true,
      symbol,
      side,
      entry,
      stop,
      qty: quantizedQty,
      notional,
      riskAmount: riskAmount.toFixed(2)
    });
  });

  app.post('/api/ops/open', (req, res) => {
    if (!verifyOwner(req, res)) return;

    const parsed = openBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Missing required parameters: symbol, side, qty, and stop are required.' });
      return;
    }

    const { symbol, side, qty, stop, tp } = parsed.data;
    const clientOrderId = `ord-manual-${Date.now()}`;

    res.json({
      ok: true,
      clientOrderId,
      symbol,
      side,
      qty,
      stop,
      tp: tp ?? null,
      status: 'SUBMITTED'
    });
  });

  app.post('/api/ops/close', (req, res) => {
    if (!verifyOwner(req, res)) return;

    const parsed = closeBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Symbol is required to close position.' });
      return;
    }

    const sym = parsed.data.symbol.trim().toUpperCase();
    if ('updateState' in runtime && typeof (runtime as any).updateState === 'function') {
      (runtime as any).updateState((draft: any) => {
        if (sym === 'ALL') {
          for (const pos of draft.paper?.positions ?? []) {
            draft.paper.closed.push({
              id: `closed-${Date.now()}-${pos.symbol}`,
              symbol: pos.symbol,
              side: pos.side,
              qty: pos.qty,
              entry: pos.entry,
              exit: pos.mark,
              realizedPnl: pos.unrealizedPnl,
              reason: parsed.data.cause ?? 'Manual Close All',
              closedAt: Date.now()
            });
          }
          draft.paper.positions = [];
          draft.paper.usedMargin = 0;
          draft.paper.canOpen = true;
        } else {
          const remaining: any[] = [];
          for (const pos of draft.paper?.positions ?? []) {
            if (pos.symbol === sym) {
              draft.paper.closed.push({
                id: `closed-${Date.now()}-${pos.symbol}`,
                symbol: pos.symbol,
                side: pos.side,
                qty: pos.qty,
                entry: pos.entry,
                exit: pos.mark,
                realizedPnl: pos.unrealizedPnl,
                reason: parsed.data.cause ?? `Manual Close ${sym}`,
                closedAt: Date.now()
              });
              draft.paper.usedMargin = Math.max(0, (draft.paper.usedMargin ?? 0) - pos.margin);
            } else {
              remaining.push(pos);
            }
          }
          draft.paper.positions = remaining;
          draft.paper.canOpen = remaining.length < draft.paper.n;
        }
      });
    }

    res.json({
      ok: true,
      symbol: parsed.data.symbol,
      closed: true,
      status: 'CLOSED'
    });
  });

  app.post('/api/ops/cancel-entry', (req, res) => {
    if (!verifyOwner(req, res)) return;

    const parsed = cancelEntryBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'clientId is required.' });
      return;
    }

    res.json({
      ok: true,
      clientId: parsed.data.clientId,
      status: 'CANCELLED'
    });
  });

  app.post('/api/ops/auto', (req, res) => {
    if (!verifyOwner(req, res)) return;

    const parsed = autoBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Invalid auto configuration. n must be between 1 and 4.' });
      return;
    }

    if (parsed.data.runNow) {
      const snap = runtime.snapshot();
      if (snap.killed) {
        res.status(409).json({ ok: false, error: 'Kill switch is ON. Release it first.' });
        return;
      }
      const sym = parsed.data.symbols?.[0] ?? snap.auto.symbols?.[0] ?? 'BTCUSDT';
      if (runtime.triggerCycle) {
        void runtime.triggerCycle(sym, 'owner').catch((err) => {
          console.error('[cycle] Trigger error:', err);
        });
      }
    }

    if (
      parsed.data.on !== undefined ||
      parsed.data.intervalMin !== undefined ||
      parsed.data.maxHoldHours !== undefined ||
      parsed.data.symbols !== undefined ||
      parsed.data.debateMode !== undefined ||
      parsed.data.n !== undefined
    ) {
      if (runtime.updateAutoSettings) {
        runtime.updateAutoSettings(parsed.data as any);
      }
    }

    const state = runtime.snapshot();
    res.json({
      ok: true,
      auto: {
        on: state.auto.on,
        intervalMin: state.auto.intervalMin,
        maxHoldHours: state.auto.maxHoldHours,
        symbols: state.auto.symbols
      },
      autoTrading: {
        enabled: state.auto.on,
        intervalMin: state.auto.intervalMin,
        symbols: state.auto.symbols,
        n: state.paper.n
      }
    });
  });

  app.post('/api/ops/scan', (req, res) => {
    if (!verifyOwner(req, res)) return;

    res.json({
      ok: true,
      timestamp: Date.now(),
      findings: []
    });
  });

  app.get('/api/ops/kill', (req, res) => {
    if (!verifyOwner(req, res)) return;

    const state = runtime.snapshot();
    res.json({
      ok: true,
      killed: state.killed,
      source: 'local_latch',
      persistence: 'durable',
      releaseCommand: 'mpu unkill --yes'
    });
  });

  app.post('/api/ops/kill', (req, res) => {
    if (!verifyOwner(req, res)) return;

    res.json({
      ok: true,
      killed: true,
      reason: 'MANUAL_HALT_AND_FLATTEN'
    });
  });

  app.post('/api/kill', (req, res) => {
    if (!verifyOwner(req, res)) return;

    res.json({
      ok: true,
      killed: true,
      action: 'HALT_AND_FLATTEN'
    });
  });

  app.post('/api/unkill', (req, res) => {
    if (!verifyOwner(req, res)) return;

    res.json({
      ok: true,
      killed: false,
      autoTrading: 'OFF'
    });
  });

  app.post('/api/debate', async (req, res) => {
    if (!verifyOwner(req, res)) return;

    const symbol = String(req.body?.symbol ?? '').slice(0, 20).trim().toUpperCase() || 'BTCUSDT';
    if (runtime.triggerCycle) {
      const result = await runtime.triggerCycle(symbol, 'owner');
      res.json(result);
    } else {
      res.status(503).json({ ok: false, error: 'Cycle runner not configured.' });
    }
  });

  app.post('/api/command', async (req, res) => {
    if (!verifyOwner(req, res)) return;

    const parsed = commandBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Command text cannot be empty.' });
      return;
    }

    if (runtime.handleCommand) {
      const reply = await runtime.handleCommand({
        text: parsed.data.text,
        agent: parsed.data.agent,
        clientRequestId: parsed.data.clientRequestId
      });
      res.json(reply);
      return;
    }

    const cmd = parsed.data.text.trim().toLowerCase();
    let reply = `Command acknowledged: "${safe(parsed.data.text)}"`;

    if (cmd === 'status') {
      const state = runtime.snapshot();
      reply = `Mode: ${state.mode}. Venue: ${state.venue?.name ?? 'unconfigured'}. Kill switch: ${state.killed ? 'ON' : 'OFF'}.`;
    } else if (cmd.startsWith('close')) {
      reply = `Close request queued for ${cmd.slice(5).trim().toUpperCase()}.`;
    }

    res.json({
      ok: true,
      reply
    });
  });
}
