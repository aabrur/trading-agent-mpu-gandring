import { randomBytes } from 'node:crypto';
import type { ExchangeAdapter, OrderRecord, Side } from '../exchange/index.js';
import { ExecutionJournal, type ExecutionIntent } from './journal.js';
import { recordDiagnostic } from '../session-log.js';
import { FinancialEvidence } from './financial-evidence.js';
import type { FinancialPage, FinancialRecord } from '../exchange/types.js';
import { log, safe } from '../redact.js';

export const newClientId = (tag = 'o') => `mg${tag}${Date.now().toString(36)}${randomBytes(4).toString('hex')}`.slice(0, 32);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Fill { ok: boolean; clientId: string; record: OrderRecord | null; qty: number; requestedQty: number; remainingQty: number; avgPrice: number | null; note: string }
export interface ProtectionResult { ok: boolean; status: 'confirmed' | 'missing' | 'unknown'; note: string; stop: number | null; tp: number | null }

// Every exchange write goes through here. Rules:
//  - one send per intent, never a blind retry
//  - after the send (or a send error, or a timeout) we read the exchange's own record and trust only that
//  - every entry carries a stop loss, the adapter refuses otherwise
export class LiveExecutor {
  readonly journal: ExecutionJournal;
  readonly financialEvidence: FinancialEvidence;
  private financialRead: Promise<void> | null = null;
  constructor(public adapter: ExchangeAdapter, private reconcileDelayMs = 1200, journalPath: string | null = null) {
    this.journal = new ExecutionJournal(journalPath, `${adapter.name}:${adapter.network}`);
    this.financialEvidence = new FinancialEvidence(journalPath ? journalPath + '.financial.json' : null);
  }
  refreshFinancialEvidence(since: number, until: number): Promise<void> {
    if (this.financialRead) return this.financialRead;
    if (!this.adapter.financialHistory || since > until) return Promise.resolve();
    this.financialRead = (async () => {
      const starts = this.journal.intents.filter((i) => i.kind === 'open' && i.at <= until).map((i) => i.at);
      const start = Math.max(0, until - 7 * 86400000, Math.min(since, ...starts));
      const symbols = [...new Set(this.journal.intents.map((i) => i.symbol))];
      let combined: FinancialPage | null = null, cursor: string | undefined;
      const records: FinancialRecord[] = [];
      const seen = new Set<string>();
      try {
        for (let n = 0; n < 20; n++) {
          const page = await this.adapter.financialHistory!({ since: start, until, symbols, cursor });
          if (combined && combined.accountScope !== page.accountScope) { this.financialEvidence.invalidateAccountScope(); throw new Error('History account changed between pages'); }
          records.push(...page.records);
          combined = { ...page, records };
          if (!page.nextCursor) break;
          if (seen.has(page.nextCursor)) throw new Error('Repeated history cursor');
          seen.add(page.nextCursor); cursor = page.nextCursor;
        }
        if (combined) {
          this.financialEvidence.ingest(combined, { since: start, until });
          recordDiagnostic({ source: 'financial-evidence', category: 'JOURNAL', eventName: 'financial_evidence.coverage', status: combined.complete && !combined.nextCursor ? 'complete' : 'partial', message: 'Financial history coverage observed', details: { supported: combined.supported, records: combined.records.length, complete: combined.complete, hasNextPage: !!combined.nextCursor } });
        }
      } catch (e) {
        if (combined) try { this.financialEvidence.ingest({ ...combined, complete: false }, { since: start, until }); } catch { /* Preserve evidence but never let an account mismatch interrupt reporting or orders. */ }
        log('[financial evidence] read incomplete: ' + safe((e as Error).message));
      }
    })().finally(() => { this.financialRead = null; });
    return this.financialRead;
  }
  private intent(kind: 'open' | 'close', o: { symbol: string; side: Side; qty: number; stop?: number; tp?: number | null; leverage?: number; positionId?: string }) {
    const intent: ExecutionIntent = { ...o, kind, requestedQty: o.qty, clientId: newClientId(kind === 'open' ? 'e' : 'c'), accountedQty: 0, accountedValue: 0, record: null, at: Date.now() };
    this.journal.intents.push(intent);
    this.journal.save(); // Persist before sending so a restart cannot lose ownership evidence.
    recordDiagnostic({ source: 'exchange', category: 'ORDER', eventName: 'order.intent', status: 'created', message: `${kind} intent persisted`, correlationId: intent.clientId, details: { clientId: intent.clientId, positionId: o.positionId, symbol: o.symbol, side: o.side, requestedQty: o.qty } });
    return intent;
  }
  async refreshPending() {
    for (const intent of this.journal.intents.filter((i) => !this.journal.settled(i))) {
      try {
        const record = await this.adapter.getOrder(intent.symbol, intent.clientId);
        const terminal = (status: OrderRecord['status']) => ['filled', 'cancelled', 'rejected'].includes(status);
        if (record.status !== 'unknown' && Number.isFinite(record.filledQty) && record.filledQty >= (intent.record?.filledQty ?? 0) && !(intent.record && terminal(intent.record.status) && !terminal(record.status))) intent.record = record;
        recordDiagnostic({ source: 'exchange', category: 'ORDER', eventName: 'order.pending_reconciled', status: record.status, correlationId: intent.clientId, message: 'Pending order record observed', details: { clientId: intent.clientId, orderId: record.orderId, symbol: intent.symbol, filledQty: record.filledQty, requestedQty: intent.requestedQty } });
      }
      catch (e) { log(`[live] pending order read failed: ${safe((e as Error).message)}`); }
    }
    this.journal.save();
  }
  hasPending(symbol: string, _side: Side, kind: 'open' | 'close') {
    return this.journal.intents.some((i) => i.symbol === symbol && i.kind === kind && !this.journal.settled(i));
  }
  account(clientId: string, qty: number, avgPrice: number | null, awaitingQty?: number) {
    const i = this.journal.intents.find((x) => x.clientId === clientId);
    if (i) { if (awaitingQty != null) { i.awaitingQty = awaitingQty; delete i.awaitingObservedQty; } i.accountedQty = qty; i.accountedValue = avgPrice == null ? null : qty * avgPrice; }
  }

  private async reconcile(symbol: string, clientId: string, sendError: string | null, requestedQty: number): Promise<Fill> {
    if (this.reconcileDelayMs) await pause(this.reconcileDelayMs);
    let rec: OrderRecord | null = null;
    try { rec = await this.adapter.getOrder(symbol, clientId); } catch (e) { log(`[live] reconcile read failed for ${clientId}: ${safe((e as Error).message)}`); }
    const filled = !!rec && rec.status !== 'unknown' && Number.isFinite(rec.filledQty) && rec.filledQty > 0;
    const intent = this.journal.intents.find((i) => i.clientId === clientId);
    if (intent && rec) { intent.record = rec; this.journal.save(); }
    const note = filled
      ? `exchange record: ${rec!.status} ${rec!.filledQty} @ ${rec!.avgPrice ?? '?'}${sendError ? ` (send reported: ${sendError})` : ''}`
      : `not filled per exchange record (${rec?.status ?? 'no record'})${sendError ? `; send error: ${sendError}` : ''}. Not retried.`;
    recordDiagnostic({ source: 'exchange', category: 'ORDER', eventName: 'order.reconciled', level: sendError || rec?.status === 'rejected' ? 'WARN' : 'INFO', status: rec?.status ?? 'unknown', correlationId: clientId, message: note, details: { clientId, orderId: rec?.orderId, symbol, filledQty: rec?.filledQty ?? null, requestedQty, sendError } });
    return { ok: filled, clientId, record: rec, qty: filled ? rec!.filledQty : 0, requestedQty, remainingQty: Math.max(0, requestedQty - (filled ? rec!.filledQty : 0)), avgPrice: filled ? rec!.avgPrice : null, note: safe(note) };
  }

  async open(o: { symbol: string; side: Side; qty: number; stop: number; tp: number | null; leverage: number }): Promise<Fill> {
    if (!(o.stop > 0)) return { ok: false, clientId: '', record: null, qty: 0, requestedQty: o.qty, remainingQty: o.qty, avgPrice: null, note: 'refused: no stop loss' };
    // Fail closed: a venue that cannot hold the stop on its own side never gets an entry.
    if (this.adapter.exchangeStops !== true) return { ok: false, clientId: '', record: null, qty: 0, requestedQty: o.qty, remainingQty: o.qty, avgPrice: null, note: `refused: the ${this.adapter.name} adapter cannot place an exchange-side stop loss` };
    const { clientId } = this.intent('open', o);
    this.journal.protectionClients.push({ symbol: o.symbol, clientId }); this.journal.save();
    let sendError: string | null = null;
    recordDiagnostic({ source: 'exchange', category: 'ORDER', eventName: 'order.submission', status: 'submitting', correlationId: clientId, message: 'Submitting entry order', details: { clientId, symbol: o.symbol, side: o.side, requestedQty: o.qty } });
    try { await this.adapter.placeOrder({ ...o, clientId }); }
    catch (e) { sendError = safe((e as Error).message); log(`[live] send for ${clientId} failed: ${sendError}. Reconciling, not retrying.`); }
    const fill = await this.reconcile(o.symbol, clientId, sendError, o.qty);
    if (!fill.ok) return fill;
    const guard = await this.ensureOnExchange(o.symbol, o.side, fill.qty, o.stop, o.tp);
    recordDiagnostic({ source: 'exchange', category: 'PROTECTION', eventName: 'protection.observed', level: guard.status === 'confirmed' ? 'INFO' : 'WARN', status: guard.status, correlationId: clientId, message: guard.note || 'Exchange protection confirmed', details: { clientId, symbol: o.symbol, stop: guard.stop, tp: guard.tp, ok: guard.ok } });
    if (!guard.ok) return { ...fill, ok: false, qty: 0, note: safe(`${fill.note}. ${guard.note}`) };
    return guard.note ? { ...fill, note: safe(`${fill.note}. ${guard.note}`) } : fill;
  }

  /**
   * Checks that the stop loss (and take profit, if any) rest ON THE EXCHANGE for this position.
   * A missing leg is placed once. If the stop is still missing, the position is closed at once (fail closed).
   * A missing take profit is reported, never a reason to drop the stop.
   */
  async ensureOnExchange(symbol: string, side: Side, qty: number, stop: number, tp: number | null): Promise<ProtectionResult> {
    // A failed read is "unknown", not "missing": we never stack orders or close on a network blip.
    const read = async () => { for (let i = 0; i < 2; i++) { try { return await this.adapter.protection(symbol, side); } catch (e) { log(`[live] protection read failed on ${symbol}: ${safe((e as Error).message)}`); } } return null; };
    let have = await read();
    if (!have) return { ok: true, status: 'unknown', note: 'WARNING: could not read exchange-side orders to verify protection; exchange state is unknown and requires reconciliation', stop: null, tp: null };
    const notes: string[] = [];
    const missStop = !have.stop, missTp = !!tp && !have.tp;
    if (missStop || missTp) {
      const protectionId = newClientId('p');
      this.journal.protectionClients.push({ symbol, clientId: protectionId }); this.journal.save();
      try { await this.adapter.protect({ symbol, side, qty, stop: missStop ? stop : null, tp: missTp ? tp : null, clientId: protectionId }); }
      catch (e) { notes.push(`placing the missing ${missStop ? 'stop' : 'take profit'} failed: ${safe((e as Error).message)}`); }
      if (this.reconcileDelayMs) await pause(this.reconcileDelayMs);
      have = await read();
      if (!have) return { ok: true, status: 'unknown', note: `WARNING: could not read exchange-side orders after protection placement; exchange state is unknown and requires reconciliation${notes.length ? `; ${notes.join('; ')}` : ''}`, stop: null, tp: null };
    }
    if (!have.stop) {
      const c = await this.close(symbol, side, qty);
      return { ok: false, status: 'missing', note: `FAIL CLOSED: no exchange-side stop could be confirmed, close attempted (${c.note}); confirmed filled ${c.qty}, requested ${qty}${notes.length ? `; ${notes.join('; ')}` : ''}`, stop: null, tp: null };
    }
    if (tp && !have.tp) notes.push('take profit is NOT on the exchange (stop is)');
    if (missStop) notes.push(`exchange-side stop re-placed at ${have.stop}`);
    return { ok: true, status: 'confirmed', note: notes.join('; '), stop: have.stop, tp: have.tp };
  }

  knownProtection(): Record<string, { stop: number; tp: number | null }> {
    const known: Record<string, { stop: number; tp: number | null }> = {};
    for (const p of this.journal.positions) {
      if (p.ownership === 'external' || !Number.isFinite(p.stop) || p.stop <= 0) continue;
      known[`${p.symbol}:${p.side}`] = { stop: p.stop, tp: p.tp != null && Number.isFinite(p.tp) && p.tp > 0 ? p.tp : null };
    }
    return known;
  }

  /**
   * Startup reconcile: every open position on the venue must have an exchange-side stop.
   * Known stops come from the desk; unknown positions get a stop PROTECT_STOP_PCT away from the worse of entry and mark.
   * If a read confirms the stop is still missing after placement, that position is closed (fail closed).
   */
  async ensureProtection(known: Record<string, { stop: number; tp: number | null }> = {}, fallbackPct = 3): Promise<string[]> {
    const notes: string[] = [];
    let venue: Awaited<ReturnType<ExchangeAdapter['positions']>> = [];
    try { venue = await this.adapter.positions(); } catch (e) { return [`could not read positions: ${safe((e as Error).message)}`]; }
    for (const p of venue) {
      let k = known[`${p.symbol}:${p.side}`] ?? known[p.symbol];
      if (!k) {
        let mark = p.entry;
        try { mark = await this.adapter.ticker(p.symbol); } catch { /* entry only */ }
        const ref = p.side === 'LONG' ? Math.min(p.entry, mark) : Math.max(p.entry, mark);
        k = { stop: Number((p.side === 'LONG' ? ref * (1 - fallbackPct / 100) : ref * (1 + fallbackPct / 100)).toPrecision(8)), tp: null };
      }
      const g = await this.ensureOnExchange(p.symbol, p.side, p.qty, k.stop, k.tp);
      notes.push(`${p.symbol} ${p.side}: ${g.status === 'confirmed' ? `protected on the exchange, stop ${g.stop}${g.tp ? `, take profit ${g.tp}` : ''}${g.note ? ` (${g.note})` : ''}` : g.note}`);
    }
    return notes;
  }

  async close(symbol: string, side: Side, qty: number, positionId?: string): Promise<Fill> {
    const { clientId } = this.intent('close', { symbol, side, qty, positionId });
    recordDiagnostic({ source: 'exchange', category: 'ORDER', eventName: 'order.submission', status: 'submitting', correlationId: clientId, message: 'Submitting reduce-only close', details: { clientId, positionId, symbol, side, requestedQty: qty } });
    let sendError: string | null = null;
    try { await this.adapter.closePosition(symbol, side, qty, clientId); }
    catch (e) { sendError = safe((e as Error).message); }
    const fill = await this.reconcile(symbol, clientId, sendError, qty);
    if (fill.ok && fill.remainingQty === 0) await this.cleanupProtection(symbol);
    // Do not sweep symbol-wide orders here: they can protect a remainder or belong to the owner.
    // Attached/reduce-only protection is left on the venue; killAll retains its explicit cancellation policy.
    return fill;
  }

  async cleanupProtection(symbol: string) {
    if (!this.adapter.cancelOrder || this.journal.intents.some((i) => i.symbol === symbol && i.kind === 'open' && !this.journal.settled(i))) return;
    try {
      if ((await this.adapter.positions(symbol)).some((p) => p.qty > 0)) return;
      for (const parent of this.journal.protectionClients.filter((p) => p.symbol === symbol)) {
        for (const suffix of ['s', 't']) {
          const clientId = `${parent.clientId}${suffix}`;
          const order = await this.adapter.getOrder(symbol, clientId);
          if (order.status === 'open' || order.status === 'partial') await this.adapter.cancelOrder(symbol, clientId);
        }
      }
      this.journal.protectionClients = this.journal.protectionClients.filter((p) => p.symbol !== symbol); this.journal.save();
    } catch (e) { log(`[live] owned protection cleanup deferred: ${safe((e as Error).message)}`); }
  }

  /** Kill switch: cancel everything and flatten every position the exchange reports. */
  async killAll(symbols: string[]): Promise<string[]> {
    const notes: string[] = [];
    let venue: Awaited<ReturnType<ExchangeAdapter['positions']>> = [];
    try { venue = await this.adapter.positions(); } catch (e) { notes.push(`could not read positions: ${safe((e as Error).message)}`); }
    const all = new Set([...symbols, ...venue.map((p) => p.symbol)]);
    for (const s of all) { try { await this.adapter.cancelAll(s); notes.push(`${s}: orders cancelled`); } catch (e) { notes.push(`${s}: cancel failed ${safe((e as Error).message)}`); } }
    try { venue = await this.adapter.positions(); } catch (e) { notes.push(`post-cancel position read failed: ${safe((e as Error).message)}`); }
    for (const p of venue) { const f = await this.close(p.symbol, p.side, p.qty); notes.push(`${p.symbol}: ${f.note}`); }
    return notes;
  }
}
