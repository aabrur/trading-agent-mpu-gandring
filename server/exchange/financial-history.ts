import { createHash } from 'node:crypto';
import { ExchangeError, type FinancialRecord, type FinancialFill, type FinancialCost, type FinancialQuery } from './types.js';
export const historyObject = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ExchangeError('Malformed financial history object');
  return v as Record<string, unknown>;
};
export function historyRows(v: unknown) { if (!Array.isArray(v)) throw new ExchangeError('Incomplete financial history list'); return v.map(historyObject); }
export function historyNumber(v: unknown) {
  if ((typeof v !== 'number' && typeof v !== 'string') || String(v).trim() === '' || !Number.isFinite(Number(v))) throw new ExchangeError('Missing financial history number');
  return Number(v);
}
export function historyText(v: unknown) {
  if ((typeof v !== 'string' && typeof v !== 'number') || String(v).trim() === '' || typeof v === 'number' && !Number.isSafeInteger(v)) throw new ExchangeError('Missing or unsafe financial history identifier');
  return String(v);
}
export const historyScope = (venue: string, network: string, publicIdentity: unknown) => createHash('sha256').update(venue + ':' + network + ':' + historyText(publicIdentity).toLowerCase()).digest('hex');
export function historyWindow(q: FinancialQuery) {
  if (!Number.isFinite(q.since) || !Number.isFinite(q.until) || q.since < 0 || q.until < q.since || q.until - q.since > 7 * 86400000) throw new ExchangeError('Financial history window must be within seven days');
}
export function asterIncome(rows: Record<string, unknown>[]): FinancialRecord[] {
  return rows.flatMap((r): FinancialRecord[] => {
    if (!['FUNDING_FEE', 'COMMISSION', 'COMMISSION_REBATE'].includes(String(r.incomeType))) return [];
    const kind = r.incomeType === 'FUNDING_FEE' ? 'funding' : 'fee';
    return [{ kind, id: historyText(r.incomeType) + ':' + historyText(r.tranId) + ':' + String(r.tradeId ?? ''), symbol: String(r.symbol ?? ''), currency: historyText(r.asset), amount: historyNumber(r.income) * (kind === 'fee' ? -1 : 1), at: historyNumber(r.time), ...(kind === 'fee' && r.tradeId ? { tradeId: String(r.tradeId) } : {}) }];
  });
}
export function asterFills(rows: Record<string, unknown>[], income: FinancialRecord[]): FinancialFill[] {
  return rows.map((r) => {
    const qty = historyNumber(r.qty), price = historyNumber(r.price);
    if (!(qty > 0 && price > 0)) throw new ExchangeError('Invalid historical fill quantity or price');
    const id = historyText(r.id), cost = income.find((i): i is FinancialCost => i.kind === 'fee' && i.tradeId === id && i.symbol === r.symbol);
    const currency = cost?.currency === 'USDT' && String(r.symbol).endsWith('USDT') ? 'USDT' : null;
    return { kind: 'fill', id, orderId: historyText(r.orderId), symbol: historyText(r.symbol), side: r.positionSide === 'LONG' || r.positionSide === 'SHORT' ? r.positionSide : null, qty, price, fee: cost ? { amount: cost.amount, currency: cost.currency } : null, realizedPnl: r.realizedPnl != null && currency ? { amount: historyNumber(r.realizedPnl), currency } : null, at: historyNumber(r.time) };
  });
}
export function bybitIncome(rows: Record<string, unknown>[]): FinancialRecord[] {
  return rows.flatMap((r): FinancialRecord[] => {
    if (!['TRADE', 'SETTLEMENT'].includes(String(r.type))) return [];
    const kind = r.type === 'TRADE' ? 'fee' : 'funding';
    return [{ kind, id: historyText(r.type) + ':' + historyText(r.id) + ':' + String(r.tradeId ?? ''), symbol: historyText(r.symbol), amount: historyNumber(kind === 'fee' ? r.fee : r.funding), currency: historyText(r.currency), at: historyNumber(r.transactionTime), ...(kind === 'fee' ? { tradeId: r.tradeId ? String(r.tradeId) : undefined, realizedPnl: r.cashFlow == null ? undefined : historyNumber(r.cashFlow) } : {}) }];
  });
}
export function bybitFills(rows: Record<string, unknown>[], income: FinancialRecord[]): FinancialFill[] {
  return rows.filter((r) => !['Funding', 'Settle'].includes(String(r.execType))).map((r) => {
    const qty = historyNumber(r.execQty), price = historyNumber(r.execPrice);
    if (!(qty > 0 && price > 0)) throw new ExchangeError('Invalid historical fill quantity or price');
    const id = historyText(r.execId), cost = income.find((i): i is FinancialCost => i.kind === 'fee' && i.tradeId === id && i.symbol === r.symbol);
    const currency = r.feeCurrency || r.feeCoin;
    return { kind: 'fill', id, orderId: historyText(r.orderId), clientId: r.orderLinkId ? String(r.orderLinkId) : undefined, symbol: historyText(r.symbol), side: null, qty, price, fee: cost ? { amount: cost.amount, currency: cost.currency } : currency && r.execFee != null ? { amount: historyNumber(r.execFee), currency: historyText(currency) } : null, realizedPnl: cost?.kind === 'fee' && cost.realizedPnl != null ? { amount: cost.realizedPnl, currency: cost.currency } : null, at: historyNumber(r.execTime) };
  });
}
