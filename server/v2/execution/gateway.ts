import { createHash, randomUUID } from 'node:crypto';
import type {
  Certainty,
  DecimalString,
  IntentState,
  MarketFrame,
  ProtectionState
} from '../contracts.js';
import type { ExecutionAuthorityService } from '../accounts/authority.js';
import type { RuntimeStore } from '../store/database.js';
import { revalidateEntry, type StructuralBreakFact, type TradeThesis } from '../decision/revalidate.js';
import { compareDecimals } from './decimal.js';
import {
  ensureExposureProtection,
  type NativeExposurePosition,
  type ProtectionSnapshot
} from './protection.js';
import { reconcileAccountState, type Reconciliation } from './reconcile.js';

export interface TradeIntent {
  intentId: string;
  accountRef: string;
  configVersion: number;
  authorityEpoch: number;
  action: 'OPEN' | 'CLOSE';
  symbol: string;
  side: 'LONG' | 'SHORT';
  quantity: DecimalString;
  entry: DecimalString | null;
  stop: DecimalString | null;
  tp: DecimalString | null;
  leverage: number;
  thesisId: string | null;
  thesis?: TradeThesis | null;
  orderType?: 'MARKET' | 'LIMIT_GTC';
}

export interface CloseIntentInput {
  intentId: string;
  accountRef: string;
  configVersion: number;
  authorityEpoch: number;
  symbol: string;
  side: 'LONG' | 'SHORT';
  quantity: DecimalString;
  ownerAuthorized?: boolean;
  trigger?: string;
}

export interface ExecutionReceipt {
  intentId: string;
  clientOrderId: string;
  orderState: IntentState;
  filledQty: DecimalString | null;
  protectionState: ProtectionState;
  certainty: Certainty | null;
  reason: string | null;
}

export interface HaltRequest {
  requestId: string;
  accountRef?: string;
  source: string;
  policy: 'HALT_ONLY' | 'HALT_AND_FLATTEN';
  reason?: string;
}

export interface HaltReceipt {
  halted: boolean;
  persisted: boolean;
  entryCancellation: 'COMPLETED' | 'PARTIAL' | 'NOT_NEEDED' | 'FAILED';
  flatten: 'COMPLETED' | 'SKIPPED_BY_POLICY' | 'FAILED';
  reason: string | null;
}

export interface GatewayOrderSubmission {
  clientOrderId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  quantity: DecimalString;
  entryPrice: DecimalString | null;
  orderType: 'MARKET' | 'LIMIT_GTC';
  leverage: number;
}

export interface GatewayOrderResult {
  clientOrderId: string;
  venueOrderId: string | null;
  state: IntentState;
  filledQty: DecimalString | null;
}

export interface GatewayVenueTransport {
  balance: () => Promise<{
    balanceUsdt: DecimalString | null;
    availableUsdt: DecimalString | null;
    realizedDailyPnlUsdt: DecimalString | null;
    feesUsdt?: DecimalString | null;
    fundingUsdt?: DecimalString | null;
  }>;
  positions: () => Promise<NativeExposurePosition[]>;
  submitOrder: (order: GatewayOrderSubmission) => Promise<GatewayOrderResult>;
  lookupOrder: (symbol: string, clientOrderId: string) => Promise<GatewayOrderResult>;
  cancelEntryOrder: (symbol: string, clientOrderId: string) => Promise<GatewayOrderResult>;
  readProtection: (position: NativeExposurePosition) => Promise<ProtectionSnapshot>;
  placeProtection: (
    position: NativeExposurePosition,
    stopPrice: DecimalString
  ) => Promise<ProtectionSnapshot>;
  closePosition: (
    position: NativeExposurePosition,
    clientOrderId: string
  ) => Promise<GatewayOrderResult>;
}

export interface AccountExecutionPolicy {
  activeConfigVersion: number;
  safetyNetUsdt: DecimalString;
  maxPositions: number;
  dailyLossCapUsdt: DecimalString;
  minEntryConfidencePct: number;
  currentLeadProbability?: number | null;
}

export interface ExecutionGatewayOptions {
  store: RuntimeStore;
  authority: ExecutionAuthorityService;
  getTransport: (accountRef: string) => GatewayVenueTransport;
  getAccountPolicy: (accountRef: string) => AccountExecutionPolicy;
  readFreshMarket: (symbol: string) => MarketFrame | null;
  readStructuralBreaks?: (symbol: string) => StructuralBreakFact[];
}

export function deriveClientOrderId(accountRef: string, intentId: string): string {
  const hash = createHash('sha256').update(`${accountRef}:${intentId}`, 'utf8').digest('hex').slice(0, 24);
  return `mpu-${hash}`;
}

export class ExecutionGateway {
  private readonly store: RuntimeStore;
  private readonly authority: ExecutionAuthorityService;
  private readonly getTransport: (accountRef: string) => GatewayVenueTransport;
  private readonly getAccountPolicy: (accountRef: string) => AccountExecutionPolicy;
  private readonly readFreshMarket: (symbol: string) => MarketFrame | null;
  private readonly readStructuralBreaks: (symbol: string) => StructuralBreakFact[];

  private readonly accountLocks = new Map<string, Promise<void>>();
  private readonly inMemoryHalted = new Set<string>();
  private globalHaltLatched = false;

  constructor(options: ExecutionGatewayOptions) {
    this.store = options.store;
    this.authority = options.authority;
    this.getTransport = options.getTransport;
    this.getAccountPolicy = options.getAccountPolicy;
    this.readFreshMarket = options.readFreshMarket;
    this.readStructuralBreaks = options.readStructuralBreaks ?? (() => []);
  }

  isHaltedInMemory(accountRef: string): boolean {
    return this.globalHaltLatched || this.inMemoryHalted.has(accountRef);
  }

  clearInMemoryHalt(accountRef: string): void {
    this.globalHaltLatched = false;
    this.inMemoryHalted.delete(accountRef);
  }

  private async withAccountLock<T>(accountRef: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.accountLocks.get(accountRef) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = prev.then(() => next, () => next);
    this.accountLocks.set(accountRef, chained);
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.accountLocks.get(accountRef) === chained) {
        this.accountLocks.delete(accountRef);
      }
    }
  }

  private async findExistingReceipt(
    accountRef: string,
    intentId: string
  ): Promise<ExecutionReceipt | null> {
    try {
      const res = await this.store.execute(
        `SELECT client_order_id, order_state, protection_state, payload_json
         FROM execution_intents
         WHERE account_ref = ? AND intent_id = ?`,
        [accountRef, intentId]
      );
      if (res.rows.length === 0) return null;
      const row = res.rows[0]!;
      let filledQty: DecimalString | null = null;
      try {
        const meta = JSON.parse(String(row.payload_json)) as { filledQty?: string | null };
        filledQty = meta.filledQty ?? null;
      } catch {
        filledQty = null;
      }
      const orderState = String(row.order_state) as IntentState;
      return {
        intentId,
        clientOrderId: String(row.client_order_id),
        orderState,
        filledQty,
        protectionState: String(row.protection_state) as ProtectionState,
        certainty: orderState === 'UNKNOWN' ? null : 'VERIFIED',
        reason: 'Idempotent replay of already journaled intent'
      };
    } catch {
      return null;
    }
  }

  async submit(intent: TradeIntent): Promise<ExecutionReceipt> {
    if (intent.action === 'CLOSE') {
      return this.close({
        intentId: intent.intentId,
        accountRef: intent.accountRef,
        configVersion: intent.configVersion,
        authorityEpoch: intent.authorityEpoch,
        symbol: intent.symbol,
        side: intent.side,
        quantity: intent.quantity,
        ownerAuthorized: false
      });
    }

    const clientOrderId = deriveClientOrderId(intent.accountRef, intent.intentId);

    // Immediate pre-lock halt check.
    if (this.isHaltedInMemory(intent.accountRef)) {
      return {
        intentId: intent.intentId,
        clientOrderId,
        orderState: 'REJECTED',
        filledQty: '0',
        protectionState: 'NOT_APPLICABLE',
        certainty: 'VERIFIED',
        reason: 'Account execution is halted'
      };
    }

    return this.withAccountLock(intent.accountRef, async () => {
      // 1. Deduplicate already journaled intent before any validation or IO.
      const existing = await this.findExistingReceipt(intent.accountRef, intent.intentId);
      if (existing) {
        return existing;
      }

      if (this.isHaltedInMemory(intent.accountRef)) {
        return {
          intentId: intent.intentId,
          clientOrderId,
          orderState: 'REJECTED',
          filledQty: '0',
          protectionState: 'NOT_APPLICABLE',
          certainty: 'VERIFIED',
          reason: 'Account execution halted while waiting for lock'
        };
      }

      // 2. Verify authority lease epoch and persisted halt flag.
      let authRecord;
      try {
        authRecord = await this.authority.current(intent.accountRef);
      } catch (err) {
        return {
          intentId: intent.intentId,
          clientOrderId,
          orderState: 'REJECTED',
          filledQty: '0',
          protectionState: 'NOT_APPLICABLE',
          certainty: null,
          reason: `Authority store read failed: ${err instanceof Error ? err.message : 'unavailable'}`
        };
      }

      if (
        !authRecord ||
        authRecord.holderId !== this.authority.defaultHolderId ||
        authRecord.writerEpoch !== intent.authorityEpoch
      ) {
        return {
          intentId: intent.intentId,
          clientOrderId,
          orderState: 'REJECTED',
          filledQty: '0',
          protectionState: 'NOT_APPLICABLE',
          certainty: 'VERIFIED',
          reason: `Stale or unheld authorityEpoch ${intent.authorityEpoch}`
        };
      }

      if (authRecord.haltLatched) {
        this.inMemoryHalted.add(intent.accountRef);
        return {
          intentId: intent.intentId,
          clientOrderId,
          orderState: 'REJECTED',
          filledQty: '0',
          protectionState: 'NOT_APPLICABLE',
          certainty: 'VERIFIED',
          reason: authRecord.haltReason ?? 'Execution halt latch is active'
        };
      }

      const policy = this.getAccountPolicy(intent.accountRef);
      if (intent.configVersion !== policy.activeConfigVersion) {
        return {
          intentId: intent.intentId,
          clientOrderId,
          orderState: 'REJECTED',
          filledQty: '0',
          protectionState: 'NOT_APPLICABLE',
          certainty: 'VERIFIED',
          reason: `Intent configVersion ${intent.configVersion} does not match active ${policy.activeConfigVersion}`
        };
      }

      if (!intent.stop) {
        return {
          intentId: intent.intentId,
          clientOrderId,
          orderState: 'REJECTED',
          filledQty: '0',
          protectionState: 'NOT_APPLICABLE',
          certainty: 'VERIFIED',
          reason: 'Every OPEN intent requires a stop price'
        };
      }

      // 3. Refresh venue balance, positions and fresh market under lock (outside SQL tx).
      const transport = this.getTransport(intent.accountRef);
      const [balanceSnap, nativePositions] = await Promise.all([
        transport.balance(),
        transport.positions()
      ]);

      if (
        balanceSnap.balanceUsdt === null ||
        compareDecimals(balanceSnap.balanceUsdt, policy.safetyNetUsdt) <= 0
      ) {
        return {
          intentId: intent.intentId,
          clientOrderId,
          orderState: 'REJECTED',
          filledQty: '0',
          protectionState: 'NOT_APPLICABLE',
          certainty: 'VERIFIED',
          reason: 'Account balance is unavailable or at/below Owner safety net'
        };
      }

      if (balanceSnap.realizedDailyPnlUsdt !== null) {
        const negLoss = balanceSnap.realizedDailyPnlUsdt.startsWith('-')
          ? balanceSnap.realizedDailyPnlUsdt.slice(1)
          : '0';
        if (compareDecimals(negLoss, policy.dailyLossCapUsdt) >= 0) {
          return {
            intentId: intent.intentId,
            clientOrderId,
            orderState: 'REJECTED',
            filledQty: '0',
            protectionState: 'NOT_APPLICABLE',
            certainty: 'VERIFIED',
            reason: `Daily loss cap hit (${balanceSnap.realizedDailyPnlUsdt} USDT)`
          };
        }
      }

      const freshMarket = this.readFreshMarket(intent.symbol);
      if (!freshMarket || freshMarket.last.availability !== 'AVAILABLE' || !freshMarket.last.value) {
        return {
          intentId: intent.intentId,
          clientOrderId,
          orderState: 'REJECTED',
          filledQty: '0',
          protectionState: 'NOT_APPLICABLE',
          certainty: null,
          reason: 'Fresh Bybit linear market price is unavailable under lock'
        };
      }

      if (intent.thesis) {
        const check = revalidateEntry({
          thesis: intent.thesis,
          activeConfigVersion: policy.activeConfigVersion,
          freshMarket,
          structuralBreaks: this.readStructuralBreaks(intent.symbol)
        });
        if (check.status !== 'valid') {
          return {
            intentId: intent.intentId,
            clientOrderId,
            orderState: 'REJECTED',
            filledQty: '0',
            protectionState: 'NOT_APPLICABLE',
            certainty: 'VERIFIED',
            reason: check.reason ?? 'Thesis invalidated under execution lock'
          };
        }
      }

      // Unique slot occupancy: union of open position symbols and pending OPEN intent symbols.
      const occupiedSymbols = new Set<string>();
      for (const pos of nativePositions) {
        if (compareDecimals(pos.qty, '0') > 0) {
          occupiedSymbols.add(pos.symbol);
        }
      }
      try {
        const pendingRows = await this.store.execute(
          `SELECT symbol FROM execution_intents
           WHERE account_ref = ? AND intent_kind = 'OPEN'
             AND order_state IN ('SUBMITTING', 'ACCEPTED', 'PARTIAL', 'UNKNOWN')`,
          [intent.accountRef]
        );
        for (const r of pendingRows.rows) {
          occupiedSymbols.add(String(r.symbol));
        }
      } catch (err) {
        return {
          intentId: intent.intentId,
          clientOrderId,
          orderState: 'REJECTED',
          filledQty: '0',
          protectionState: 'NOT_APPLICABLE',
          certainty: null,
          reason: `Failed to read pending occupancy: ${err instanceof Error ? err.message : 'store error'}`
        };
      }

      if (!occupiedSymbols.has(intent.symbol) && occupiedSymbols.size >= policy.maxPositions) {
        return {
          intentId: intent.intentId,
          clientOrderId,
          orderState: 'REJECTED',
          filledQty: '0',
          protectionState: 'NOT_APPLICABLE',
          certainty: 'VERIFIED',
          reason: `Max open positions (${policy.maxPositions}) occupied`
        };
      }

      // Final halt check before journaling.
      if (this.isHaltedInMemory(intent.accountRef)) {
        return {
          intentId: intent.intentId,
          clientOrderId,
          orderState: 'REJECTED',
          filledQty: '0',
          protectionState: 'NOT_APPLICABLE',
          certainty: 'VERIFIED',
          reason: 'Execution halted right before journal write'
        };
      }

      // 4. Journal-before-send in a short SQL transaction (zero network IO inside tx).
      const nowIso = new Date().toISOString();
      try {
        await this.store.transaction(async (tx) => {
          await tx.execute(
            `INSERT INTO execution_intents (
              account_ref, intent_id, client_order_id, cycle_id, symbol, side, intent_kind,
              order_state, protection_state, venue_order_id, payload_json, created_at, updated_at
            ) VALUES (?, ?, ?, NULL, ?, ?, 'OPEN', 'SUBMITTING', 'PENDING', NULL, ?, ?, ?)`,
            [
              intent.accountRef,
              intent.intentId,
              clientOrderId,
              intent.symbol,
              intent.side,
              JSON.stringify({
                quantity: intent.quantity,
                entry: intent.entry,
                stop: intent.stop,
                tp: intent.tp,
                leverage: intent.leverage,
                thesisId: intent.thesisId
              }),
              nowIso,
              nowIso
            ]
          );
          await tx.append({
            eventId: `intent-journaled-${intent.accountRef}-${intent.intentId}`,
            scope: intent.accountRef,
            kind: 'execution.intent.journaled',
            createdAt: nowIso,
            correlationId: intent.intentId,
            causationId: intent.thesisId,
            schemaVersion: 1,
            payload: {
              intentId: intent.intentId,
              clientOrderId,
              symbol: intent.symbol,
              side: intent.side,
              quantity: intent.quantity
            }
          });
        });
      } catch (err) {
        return {
          intentId: intent.intentId,
          clientOrderId,
          orderState: 'REJECTED',
          filledQty: '0',
          protectionState: 'NOT_APPLICABLE',
          certainty: null,
          reason: `Journal write failed before submit: ${err instanceof Error ? err.message : 'store error'}`
        };
      }

      // Final halt check right before network write.
      if (this.isHaltedInMemory(intent.accountRef)) {
        await this.store
          .transaction(async (tx) => {
            await tx.execute(
              `UPDATE execution_intents SET order_state = 'CANCELLED', protection_state = 'NOT_APPLICABLE', updated_at = ?
               WHERE account_ref = ? AND intent_id = ?`,
              [new Date().toISOString(), intent.accountRef, intent.intentId]
            );
          })
          .catch(() => {});
        return {
          intentId: intent.intentId,
          clientOrderId,
          orderState: 'REJECTED',
          filledQty: '0',
          protectionState: 'NOT_APPLICABLE',
          certainty: 'VERIFIED',
          reason: 'Execution halted before network submission'
        };
      }

      // 5. Single native order submission outside SQL transaction.
      let submitResult: GatewayOrderResult;
      try {
        submitResult = await transport.submitOrder({
          clientOrderId,
          symbol: intent.symbol,
          side: intent.side,
          quantity: intent.quantity,
          entryPrice: intent.entry,
          orderType: intent.orderType ?? 'MARKET',
          leverage: intent.leverage
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Exchange submission failed';
        await this.store
          .transaction(async (tx) => {
            await tx.execute(
              `UPDATE execution_intents
               SET order_state = 'UNKNOWN', updated_at = ?
               WHERE account_ref = ? AND intent_id = ?`,
              [new Date().toISOString(), intent.accountRef, intent.intentId]
            );
          })
          .catch(() => {});

        return {
          intentId: intent.intentId,
          clientOrderId,
          orderState: 'UNKNOWN',
          filledQty: null,
          protectionState: 'PENDING',
          certainty: null,
          reason: errMsg
        };
      }

      // 6. Immediately protect any positive filled exposure (partial or full).
      let protectionState: ProtectionState = 'PENDING';
      let reason: string | null = null;
      const filledQty = submitResult.filledQty;

      if (filledQty !== null && compareDecimals(filledQty, '0') > 0) {
        const positionObj: NativeExposurePosition = {
          positionKey: `${intent.symbol}:ONE_WAY`,
          symbol: intent.symbol,
          side: intent.side,
          qty: filledQty,
          entryPrice: intent.entry ?? freshMarket.last.value
        };

        const protOutcome = await ensureExposureProtection({
          position: positionObj,
          desiredStopPrice: intent.stop,
          readProtection: (p) => transport.readProtection(p),
          placeProtection: (p, s) => transport.placeProtection(p, s),
          emergencyClose: async (p, cid) => {
            await transport.closePosition(p, cid);
          }
        });
        protectionState = protOutcome.protectionState;
        reason = protOutcome.reason;
      } else if (submitResult.state === 'CANCELLED' || submitResult.state === 'REJECTED') {
        protectionState = 'NOT_APPLICABLE';
      }

      // 7. Persist submission & protection outcome in a short SQL transaction.
      const finishIso = new Date().toISOString();
      await this.store
        .transaction(async (tx) => {
          await tx.execute(
            `UPDATE execution_intents
             SET order_state = ?, protection_state = ?, venue_order_id = ?, payload_json = ?, updated_at = ?
             WHERE account_ref = ? AND intent_id = ?`,
            [
              submitResult.state,
              protectionState,
              submitResult.venueOrderId,
              JSON.stringify({
                quantity: intent.quantity,
                filledQty,
                entry: intent.entry,
                stop: intent.stop,
                tp: intent.tp,
                leverage: intent.leverage,
                thesisId: intent.thesisId
              }),
              finishIso,
              intent.accountRef,
              intent.intentId
            ]
          );

          if (
            filledQty !== null &&
            compareDecimals(filledQty, '0') > 0 &&
            protectionState === 'VERIFIED'
          ) {
            await tx.execute(
              `INSERT INTO managed_positions (
                account_ref, position_key, native_position_id, symbol, native_instrument,
                position_mode, side, qty, entry_price, stop_price, tp_price, leverage,
                ownership, protection_state, thesis_json, state, opened_at, updated_at, closed_at
              ) VALUES (?, ?, NULL, ?, ?, 'ONE_WAY', ?, ?, ?, ?, ?, ?, 'MANAGED', ?, '{}', 'OPEN', ?, ?, NULL)
              ON CONFLICT(account_ref, position_key) DO UPDATE SET
                qty = excluded.qty,
                stop_price = excluded.stop_price,
                tp_price = excluded.tp_price,
                protection_state = excluded.protection_state,
                updated_at = excluded.updated_at`,
              [
                intent.accountRef,
                `${intent.symbol}:ONE_WAY`,
                intent.symbol,
                intent.symbol,
                intent.side,
                filledQty,
                intent.entry ?? freshMarket.last.value,
                intent.stop,
                intent.tp,
                intent.leverage,
                protectionState,
                finishIso,
                finishIso
              ]
            );
          }
        })
        .catch(() => {});

      return {
        intentId: intent.intentId,
        clientOrderId,
        orderState: submitResult.state,
        filledQty,
        protectionState,
        certainty: submitResult.state === 'UNKNOWN' ? null : 'VERIFIED',
        reason
      };
    });
  }

  async close(input: CloseIntentInput): Promise<ExecutionReceipt> {
    const clientOrderId = deriveClientOrderId(input.accountRef, input.intentId);

    return this.withAccountLock(input.accountRef, async () => {
      const existing = await this.findExistingReceipt(input.accountRef, input.intentId);
      if (existing) return existing;

      const authRecord = await this.authority.current(input.accountRef);
      if (
        !authRecord ||
        authRecord.holderId !== this.authority.defaultHolderId ||
        authRecord.writerEpoch !== input.authorityEpoch
      ) {
        return {
          intentId: input.intentId,
          clientOrderId,
          orderState: 'REJECTED',
          filledQty: '0',
          protectionState: 'NOT_APPLICABLE',
          certainty: 'VERIFIED',
          reason: `Stale or unheld authorityEpoch ${input.authorityEpoch}`
        };
      }

      // Direct Owner or verified exit CLOSE never checks entry confidence, slot occupancy or daily loss cap.
      const transport = this.getTransport(input.accountRef);
      const nativePositions = await transport.positions();
      const targetPos = nativePositions.find(
        (p) => p.symbol === input.symbol && compareDecimals(p.qty, '0') > 0
      );

      if (!targetPos) {
        return {
          intentId: input.intentId,
          clientOrderId,
          orderState: 'REJECTED',
          filledQty: '0',
          protectionState: 'NOT_APPLICABLE',
          certainty: 'VERIFIED',
          reason: `No open native position on ${input.symbol}`
        };
      }

      const nowIso = new Date().toISOString();
      await this.store.transaction(async (tx) => {
        await tx.execute(
          `INSERT INTO execution_intents (
            account_ref, intent_id, client_order_id, cycle_id, symbol, side, intent_kind,
            order_state, protection_state, venue_order_id, payload_json, created_at, updated_at
          ) VALUES (?, ?, ?, NULL, ?, ?, 'CLOSE', 'SUBMITTING', 'NOT_APPLICABLE', NULL, ?, ?, ?)`,
          [
            input.accountRef,
            input.intentId,
            clientOrderId,
            input.symbol,
            targetPos.side,
            JSON.stringify({ quantity: targetPos.qty, ownerAuthorized: Boolean(input.ownerAuthorized) }),
            nowIso,
            nowIso
          ]
        );
      });

      try {
        const res = await transport.closePosition(targetPos, clientOrderId);
        const doneIso = new Date().toISOString();
        await this.store.transaction(async (tx) => {
          await tx.execute(
            `UPDATE execution_intents
             SET order_state = ?, venue_order_id = ?, payload_json = ?, updated_at = ?
             WHERE account_ref = ? AND intent_id = ?`,
            [
              res.state,
              res.venueOrderId,
              JSON.stringify({ filledQty: res.filledQty }),
              doneIso,
              input.accountRef,
              input.intentId
            ]
          );
          if (res.state === 'FILLED') {
            await tx.execute(
              `UPDATE managed_positions
               SET state = 'CLOSED', closed_at = ?, updated_at = ?
               WHERE account_ref = ? AND symbol = ? AND state = 'OPEN'`,
              [doneIso, doneIso, input.accountRef, input.symbol]
            );
          }
        });

        return {
          intentId: input.intentId,
          clientOrderId,
          orderState: res.state,
          filledQty: res.filledQty,
          protectionState: 'NOT_APPLICABLE',
          certainty: res.state === 'UNKNOWN' ? null : 'VERIFIED',
          reason: null
        };
      } catch (err) {
        return {
          intentId: input.intentId,
          clientOrderId,
          orderState: 'UNKNOWN',
          filledQty: null,
          protectionState: 'NOT_APPLICABLE',
          certainty: null,
          reason: err instanceof Error ? err.message : 'Close submission failed'
        };
      }
    });
  }

  async halt(request: HaltRequest): Promise<HaltReceipt> {
    // 1. Immediate synchronous in-memory latch BEFORE any asynchronous work!
    if (request.accountRef) {
      this.inMemoryHalted.add(request.accountRef);
    } else {
      this.globalHaltLatched = true;
    }

    const targetAccount = request.accountRef;
    let persisted = false;
    if (targetAccount) {
      try {
        await this.authority.setHalt(
          targetAccount,
          true,
          request.source,
          request.reason ?? request.policy
        );
        persisted = true;
      } catch {
        persisted = false;
      }
    }

    if (!targetAccount) {
      return {
        halted: true,
        persisted,
        entryCancellation: 'NOT_NEEDED',
        flatten: request.policy === 'HALT_AND_FLATTEN' ? 'COMPLETED' : 'SKIPPED_BY_POLICY',
        reason: request.reason ?? null
      };
    }

    let entryCancellation: HaltReceipt['entryCancellation'] = 'NOT_NEEDED';
    let flatten: HaltReceipt['flatten'] =
      request.policy === 'HALT_AND_FLATTEN' ? 'COMPLETED' : 'SKIPPED_BY_POLICY';

    try {
      const transport = this.getTransport(targetAccount);
      let openIntents: Array<{ symbol: string; clientOrderId: string }> = [];
      try {
        const rows = await this.store.execute(
          `SELECT symbol, client_order_id
           FROM execution_intents
           WHERE account_ref = ? AND intent_kind = 'OPEN'
             AND order_state IN ('ACCEPTED', 'PARTIAL', 'SUBMITTING')`,
          [targetAccount]
        );
        openIntents = rows.rows.map((r) => ({
          symbol: String(r.symbol),
          clientOrderId: String(r.client_order_id)
        }));
      } catch {
        openIntents = [];
      }

      if (openIntents.length > 0) {
        let cancelFailures = 0;
        for (const item of openIntents) {
          try {
            await transport.cancelEntryOrder(item.symbol, item.clientOrderId);
          } catch {
            cancelFailures += 1;
          }
        }
        entryCancellation =
          cancelFailures === 0
            ? 'COMPLETED'
            : cancelFailures < openIntents.length
              ? 'PARTIAL'
              : 'FAILED';
      }

      if (request.policy === 'HALT_AND_FLATTEN') {
        const positions = await transport.positions();
        for (const pos of positions) {
          if (compareDecimals(pos.qty, '0') > 0) {
            await transport.closePosition(pos, `kill-${randomUUID().slice(0, 16)}`);
          }
        }
        flatten = 'COMPLETED';
      }
    } catch {
      if (request.policy === 'HALT_AND_FLATTEN') {
        flatten = 'FAILED';
      }
    }

    return {
      halted: true,
      persisted,
      entryCancellation,
      flatten,
      reason: request.reason ?? null
    };
  }

  async reconcile(accountRef: string): Promise<Reconciliation> {
    return this.withAccountLock(accountRef, async () =>
      reconcileAccountState({
        store: this.store,
        accountRef,
        transport: this.getTransport(accountRef)
      })
    );
  }

  /**
   * Records external status projections (e.g. Grok callback trade.status / position.status)
   * purely as audit events without performing any native order writes.
   */
  async recordExternalStatusObservation(params: {
    accountRef: string;
    source: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    const nowIso = new Date().toISOString();
    await this.store.append({
      eventId: `ext-obs-${randomUUID()}`,
      scope: params.accountRef,
      kind: 'execution.external_status_observed',
      createdAt: nowIso,
      correlationId: null,
      causationId: null,
      schemaVersion: 1,
      payload: {
        source: params.source,
        reported: params.payload
      }
    });
  }
}
