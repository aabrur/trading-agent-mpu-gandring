import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FinancialPage, FinancialRecord, FinancialFill, FinancialCost } from '../exchange/types.js';
import type { ExecutionIntent } from './journal.js';
import type { ClosedTrade } from '../types.js';
import { log } from '../redact.js';
export interface FinancialSummary { accountScope: string | null; coverage: 'complete' | 'partial' | 'unsupported'; actualFees: number | null; funding: number | null; confirmedNetRealized: number | null; unattributedRecords: number; observedAt: number | null }
type Window = { since: number; until: number; supported: FinancialPage['supported']; fillSymbols?: string[] };
const key = (r: FinancialRecord) => r.kind + ':' + r.symbol + ':' + r.id;
export class FinancialEvidence {
  private scope: string | null = null;
  private records = new Map<string, FinancialRecord>();
  private windows: Window[] = [];
  private observedAt: number | null = null;
  private mismatch = false;
  private attributed = new Map<string, string>();
  private net: { at: number; amount: number | null }[] = [];
  constructor(private file: string | null = null) {
    if (file && existsSync(file)) try {
      const s = JSON.parse(readFileSync(file, 'utf8')) as { scope: string; records: FinancialRecord[]; windows: Window[]; observedAt: number; mismatch?: boolean };
      if (typeof s.scope === 'string' && Array.isArray(s.records) && Array.isArray(s.windows)) {
        this.scope = s.scope; this.records = new Map(s.records.map((r) => [key(r), r])); this.windows = s.windows; this.observedAt = s.observedAt; this.mismatch = s.mismatch === true;
      }
    } catch { log('[financial evidence] local evidence could not be read'); }
  }
  ingest(page: FinancialPage, window: { since: number; until: number }) {
    if (this.scope && this.scope !== page.accountScope) { this.invalidateAccountScope(); throw new Error('Financial evidence account scope mismatch'); }
    if (!page.accountScope || !Number.isFinite(window.since) || !Number.isFinite(window.until) || window.until < window.since) throw new Error('Invalid financial evidence window');
    for (const r of page.records) {
      const numbers = r.kind === 'fill' ? [r.qty, r.price, r.at, ...(r.fee ? [r.fee.amount] : []), ...(r.realizedPnl ? [r.realizedPnl.amount] : [])] : [r.amount, r.at];
      if (!r.id || !numbers.every(Number.isFinite) || r.at < window.since || r.at > window.until) throw new Error('Invalid financial evidence record');
    }
    this.scope = page.accountScope;
    for (const r of page.records) this.records.set(key(r), structuredClone(r));
    if (page.complete && !page.nextCursor) {
      const next = { ...window, supported: [...page.supported], fillSymbols: page.fillSymbols };
      // Replace identical coverage; retain lifecycle evidence rather than expiring it blindly.
      this.windows = this.windows.filter((w) => !(w.since === next.since && w.until === next.until));
      this.windows.push(next);
    }
    this.observedAt = Date.now(); this.save();
  }
  invalidateAccountScope() { this.mismatch = true; this.save(); }
  private covered(since: number, until: number, category: 'fills' | 'fees' | 'funding', symbol?: string) {
    const windows = this.windows.filter((w) => w.supported.includes(category) && (category !== 'fills' || !w.fillSymbols || symbol != null && w.fillSymbols.includes(symbol))).sort((a, b) => a.since - b.since);
    let cursor = since;
    for (const w of windows) {
      if (w.since > cursor) break;
      if (w.until >= cursor) cursor = w.until + 1;
      if (cursor > until) return true;
    }
    return false;
  }
  attribute(intents: ExecutionIntent[], trades: ClosedTrade[]) {
    this.attributed.clear(); this.net = [];
    const fills = [...this.records.values()].filter((r): r is FinancialFill => r.kind === 'fill');
    const costs = [...this.records.values()].filter((r): r is FinancialCost => r.kind === 'fee');
    for (const fill of fills) {
      const matches = intents.filter((i) => i.positionId && i.symbol === fill.symbol && (!fill.side || i.side === fill.side) && (fill.clientId === i.clientId || fill.orderId === i.record?.orderId));
      if (matches.length === 1) this.attributed.set(key(fill), matches[0].positionId!);
    }
    for (const trade of trades.filter((t) => t.remainingQty === 0)) {
      const pid = trade.positionId ?? trade.id, own = intents.filter((i) => i.positionId === pid), related = fills.filter((f) => this.attributed.get(key(f)) === pid);
      const opens = related.filter((f) => own.some((i) => i.kind === 'open' && (i.clientId === f.clientId || i.record?.orderId === f.orderId)));
      const closes = related.filter((f) => !opens.includes(f));
      const start = Math.min(...opens.map((f) => f.at));
      const allQty = (rows: FinancialFill[]) => rows.reduce((s, f) => s + f.qty, 0);
      const expected = own.filter((i) => i.kind === 'open').reduce((s, i) => s + (i.record?.filledQty ?? 0), 0);
      const closeExpected = own.filter((i) => i.kind === 'close').reduce((s, i) => s + (i.record?.filledQty ?? 0), 0);
      const tolerance = Math.max(1, expected) * 1e-10;
      const coverage = ['fills', 'fees', 'funding'].every((c) => this.covered(start, trade.closedAt, c as 'fills' | 'fees' | 'funding', trade.symbol));
      const funding = [...this.records.values()].some((r) => r.kind === 'funding' && r.symbol === trade.symbol && r.at >= start && r.at <= trade.closedAt && r.amount !== 0);
      let amount: number | null = null;
      if (opens.length && closes.length && expected > 0 && Math.abs(allQty(opens) - expected) <= tolerance && Math.abs(allQty(closes) - expected) <= tolerance && Math.abs(closeExpected - expected) <= tolerance && trade.entryStatus !== 'estimated' && coverage && !funding) {
        let fees = 0, gross = 0, known = true;
        for (const fill of related) {
          const feeRows = costs.filter((c) => c.tradeId === fill.id && c.symbol === fill.symbol);
          const fee = feeRows.length ? feeRows.every((c) => c.currency === 'USDT') ? feeRows.reduce((s, c) => s + c.amount, 0) : null : fill.fee?.currency === 'USDT' ? fill.fee.amount : null;
          const realized = fill.realizedPnl ?? (feeRows[0]?.realizedPnl != null ? { amount: feeRows[0].realizedPnl, currency: feeRows[0].currency } : null);
          if (fee == null || closes.includes(fill) && realized?.currency !== 'USDT') known = false;
          fees += fee ?? 0; if (closes.includes(fill)) gross += realized?.amount ?? 0;
        }
        if (known) amount = Number((gross - fees).toFixed(8));
      }
      this.net.push({ at: trade.closedAt, amount });
    }
  }
  summary(since: number, until: number): FinancialSummary {
    const rows = [...this.records.values()].filter((r) => r.at >= since && r.at <= until);
    const valid = this.scope != null && !this.mismatch;
    const total = (kind: 'fee' | 'funding', category: 'fees' | 'funding') => {
      const matching = rows.filter((r) => r.kind === kind);
      return valid && this.covered(since, until, category) && matching.every((r) => r.kind !== 'fill' && r.currency === 'USDT') ? Number(matching.reduce((sum, r) => sum + (r.kind === 'fill' ? 0 : r.amount), 0).toFixed(8)) : null;
    };
    let fees = total('fee', 'fees');
    const costs = rows.filter((r): r is FinancialCost => r.kind === 'fee');
    const unmatched = rows.filter((r): r is FinancialFill => r.kind === 'fill' && !costs.some((c) => c.tradeId === r.id && c.symbol === r.symbol));
    if (unmatched.some((f) => !f.fee || f.fee.currency !== 'USDT')) fees = null;
    else if (fees != null) fees = Number((fees + unmatched.reduce((sum, f) => sum + f.fee!.amount, 0)).toFixed(8));
    const funding = total('funding', 'funding');
    const net = this.net.filter((r) => r.at >= since && r.at <= until);
    return { accountScope: valid ? this.scope : null, coverage: !valid ? 'unsupported' : fees != null && funding != null ? 'complete' : 'partial', actualFees: fees, funding, confirmedNetRealized: valid && net.length && net.every((r) => r.amount != null) ? Number(net.reduce((s, r) => s + r.amount!, 0).toFixed(8)) : null, unattributedRecords: rows.filter((r) => !this.attributed.has(key(r))).length, observedAt: this.observedAt };
  }
  private save() {
    if (!this.file) return;
    try { mkdirSync(path.dirname(this.file), { recursive: true }); writeFileSync(this.file + '.tmp', JSON.stringify({ scope: this.scope, records: [...this.records.values()], windows: this.windows, observedAt: this.observedAt, mismatch: this.mismatch })); renameSync(this.file + '.tmp', this.file); }
    catch { log('[financial evidence] local evidence could not be saved'); }
  }
}
