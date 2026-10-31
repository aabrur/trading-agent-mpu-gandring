import type express from 'express';
import { safe } from '../redact.js';
import { isLocalLoopbackClient, type OfficeRuntime } from './contracts.js';
import { broadcastChannelMessage } from './channels.js';

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
  autoOn: boolean;
  autoIntervalMin: number;
}): string {
  const dt = new Date(params.at).toISOString();
  const eqStr = params.equity != null ? `${params.equity} USDT` : 'UNAVAILABLE';
  const balStr = params.balance != null ? `${params.balance}` : '0';
  const mtStr = params.moneyTrade != null ? `${params.moneyTrade}` : '0';
  const posCount = params.positions.length;
  const posLines = posCount > 0
    ? params.positions.map((p) => `  - ${p.symbol} ${p.side} ${p.qty ?? ''} entry ${p.entry ?? ''} stop ${p.stop ?? 'none'} tp ${p.tp ?? 'none'} pnl ${p.unrealizedPnl ?? 0}`).join('\n')
    : '  none';

  return [
    `Desk report ${dt}`,
    `Mode: ${params.mode}${params.venue ? ` on ${params.venue}` : ''}. Kill switch: ${params.killed ? 'ON' : 'OFF'}. Office: UP.`,
    `Equity: ${eqStr} (balance ${balStr}, safety net ${params.safetyNet}, Money Trade ${mtStr}). Daily loss stop: ${params.dailyLossHit ? 'HIT' : 'not hit'} (${params.dailyLossLimitPct}% cap).`,
    `Auto: ${params.autoOn ? `ON (every ${params.autoIntervalMin} min)` : 'OFF'}.`,
    `Positions (${posCount}):`,
    posLines
  ].join('\n');
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
      positions: (state.paper.positions ?? []) as any[],
      autoOn: state.auto?.on ?? false,
      autoIntervalMin: state.auto?.intervalMin ?? 15
    }));

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
      text: reportText
    };

    this.reports.unshift(report);
    if (this.reports.length > 50) {
      this.reports.pop();
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
