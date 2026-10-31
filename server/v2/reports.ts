import type express from 'express';
import { safe } from '../redact.js';
import { isLocalLoopbackClient, type OfficeRuntime } from './contracts.js';

export interface ReportPosition {
  symbol: string;
  side: string;
  qty: string;
  entry: string;
  stop: string | null;
  tp: string | null;
  mark: string;
  pnl: string | null;
  openedAt: number;
}

export interface Report {
  id: string;
  at: number;
  since: number;
  mode: string;
  exchange: string | null;
  balance: number | null;
  safetyNet: number;
  moneyTrade: number | null;
  n: number;
  perOrder: number | null;
  equity: number | null;
  unrealized: number | null;
  realized: number | null;
  dailyLoss: { limitPct: number; hit: boolean };
  auto: { on: boolean; cycles: number; intervalMin: number };
  positions: ReportPosition[];
  opened: unknown[];
  closed: unknown[];
  skipped: unknown[];
  scorecard: unknown[];
  lessons: unknown[];
  scan: unknown[];
  text: string;
}

export class ReportsService {
  private reports: Report[] = [];
  private sequence = 0;

  constructor() {
    // Generate initial startup report
    this.createStartupReport();
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

    const report: Report = {
      id: `rep-${this.sequence}-${now.toString(36)}`,
      at: now,
      since: now - 3600000,
      mode: state.mode,
      exchange: state.venue?.name ?? null,
      balance: balVal,
      safetyNet,
      moneyTrade,
      n,
      perOrder,
      equity: state.financial.equity.value,
      unrealized: 0,
      realized: 0,
      dailyLoss: {
        limitPct: state.dailyLoss?.limitPct ?? state.trading?.values?.dailyLossLimitPct ?? 10,
        hit: state.dailyLoss?.hit ?? false
      },
      auto: {
        on: state.auto?.on ?? false,
        cycles: state.auto?.cycles ?? 0,
        intervalMin: state.auto?.intervalMin ?? 15
      },
      positions: [],
      opened: [],
      closed: [],
      skipped: [],
      scorecard: state.scorecard,
      lessons: [],
      scan: [],
      text: safe(`Desk report ${new Date(now).toISOString()}\nMode: ${state.mode}. Kill switch: ${state.killed ? 'ON' : 'OFF'}. Office: UP.\nEquity: ${state.financial.equity.value ?? 'UNAVAILABLE'}. Positions: none.`)
    };

    this.reports.unshift(report);
    if (this.reports.length > 50) {
      this.reports.pop();
    }
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
