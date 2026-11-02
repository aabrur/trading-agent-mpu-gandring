import type express from 'express';
import { safe } from '../redact.js';
import { formatReportCard, deskOpenPnl } from './channel-text.js';
import { isLocalLoopbackClient, type OfficeRuntime } from './contracts.js';
import { broadcastChannelMessage } from './channels.js';
import type { Report } from '../../shared/office.js';

export type { Report };

export function formatDeskReportText(params: {
  at: number;
  mode: string;
  venue: string | null;
  killed: boolean;
  equity: number | null;
  balance: number | null;
  safetyNet: number;
  moneyTrade: number | null;
  dailyLossHit: boolean;
  dailyLossLimitPct: number;
  positions: Array<{ symbol: string; side: string; qty?: string | number; entry?: string | number; stop?: string | number; tp?: string | number | null; unrealizedPnl?: number }>;
  openPnl?: number | null;
  pnlSource?: string;
  realized?: number | null;
  autoOn: boolean;
  autoIntervalMin: number;
}): string {
  const open = deskOpenPnl({
    mode: params.mode,
    paperUnrealized: params.positions.reduce((sum, p) => sum + Number(p.unrealizedPnl ?? 0), 0),
    venueUnrealized: params.openPnl ?? null,
    venueStatus: params.pnlSource === 'Exchange' ? 'confirmed' : params.pnlSource === 'Exchange stale' ? 'stale' : null
  });
  const openPnl = params.openPnl ?? open.value;
  const source = params.pnlSource ?? open.source;
  return formatReportCard({
    at: params.at,
    mode: params.mode,
    venue: params.venue,
    killed: params.killed,
    autoOn: params.autoOn,
    autoIntervalMin: params.autoIntervalMin,
    equity: params.equity,
    balance: params.balance,
    safetyNet: params.safetyNet,
    moneyTrade: params.moneyTrade,
    openPnl,
    pnlSource: source,
    realized: params.realized ?? null,
    dailyLossHit: params.dailyLossHit,
    dailyLossLimitPct: params.dailyLossLimitPct,
    positions: params.positions
  });
}

export class ReportsService {
  private reports: Report[] = [];
  private sequence = 0;
  private timer: NodeJS.Timeout | null = null;
  private runtime: OfficeRuntime | null = null;

  constructor() {
    // Generate initial startup report
    this.createStartupReport();
  }

  public start(runtime: OfficeRuntime, intervalMin = 60): void {
    this.runtime = runtime;
    if (this.timer) {
      clearInterval(this.timer);
    }
    const snap = runtime.snapshot();
    if ((!snap.reports || snap.reports.length === 0) && this.reports.length > 0 && runtime.updateState) {
      runtime.updateState((draft) => {
        draft.reports = [...this.reports];
      });
    }
    const intervalMs = Math.max(1, intervalMin) * 60_000;
    this.timer = setInterval(() => {
      if (this.runtime) {
        this.generateReportNow(this.runtime);
      }
    }, intervalMs);
    this.timer.unref?.();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private createStartupReport(): void {
    const now = Date.now();
    this.reports.push({
      id: `rep-${now.toString(36)}`,
      at: now,
      since: now - 3600000,
      mode: 'PAPER',
      exchange: null,
      balance: 1000,
      safetyNet: 200,
      moneyTrade: 800,
      n: 3,
      perOrder: 266.66,
      equity: 1000,
      unrealized: 0,
      realized: 0,
      dailyLoss: { limitPct: 10, hit: false },
      auto: { on: false, cycles: 0, intervalMin: 15 },
      positions: [],
      opened: [],
      closed: [],
      skipped: [],
      scorecard: [],
      lessons: [],
      scan: [],
      text: `Desk report ${new Date(now).toISOString()}\nMode: PAPER. Kill switch: OFF. Office: UP.\nEquity: 1000 USDT (balance 1000, safety net 200, Money Trade 800). Today: 0 USDT.\nPositions: none.`
    });
  }

  public listReports(): Report[] {
    return [...this.reports];
  }

  public generateReportNow(runtime: OfficeRuntime): Report {
    this.sequence += 1;
    const now = Date.now();
    const state = runtime.snapshot();

    const balVal = state.financial.balance.value;
    const safetyNet = state.paper.safetyNet;
    const moneyTrade = balVal !== null ? Math.max(0, balVal - safetyNet) : null;
    const n = state.paper.n;
    const perOrder = moneyTrade !== null && n > 0 ? Math.floor((moneyTrade / n) * 100) / 100 : null;

    const positions = state.paper.positions ?? [];
    const open = deskOpenPnl({
      mode: state.mode,
      paperUnrealized: state.paper.unrealized,
      venueUnrealized: state.venueAccount?.unrealized ?? null,
      venueStatus: state.venueAccount?.status ?? null
    });
    const realized = state.financial.realizedPnl.availability === 'AVAILABLE' ? state.financial.realizedPnl.value : null;
    const positionPnl = positions.reduce((sum, p) => sum + Number(p.unrealizedPnl ?? 0), 0);
    const openPnl = open.value ?? positionPnl;

    const reportText = safe(formatDeskReportText({
      at: now,
      mode: state.mode,
      venue: state.venue?.name ?? null,
      killed: state.killed,
      equity: state.financial.equity.value,
      balance: balVal,
      safetyNet,
      moneyTrade,
      dailyLossHit: state.dailyLoss?.hit ?? false,
      dailyLossLimitPct: state.dailyLoss?.limitPct ?? state.trading?.values?.dailyLossLimitPct ?? 10,
      positions,
      openPnl,
      pnlSource: open.source,
      realized,
      autoOn: state.auto?.on ?? false,
      autoIntervalMin: state.auto?.intervalMin ?? 15
    }));

    const report: Report = {
      id: `rep-${this.sequence}-${now.toString(36)}`,
      at: now,
      since: now - 3600000,
      mode: state.mode,
      exchange: state.venue?.name ?? null,
      balance: balVal ?? (state.mode === 'PAPER' ? 1000 : 0),
      safetyNet,
      moneyTrade: moneyTrade ?? 0,
      n,
      perOrder: perOrder ?? 0,
      equity: state.financial.equity.value ?? (state.mode === 'PAPER' ? 1000 : 0),
      unrealized: openPnl,
      realized: realized ?? 0,
      dailyLoss: {
        limitPct: state.dailyLoss?.limitPct ?? state.trading?.values?.dailyLossLimitPct ?? 10,
        hit: state.dailyLoss?.hit ?? false
      },
      auto: {
        on: state.auto?.on ?? false,
        cycles: state.auto?.cycles ?? 0,
        intervalMin: state.auto?.intervalMin ?? 15
      },
      positions: (state.paper.positions ?? []).map((p) => ({
        symbol: p.symbol,
        side: p.side,
        qty: Number(p.qty) || 0,
        entry: Number(p.entry) || 0,
        stop: Number(p.stop) || 0,
        tp: p.tp != null ? Number(p.tp) : null,
        mark: Number(p.mark ?? p.entry) || 0,
        pnl: Number(p.unrealizedPnl ?? 0) || 0,
        openedAt: p.openedAt
      })),
      opened: [],
      closed: [],
      skipped: [],
      scorecard: state.scorecard,
      lessons: [],
      scan: [],
      text: reportText
    };

    this.reports.unshift(report);
    if (this.reports.length > 50) {
      this.reports.pop();
    }

    if (runtime.updateState) {
      runtime.updateState((draft) => {
        draft.reports.unshift(report);
        if (draft.reports.length > 50) {
          draft.reports.pop();
        }
      });
    }

    // Broadcast report text to channels
    void broadcastChannelMessage(process.env, reportText).catch((err: unknown) => {
      console.error('[reports] failed to broadcast report to channels:', (err as Error)?.message);
    });

    return report;
  }
}

export function mountReportRoutes(
  app: express.Express,
  service: ReportsService,
  runtime: OfficeRuntime
): void {
  app.get('/api/reports', (_req, res) => {
    res.json({
      ok: true,
      reports: service.listReports()
    });
  });

  app.post('/api/reports/now', (req, res) => {
    const check = isLocalLoopbackClient({
      remoteAddress: req.socket.remoteAddress,
      hostHeader: req.headers.host,
      origin: req.get('origin')
    });
    if (!check.ok) {
      res.status(403).json({ ok: false, error: check.reason });
      return;
    }

    try {
      const report = service.generateReportNow(runtime);
      res.json({
        ok: true,
        report
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: safe((err as Error).message)
      });
    }
  });
}
