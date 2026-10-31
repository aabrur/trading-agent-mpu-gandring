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
  private positionsMap = new Map<string, NativePosition>();
  private protectionsMap = new Map<string, NativeProtection>();
  private ordersMap = new Map<string, NativeOrderReceipt>();
  private financialRecords: NativeFinancialRecord[] = [];
  private orderSequence = 0;

  constructor(options: PaperVenueOptions = {}) {
    if (options.liveCredential) {
      throw new AdapterCapabilityError('PaperVenue refuses live keys and signing credentials.');
    }
    this.venue = options.venue ?? 'bybit';
    this.network = options.network ?? 'mainnet';
    this.equity = options.initialBalance ?? '1000';
    this.availableBalance = this.equity;
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
      realizedDailyPnl: '0',
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
    const lastPrice = symbol.startsWith('BTC') ? '65000.0' : '3000.0';
    return {
      symbol,
      last: lastPrice,
      bid: subDecimals(lastPrice, '0.5'),
      ask: addDecimals(lastPrice, '0.5'),
      sourceAt: Date.now(),
      observedAt: Date.now(),
      ageMs: 5
    };
  }

  public async positions(): Promise<NativePosition[]> {
    return Array.from(this.positionsMap.values());
  }

  public async submit(intent: NativeOrder): Promise<NativeOrderReceipt> {
    this.orderSequence += 1;
    const simOrderId = `sim-order-${this.orderSequence}-${intent.clientOrderId}`;
    const fillPrice = intent.limitPrice ?? (intent.symbol.startsWith('BTC') ? '65000.0' : '3000.0');

    const receipt: NativeOrderReceipt = {
      clientOrderId: intent.clientOrderId,
      venueOrderId: simOrderId,
      symbol: intent.symbol,
      state: 'FILLED',
      filledQty: intent.quantity,
      avgFillPrice: fillPrice,
      observedAt: Date.now(),
      reason: 'SIMULATED'
    };

    this.ordersMap.set(intent.clientOrderId, receipt);

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
        nativePositionId: `sim-pos-${this.orderSequence}`,
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
      id: `sim-fin-${this.orderSequence}`,
      kind: 'fill',
      symbol: intent.symbol,
      side: intent.side,
      qty: intent.quantity,
      price: fillPrice,
      feeAmount: quantize(mulDecimals(mulDecimals(intent.quantity, fillPrice), '0.00055'), '0.0001', 'ceil'),
      feeCurrency: 'USDT',
      realizedPnl: '0',
      fundingAmount: null,
      currency: 'USDT',
      occurredAt: Date.now()
    });

    return receipt;
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
    return {
      ...found,
      state: 'CANCELLED',
      reason: 'SIMULATED'
    };
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

  public async close(position: NativePosition, clientOrderId: string): Promise<NativeOrderReceipt> {
    this.orderSequence += 1;
    this.positionsMap.delete(position.positionKey);
    this.protectionsMap.delete(position.positionKey);

    const closePrice = position.symbol.startsWith('BTC') ? '66000.0' : '3100.0';
    const priceDiff = position.side === 'LONG'
      ? subDecimals(closePrice, position.entryPrice)
      : subDecimals(position.entryPrice, closePrice);
    const pnl = mulDecimals(position.qty, priceDiff);
    this.equity = addDecimals(this.equity, pnl);
    this.availableBalance = this.equity;

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
      feeAmount: quantize(mulDecimals(mulDecimals(position.qty, closePrice), '0.00055'), '0.0001', 'ceil'),
      feeCurrency: 'USDT',
      realizedPnl: pnl,
      fundingAmount: null,
      currency: 'USDT',
      occurredAt: Date.now()
    });

    return receipt;
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
