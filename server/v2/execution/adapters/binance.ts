import { createHmac } from 'node:crypto';
import type { DecimalString, IntentState } from '../../contracts.js';
import { addDecimals, compareDecimals, quantize } from '../decimal.js';
import {
  AdapterCapabilityError,
  VENUE_STATUS,
  VenueTransportError,
  evaluateProtectionCoverage,
  fetchVenueJson,
  parseOptionalDecimal,
  parsePositiveDecimalOrNull,
  prepareNativeOrderQuantities,
  scrubAdapterError,
  validateDelegatedCredentialInput,
  type AdapterOptions,
  type DelegatedCredentials,
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
} from './types.js';

export function signBinanceQuery(query: string, secret: string): string {
  return createHmac('sha256', secret).update(query).digest('hex');
}

function mapBinanceOrderState(rawStatus: unknown): IntentState {
  const s = typeof rawStatus === 'string' ? rawStatus.toUpperCase() : '';
  switch (s) {
    case 'FILLED':
      return 'FILLED';
    case 'PARTIALLY_FILLED':
      return 'PARTIAL';
    case 'NEW':
      return 'ACCEPTED';
    case 'CANCELED':
    case 'EXPIRED':
      return 'CANCELLED';
    case 'REJECTED':
      return 'REJECTED';
    default:
      return 'UNKNOWN';
  }
}

function positionSideForOrder(
  positionMode: 'ONE_WAY' | 'HEDGE',
  hedgeLeg: 'LONG' | 'SHORT' | null
): 'BOTH' | 'LONG' | 'SHORT' {
  if (positionMode === 'ONE_WAY') {
    if (hedgeLeg !== null) {
      throw new AdapterCapabilityError('ONE_WAY order must not specify a hedgeLeg');
    }
    return 'BOTH';
  }
  if (hedgeLeg === 'LONG' || hedgeLeg === 'SHORT') return hedgeLeg;
  throw new AdapterCapabilityError('HEDGE order requires an explicit hedgeLeg');
}

export function createVenueAdapter(options: AdapterOptions): VenueAdapter {
  const base =
    options.network === 'testnet'
      ? 'https://demo-fapi.binance.com'
      : 'https://fapi.binance.com';

  async function loadCredentials(): Promise<DelegatedCredentials> {
    const creds = await options.readSecret(options.credentialRef);
    validateDelegatedCredentialInput({
      venue: 'binance',
      key: creds.key,
      secret: creds.secret,
      passphrase: creds.passphrase
    });
    return creds;
  }

  async function req(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params: Record<string, string | number | boolean | undefined> = {},
    hostOverride = base
  ): Promise<unknown> {
    const creds = await loadCredentials();
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...params, recvWindow: 5000, timestamp: Date.now() })) {
      if (v !== undefined) qs.append(k, String(v));
    }
    qs.append('signature', signBinanceQuery(qs.toString(), creds.secret));
    try {
      const json = await fetchVenueJson(
        options.fetchImpl,
        `${hostOverride}${path}?${qs.toString()}`,
        {
          method,
          headers: { 'X-MBX-APIKEY': creds.key }
        }
      );
      if (
        json &&
        typeof json === 'object' &&
        !Array.isArray(json) &&
        typeof (json as Record<string, unknown>).code === 'number' &&
        Number((json as Record<string, unknown>).code) < 0
      ) {
        const obj = json as Record<string, unknown>;
        throw new VenueTransportError(
          `binance ${path}: ${String(obj.msg ?? 'error')} (${String(obj.code)})`,
          Number(obj.code)
        );
      }
      return json;
    } catch (err) {
      throw new VenueTransportError(
        scrubAdapterError(err instanceof Error ? err.message : String(err), [creds.secret]),
        err instanceof VenueTransportError ? err.code : undefined,
        err instanceof VenueTransportError ? err.retryable : false
      );
    }
  }

  const adapter: VenueAdapter = {
    venue: 'binance',
    network: options.network,
    status: VENUE_STATUS.binance,
    capabilities: {
      exchangeStops: true,
      restingLimitGtcEntry: false,
      hedgeMode: true,
      financialHistory: ['fills', 'fees', 'funding']
    },

    async permissions(): Promise<PermissionEvidence> {
      const observedAt = Date.now();
      if (options.network === 'testnet') {
        const bal = await req('GET', '/fapi/v2/balance');
        const readable = Array.isArray(bal);
        return {
          ok: readable,
          canTrade: readable,
          canWithdraw: null,
          verified: false,
          delegatedOnly: true,
          detail:
            'Demo Trading signed balance check succeeded; apiRestrictions endpoint is unavailable on testnet',
          observedAt
        };
      }
      const r = ((await req(
        'GET',
        '/sapi/v1/account/apiRestrictions',
        {},
        'https://api.binance.com'
      )) ?? {}) as Record<string, unknown>;
      const canWithdraw = Boolean(r.enableWithdrawals);
      const canTrade = Boolean(r.enableFutures);
      return {
        ok: canTrade && !canWithdraw,
        canTrade,
        canWithdraw,
        verified: true,
        delegatedOnly: !canWithdraw,
        detail: `${canWithdraw ? 'key HAS withdraw permission' : 'no withdraw permission'}; futures ${canTrade ? 'enabled' : 'disabled'}; ipRestrict ${r.ipRestrict ? 'on' : 'off'}`,
        observedAt
      };
    },

    async accountIdentity(): Promise<NativeAccountIdentity> {
      const creds = await loadCredentials();
      let positionMode: 'ONE_WAY' | 'HEDGE' = 'ONE_WAY';
      try {
        const dual = (await req('GET', '/fapi/v1/positionSide/dual')) as Record<
          string,
          unknown
        > | null;
        if (dual?.dualSidePosition === true || dual?.dualSidePosition === 'true') {
          positionMode = 'HEDGE';
        }
      } catch {
        // Default ONE_WAY
      }
      return {
        venue: 'binance',
        network: options.network,
        publicAccountId: `binance:${creds.key.slice(0, 8)}`,
        subaccountRef: null,
        positionMode,
        observedAt: Date.now()
      };
    },

    async balance(): Promise<NativeBalance> {
      const r = ((await req('GET', '/fapi/v2/account')) ?? {}) as Record<string, unknown>;
      const observedAt = Date.now();
      const equity = parseOptionalDecimal(r.totalMarginBalance);
      const available = parseOptionalDecimal(r.availableBalance);
      return {
        settlementCurrency: 'USDT',
        equity,
        available,
        realizedDailyPnl: null,
        observedAt,
        availability: equity && available ? 'AVAILABLE' : 'UNAVAILABLE'
      };
    },

    async instruments(symbol: string): Promise<NativeRules> {
      const info = ((await fetchVenueJson(
        options.fetchImpl,
        `${base}/fapi/v1/exchangeInfo`
      )) ?? {}) as Record<string, unknown>;
      const symbols = Array.isArray(info.symbols)
        ? (info.symbols as Array<Record<string, unknown>>)
        : [];
      const row = symbols.find((s) => s.symbol === symbol);
      if (!row) {
        throw new VenueTransportError(`binance: unknown symbol ${symbol}`);
      }
      const filters = Array.isArray(row.filters)
        ? (row.filters as Array<Record<string, unknown>>)
        : [];
      const findFilter = (t: string) => filters.find((f) => f.filterType === t);
      const pxFilter = findFilter('PRICE_FILTER');
      const lotFilters = [findFilter('LOT_SIZE'), findFilter('MARKET_LOT_SIZE')].filter(
        (x): x is Record<string, unknown> => Boolean(x)
      );
      const minNotionalFilter = findFilter('MIN_NOTIONAL');

      const tickSize = parsePositiveDecimalOrNull(pxFilter?.tickSize);
      let qtyStep: DecimalString | null = null;
      let minQty: DecimalString | null = null;
      let maxQty: DecimalString | null = null;
      for (const lf of lotFilters) {
        const st = parsePositiveDecimalOrNull(lf.stepSize);
        if (st && (!qtyStep || compareDecimals(st, qtyStep) > 0)) qtyStep = st;
        const mn = parsePositiveDecimalOrNull(lf.minQty);
        if (mn && (!minQty || compareDecimals(mn, minQty) > 0)) minQty = mn;
        const mx = parsePositiveDecimalOrNull(lf.maxQty);
        if (mx && (!maxQty || compareDecimals(mx, maxQty) < 0)) maxQty = mx;
      }
      if (!tickSize || !qtyStep || !minQty) {
        throw new VenueTransportError(`binance: incomplete instrument filters for ${symbol}`);
      }
      if (compareDecimals(minQty, qtyStep) < 0) minQty = qtyStep;

      return {
        symbol,
        nativeSymbol: String(row.symbol ?? symbol),
        tickSize,
        qtyStep,
        minQty,
        maxQty,
        minNotional: parsePositiveDecimalOrNull(
          minNotionalFilter?.notional ?? minNotionalFilter?.minNotional
        ),
        contractMultiplier: parsePositiveDecimalOrNull(row.contractSize) ?? '1',
        settlementCurrency: String(row.quoteAsset ?? 'USDT'),
        positionModeCapability: 'BOTH',
        exchangeStops: true,
        restingLimitGtcEntry: false
      };
    },

    async quote(symbol: string): Promise<VenueQuote> {
      const r = ((await fetchVenueJson(
        options.fetchImpl,
        `${base}/fapi/v1/ticker/price?symbol=${encodeURIComponent(symbol)}`
      )) ?? {}) as Record<string, unknown>;
      const observedAt = Date.now();
      const last = parsePositiveDecimalOrNull(r.price);
      if (!last) {
        throw new VenueTransportError(`binance: missing price for ${symbol}`);
      }
      const sourceAt = Number.isFinite(Number(r.time)) ? Number(r.time) : null;
      return {
        symbol,
        last,
        bid: null,
        ask: null,
        sourceAt,
        observedAt,
        ageMs: sourceAt !== null ? Math.max(0, observedAt - sourceAt) : null
      };
    },

    async positions(): Promise<NativePosition[]> {
      const raw = await req('GET', '/fapi/v2/positionRisk');
      if (!Array.isArray(raw)) {
        throw new VenueTransportError('binance: invalid positionRisk payload');
      }
      const observedAt = Date.now();
      const out: NativePosition[] = [];
      for (const p of raw as Array<Record<string, unknown>>) {
        const amt = parseOptionalDecimal(p.positionAmt);
        if (!amt || compareDecimals(amt, '0') === 0) continue;
        const isNegative = compareDecimals(amt, '0') < 0;
        const absQty = isNegative ? amt.slice(1) : amt;
        const posSideRaw = String(p.positionSide ?? 'BOTH').toUpperCase();
        const positionMode: 'ONE_WAY' | 'HEDGE' =
          posSideRaw === 'LONG' || posSideRaw === 'SHORT' ? 'HEDGE' : 'ONE_WAY';
        const hedgeLeg: 'LONG' | 'SHORT' | null =
          posSideRaw === 'LONG' ? 'LONG' : posSideRaw === 'SHORT' ? 'SHORT' : null;
        const side: 'LONG' | 'SHORT' = hedgeLeg ?? (isNegative ? 'SHORT' : 'LONG');
        const sym = String(p.symbol);
        const entryPrice = parsePositiveDecimalOrNull(p.entryPrice);
        if (!entryPrice) continue;
        const lev = Number(p.leverage);
        out.push({
          positionKey:
            positionMode === 'HEDGE' ? `${sym}:HEDGE:${hedgeLeg}` : `${sym}:ONE_WAY:NET`,
          nativePositionId: `${sym}:${posSideRaw}`,
          symbol: sym,
          nativeSymbol: sym,
          positionMode,
          hedgeLeg,
          side,
          qty: absQty,
          entryPrice,
          leverage: Number.isFinite(lev) && lev > 0 ? lev : null,
          unrealizedPnl: parseOptionalDecimal(p.unRealizedProfit),
          observedAt
        });
      }
      return out;
    },

    async submit(intent: NativeOrder): Promise<NativeOrderReceipt> {
      const [rules, currentQuote] = await Promise.all([
        adapter.instruments(intent.symbol),
        adapter.quote(intent.symbol)
      ]);
      const prepared = prepareNativeOrderQuantities(intent, rules, currentQuote.last);
      const posSide = positionSideForOrder(intent.positionMode, intent.hedgeLeg);

      await req('POST', '/fapi/v1/leverage', {
        symbol: rules.nativeSymbol,
        leverage: Math.round(intent.leverage)
      });

      const created = ((await req('POST', '/fapi/v1/order', {
        symbol: rules.nativeSymbol,
        side: intent.side === 'LONG' ? 'BUY' : 'SELL',
        positionSide: posSide === 'BOTH' ? undefined : posSide,
        type: 'MARKET',
        quantity: prepared.quantity,
        newClientOrderId: intent.clientOrderId
      })) ?? {}) as Record<string, unknown>;

      return {
        clientOrderId: intent.clientOrderId,
        venueOrderId: created.orderId != null ? String(created.orderId) : null,
        symbol: intent.symbol,
        state: 'ACCEPTED',
        filledQty: null,
        avgFillPrice: null,
        observedAt: Date.now(),
        reason: null
      };
    },

    async lookupOrder(symbol: string, clientOrderId: string): Promise<NativeOrderReceipt> {
      try {
        const r = ((await req('GET', '/fapi/v1/order', {
          symbol,
          origClientOrderId: clientOrderId
        })) ?? {}) as Record<string, unknown>;
        const state = mapBinanceOrderState(r.status);
        const execQty = parseOptionalDecimal(r.executedQty);
        return {
          clientOrderId,
          venueOrderId: r.orderId != null ? String(r.orderId) : null,
          symbol,
          state,
          filledQty:
            execQty && compareDecimals(execQty, '0') > 0
              ? execQty
              : state === 'FILLED' || state === 'PARTIAL'
                ? execQty
                : null,
          avgFillPrice: parsePositiveDecimalOrNull(r.avgPrice),
          observedAt: Date.now(),
          reason: null
        };
      } catch (err) {
        if (err instanceof VenueTransportError && Number(err.code) === -2013) {
          return {
            clientOrderId,
            venueOrderId: null,
            symbol,
            state: 'UNKNOWN',
            filledQty: null,
            avgFillPrice: null,
            observedAt: Date.now(),
            reason: 'Order does not exist on Binance'
          };
        }
        throw err;
      }
    },

    async cancelEntry(symbol: string, clientOrderId: string): Promise<NativeOrderReceipt> {
      try {
        await req('DELETE', '/fapi/v1/order', {
          symbol,
          origClientOrderId: clientOrderId
        });
      } catch (err) {
        if (!(err instanceof VenueTransportError)) throw err;
      }
      return adapter.lookupOrder(symbol, clientOrderId);
    },

    async protection(position: NativePosition): Promise<ProtectionEvidence> {
      const expectedPosSide = positionSideForOrder(position.positionMode, position.hedgeLeg);
      const raw = await req('GET', '/fapi/v1/openOrders', { symbol: position.nativeSymbol });
      if (!Array.isArray(raw)) {
        throw new VenueTransportError('binance: invalid openOrders response');
      }
      const observedAt = Date.now();
      const exitSide = position.side === 'LONG' ? 'SELL' : 'BUY';

      let stopPrice: DecimalString | null = null;
      let tpPrice: DecimalString | null = null;
      let netPositionBound = false;
      let reduceOnlyOrPositionBound = false;
      let coveredQty: DecimalString = '0';

      for (const o of raw as Array<Record<string, unknown>>) {
        if (String(o.symbol ?? '') !== position.nativeSymbol) continue;
        if (String(o.side ?? '').toUpperCase() !== exitSide) continue;
        const oPosSide = String(o.positionSide ?? 'BOTH').toUpperCase();
        if (oPosSide !== expectedPosSide) continue;

        const oType = String(o.type ?? '').toUpperCase();
        const px = parsePositiveDecimalOrNull(o.stopPrice);
        const closePos = o.closePosition === true || o.closePosition === 'true';
        const reduceOnly = closePos || o.reduceOnly === true || o.reduceOnly === 'true';

        if (oType.startsWith('STOP') && px) {
          if (!stopPrice) stopPrice = px;
          if (closePos) {
            netPositionBound = true;
            reduceOnlyOrPositionBound = true;
          } else if (reduceOnly) {
            reduceOnlyOrPositionBound = true;
            const q = parsePositiveDecimalOrNull(o.origQty ?? o.quantity);
            if (q) coveredQty = addDecimals(coveredQty, q);
          }
        } else if (oType.startsWith('TAKE_PROFIT') && px && !tpPrice) {
          tpPrice = px;
        }
      }

      return evaluateProtectionCoverage({
        symbol: position.symbol,
        positionKey: position.positionKey,
        side: position.side,
        requiredQty: position.qty,
        coveredQty,
        stopPrice,
        tpPrice,
        reduceOnlyOrPositionBound,
        netPositionBound,
        observedAt
      });
    },

    async protect(
      position: NativePosition,
      protection: NativeProtection
    ): Promise<ProtectionEvidence> {
      const posSide = positionSideForOrder(position.positionMode, position.hedgeLeg);
      const rules = await adapter.instruments(position.symbol);
      const exitSide = position.side === 'LONG' ? 'SELL' : 'BUY';
      const workingType =
        protection.triggerBy === 'LAST_PRICE' ? 'CONTRACT_PRICE' : 'MARK_PRICE';
      const quantizedStop = quantize(
        protection.stopPrice,
        rules.tickSize,
        position.side === 'LONG' ? 'floor' : 'ceil'
      );

      await req('POST', '/fapi/v1/order', {
        symbol: position.nativeSymbol,
        side: exitSide,
        positionSide: posSide === 'BOTH' ? undefined : posSide,
        type: 'STOP_MARKET',
        stopPrice: quantizedStop,
        closePosition: true,
        workingType,
        newClientOrderId: `${protection.clientOrderId}s`
      });

      if (protection.tpPrice) {
        const quantizedTp = quantize(
          protection.tpPrice,
          rules.tickSize,
          position.side === 'LONG' ? 'ceil' : 'floor'
        );
        await req('POST', '/fapi/v1/order', {
          symbol: position.nativeSymbol,
          side: exitSide,
          positionSide: posSide === 'BOTH' ? undefined : posSide,
          type: 'TAKE_PROFIT_MARKET',
          stopPrice: quantizedTp,
          closePosition: true,
          workingType,
          newClientOrderId: `${protection.clientOrderId}t`
        });
      }

      return adapter.protection(position);
    },

    async close(position: NativePosition, clientOrderId: string): Promise<NativeOrderReceipt> {
      const posSide = positionSideForOrder(position.positionMode, position.hedgeLeg);
      const rules = await adapter.instruments(position.symbol);
      const qty = quantize(position.qty, rules.qtyStep, 'floor');
      const created = ((await req('POST', '/fapi/v1/order', {
        symbol: position.nativeSymbol,
        side: position.side === 'LONG' ? 'SELL' : 'BUY',
        positionSide: posSide === 'BOTH' ? undefined : posSide,
        type: 'MARKET',
        quantity: qty,
        reduceOnly: posSide === 'BOTH' ? true : undefined,
        newClientOrderId: clientOrderId
      })) ?? {}) as Record<string, unknown>;

      return {
        clientOrderId,
        venueOrderId: created.orderId != null ? String(created.orderId) : null,
        symbol: position.symbol,
        state: 'ACCEPTED',
        filledQty: null,
        avgFillPrice: null,
        observedAt: Date.now(),
        reason: null
      };
    },

    async financialHistory(_cursor: string | null): Promise<FinancialPage> {
      const raw = await req('GET', '/fapi/v1/income', { limit: 1000 });
      const rows = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
      const records: NativeFinancialRecord[] = [];
      for (const item of rows) {
        const id = String(item.tranId ?? item.time ?? '');
        if (!id) continue;
        const incomeType = String(item.incomeType ?? '').toUpperCase();
        const isFunding = incomeType.includes('FUNDING');
        const isCommission = incomeType.includes('COMMISSION');
        const amt = parseOptionalDecimal(item.income);
        records.push({
          id: `bn:${id}`,
          kind: isFunding ? 'funding' : 'fee',
          symbol: item.symbol ? String(item.symbol) : null,
          side: null,
          qty: null,
          price: null,
          feeAmount: isCommission ? amt : null,
          feeCurrency: item.asset ? String(item.asset) : null,
          realizedPnl: incomeType === 'REALIZED_PNL' ? amt : null,
          fundingAmount: isFunding ? amt : null,
          currency: item.asset ? String(item.asset) : 'USDT',
          occurredAt: Number(item.time ?? Date.now())
        });
      }
      return {
        records,
        nextCursor: null,
        complete: rows.length < 1000,
        supported: ['fees', 'funding']
      };
    }
  };

  return adapter;
}
