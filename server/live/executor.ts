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
    const clientId = newClientId('e');
    let sendError: string | null = null;
    try { await this.adapter.placeOrder({ ...o, clientId }); }
    catch (e) { sendError = safe((e as Error).message); log(`[live] send for ${clientId} failed: ${sendError}. Reconciling, not retrying.`); }
    return this.reconcile(o.symbol, clientId, sendError);
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
