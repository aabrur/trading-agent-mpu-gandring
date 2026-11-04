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
    stopPrice: DecimalString,
    tpPrice?: DecimalString | null
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
  verifiedStops: Record<string, DecimalString | null>;
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
    `SELECT position_key, symbol, side, entry_price, stop_price, tp_price
     FROM managed_positions
     WHERE account_ref = ? AND state = 'OPEN'`,
    [accountRef]
  );

  const openManaged = managedRows.rows
    .map((row) => ({
      positionKey: String(row.position_key),
      symbol: String(row.symbol),
      side: String(row.side),
      entryPrice: row.entry_price == null ? null : String(row.entry_price),
      stopPrice: row.stop_price == null ? null : String(row.stop_price),
      tpPrice: row.tp_price == null ? null : String(row.tp_price)
    }))
    .filter((row): row is {
      positionKey: string;
      symbol: string;
      side: 'LONG' | 'SHORT';
      entryPrice: string | null;
      stopPrice: string | null;
      tpPrice: string | null;
    } => row.side === 'LONG' || row.side === 'SHORT');
  const activeRelations: Array<{ symbol: string; side: 'LONG' | 'SHORT'; stop: string | null; tp: string | null }> = [];

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
      let stop: string | null = null;
      let tp: string | null = null;
      if (side === 'LONG' || side === 'SHORT') {
        try {
          const parsed = JSON.parse(String(row.payload_json)) as { stop?: string | null; tp?: string | null };
          stop = parsed.stop ? String(parsed.stop) : null;
          tp = parsed.tp ? String(parsed.tp) : null;
        } catch {
          stop = null;
          tp = null;
        }
      }
      try {
        const lookedUp = await transport.lookupOrder(symbol, clientOrderId);
        resolvedIntentUpdates.push({
          intentId,
          state: lookedUp.state,
          venueOrderId: lookedUp.venueOrderId
        });
        const filled =
          (lookedUp.state === 'FILLED' || lookedUp.state === 'PARTIAL') &&
          lookedUp.filledQty != null &&
          compareDecimals(lookedUp.filledQty, '0') > 0;
        if (filled && (side === 'LONG' || side === 'SHORT')) {
          activeRelations.push({ symbol, side, stop, tp });
        }
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
  const verifiedStops: Record<string, DecimalString | null> = {};
  const ownedKeys = new Set<string>();

  const claim = (pos: NativeExposurePosition): { owned: boolean; stop: string | null; tp: string | null } => {
    const managed = openManaged.find(
      (row) => row.positionKey === pos.positionKey && row.side === pos.side
    );
    if (managed) {
      const sameEntry = !managed.entryPrice || compareDecimals(managed.entryPrice, pos.entryPrice) === 0;
      if (sameEntry) return { owned: true, stop: managed.stopPrice, tp: managed.tpPrice };
    }
    const active = activeRelations.find((row) => row.symbol === pos.symbol && row.side === pos.side);
    if (active) return { owned: true, stop: active.stop, tp: active.tp };
    return { owned: false, stop: null, tp: null };
  };

  const noteReadback = (pos: NativeExposurePosition, snap: ProtectionSnapshot) => {
    protection[pos.positionKey] = snap.state;
    verifiedStops[pos.positionKey] = snap.state === 'VERIFIED' ? snap.stopPrice : null;
  };

  for (const pos of nativePositions) {
    if (compareDecimals(pos.qty, '0') <= 0) continue;
    const relation = claim(pos);
    if (!relation.owned) {
      externalCredentialConflict = true;
      unknowns.push(
        `External unattributed position detected on ${pos.symbol} (${pos.positionKey}); local lease cannot fence external API writers`
      );
      try {
        noteReadback(pos, await transport.readProtection(pos));
      } catch {
        protection[pos.positionKey] = 'UNVERIFIED';
        verifiedStops[pos.positionKey] = null;
      }
      continue;
    }

    ownedKeys.add(pos.positionKey);
    let observedStop: string | null = null;
    const readProtection = async (position: NativeExposurePosition) => {
      const snap = await transport.readProtection(position);
      if (snap.state === 'VERIFIED' && snap.stopPrice) observedStop = snap.stopPrice;
      return snap;
    };
    const placeProtection = async (position: NativeExposurePosition, stopPrice: DecimalString, tpPrice?: DecimalString | null) => {
      const snap = await transport.placeProtection(position, stopPrice, tpPrice);
      if (snap.state === 'VERIFIED' && snap.stopPrice) observedStop = snap.stopPrice;
      return snap;
    };
    if (relation.stop) {
      const prot = await ensureExposureProtection({
        position: pos,
        desiredStopPrice: relation.stop,
        desiredTpPrice: relation.tp,
        readProtection,
        placeProtection,
        emergencyClose: async (p, cid) => {
          await transport.closePosition(p, cid);
        }
      });
      protection[pos.positionKey] = prot.protectionState;
      try {
        const snap = await readProtection(pos);
        if (snap.state === 'VERIFIED' && snap.stopPrice) observedStop = snap.stopPrice;
      } catch {
        // Keep the verified snapshot already obtained. Do not substitute the database stop.
      }
    } else {
      try {
        noteReadback(pos, await readProtection(pos));
      } catch {
        protection[pos.positionKey] = 'UNVERIFIED';
      }
    }
    verifiedStops[pos.positionKey] = observedStop;
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

    for (const row of openManaged) {
      if (ownedKeys.has(row.positionKey)) continue;
      await tx.execute(
        `UPDATE managed_positions
         SET state = 'CLOSED', closed_at = ?, updated_at = ?
         WHERE account_ref = ? AND position_key = ? AND state = 'OPEN'`,
        [nowIso, nowIso, accountRef, row.positionKey]
      );
    }

    for (const pos of nativePositions) {
      if (!ownedKeys.has(pos.positionKey)) continue;
      const protState = protection[pos.positionKey] ?? 'UNVERIFIED';
      const relation = claim(pos);
      await tx.execute(
        `INSERT INTO managed_positions (
          account_ref, position_key, native_position_id, symbol, native_instrument,
          position_mode, side, qty, entry_price, stop_price, tp_price, leverage,
          ownership, protection_state, thesis_json, state, opened_at, updated_at, closed_at
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'MANAGED', ?, '{}', 'OPEN', ?, ?, NULL)
        ON CONFLICT(account_ref, position_key) DO UPDATE SET
          qty = excluded.qty,
          entry_price = excluded.entry_price,
          tp_price = COALESCE(excluded.tp_price, managed_positions.tp_price),
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
          relation.stop,
          relation.tp,
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
    verifiedStops,
    unknowns,
    externalCredentialConflict
  };
}
