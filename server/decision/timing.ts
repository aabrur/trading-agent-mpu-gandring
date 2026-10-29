export interface CycleTiming {
  startedAt?: number;
  endedAt?: number;
  instrumentMetadata: number;
  nativeQuote: number;
  quoteRevalidation: number;
  marketData: number;
  marketAnalyst: number;
  researchAnalyst: number;
  strategist: number;
  jevPreAnalysis: number;
  rebuttals: number;
  deskLead: number;
  jevReview: number;
  executionTrader: number;
  riskManager: number;
  orderSubmission: number;
  fillConfirmation: number;
  total: number;
}

const ZERO: CycleTiming = {
  instrumentMetadata: 0, nativeQuote: 0, quoteRevalidation: 0, marketData: 0, marketAnalyst: 0, researchAnalyst: 0, strategist: 0,
  jevPreAnalysis: 0, rebuttals: 0, deskLead: 0, jevReview: 0,
  executionTrader: 0, riskManager: 0, orderSubmission: 0, fillConfirmation: 0, total: 0
};

export class CycleTimer {
  private t0 = Date.now();
  private marks: Partial<Record<keyof CycleTiming, number>> = {};
  mark(key: Exclude<keyof CycleTiming, 'total'>, ms: number) {
    this.marks[key] = Math.max(0, Math.round(ms));
  }
  async measure<T>(key: Exclude<keyof CycleTiming, 'total'>, work: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try { return await work(); }
    finally { this.mark(key, Date.now() - start); }
  }
  finish(): CycleTiming {
    const endedAt = Date.now();
    const out = { ...ZERO, ...this.marks, startedAt: this.t0, endedAt, total: endedAt - this.t0 };
    return out;
  }
}

export function formatCycleTiming(t: CycleTiming): string {
  const rows: [string, number][] = [
    ['INSTRUMENT METADATA', t.instrumentMetadata],
    ['NATIVE QUOTE', t.nativeQuote],
    ['QUOTE REVALIDATION', t.quoteRevalidation],
    ['EXECUTION TRADER', t.executionTrader],
    ['MARKET DATA', t.marketData],
    ['MARKET ANALYST', t.marketAnalyst],
    ['RESEARCH ANALYST', t.researchAnalyst],
    ['STRATEGIST', t.strategist],
    ['JEV PRE-ANALYSIS', t.jevPreAnalysis],
    ['REBUTTALS', t.rebuttals],
    ['DESK LEAD', t.deskLead],
    ['JEV REVIEW', t.jevReview],
    ['RISK MANAGER', t.riskManager],
    ['ORDER SUBMISSION', t.orderSubmission],
    ['FILL CONFIRMATION', t.fillConfirmation],
    ['TOTAL', t.total]
  ];
  return rows.map(([label, ms]) => `${label.padEnd(20)} ${ms}ms`).join('\n');
}
