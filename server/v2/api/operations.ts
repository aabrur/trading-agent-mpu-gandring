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
    const isLive = state.mode === 'LIVE' || state.mode === 'TESTNET';
    const balanceVal = isLive ? state.financial.balance.value : state.paper.balance;
    if (balanceVal === null || balanceVal === undefined) {
      res.status(400).json({ ok: false, error: 'Account balance unavailable for sizing.' });
      return;
    }

    const safetyNet = state.trading?.values.safetyNet ?? state.paper.safetyNet;
    const n = state.trading?.values.maxPositions ?? state.paper.n;
    const orderSizePct = state.trading?.values.orderSizePct;
    const maxLeverage = parsed.data.leverage ?? state.trading?.values.maxLeverage ?? 5;

    const moneyTrade = Math.max(0, balanceVal - safetyNet);
    const perOrder = orderSizePct != null ? (moneyTrade * orderSizePct) / 100 : moneyTrade / n;
    const notional = perOrder * maxLeverage;
    const rawQty = entryNum > 0 ? notional / entryNum : 0;
    const quantizedQty = Math.max(0.001, Math.floor(rawQty * 1000) / 1000).toFixed(3);
    const actualNotional = (parseFloat(quantizedQty) * entryNum).toFixed(2);
    const riskAmount = (parseFloat(quantizedQty) * riskDistance).toFixed(2);

    res.json({
      ok: true,
      symbol,
      side,
      entry,
      stop,
      qty: quantizedQty,
      notional: actualNotional,
      riskAmount
    });
  });

  app.post('/api/ops/open', async (req, res) => {
    if (!verifyOwner(req, res)) return;

    const parsed = openBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Missing required parameters: symbol, side, qty, and stop are required.' });
      return;
    }

    const { symbol, side, qty, stop, tp, leverage, orderType } = parsed.data;
    const clientOrderId = `ord-manual-${Date.now()}`;

    const reply = await runtime.dispatch({
      kind: 'open',
      actor: 'local_owner',
      symbol,
      payload: {
        symbol,
        side,
        qty,
        stop,
        tp: tp ?? null,
        leverage: leverage ?? 5,
        orderType,
        clientOrderId
      }
    });

    if (!reply.ok) {
      res.status(400).json({
        ok: false,
        error: reply.message,
        code: reply.code,
        status: 'REJECTED'
      });
      return;
    }

    res.json({
      ok: true,
      clientOrderId: (reply.data?.clientOrderId as string | undefined) ?? clientOrderId,
      symbol,
      side,
      qty,
      stop,
      tp: tp ?? null,
      status: (reply.data?.orderState as string | undefined) ?? 'SUBMITTED',
      orderState: (reply.data?.orderState as string | undefined) ?? 'ACCEPTED',
      protectionState: (reply.data?.protectionState as string | undefined) ?? 'UNVERIFIED'
    });
  });

  app.post('/api/ops/close', async (req, res) => {
    if (!verifyOwner(req, res)) return;

    const parsed = closeBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Symbol is required to close position.' });
      return;
    }

    const sym = parsed.data.symbol.trim().toUpperCase();
    const reply = await runtime.dispatch({
      kind: 'close',
      actor: 'local_owner',
      symbol: sym,
      payload: {
        symbol: sym,
        cause: parsed.data.cause ?? 'Manual Close'
      }
    });

    if (!reply.ok) {
      res.status(400).json({
        ok: false,
        error: reply.message,
        code: reply.code
      });
      return;
    }

    res.json({
      ok: true,
      symbol: parsed.data.symbol,
      closed: true,
      status: (reply.data?.orderState as string | undefined) ?? 'CLOSED',
      orderState: (reply.data?.orderState as string | undefined) ?? 'CLOSED'
    });
  });

  app.post('/api/ops/cancel-entry', async (req, res) => {
    if (!verifyOwner(req, res)) return;

    const parsed = cancelEntryBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'clientId is required.' });
      return;
    }

    const reply = await runtime.dispatch({
      kind: 'cancel_entry',
      actor: 'local_owner',
      symbol: parsed.data.symbol,
      payload: {
        clientOrderId: parsed.data.clientId,
        symbol: parsed.data.symbol
      }
    });

    res.json({
      ok: reply.ok,
      clientId: parsed.data.clientId,
      status: reply.ok ? 'CANCELLED' : 'FAILED',
      message: reply.message
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

  app.post('/api/ops/scan', async (req, res) => {
    if (!verifyOwner(req, res)) return;

    const reply = await runtime.dispatch({
      kind: 'scan',
      actor: 'local_owner'
    });

    res.json({
      ok: reply.ok,
      timestamp: Date.now(),
      findings: (reply.data?.findings as unknown[] | undefined) ?? [],
      message: reply.message
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

  app.post('/api/ops/kill', async (req, res) => {
    if (!verifyOwner(req, res)) return;

    const reply = await runtime.dispatch({
      kind: 'kill',
      actor: 'local_owner'
    });

    res.json({
      ok: reply.ok,
      killed: true,
      reason: 'MANUAL_HALT_AND_FLATTEN',
      flatten: reply.data?.flatten ?? 'COMPLETED',
      entryCancellation: reply.data?.entryCancellation ?? 'COMPLETED',
      message: reply.message
    });
  });

  app.post('/api/kill', async (req, res) => {
    if (!verifyOwner(req, res)) return;

    const reply = await runtime.dispatch({
      kind: 'kill',
      actor: 'local_owner'
    });

    res.json({
      ok: reply.ok,
      killed: true,
      action: 'HALT_AND_FLATTEN',
      flatten: reply.data?.flatten ?? 'COMPLETED',
      entryCancellation: reply.data?.entryCancellation ?? 'COMPLETED',
      message: reply.message
    });
  });

  app.post('/api/unkill', async (req, res) => {
    if (!verifyOwner(req, res)) return;

    const reply = await runtime.dispatch({
      kind: 'unkill',
      actor: 'local_owner'
    });

    res.json({
      ok: reply.ok,
      killed: false,
      autoTrading: 'OFF',
      message: reply.message
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

    const reply = await runtime.dispatch({
      kind: 'command',
      actor: 'local_owner',
      text: parsed.data.text,
      agent: parsed.data.agent as any,
      clientRequestId: parsed.data.clientRequestId
    });

    res.json({
      ok: reply.ok,
      reply: reply.message
    });
  });
}
