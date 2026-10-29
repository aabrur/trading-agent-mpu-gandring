import type { ExitCause } from '../types.js';
import { randomBytes } from 'node:crypto';
import type { ExchangeAdapter, OrderRecord, Side } from '../exchange/index.js';
import { ExecutionJournal, type ExecutionIntent } from './journal.js';
import { recordDiagnostic } from '../session-log.js';
import { FinancialEvidence } from './financial-evidence.js';
import { floorStep, roundEntryLimit, type FinancialPage, type FinancialRecord, type PlaceOrder } from '../exchange/types.js';
import { log, safe } from '../redact.js';

export const newClientId = (tag = 'o') => `mg${tag}${Date.now().toString(36)}${randomBytes(4).toString('hex')}`.slice(0, 32);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Fill { ok: boolean; clientId: string; record: OrderRecord | null; qty: number; requestedQty: number; remainingQty: number; avgPrice: number | null; note: string; pending?: boolean; entryState?: ExecutionIntent['entryState']; protectionStatus?: ExecutionIntent['protectionStatus'] }
export type OpenRequest = Omit<PlaceOrder, 'clientId'> & { clientId?: string };
export interface ProtectionResult { ok: boolean; status: 'confirmed' | 'missing' | 'unknown'; note: string; stop: number | null; tp: number | null }

// Every exchange write goes through here. Rules:
//  - one send per intent, never a blind retry
//  - after the send (or a send error, or a timeout) we read the exchange's own record and trust only that
//  - every entry carries a stop loss, the adapter refuses otherwise
export class LiveExecutor {
  readonly journal: ExecutionJournal;
  readonly financialEvidence: FinancialEvidence;
  private financialRead: Promise<void> | null = null;
  private limitOperations: Promise<void> = Promise.resolve();
  private limitExclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.limitOperations.then(work);
    this.limitOperations = result.then(() => {}, () => {});
    return result;
  }
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
  private async intent(kind: 'open' | 'close', o: { symbol: string; side: Side; qty: number; stop?: number; tp?: number | null; leverage?: number; positionId?: string; exitCause?: ExitCause }, clientId = newClientId(kind === 'open' ? 'e' : 'c')) {
    const intent: ExecutionIntent = { ...o, kind, requestedQty: o.qty, clientId, accountedQty: 0, accountedValue: 0, record: null, at: Date.now() };
    this.journal.intents.push(intent);
    await this.journal.saveAsync(); // Persist before sending so a restart cannot lose ownership evidence.
    recordDiagnostic({ source: 'exchange', category: 'ORDER', eventName: 'order.intent', status: 'created', message: `${kind} intent persisted`, correlationId: intent.clientId, details: { clientId: intent.clientId, positionId: o.positionId, symbol: o.symbol, side: o.side, requestedQty: o.qty } });
    return intent;
  }
  async refreshPending() {
    await this.limitExclusive(async () => {
      for (const intent of this.journal.intents.filter(i => i.entry?.type === 'LIMIT_GTC' && (!this.journal.settled(i) || i.protectionStatus === 'unknown'))) {
        const entry = intent.entry;
        if (entry?.type === 'LIMIT_GTC' && entry.expireAt != null && entry.expireAt <= Date.now() && !this.limitTerminal(intent)) await this.cancelLimit(intent, true);
        else await this.readLimit(intent);
        await this.protectLimit(intent);
      }
    });
    for (const intent of this.journal.intents.filter((i) => !this.journal.settled(i))) {
      if (intent.entry?.type === 'LIMIT_GTC') continue;
      try {
        const record = await this.adapter.getOrder(intent.symbol, intent.clientId);
        const terminal = (status: OrderRecord['status']) => ['filled', 'cancelled', 'rejected'].includes(status);
        if (record.status !== 'unknown' && Number.isFinite(record.filledQty) && record.filledQty >= (intent.record?.filledQty ?? 0) && !(intent.record && terminal(intent.record.status) && !terminal(record.status))) intent.record = record;
        recordDiagnostic({ source: 'exchange', category: 'ORDER', eventName: 'order.pending_reconciled', status: record.status, correlationId: intent.clientId, message: 'Pending order record observed', details: { clientId: intent.clientId, orderId: record.orderId, symbol: intent.symbol, filledQty: record.filledQty, requestedQty: intent.requestedQty } });
      }
      catch (e) { log(`[live] pending order read failed: ${safe((e as Error).message)}`); }
    }
    await this.journal.saveAsync();
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
    if (intent && rec) { intent.record = rec; await this.journal.saveAsync(); }
    const note = filled
      ? `exchange record: ${rec!.status} ${rec!.filledQty} @ ${rec!.avgPrice ?? '?'}${sendError ? ` (send reported: ${sendError})` : ''}`
      : `not filled per exchange record (${rec?.status ?? 'no record'})${sendError ? `; send error: ${sendError}` : ''}. Not retried.`;
    recordDiagnostic({ source: 'exchange', category: 'ORDER', eventName: 'order.reconciled', level: sendError || rec?.status === 'rejected' ? 'WARN' : 'INFO', status: rec?.status ?? 'unknown', correlationId: clientId, message: note, details: { clientId, orderId: rec?.orderId, symbol, filledQty: rec?.filledQty ?? null, requestedQty, sendError } });
    return { ok: filled, clientId, record: rec, qty: filled ? rec!.filledQty : 0, requestedQty, remainingQty: Math.max(0, requestedQty - (filled ? rec!.filledQty : 0)), avgPrice: filled ? rec!.avgPrice : null, note: safe(note) };
  }

  async open(o: OpenRequest): Promise<Fill> {
    if (o.entry?.type === 'LIMIT_GTC') return this.limitExclusive(() => this.openLimit(o));
    if (o.entry && o.entry.type !== 'MARKET') throw new Error('Unsupported entry type');
    if (!(o.stop > 0)) return { ok: false, clientId: '', record: null, qty: 0, requestedQty: o.qty, remainingQty: o.qty, avgPrice: null, note: 'refused: no stop loss' };
    // Fail closed: a venue that cannot hold the stop on its own side never gets an entry.
    if (this.adapter.exchangeStops !== true) return { ok: false, clientId: '', record: null, qty: 0, requestedQty: o.qty, remainingQty: o.qty, avgPrice: null, note: `refused: the ${this.adapter.name} adapter cannot place an exchange-side stop loss` };
    const { clientId } = await this.intent('open', o);
    this.journal.protectionClients.push({ symbol: o.symbol, clientId }); await this.journal.saveAsync();
    let sendError: string | null = null;
    recordDiagnostic({ source: 'exchange', category: 'ORDER', eventName: 'order.submission', status: 'submitting', correlationId: clientId, message: 'Submitting entry order', details: { clientId, symbol: o.symbol, side: o.side, requestedQty: o.qty } });
    try { await this.adapter.placeOrder({ ...o, clientId }); }
    catch (e) { sendError = safe((e as Error).message); log(`[live] send for ${clientId} failed: ${sendError}. Reconciling, not retrying.`); }
    const fill = await this.reconcile(o.symbol, clientId, sendError, o.qty);
    if (!fill.ok) return fill;
    if (fill.avgPrice != null && (o.side === 'LONG' ? o.stop >= fill.avgPrice : o.stop <= fill.avgPrice)) {
      const exit = await this.close(o.symbol, o.side, fill.qty);
      return { ...fill, ok: false, note: `${fill.note}. FAIL CLOSED: actual fill crossed the required stop; reduce-only close: ${exit.note}` };
    }
    const guard = await this.ensureOnExchange(o.symbol, o.side, fill.qty, o.stop, o.tp);
    recordDiagnostic({ source: 'exchange', category: 'PROTECTION', eventName: 'protection.observed', level: guard.status === 'confirmed' ? 'INFO' : 'WARN', status: guard.status, correlationId: clientId, message: guard.note || 'Exchange protection confirmed', details: { clientId, symbol: o.symbol, stop: guard.stop, tp: guard.tp, ok: guard.ok } });
    if (!guard.ok) return { ...fill, ok: false, qty: 0, note: safe(`${fill.note}. ${guard.note}`) };
    return guard.note ? { ...fill, note: safe(`${fill.note}. ${guard.note}`) } : fill;
  }

  private limitTerminal(intent: ExecutionIntent) { return !!intent.record && ['filled', 'cancelled', 'rejected'].includes(intent.record.status); }
  private limitFill(intent: ExecutionIntent): Fill {
    const qty = intent.record?.filledQty ?? 0;
    const pending = !this.limitTerminal(intent);
    return { ok: qty > 0 && intent.protectionStatus !== 'missing', clientId: intent.clientId, record: intent.record, qty, requestedQty: intent.requestedQty, remainingQty: Math.max(0, intent.requestedQty - qty), avgPrice: intent.record?.avgPrice ?? null, pending, entryState: intent.entryState, protectionStatus: intent.protectionStatus, note: `LIMIT_GTC ${intent.entryState}: filled ${qty}/${intent.requestedQty}; protection ${intent.protectionStatus ?? 'not applicable'}. Reconcile this client id; never resend an entry.` };
  }
  private async readLimit(intent: ExecutionIntent) {
    try {
      const record = await this.adapter.getOrder(intent.symbol, intent.clientId);
      if (record.status === 'unknown' || !Number.isFinite(record.filledQty) || record.filledQty < (intent.record?.filledQty ?? 0) || record.filledQty > intent.requestedQty * (1 + 1e-10)) {
        intent.entryState = 'UNKNOWN';
      } else if (!(this.limitTerminal(intent) && !['filled', 'cancelled', 'rejected'].includes(record.status))) {
        intent.record = record;
        if (record.orderId) intent.orderId = record.orderId;
        intent.filledQty = record.filledQty;
        intent.remainingQty = Math.max(0, intent.requestedQty - record.filledQty);
        intent.entryState = record.status === 'filled' ? 'FILLED' : record.status === 'partial' ? (intent.cancelRequestedAt ? 'CANCEL_REQUESTED' : 'PARTIAL') : record.status === 'open' ? (intent.cancelRequestedAt ? 'CANCEL_REQUESTED' : 'RESTING') : record.status === 'rejected' ? 'REJECTED' : record.status === 'cancelled' ? (record.raw === 'EXPIRED' || intent.expireRequested ? 'EXPIRED' : 'CANCELLED') : 'UNKNOWN';
        intent.acceptedAt ??= Date.now();
      }
    } catch { intent.entryState = 'UNKNOWN'; }
    intent.updatedAt = Date.now();
    await this.journal.saveAsync();
  }
  private async cancelLimit(intent: ExecutionIntent, expired = false) {
    await this.readLimit(intent);
    if (this.limitTerminal(intent)) return;
    if (!this.adapter.cancelOrder) throw new Error('This adapter cannot cancel an entry');
    // A persisted request is never blindly sent twice after timeout or restart.
    if (intent.cancelRequestedAt == null) {
      intent.cancelRequestedAt = Date.now(); intent.expireRequested = expired; intent.entryState = 'CANCEL_REQUESTED'; intent.updatedAt = Date.now();
      await this.journal.saveAsync();
      try { await this.adapter.cancelOrder(intent.symbol, intent.clientId); } catch { intent.entryState = 'UNKNOWN'; }
    }
    await this.readLimit(intent);
  }
  /** Owner-selected cancel: touches only this entry, never the stop/TP on already-filled exposure. */
  cancelEntry(clientId: string): Promise<Fill> {
    return this.limitExclusive(async () => {
      const intent = this.journal.intents.find(i => i.clientId === clientId && i.kind === 'open' && i.entry?.type === 'LIMIT_GTC');
      if (!intent) throw new Error('Unknown LIMIT_GTC entry client id');
      await this.cancelLimit(intent);
      await this.protectLimit(intent);
      return this.limitFill(intent);
    });
  }
  private async protectLimit(intent: ExecutionIntent) {
    if (!(intent.record?.filledQty && intent.stop)) return;
    let position: Awaited<ReturnType<ExchangeAdapter['positions']>>[number] | undefined;
    try { position = (await this.adapter.positions(intent.symbol)).find(p => p.side === intent.side && p.qty > 0); }
    catch { intent.protectionStatus = 'unknown'; await this.cancelLimit(intent); await this.journal.saveAsync(); return; }
    if (!position) { intent.protectionStatus = 'unknown'; await this.cancelLimit(intent); await this.journal.saveAsync(); return; } // Cumulative fills do not prove current exposure or protection.
    if (intent.emergencyCloseId) {
      const prior = this.journal.intents.find(i => i.clientId === intent.emergencyCloseId);
      const terminal = prior?.record && ['filled', 'cancelled', 'rejected'].includes(prior.record.status);
      if (!terminal || intent.record.filledQty <= (intent.emergencyCoveredFillQty ?? intent.record.filledQty)) return;
    }
    const read = async () => { try { return await this.adapter.protection(intent.symbol, intent.side, position.qty); } catch { return null; } };
    let protection = await read();
    if (!protection) { intent.protectionStatus = 'unknown'; await this.cancelLimit(intent); await this.journal.saveAsync(); return; }
    if (!protection.stop && intent.protectionAttemptedQty == null) {
      // Aster's closePosition STOP protects the entire current net position, including subsequent partial fills.
      // Persist the stable protection id before the one send; uncertain replies are read back, never duplicated.
      intent.protectionAttemptedQty = position.qty;
      this.journal.protectionClients.push({ symbol: intent.symbol, clientId: intent.clientId });
      await this.journal.saveAsync();
      try { await this.adapter.protect({ symbol: intent.symbol, side: intent.side, qty: position.qty, stop: intent.stop, tp: intent.tp ?? null, clientId: intent.clientId }); } catch { /* Read the venue result even when send fails. */ }
      protection = await read();
    }
    intent.protectionStatus = !protection ? 'unknown' : !protection.stop ? 'missing' : protection.stopCoverage === 'net_position' || (protection.stopCoverage === 'quantity' && (protection.stopQty ?? 0) >= position.qty) ? 'confirmed' : protection.stopCoverage === 'quantity' ? 'missing' : 'unknown';
    intent.updatedAt = Date.now(); await this.journal.saveAsync();
    if (intent.protectionStatus !== 'confirmed') await this.cancelLimit(intent);
    if (intent.protectionStatus === 'missing') {
      // Do not stack an emergency close while another close result remains unresolved.
      const existing = this.journal.intents.find(i => i.symbol === intent.symbol && i.side === intent.side && i.kind === 'close' && (!i.record || !['filled', 'cancelled', 'rejected'].includes(i.record.status)));
      const newExposure = intent.record.filledQty - (intent.emergencyCoveredFillQty ?? 0);
      intent.emergencyCloseId = existing?.clientId ?? newClientId('c'); await this.journal.saveAsync();
      if (!existing) {
        intent.emergencyCoveredFillQty = intent.record.filledQty; await this.journal.saveAsync();
        await this.close(intent.symbol, intent.side, Math.min(position.qty, newExposure), intent.positionId, 'UNKNOWN', intent.emergencyCloseId);
      }
    }
  }
  private async openLimit(o: OpenRequest): Promise<Fill> {
    if (o.entry?.type !== 'LIMIT_GTC' || this.adapter.name !== 'aster' || this.adapter.restingLimitGtcEntry !== true || !this.adapter.cancelOrder || this.adapter.exchangeStops !== true) throw new Error('Resting LIMIT_GTC entry is unavailable for this adapter');
    const entry = o.entry;
    if (![o.qty, o.stop, o.leverage, entry.price].every(v => Number.isFinite(v) && v > 0) || (entry.expireAt != null && !Number.isFinite(entry.expireAt))) throw new Error('Invalid LIMIT_GTC ticket or explicit expiration');
    const clientId = o.clientId ?? newClientId('e');
    if (!/^[.A-Z:/a-z0-9_-]{1,32}$/.test(clientId)) throw new Error('Invalid entry client id');
    const existing = this.journal.intents.find(i => i.clientId === clientId);
    if (existing) {
      if (existing.kind !== 'open' || existing.entry?.type !== 'LIMIT_GTC' || existing.symbol !== o.symbol || existing.side !== o.side || existing.requestedQty !== o.qty || existing.entry.price !== entry.price || existing.stop !== o.stop || existing.tp !== o.tp || existing.leverage !== o.leverage || existing.entry.expireAt !== entry.expireAt) throw new Error('Client id already belongs to a different ticket');
      await this.readLimit(existing); await this.protectLimit(existing); return this.limitFill(existing);
    }
    if (entry.expireAt != null && entry.expireAt <= Date.now()) throw new Error('Invalid LIMIT_GTC explicit expiration');
    const ins = await this.adapter.instrument(o.symbol);
    const price = roundEntryLimit(entry.price, ins.tickSize, o.side);
    if (Math.abs(floorStep(o.qty, ins.qtyStep) - o.qty) > Math.max(1, o.qty) * 1e-10 || o.qty < ins.minQty || (o.side === 'LONG' ? o.stop >= price : o.stop <= price)) throw new Error('LIMIT_GTC ticket does not match venue lot, tick or stop geometry');
    const intent: ExecutionIntent = { ...o, clientId, kind: 'open', requestedQty: o.qty, entry: { ...entry }, limitPrice: price, entryState: 'CREATED', venue: this.adapter.name, network: this.adapter.network, at: Date.now(), updatedAt: Date.now(), filledQty: 0, remainingQty: o.qty, accountedQty: 0, accountedValue: 0, record: null };
    this.journal.intents.push(intent);
    await this.journal.saveAsync();
    intent.entryState = 'SUBMITTED'; intent.submittedAt = Date.now(); intent.updatedAt = Date.now(); await this.journal.saveAsync();
    try { const sent = await this.adapter.placeOrder({ ...o, entry: { ...entry, price }, clientId }); intent.orderId = sent.orderId ?? undefined; }
    catch { intent.entryState = 'UNKNOWN'; }
    await this.journal.saveAsync(); await this.readLimit(intent); await this.protectLimit(intent);
    return this.limitFill(intent);
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
      this.journal.protectionClients.push({ symbol, clientId: protectionId }); await this.journal.saveAsync();
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

  async close(symbol: string, side: Side, qty: number, positionId?: string, exitCause: ExitCause = 'UNKNOWN', requestedClientId?: string): Promise<Fill> {
    const prior = requestedClientId ? this.journal.intents.find(i => i.clientId === requestedClientId) : null;
    if (prior) return this.reconcile(symbol, prior.clientId, null, prior.requestedQty);
    const { clientId } = await this.intent('close', { symbol, side, qty, positionId, exitCause }, requestedClientId);
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
      this.journal.protectionClients = this.journal.protectionClients.filter((p) => p.symbol !== symbol); await this.journal.saveAsync();
    } catch (e) { log(`[live] owned protection cleanup deferred: ${safe((e as Error).message)}`); }
  }

  /** Kill switch: cancel everything and flatten every position the exchange reports. */
  async killAll(symbols: string[]): Promise<string[]> {
    const notes: string[] = [];
    let venue: Awaited<ReturnType<ExchangeAdapter['positions']>> = [];
    try { venue = await this.adapter.positions(); } catch (e) { notes.push(`could not read positions: ${safe((e as Error).message)}`); }
    const all = new Set([...symbols, ...venue.map((p) => p.symbol), ...this.journal.intents.filter(i => i.kind === 'open' && !this.journal.settled(i)).map(i => i.symbol)]);
    for (const s of all) { try { await this.adapter.cancelAll(s); notes.push(`${s}: orders cancelled`); } catch (e) { notes.push(`${s}: cancel failed ${safe((e as Error).message)}`); } }
    try { venue = await this.adapter.positions(); } catch (e) { notes.push(`post-cancel position read failed: ${safe((e as Error).message)}`); }
    for (const p of venue) {
      const unresolved = this.journal.intents.find(i => i.kind === 'close' && i.symbol === p.symbol && i.side === p.side && !this.journal.settled(i));
      if (unresolved) { notes.push(`${p.symbol}: prior close ${unresolved.clientId} requires reconciliation; no duplicate flatten submitted`); continue; }
      const f = await this.close(p.symbol, p.side, p.qty, undefined, 'OWNER_KILL'); notes.push(`${p.symbol}: ${f.note}`);
    }
    await this.refreshPending();
    return notes;
  }
}
