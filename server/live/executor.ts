import { randomBytes } from 'node:crypto';
import type { ExchangeAdapter, OrderRecord, Side } from '../exchange/index.js';
import { log, safe } from '../redact.js';

export const newClientId = (tag = 'o') => `mg${tag}${Date.now().toString(36)}${randomBytes(4).toString('hex')}`.slice(0, 32);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Fill { ok: boolean; clientId: string; record: OrderRecord | null; qty: number; avgPrice: number | null; note: string }

// Every exchange write goes through here. Rules:
//  - one send per intent, never a blind retry
//  - after the send (or a send error, or a timeout) we read the exchange's own record and trust only that
//  - every entry carries a stop loss, the adapter refuses otherwise
export class LiveExecutor {
  constructor(public adapter: ExchangeAdapter, private reconcileDelayMs = 1200) {}

  private async reconcile(symbol: string, clientId: string, sendError: string | null): Promise<Fill> {
    if (this.reconcileDelayMs) await pause(this.reconcileDelayMs);
    let rec: OrderRecord | null = null;
    try { rec = await this.adapter.getOrder(symbol, clientId); } catch (e) { log(`[live] reconcile read failed for ${clientId}: ${safe((e as Error).message)}`); }
    const filled = !!rec && (rec.status === 'filled' || rec.status === 'partial') && rec.filledQty > 0;
    const note = filled
      ? `exchange record: ${rec!.status} ${rec!.filledQty} @ ${rec!.avgPrice ?? '?'}${sendError ? ` (send reported: ${sendError})` : ''}`
      : `not filled per exchange record (${rec?.status ?? 'no record'})${sendError ? `; send error: ${sendError}` : ''}. Not retried.`;
    return { ok: filled, clientId, record: rec, qty: filled ? rec!.filledQty : 0, avgPrice: filled ? rec!.avgPrice : null, note: safe(note) };
  }

  async open(o: { symbol: string; side: Side; qty: number; stop: number; tp: number | null; leverage: number }): Promise<Fill> {
    if (!(o.stop > 0)) return { ok: false, clientId: '', record: null, qty: 0, avgPrice: null, note: 'refused: no stop loss' };
    // Fail closed: a venue that cannot hold the stop on its own side never gets an entry.
    if (this.adapter.exchangeStops !== true) return { ok: false, clientId: '', record: null, qty: 0, avgPrice: null, note: `refused: the ${this.adapter.name} adapter cannot place an exchange-side stop loss` };
    const clientId = newClientId('e');
    let sendError: string | null = null;
    try { await this.adapter.placeOrder({ ...o, clientId }); }
    catch (e) { sendError = safe((e as Error).message); log(`[live] send for ${clientId} failed: ${sendError}. Reconciling, not retrying.`); }
    const fill = await this.reconcile(o.symbol, clientId, sendError);
    if (!fill.ok) return fill;
    const guard = await this.ensureOnExchange(o.symbol, o.side, fill.qty, o.stop, o.tp);
    if (!guard.ok) return { ...fill, ok: false, qty: 0, note: safe(`${fill.note}. ${guard.note}`) };
    return guard.note ? { ...fill, note: safe(`${fill.note}. ${guard.note}`) } : fill;
  }

  /**
   * Checks that the stop loss (and take profit, if any) rest ON THE EXCHANGE for this position.
   * A missing leg is placed once. If the stop is still missing, the position is closed at once (fail closed).
   * A missing take profit is reported, never a reason to drop the stop.
   */
  async ensureOnExchange(symbol: string, side: Side, qty: number, stop: number, tp: number | null): Promise<{ ok: boolean; note: string; stop: number | null; tp: number | null }> {
    // A failed read is "unknown", not "missing": we never stack orders or close on a network blip.
    const read = async () => { for (let i = 0; i < 2; i++) { try { return await this.adapter.protection(symbol, side); } catch (e) { log(`[live] protection read failed on ${symbol}: ${safe((e as Error).message)}`); } } return null; };
    let have = await read();
    if (!have) return { ok: true, note: 'WARNING: could not read exchange-side orders to verify the stop; the entry was sent with its stop and will be checked again at next start', stop: null, tp: null };
    const notes: string[] = [];
    const missStop = !have.stop, missTp = !!tp && !have.tp;
    if (missStop || missTp) {
      try { await this.adapter.protect({ symbol, side, qty, stop: missStop ? stop : null, tp: missTp ? tp : null, clientId: newClientId('p') }); }
      catch (e) { notes.push(`placing the missing ${missStop ? 'stop' : 'take profit'} failed: ${safe((e as Error).message)}`); }
      if (this.reconcileDelayMs) await pause(this.reconcileDelayMs);
      have = (await read()) ?? { stop: null, tp: null };
    }
    if (!have.stop) {
      const c = await this.close(symbol, side, qty);
      return { ok: false, note: `FAIL CLOSED: no exchange-side stop could be confirmed, position closed (${c.note})${notes.length ? `; ${notes.join('; ')}` : ''}`, stop: null, tp: null };
    }
    if (tp && !have.tp) notes.push('take profit is NOT on the exchange (stop is)');
    if (missStop) notes.push(`exchange-side stop re-placed at ${have.stop}`);
    return { ok: true, note: notes.join('; '), stop: have.stop, tp: have.tp };
  }

  /**
   * Startup reconcile: every open position on the venue must have an exchange-side stop.
   * Known stops come from the desk; unknown positions get a stop PROTECT_STOP_PCT away from the worse of entry and mark.
   * If a stop cannot be placed, that position is closed (fail closed).
   */
  async ensureProtection(known: Record<string, { stop: number; tp: number | null }> = {}, fallbackPct = 3): Promise<string[]> {
    const notes: string[] = [];
    let venue: Awaited<ReturnType<ExchangeAdapter['positions']>> = [];
    try { venue = await this.adapter.positions(); } catch (e) { return [`could not read positions: ${safe((e as Error).message)}`]; }
    for (const p of venue) {
      let k = known[p.symbol];
      if (!k) {
        let mark = p.entry;
        try { mark = await this.adapter.ticker(p.symbol); } catch { /* entry only */ }
        const ref = p.side === 'LONG' ? Math.min(p.entry, mark) : Math.max(p.entry, mark);
        k = { stop: Number((p.side === 'LONG' ? ref * (1 - fallbackPct / 100) : ref * (1 + fallbackPct / 100)).toPrecision(8)), tp: null };
      }
      const g = await this.ensureOnExchange(p.symbol, p.side, p.qty, k.stop, k.tp);
      notes.push(`${p.symbol} ${p.side}: ${g.ok ? `protected on the exchange, stop ${g.stop}${g.tp ? `, take profit ${g.tp}` : ''}${g.note ? ` (${g.note})` : ''}` : g.note}`);
    }
    return notes;
  }

  async close(symbol: string, side: Side, qty: number): Promise<Fill> {
    const clientId = newClientId('c');
    let sendError: string | null = null;
    try { await this.adapter.closePosition(symbol, side, qty, clientId); }
    catch (e) { sendError = safe((e as Error).message); }
    const fill = await this.reconcile(symbol, clientId, sendError);
    try { await this.adapter.cancelAll(symbol); } catch (e) { log(`[live] cancel leftovers on ${symbol} failed: ${safe((e as Error).message)}`); }
    return fill;
  }

  /** Kill switch: cancel everything and flatten every position the exchange reports. */
  async killAll(symbols: string[]): Promise<string[]> {
    const notes: string[] = [];
    let venue: Awaited<ReturnType<ExchangeAdapter['positions']>> = [];
    try { venue = await this.adapter.positions(); } catch (e) { notes.push(`could not read positions: ${safe((e as Error).message)}`); }
    const all = new Set([...symbols, ...venue.map((p) => p.symbol)]);
    for (const s of all) { try { await this.adapter.cancelAll(s); notes.push(`${s}: orders cancelled`); } catch (e) { notes.push(`${s}: cancel failed ${safe((e as Error).message)}`); } }
    for (const p of venue) { const f = await this.close(p.symbol, p.side, p.qty); notes.push(`${p.symbol}: ${f.note}`); }
    return notes;
  }
}
