import type { Availability, DecimalString, IntentState, ProtectionState } from '../contracts.js';
import type { RuntimeStore } from '../store/database.js';
import { compareDecimals } from './decimal.js';
import {
  ensureExposureProtection,
  type NativeExposurePosition,
  type ProtectionSnapshot
} from './protection.js';

export interface ReconcileTransportOrder {
  clientOrderId: string;
  venueOrderId: string | null;
  state: IntentState;
  filledQty: DecimalString | null;
}

export interface ReconcileVenueTransport {
  balance: () => Promise<{
    balanceUsdt: DecimalString | null;
    availableUsdt: DecimalString | null;
    realizedDailyPnlUsdt: DecimalString | null;
    feesUsdt?: DecimalString | null;
    fundingUsdt?: DecimalString | null;
  }>;
  positions: () => Promise<NativeExposurePosition[]>;
  lookupOrder: (symbol: string, clientOrderId: string) => Promise<ReconcileTransportOrder>;
  readProtection: (position: NativeExposurePosition) => Promise<ProtectionSnapshot>;
  placeProtection: (
    position: NativeExposurePosition,
    stopPrice: DecimalString
  ) => Promise<ProtectionSnapshot>;
  closePosition: (
    position: NativeExposurePosition,
    clientOrderId: string
  ) => Promise<ReconcileTransportOrder>;
}

export interface ReconciledPendingIntent {
  intentId: string;
  clientOrderId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  orderState: IntentState;
  filledQty: DecimalString | null;
}

export interface Reconciliation {
  accountRef: string;
  positions: NativeExposurePosition[];
  pending: ReconciledPendingIntent[];
  protection: Record<string, ProtectionState>;
  financial: {
    realizedPnl: DecimalString | null;
    fees: DecimalString | null;
    funding: DecimalString | null;
    availability: Availability;
  };
  unknowns: string[];
  externalCredentialConflict: boolean;
}

/**
 * Reconciles durable local intents and managed positions against native venue readbacks
 * without submitting new entry orders or holding SQL transactions across network IO.
 */
export async function reconcileAccountState(params: {
  store: RuntimeStore;
  accountRef: string;
  transport: ReconcileVenueTransport;
}): Promise<Reconciliation> {
  const { store, accountRef, transport } = params;

  // 1. Read local unresolved intents and known managed symbols in short queries.
  const intentRows = await store.execute(
    `SELECT intent_id, client_order_id, symbol, side, intent_kind, order_state, payload_json
     FROM execution_intents
     WHERE account_ref = ?`,
    [accountRef]
  );

  const managedRows = await store.execute(
    `SELECT position_key, symbol, stop_price
     FROM managed_positions
     WHERE account_ref = ? AND state = 'OPEN'`,
    [accountRef]
  );

  const knownSymbols = new Set<string>();
  const stopBySymbol = new Map<string, string>();
  for (const row of intentRows.rows) {
    knownSymbols.add(String(row.symbol));
    try {
      const parsed = JSON.parse(String(row.payload_json)) as { stop?: string | null };
      if (parsed.stop) {
        stopBySymbol.set(String(row.symbol), parsed.stop);
      }
    } catch {
      // Ignore malformed historical payload metadata.
    }
  }
  for (const row of managedRows.rows) {
    knownSymbols.add(String(row.symbol));
    if (row.stop_price !== null) {
      stopBySymbol.set(String(row.symbol), String(row.stop_price));
    }
  }

  // 2. Resolve ambiguous intents via native lookupOrder (zero submit calls).
  const pending: ReconciledPendingIntent[] = [];
  const unknowns: string[] = [];
  const resolvedIntentUpdates: Array<{
    intentId: string;
    state: IntentState;
    venueOrderId: string | null;
  }> = [];

  for (const row of intentRows.rows) {
    const orderState = String(row.order_state) as IntentState;
    const intentId = String(row.intent_id);
    const clientOrderId = String(row.client_order_id);
    const symbol = String(row.symbol);
    const side = String(row.side) as 'LONG' | 'SHORT';

    if (
      orderState === 'SUBMITTING' ||
      orderState === 'UNKNOWN' ||
      orderState === 'ACCEPTED' ||
      orderState === 'PARTIAL'
    ) {
      try {
        const lookedUp = await transport.lookupOrder(symbol, clientOrderId);
        resolvedIntentUpdates.push({
          intentId,
          state: lookedUp.state,
          venueOrderId: lookedUp.venueOrderId
        });
        if (
          lookedUp.state === 'ACCEPTED' ||
          lookedUp.state === 'PARTIAL' ||
          lookedUp.state === 'UNKNOWN'
        ) {
          pending.push({
            intentId,
            clientOrderId,
            symbol,
            side,
            orderState: lookedUp.state,
            filledQty: lookedUp.filledQty
          });
        }
        if (lookedUp.state === 'UNKNOWN') {
          unknowns.push(`Unresolved order ${clientOrderId} on ${symbol}`);
        }
      } catch {
        unknowns.push(`Order lookup unavailable for ${clientOrderId} on ${symbol}`);
        pending.push({
          intentId,
          clientOrderId,
          symbol,
          side,
          orderState: 'UNKNOWN',
          filledQty: null
        });
      }
    }
  }

  // 3. Query native positions and balance outside any SQL transaction.
  const [nativePositions, nativeBalance] = await Promise.all([
    transport.positions(),
    transport.balance()
  ]);

  let externalCredentialConflict = false;
  const protection: Record<string, ProtectionState> = {};

  for (const pos of nativePositions) {
    if (compareDecimals(pos.qty, '0') <= 0) continue;

    if (!knownSymbols.has(pos.symbol)) {
      externalCredentialConflict = true;
      unknowns.push(
        `External unattributed position detected on ${pos.symbol} (${pos.positionKey}); local lease cannot fence external API writers`
      );
      try {
        const snap = await transport.readProtection(pos);
        protection[pos.positionKey] = snap.state;
      } catch {
        protection[pos.positionKey] = 'UNVERIFIED';
      }
      continue;
    }

    const desiredStop = stopBySymbol.get(pos.symbol);
    if (desiredStop) {
      const prot = await ensureExposureProtection({
        position: pos,
        desiredStopPrice: desiredStop,
        readProtection: (p) => transport.readProtection(p),
        placeProtection: (p, s) => transport.placeProtection(p, s),
        emergencyClose: async (p, cid) => {
          await transport.closePosition(p, cid);
        }
      });
      protection[pos.positionKey] = prot.protectionState;
    } else {
      const snap = await transport.readProtection(pos);
      protection[pos.positionKey] = snap.state;
    }
  }

  // 4. Persist reconciled states in a single short SQL transaction.
  const nowIso = new Date().toISOString();
  await store.transaction(async (tx) => {
    for (const upd of resolvedIntentUpdates) {
      await tx.execute(
        `UPDATE execution_intents
         SET order_state = ?, venue_order_id = COALESCE(?, venue_order_id), updated_at = ?
         WHERE account_ref = ? AND intent_id = ?`,
        [upd.state, upd.venueOrderId, nowIso, accountRef, upd.intentId]
      );
    }

    for (const pos of nativePositions) {
      if (!knownSymbols.has(pos.symbol)) continue;
      const protState = protection[pos.positionKey] ?? 'UNVERIFIED';
      await tx.execute(
        `INSERT INTO managed_positions (
          account_ref, position_key, native_position_id, symbol, native_instrument,
          position_mode, side, qty, entry_price, stop_price, tp_price, leverage,
          ownership, protection_state, thesis_json, state, opened_at, updated_at, closed_at
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, 1, 'MANAGED', ?, '{}', 'OPEN', ?, ?, NULL)
        ON CONFLICT(account_ref, position_key) DO UPDATE SET
          qty = excluded.qty,
          entry_price = excluded.entry_price,
          protection_state = excluded.protection_state,
          updated_at = excluded.updated_at`,
        [
          accountRef,
          pos.positionKey,
          pos.symbol,
          pos.symbol,
          pos.positionMode ?? 'ONE_WAY',
          pos.side,
          pos.qty,
          pos.entryPrice,
          stopBySymbol.get(pos.symbol) ?? null,
          protState,
          nowIso,
          nowIso
        ]
      );
    }
  });

  const hasFinancial =
    nativeBalance.realizedDailyPnlUsdt !== null ||
    nativeBalance.feesUsdt !== undefined ||
    nativeBalance.fundingUsdt !== undefined;

  return {
    accountRef,
    positions: nativePositions,
    pending,
    protection,
    financial: {
      realizedPnl: nativeBalance.realizedDailyPnlUsdt,
      fees: nativeBalance.feesUsdt ?? null,
      funding: nativeBalance.fundingUsdt ?? null,
      availability: hasFinancial ? 'AVAILABLE' : 'UNAVAILABLE'
    },
    unknowns,
    externalCredentialConflict
  };
}
