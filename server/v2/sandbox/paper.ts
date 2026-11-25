import { safe } from '../../redact.js';
import {
  type DecimalString,
  type Network,
  type Venue
} from '../contracts.js';
import {
  AdapterCapabilityError,
  type FinancialPage,
  type NativeAccountIdentity,
  type NativeBalance,
  type NativeFinancialRecord,
  type NativeOrder,
  type NativeOrderReceipt,
  type NativePosition,
  type NativeProtection,
  type NativeRules,
  type PermissionEvidence,
  type ProtectionEvidence,
  type VenueAdapter,
  type VenueQuote
} from '../execution/adapters/types.js';
import {
  addDecimals,
  compareDecimals,
  divDecimals,
  mulDecimals,
  quantize,
  subDecimals
} from '../execution/decimal.js';

export interface PaperVenueOptions {
  venue?: Venue;
  network?: Network;
  initialBalance?: DecimalString;
  liveCredential?: unknown;
  quoteProvider?: (symbol: string) => { last: string; bid?: string | null; ask?: string | null } | null;
}

export class PaperVenue implements VenueAdapter {
  public readonly venue: Venue;
  public readonly network: Network;
  public readonly status = 'implemented' as const;
  public readonly mode = 'PAPER' as const;

  public readonly capabilities = {
    exchangeStops: true,
    restingLimitGtcEntry: true,
    hedgeMode: false,
    financialHistory: ['fills', 'fees', 'funding'] as const
  };

  private equity: DecimalString;
  private availableBalance: DecimalString;
  private realizedDailyPnl: DecimalString = '0';
  private positionsMap = new Map<string, NativePosition>();
  private protectionsMap = new Map<string, NativeProtection>();
  private ordersMap = new Map<string, NativeOrderReceipt>();
  private pendingLimits = new Map<string, NativeOrder>();
  private financialRecords: NativeFinancialRecord[] = [];
  private orderSequence = 0;
  private readonly quoteProvider?: PaperVenueOptions['quoteProvider'];

  constructor(options: PaperVenueOptions = {}) {
    if (options.liveCredential) {
      throw new AdapterCapabilityError('PaperVenue refuses live keys and signing credentials.');
    }
    this.venue = options.venue ?? 'bybit';
    this.network = options.network ?? 'mainnet';
    this.equity = options.initialBalance ?? '1000';
    this.availableBalance = this.equity;
    this.quoteProvider = options.quoteProvider;
  }

  public setBalance(nextBalance: DecimalString): void {
    this.equity = nextBalance;
    this.availableBalance = nextBalance;
  }

  public async permissions(): Promise<PermissionEvidence> {
    return {
      ok: true,
      canTrade: true,
      canWithdraw: false,
      verified: true,
      delegatedOnly: true,
      detail: 'SIMULATED_PAPER_ENVIRONMENT',
      observedAt: Date.now()
    };
  }

  public async accountIdentity(): Promise<NativeAccountIdentity> {
    return {
      venue: this.venue,
      network: this.network,
      publicAccountId: 'paper-account',
      subaccountRef: null,
      positionMode: 'ONE_WAY',
      observedAt: Date.now()
    };
  }

  public async balance(): Promise<NativeBalance> {
    return {
      settlementCurrency: 'USDT',
      equity: this.equity,
      available: this.availableBalance,
      realizedDailyPnl: this.realizedDailyPnl,
      observedAt: Date.now(),
      availability: 'AVAILABLE'
    };
  }

  public async instruments(symbol: string): Promise<NativeRules> {
    return {
      symbol,
      nativeSymbol: symbol,
      tickSize: '0.1',
      qtyStep: '0.001',
      minQty: '0.001',
      maxQty: '1000',
      minNotional: '5',
      contractMultiplier: '1',
      settlementCurrency: 'USDT',
      positionModeCapability: 'ONE_WAY',
      exchangeStops: true,
      restingLimitGtcEntry: true
    };
  }

  public async quote(symbol: string): Promise<VenueQuote> {
    const live = this.quoteProvider?.(symbol.toUpperCase());
    if (live && live.last && compareDecimals(live.last, '0') > 0) {
      return {
        symbol,
        last: live.last,
        bid: live.bid && compareDecimals(live.bid, '0') > 0 ? live.bid : subDecimals(live.last, '0.1'),
        ask: live.ask && compareDecimals(live.ask, '0') > 0 ? live.ask : addDecimals(live.last, '0.1'),
        sourceAt: Date.now(),
        observedAt: Date.now(),
        ageMs: 5
      };
    }
    const isBtc = symbol.startsWith('BTC');
    const isEth = symbol.startsWith('ETH');
    const lastPrice = isBtc ? '65000.0' : isEth ? '3000.0' : '0.0';
    return {
      symbol,
      last: lastPrice,
      bid: lastPrice !== '0.0' ? subDecimals(lastPrice, '0.5') : '0.0',
      ask: lastPrice !== '0.0' ? addDecimals(lastPrice, '0.5') : '0.0',
      sourceAt: Date.now(),
      observedAt: Date.now(),
      ageMs: 5
    };
  }

  public async positions(): Promise<NativePosition[]> {
    return Array.from(this.positionsMap.values());
  }

  private fillOrder(intent: NativeOrder, fillPrice: DecimalString, feeRate: DecimalString, existingSeq?: number): NativeOrderReceipt {
    const seq = existingSeq ?? this.orderSequence;
    const receipt: NativeOrderReceipt = {
      clientOrderId: intent.clientOrderId,
      venueOrderId: `sim-order-${seq}-${intent.clientOrderId}`,
      symbol: intent.symbol,
      state: 'FILLED',
      filledQty: intent.quantity,
      avgFillPrice: fillPrice,
      observedAt: Date.now(),
      reason: 'SIMULATED'
    };
    this.ordersMap.set(intent.clientOrderId, receipt);

    const feeAmount = quantize(mulDecimals(mulDecimals(intent.quantity, fillPrice), feeRate), '0.0001', 'ceil');
    this.equity = subDecimals(this.equity, feeAmount);
    this.availableBalance = this.equity;

    const positionKey = `${this.venue}:${this.network}:paper-account:${intent.symbol}:ONE_WAY`;
    const existing = this.positionsMap.get(positionKey);
    if (existing) {
      if (existing.side === intent.side) {
        const totalQty = addDecimals(existing.qty, intent.quantity);
        const totalCost = addDecimals(
          mulDecimals(existing.qty, existing.entryPrice),
          mulDecimals(intent.quantity, fillPrice)
        );
        const newAvg = divDecimals(totalCost, totalQty, 4);
        this.positionsMap.set(positionKey, {
          ...existing,
          qty: totalQty,
          entryPrice: newAvg,
          observedAt: Date.now()
        });
      }
    } else {
      this.positionsMap.set(positionKey, {
        positionKey,
        nativePositionId: `sim-pos-${seq}`,
        symbol: intent.symbol,
        nativeSymbol: intent.symbol,
        positionMode: 'ONE_WAY',
        hedgeLeg: null,
        side: intent.side,
        qty: intent.quantity,
        entryPrice: fillPrice,
        leverage: intent.leverage,
        unrealizedPnl: '0',
        observedAt: Date.now()
      });
    }

    this.financialRecords.push({
      id: `sim-fin-${seq}`,
      kind: 'fill',
      symbol: intent.symbol,
      side: intent.side,
      qty: intent.quantity,
      price: fillPrice,
      feeAmount,
      feeCurrency: 'USDT',
      realizedPnl: '0',
      fundingAmount: null,
      currency: 'USDT',
      occurredAt: Date.now()
    });

    return receipt;
  }

  public async submit(intent: NativeOrder): Promise<NativeOrderReceipt> {
    this.orderSequence += 1;
    const seq = this.orderSequence;
    const q = await this.quote(intent.symbol);
    const liveRef = compareDecimals(q.last, '0') > 0
      ? q.last
      : (intent.symbol.startsWith('BTC') ? '65000.0' : '3000.0');

    if (intent.orderType === 'LIMIT_GTC' && intent.limitPrice) {
      const crosses = intent.side === 'LONG'
        ? compareDecimals(liveRef, intent.limitPrice) <= 0
        : compareDecimals(liveRef, intent.limitPrice) >= 0;
      if (!crosses) {
        const pendingReceipt: NativeOrderReceipt = {
          clientOrderId: intent.clientOrderId,
          venueOrderId: `sim-order-${seq}-${intent.clientOrderId}`,
          symbol: intent.symbol,
          state: 'ACCEPTED',
          filledQty: null,
          avgFillPrice: null,
          observedAt: Date.now(),
          reason: 'SIMULATED'
        };
        this.ordersMap.set(intent.clientOrderId, pendingReceipt);
        this.pendingLimits.set(intent.clientOrderId, intent);
        return pendingReceipt;
      }
      return this.fillOrder(intent, intent.limitPrice, '0.0002', seq);
    }

    const fillPrice = intent.limitPrice ?? liveRef;
    return this.fillOrder(intent, fillPrice, '0.00055', seq);
  }

  public async lookupOrder(symbol: string, clientOrderId: string): Promise<NativeOrderReceipt> {
    const found = this.ordersMap.get(clientOrderId);
    if (!found) {
      throw new AdapterCapabilityError(`Paper order not found: ${clientOrderId}`);
    }
    return found;
  }

  public async cancelEntry(symbol: string, clientOrderId: string): Promise<NativeOrderReceipt> {
    const found = this.ordersMap.get(clientOrderId);
    if (!found) {
      throw new AdapterCapabilityError(`Paper order not found: ${clientOrderId}`);
    }
    this.pendingLimits.delete(clientOrderId);
    const cancelled: NativeOrderReceipt = {
      ...found,
      state: 'CANCELLED',
      reason: 'SIMULATED'
    };
    this.ordersMap.set(clientOrderId, cancelled);
    return cancelled;
  }

  public async protection(position: NativePosition): Promise<ProtectionEvidence> {
    const saved = this.protectionsMap.get(position.positionKey);
    return {
      symbol: position.symbol,
      positionKey: position.positionKey,
      side: position.side,
      requiredQty: position.qty,
      coveredQty: saved ? position.qty : '0',
      stopPrice: saved?.stopPrice ?? null,
      tpPrice: saved?.tpPrice ?? null,
      reduceOnlyOrPositionBound: true,
      state: saved ? 'VERIFIED' : 'MISSING',
      observedAt: Date.now(),
      reason: 'SIMULATED'
    };
  }

  public async protect(position: NativePosition, protection: NativeProtection): Promise<ProtectionEvidence> {
    this.protectionsMap.set(position.positionKey, protection);
    return {
      symbol: position.symbol,
      positionKey: position.positionKey,
      side: position.side,
      requiredQty: position.qty,
      coveredQty: position.qty,
      stopPrice: protection.stopPrice,
      tpPrice: protection.tpPrice,
      reduceOnlyOrPositionBound: true,
      state: 'VERIFIED',
      observedAt: Date.now(),
      reason: 'SIMULATED'
    };
  }

  public async close(position: NativePosition, clientOrderId: string, overridePrice?: DecimalString): Promise<NativeOrderReceipt> {
    this.orderSequence += 1;
    this.positionsMap.delete(position.positionKey);
    this.protectionsMap.delete(position.positionKey);

    let closePrice = overridePrice;
    if (!closePrice) {
      const q = await this.quote(position.symbol);
      closePrice = compareDecimals(q.last, '0') > 0
        ? q.last
        : (position.symbol.startsWith('BTC') ? '66000.0' : '3100.0');
    }
    const priceDiff = position.side === 'LONG'
      ? subDecimals(closePrice, position.entryPrice)
      : subDecimals(position.entryPrice, closePrice);
    const grossPnl = mulDecimals(position.qty, priceDiff);
    const exitFee = quantize(mulDecimals(mulDecimals(position.qty, closePrice), '0.00055'), '0.0001', 'ceil');
    const netDelta = subDecimals(grossPnl, exitFee);
    this.equity = addDecimals(this.equity, netDelta);
    this.availableBalance = this.equity;
    this.realizedDailyPnl = addDecimals(this.realizedDailyPnl, netDelta);

    const receipt: NativeOrderReceipt = {
      clientOrderId,
      venueOrderId: `sim-close-${this.orderSequence}-${clientOrderId}`,
      symbol: position.symbol,
      state: 'FILLED',
      filledQty: position.qty,
      avgFillPrice: closePrice,
      observedAt: Date.now(),
      reason: 'SIMULATED'
    };

    this.ordersMap.set(clientOrderId, receipt);

    this.financialRecords.push({
      id: `sim-fin-${this.orderSequence}`,
      kind: 'fill',
      symbol: position.symbol,
      side: position.side === 'LONG' ? 'SHORT' : 'LONG',
      qty: position.qty,
      price: closePrice,
      feeAmount: exitFee,
      feeCurrency: 'USDT',
      realizedPnl: netDelta,
      fundingAmount: null,
      currency: 'USDT',
      occurredAt: Date.now()
    });

    return receipt;
  }

  public async evaluateTick(
    symbol: string,
    markPrice: DecimalString
  ): Promise<Array<{ kind: 'LIMIT_FILLED' | 'STOP_LOSS' | 'TAKE_PROFIT'; symbol: string; clientOrderId: string; price: DecimalString; pnl?: DecimalString }>> {
    const clean = symbol.toUpperCase();
    const events: Array<{ kind: 'LIMIT_FILLED' | 'STOP_LOSS' | 'TAKE_PROFIT'; symbol: string; clientOrderId: string; price: DecimalString; pnl?: DecimalString }> = [];

    for (const [cid, pending] of this.pendingLimits.entries()) {
      if (pending.symbol.toUpperCase() !== clean || !pending.limitPrice) continue;
      const crossed = pending.side === 'LONG'
        ? compareDecimals(markPrice, pending.limitPrice) <= 0
        : compareDecimals(markPrice, pending.limitPrice) >= 0;
      if (crossed) {
        this.pendingLimits.delete(cid);
        this.orderSequence += 1;
        this.fillOrder(pending, pending.limitPrice, '0.0002', this.orderSequence);
        events.push({ kind: 'LIMIT_FILLED', symbol: clean, clientOrderId: cid, price: pending.limitPrice });
      }
    }

    for (const pos of Array.from(this.positionsMap.values())) {
      if (pos.symbol.toUpperCase() !== clean) continue;
      const prot = this.protectionsMap.get(pos.positionKey);
      if (!prot) continue;
      const hitStop = pos.side === 'LONG'
        ? compareDecimals(markPrice, prot.stopPrice) <= 0
        : compareDecimals(markPrice, prot.stopPrice) >= 0;
      const hitTp = prot.tpPrice
        ? (pos.side === 'LONG'
            ? compareDecimals(markPrice, prot.tpPrice) >= 0
            : compareDecimals(markPrice, prot.tpPrice) <= 0)
        : false;
      if (hitStop) {
        const cid = `sim-sl-${Date.now()}-${clean}`;
        await this.close(pos, cid, prot.stopPrice);
        events.push({ kind: 'STOP_LOSS', symbol: clean, clientOrderId: cid, price: prot.stopPrice });
      } else if (hitTp && prot.tpPrice) {
        const cid = `sim-tp-${Date.now()}-${clean}`;
        await this.close(pos, cid, prot.tpPrice);
        events.push({ kind: 'TAKE_PROFIT', symbol: clean, clientOrderId: cid, price: prot.tpPrice });
      }
    }

    return events;
  }

  public async financialHistory(_cursor: string | null): Promise<FinancialPage> {
    return {
      records: [...this.financialRecords],
      nextCursor: null,
      complete: true,
      supported: ['fills', 'fees', 'funding']
    };
  }
}

export function createPaperVenue(options: PaperVenueOptions = {}): PaperVenue {
  return new PaperVenue(options);
}
