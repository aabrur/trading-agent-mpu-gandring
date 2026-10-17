import type { ExchangeAdapter } from '../exchange/index.js';
import { floorStep } from '../exchange/index.js';
import { LiveExecutor } from './executor.js';

export interface RoundTrip { ok: boolean; steps: string[]; clientId: string; symbol: string }

/** Smallest possible round trip on TESTNET: read, place with stop, reconcile, see the position, close, cancel, confirm flat. */
export async function testnetRoundTrip(adapter: ExchangeAdapter, symbol = 'BTCUSDT', opts: { reconcileDelayMs?: number; minNotional?: number } = {}): Promise<RoundTrip> {
  if (adapter.network !== 'testnet') throw new Error('the round trip only runs on testnet');
  const steps: string[] = [];
  const ex = new LiveExecutor(adapter, opts.reconcileDelayMs ?? 1500);
  const fail = (why: string): RoundTrip => ({ ok: false, steps: [...steps, `FAILED: ${why}`], clientId: '', symbol });
  try {
    const ping = await adapter.ping(); steps.push(`read ok: ${ping.detail}`);
    const bal = await adapter.balance(); steps.push(`testnet balance ${bal.availableUsdt.toFixed(2)} USDT available`);
    const ins = await adapter.instrument(symbol);
    const px = await adapter.ticker(symbol);
    const want = (opts.minNotional ?? 6) / px;
    let qty = Math.max(ins.minQty, floorStep(want + ins.qtyStep, ins.qtyStep));
    qty = floorStep(qty, ins.qtyStep) || ins.minQty;
    steps.push(`${symbol} last ${px}, test size ${qty}`);
    const fill = await ex.open({ symbol, side: 'LONG', qty, stop: px * 0.97, tp: px * 1.03, leverage: 1 });
    steps.push(`place + reconcile: ${fill.note}`);
    if (!fill.ok) return fail('entry did not fill');
    const pos = (await adapter.positions(symbol)).find((p) => p.side === 'LONG');
    if (!pos) return fail('position not visible on the exchange after the fill');
    steps.push(`position seen: ${pos.qty} @ ${pos.entry}${pos.stop ? `, stop ${pos.stop}` : ''}`);
    const close = await ex.close(symbol, 'LONG', pos.qty);
    steps.push(`close + reconcile + cancel: ${close.note}`);
    if (!close.ok) return fail('close did not fill');
    const left = (await adapter.positions(symbol)).filter((p) => p.qty > 0);
    if (left.length) return fail('position still open after close');
    steps.push('flat again');
    return { ok: true, steps, clientId: fill.clientId, symbol };
  } catch (e) {
    return fail((e as Error).message);
  }
}
