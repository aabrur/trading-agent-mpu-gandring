import { createHmac } from 'node:crypto';
import type { DecimalString, IntentState } from '../../contracts.js';
import { addDecimals, compareDecimals, quantize, subDecimals } from '../decimal.js';
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

export function signBybitV5(input: {
  timestamp: string;
  apiKey: string;
  recvWindow: string;
  payload: string;
  secret: string;
}): string {
  return createHmac('sha256', input.secret)
    .update(input.timestamp + input.apiKey + input.recvWindow + input.payload)
    .digest('hex');
}

function mapBybitOrderState(rawStatus: unknown): IntentState {
  const status = typeof rawStatus === 'string' ? rawStatus : '';
  switch (status) {
    case 'Filled':
      return 'FILLED';
    case 'PartiallyFilled':
      return 'PARTIAL';
    case 'New':
    case 'Created':
    case 'Untriggered':
      return 'ACCEPTED';
    case 'Cancelled':
    case 'PartiallyFilledCanceled':
    case 'Deactivated':
      return 'CANCELLED';
    case 'Rejected':
      return 'REJECTED';
    default:
      return 'UNKNOWN';
  }
}

function mapTriggerBy(triggerBy: NativeProtection['triggerBy']): string {
  if (triggerBy === 'LAST_PRICE') return 'LastPrice';
  if (triggerBy === 'INDEX_PRICE') return 'IndexPrice';
  return 'MarkPrice';
}

function positionIdxForOrder(positionMode: 'ONE_WAY' | 'HEDGE', hedgeLeg: 'LONG' | 'SHORT' | null): 0 | 1 | 2 {
  if (positionMode === 'ONE_WAY') {
    if (hedgeLeg !== null) {
      throw new AdapterCapabilityError('ONE_WAY order must not specify a hedgeLeg');
    }
    return 0;
  }
  if (hedgeLeg === 'LONG') return 1;
  if (hedgeLeg === 'SHORT') return 2;
  throw new AdapterCapabilityError('HEDGE order requires an explicit hedgeLeg');
}

export function createVenueAdapter(options: AdapterOptions): VenueAdapter {
  const base =
    options.network === 'testnet' ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
  const recvWindow = '5000';
  let timeOffsetMs = 0;
  let clockReady = false;
  let cachedUserId: string | null = null;
  let cachedSubaccountRef: string | null = null;

  async function loadCredentials(): Promise<DelegatedCredentials> {
    const creds = await options.readSecret(options.credentialRef);
    validateDelegatedCredentialInput({
      venue: 'bybit',
      key: creds.key,
      secret: creds.secret,
      passphrase: creds.passphrase
    });
    return creds;
  }

  function serverMillis(json: Record<string, unknown> | null): number | null {
    const reported = Number(json?.time);
    if (Number.isFinite(reported) && reported > 0) return reported;
    const resultObj =
      json?.result && typeof json.result === 'object'
        ? (json.result as Record<string, unknown>)
        : null;
    const nano = resultObj?.timeNano;
    if (typeof nano === 'string' && /^\d{7,}$/.test(nano)) {
      const ms = Number(nano.slice(0, -6));
      if (Number.isFinite(ms) && ms > 0) return ms;
    }
    return null;
  }

  async function syncTime(): Promise<void> {
    try {
      const before = Date.now();
      const raw = (await fetchVenueJson(options.fetchImpl, `${base}/v5/market/time`, {
        method: 'GET'
      })) as Record<string, unknown> | null;
      const after = Date.now();
      const server = serverMillis(raw);
      if (server !== null) {
        timeOffsetMs = Math.round(server - (before + after) / 2);
      }
    } catch {
      // Keep last offset when public clock check is unavailable.
    }
  }

  async function signedRequest(
    creds: DelegatedCredentials,
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, string | number | boolean | undefined>
  ): Promise<Record<string, unknown>> {
    const defined = Object.fromEntries(
      Object.entries(params).filter(([, v]) => v !== undefined)
    );
    const query =
      method === 'GET'
        ? new URLSearchParams(
            Object.fromEntries(Object.entries(defined).map(([k, v]) => [k, String(v)]))
          ).toString()
        : '';
    const body = method === 'POST' ? JSON.stringify(defined) : '';
    const timestamp = String(Date.now() + timeOffsetMs);
    const signature = signBybitV5({
      timestamp,
      apiKey: creds.key,
      recvWindow,
      payload: method === 'GET' ? query : body,
      secret: creds.secret
    });

    try {
      const json = (await fetchVenueJson(
        options.fetchImpl,
        `${base}${path}${query ? `?${query}` : ''}`,
        {
          method,
          headers: {
            'Content-Type': 'application/json',
            'X-BAPI-API-KEY': creds.key,
            'X-BAPI-TIMESTAMP': timestamp,
            'X-BAPI-RECV-WINDOW': recvWindow,
            'X-BAPI-SIGN': signature
          },
          body: method === 'POST' ? body : undefined
        }
      )) as Record<string, unknown> | null;
      return json ?? {};
    } catch (err) {
      const msg = scrubAdapterError(
        err instanceof Error ? err.message : String(err),
        [creds.secret, creds.passphrase]
      );
      const code = err instanceof VenueTransportError ? err.code : undefined;
      const retryable = err instanceof VenueTransportError ? err.retryable : false;
      throw new VenueTransportError(msg, code, retryable);
    }
  }

  async function req(
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, string | number | boolean | undefined> = {}
  ): Promise<Record<string, unknown>> {
    const creds = await loadCredentials();
    if (!clockReady) {
      await syncTime();
      clockReady = true;
    }
    let json = await signedRequest(creds, method, path, params);
    if (Number(json.retCode) === 10002) {
      await syncTime();
      json = await signedRequest(creds, method, path, params);
    }
    if (Number(json.retCode ?? -1) !== 0) {
      const cleanMsg = scrubAdapterError(
        `bybit ${path}: ${String(json.retMsg ?? 'error')} (${String(json.retCode ?? 'unknown')})`,
        [creds.secret, creds.passphrase]
      );
      throw new VenueTransportError(
        cleanMsg,
        typeof json.retCode === 'number' || typeof json.retCode === 'string'
          ? json.retCode
          : undefined
      );
    }
    return json.result && typeof json.result === 'object'
      ? (json.result as Record<string, unknown>)
      : {};
  }

  async function publicReq(
    path: string,
    params: Record<string, string | undefined>
  ): Promise<{ result: Record<string, unknown>; time: number | null }> {
    const query = new URLSearchParams(
      Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined)
    ).toString();
    const json = (await fetchVenueJson(
      options.fetchImpl,
      `${base}${path}${query ? `?${query}` : ''}`,
      { method: 'GET' }
    )) as Record<string, unknown> | null;
    if (Number(json?.retCode ?? -1) !== 0) {
      throw new VenueTransportError(
        `bybit ${path}: ${String(json?.retMsg ?? 'error')} (${String(json?.retCode ?? 'unknown')})`,
        typeof json?.retCode === 'number' ? json.retCode : undefined
      );
    }
    const result =
      json?.result && typeof json.result === 'object'
        ? (json.result as Record<string, unknown>)
        : {};
    const time = Number.isFinite(Number(json?.time)) ? Number(json?.time) : null;
    return { result, time };
  }

  const adapter: VenueAdapter = {
    venue: 'bybit',
    network: options.network,
    status: VENUE_STATUS.bybit,
    capabilities: {
      exchangeStops: true,
      restingLimitGtcEntry: false,
      hedgeMode: true,
      financialHistory: ['fills', 'fees', 'funding']
    },

    async permissions(): Promise<PermissionEvidence> {
      const r = await req('GET', '/v5/user/query-api');
      const observedAt = Date.now();
      if (r.userID) cachedUserId = String(r.userID);
      if (r.parentUid && String(r.parentUid) !== '0' && r.userID) {
        cachedSubaccountRef = String(r.userID);
      }
      const permsObj =
        r.permissions && typeof r.permissions === 'object'
          ? (r.permissions as Record<string, unknown>)
          : {};
      const wallet = Array.isArray(permsObj.Wallet) ? permsObj.Wallet.map(String) : [];
      const contractTrade = Array.isArray(permsObj.ContractTrade)
        ? permsObj.ContractTrade.map(String)
        : [];
      const derivatives = Array.isArray(permsObj.Derivatives)
        ? permsObj.Derivatives.map(String)
        : [];
      const canWithdraw = wallet.includes('Withdraw');
      const canTrade = Number(r.readOnly) === 0 && (contractTrade.length > 0 || derivatives.length > 0);
      const notes = [
        canWithdraw ? 'key HAS withdraw permission' : 'no withdraw permission',
        canTrade ? 'can trade linear contracts' : 'cannot trade contracts (readOnly or missing ContractTrade)'
      ];
      const nonWithdrawWallet = wallet.filter((w) => w !== 'Withdraw');
      if (nonWithdrawWallet.length > 0) {
        notes.push(`wallet transfer permissions present: ${nonWithdrawWallet.join(', ')}`);
      }
      const ips = Array.isArray(r.ips) ? r.ips : [];
      if (ips.length === 0) {
        notes.push('no IP whitelist set (recommended)');
      }
      return {
        ok: canTrade && !canWithdraw,
        canTrade,
        canWithdraw,
        verified: true,
        delegatedOnly: !canWithdraw,
        detail: notes.join('; '),
        observedAt
      };
    },

    async accountIdentity(): Promise<NativeAccountIdentity> {
      if (!cachedUserId) {
        await adapter.permissions();
      }
      const posRes = await req('GET', '/v5/position/list', {
        category: 'linear',
        settleCoin: 'USDT'
      });
      const list = Array.isArray(posRes.list) ? (posRes.list as Array<Record<string, unknown>>) : [];
      const isHedge = list.some((p) => Number(p.positionIdx) === 1 || Number(p.positionIdx) === 2);
      return {
        venue: 'bybit',
        network: options.network,
        publicAccountId: cachedUserId ?? 'unknown',
        subaccountRef: cachedSubaccountRef,
        positionMode: isHedge ? 'HEDGE' : 'ONE_WAY',
        observedAt: Date.now()
      };
    },

    async balance(): Promise<NativeBalance> {
      const r = await req('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' });
      const observedAt = Date.now();
      const list = Array.isArray(r.list) ? (r.list as Array<Record<string, unknown>>) : [];
      const acc = list[0];
      if (!acc) {
        return {
          settlementCurrency: 'USDT',
          equity: null,
          available: null,
          realizedDailyPnl: null,
          observedAt,
          availability: 'UNAVAILABLE'
        };
      }
      const equity = parseOptionalDecimal(acc.totalEquity);
      let available = parseOptionalDecimal(acc.totalAvailableBalance);
      const totalInitialMargin = parseOptionalDecimal(acc.totalInitialMargin) ?? '0';
      if (
        equity &&
        available &&
        compareDecimals(available, '0') <= 0 &&
        compareDecimals(equity, '0') > 0 &&
        compareDecimals(totalInitialMargin, '0') <= 0
      ) {
        const coins = Array.isArray(acc.coin) ? (acc.coin as Array<Record<string, unknown>>) : [];
        const usdtCoin = coins.find((c) => c.coin === 'USDT');
        if (usdtCoin) {
          const wb = parseOptionalDecimal(usdtCoin.walletBalance) ?? '0';
          const posIm = parseOptionalDecimal(usdtCoin.totalPositionIM) ?? '0';
          const ordIm = parseOptionalDecimal(usdtCoin.totalOrderIM) ?? '0';
          const locked = parseOptionalDecimal(usdtCoin.locked) ?? '0';
          const free = subDecimals(subDecimals(subDecimals(wb, posIm), ordIm), locked);
          if (compareDecimals(free, '0') > 0) available = free;
        }
      }
      if (!equity || !available) {
        return {
          settlementCurrency: 'USDT',
          equity,
          available,
          realizedDailyPnl: null,
          observedAt,
          availability: 'UNAVAILABLE'
        };
      }
      return {
        settlementCurrency: 'USDT',
        equity,
        available,
        realizedDailyPnl: null,
        observedAt,
        availability: 'AVAILABLE'
      };
    },

    async instruments(symbol: string): Promise<NativeRules> {
      const { result } = await publicReq('/v5/market/instruments-info', {
        category: 'linear',
        symbol
      });
      const list = Array.isArray(result.list) ? (result.list as Array<Record<string, unknown>>) : [];
      const item = list[0];
      if (!item) {
        throw new VenueTransportError(`bybit: unknown symbol ${symbol}`);
      }
      const priceFilter = (item.priceFilter ?? {}) as Record<string, unknown>;
      const lotSizeFilter = (item.lotSizeFilter ?? {}) as Record<string, unknown>;
      const tickSize = parsePositiveDecimalOrNull(priceFilter.tickSize);
      const qtyStep = parsePositiveDecimalOrNull(lotSizeFilter.qtyStep);
      const minQty = parsePositiveDecimalOrNull(lotSizeFilter.minOrderQty);
      if (!tickSize || !qtyStep || !minQty) {
        throw new VenueTransportError(`bybit: incomplete instrument rules for ${symbol}`);
      }
      const maxQty = parsePositiveDecimalOrNull(
        lotSizeFilter.maxMktOrderQty ?? lotSizeFilter.maxOrderQty
      );
      const minNotional = parsePositiveDecimalOrNull(lotSizeFilter.minNotionalValue);
      return {
        symbol,
        nativeSymbol: String(item.symbol ?? symbol),
        tickSize,
        qtyStep,
        minQty,
        maxQty,
        minNotional,
        contractMultiplier: '1',
        settlementCurrency: String(item.settleCoin ?? 'USDT'),
        positionModeCapability: 'BOTH',
        exchangeStops: true,
        restingLimitGtcEntry: false
      };
    },

    async quote(symbol: string): Promise<VenueQuote> {
      const { result, time } = await publicReq('/v5/market/tickers', {
        category: 'linear',
        symbol
      });
      const observedAt = Date.now();
      const list = Array.isArray(result.list) ? (result.list as Array<Record<string, unknown>>) : [];
      const row = list[0];
      const last = parsePositiveDecimalOrNull(row?.lastPrice);
      if (!last) {
        throw new VenueTransportError(`bybit: missing ticker lastPrice for ${symbol}`);
      }
      return {
        symbol,
        last,
        bid: parsePositiveDecimalOrNull(row?.bid1Price),
        ask: parsePositiveDecimalOrNull(row?.ask1Price),
        sourceAt: time,
        observedAt,
        ageMs: time !== null ? Math.max(0, observedAt - time) : null
      };
    },

    async positions(): Promise<NativePosition[]> {
      const out: NativePosition[] = [];
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      const observedAt = Date.now();

      do {
        const res = await req('GET', '/v5/position/list', {
          category: 'linear',
          settleCoin: 'USDT',
          cursor
        });
        if (!Array.isArray(res.list)) {
          throw new VenueTransportError('bybit: incomplete position list response');
        }
        for (const p of res.list as Array<Record<string, unknown>>) {
          const qty = parseOptionalDecimal(p.size);
          if (!qty || compareDecimals(qty, '0') <= 0) continue;
          const rawSide = String(p.side ?? '');
          if (rawSide !== 'Buy' && rawSide !== 'Sell') {
            throw new VenueTransportError(`bybit: unexpected position side ${rawSide}`);
          }
          const side: 'LONG' | 'SHORT' = rawSide === 'Buy' ? 'LONG' : 'SHORT';
          const idx = Number(p.positionIdx ?? 0);
          const positionMode: 'ONE_WAY' | 'HEDGE' = idx === 1 || idx === 2 ? 'HEDGE' : 'ONE_WAY';
          const hedgeLeg: 'LONG' | 'SHORT' | null =
            idx === 1 ? 'LONG' : idx === 2 ? 'SHORT' : null;
          const sym = String(p.symbol);
          const entryPrice = parsePositiveDecimalOrNull(p.avgPrice ?? p.entryPrice);
          if (!entryPrice) {
            throw new VenueTransportError(`bybit: missing position avgPrice for ${sym}`);
          }
          const levNum = Number(p.leverage);
          out.push({
            positionKey:
              positionMode === 'HEDGE'
                ? `${sym}:HEDGE:${hedgeLeg}`
                : `${sym}:ONE_WAY:NET`,
            nativePositionId: `${sym}:${idx}`,
            symbol: sym,
            nativeSymbol: sym,
            positionMode,
            hedgeLeg,
            side,
            qty,
            entryPrice,
            leverage: Number.isFinite(levNum) && levNum > 0 ? levNum : null,
            unrealizedPnl: parseOptionalDecimal(p.unrealisedPnl),
            observedAt
          });
        }
        const next = typeof res.nextPageCursor === 'string' && res.nextPageCursor ? res.nextPageCursor : undefined;
        if (next && seenCursors.has(next)) {
          throw new VenueTransportError('bybit: repeated position pagination cursor');
        }
        if (next) seenCursors.add(next);
        cursor = next;
      } while (cursor);

      return out;
    },

    async submit(intent: NativeOrder): Promise<NativeOrderReceipt> {
      const [rules, currentQuote] = await Promise.all([
        adapter.instruments(intent.symbol),
        adapter.quote(intent.symbol)
      ]);
      const prepared = prepareNativeOrderQuantities(intent, rules, currentQuote.last);
      const positionIdx = positionIdxForOrder(intent.positionMode, intent.hedgeLeg);

      try {
        await req('POST', '/v5/position/set-leverage', {
          category: 'linear',
          symbol: rules.nativeSymbol,
          buyLeverage: String(intent.leverage),
          sellLeverage: String(intent.leverage)
        });
      } catch (err) {
        if (!(err instanceof VenueTransportError) || Number(err.code) !== 110043) {
          throw err;
        }
      }

      const created = await req('POST', '/v5/order/create', {
        category: 'linear',
        symbol: rules.nativeSymbol,
        side: intent.side === 'LONG' ? 'Buy' : 'Sell',
        orderType: 'Market',
        qty: prepared.quantity,
        positionIdx,
        orderLinkId: intent.clientOrderId
      });

      return {
        clientOrderId: intent.clientOrderId,
        venueOrderId: typeof created.orderId === 'string' && created.orderId ? created.orderId : null,
        symbol: intent.symbol,
        state: 'ACCEPTED',
        filledQty: null,
        avgFillPrice: null,
        observedAt: Date.now(),
        reason: null
      };
    },

    async lookupOrder(symbol: string, clientOrderId: string): Promise<NativeOrderReceipt> {
      const rt = await req('GET', '/v5/order/realtime', {
        category: 'linear',
        symbol,
        orderLinkId: clientOrderId
      });
      let row = Array.isArray(rt.list) ? (rt.list[0] as Record<string, unknown> | undefined) : undefined;
      if (!row) {
        const hist = await req('GET', '/v5/order/history', {
          category: 'linear',
          symbol,
          orderLinkId: clientOrderId
        });
        row = Array.isArray(hist.list)
          ? (hist.list[0] as Record<string, unknown> | undefined)
          : undefined;
      }
      const observedAt = Date.now();
      if (!row) {
        return {
          clientOrderId,
          venueOrderId: null,
          symbol,
          state: 'UNKNOWN',
          filledQty: null,
          avgFillPrice: null,
          observedAt,
          reason: 'Order not found in realtime or history endpoints'
        };
      }
      const state = mapBybitOrderState(row.orderStatus);
      const cumExecQty = parseOptionalDecimal(row.cumExecQty);
      const avgPrice = parsePositiveDecimalOrNull(row.avgPrice);
      return {
        clientOrderId,
        venueOrderId: typeof row.orderId === 'string' && row.orderId ? row.orderId : null,
        symbol,
        state,
        filledQty:
          cumExecQty && compareDecimals(cumExecQty, '0') > 0
            ? cumExecQty
            : state === 'FILLED' || state === 'PARTIAL'
              ? cumExecQty
              : null,
        avgFillPrice: avgPrice,
        observedAt,
        reason: typeof row.rejectReason === 'string' && row.rejectReason ? row.rejectReason : null
      };
    },

    async cancelEntry(symbol: string, clientOrderId: string): Promise<NativeOrderReceipt> {
      try {
        await req('POST', '/v5/order/cancel', {
          category: 'linear',
          symbol,
          orderLinkId: clientOrderId
        });
      } catch (err) {
        // Order may already be filled or cancelled; lookupOrder resolves authoritative state.
        if (!(err instanceof VenueTransportError)) throw err;
      }
      return adapter.lookupOrder(symbol, clientOrderId);
    },

    async protection(position: NativePosition): Promise<ProtectionEvidence> {
      const expectedIdx = positionIdxForOrder(position.positionMode, position.hedgeLeg);
      const [posRes, stopRes] = await Promise.all([
        req('GET', '/v5/position/list', {
          category: 'linear',
          symbol: position.nativeSymbol
        }),
        req('GET', '/v5/order/realtime', {
          category: 'linear',
          symbol: position.nativeSymbol,
          orderFilter: 'StopOrder'
        })
      ]);
      const observedAt = Date.now();
      const posList = Array.isArray(posRes.list)
        ? (posRes.list as Array<Record<string, unknown>>)
        : [];
      const matchingPos = posList.find((p) => {
        const idx = Number(p.positionIdx ?? 0);
        const side = p.side === 'Buy' ? 'LONG' : p.side === 'Sell' ? 'SHORT' : null;
        return idx === expectedIdx && side === position.side;
      });

      const posStop = parsePositiveDecimalOrNull(matchingPos?.stopLoss);
      const posTp = parsePositiveDecimalOrNull(matchingPos?.takeProfit);
      const posQty = parsePositiveDecimalOrNull(matchingPos?.size);

      if (posStop && posQty) {
        return evaluateProtectionCoverage({
          symbol: position.symbol,
          positionKey: position.positionKey,
          side: position.side,
          requiredQty: position.qty,
          coveredQty: posQty,
          stopPrice: posStop,
          tpPrice: posTp,
          reduceOnlyOrPositionBound: true,
          observedAt
        });
      }

      const stopList = Array.isArray(stopRes.list)
        ? (stopRes.list as Array<Record<string, unknown>>)
        : [];
      const expectedExitSide = position.side === 'LONG' ? 'Sell' : 'Buy';
      let coveredQty: DecimalString = '0';
      let activeStopPrice: DecimalString | null = null;
      let anyReduceOnly = false;

      for (const order of stopList) {
        if (String(order.side ?? '') !== expectedExitSide) continue;
        if (Number(order.positionIdx ?? 0) !== expectedIdx) continue;
        const status = String(order.orderStatus ?? '');
        if (status !== 'Untriggered' && status !== 'New' && status !== 'Active') continue;
        const triggerPx = parsePositiveDecimalOrNull(order.triggerPrice);
        const qty = parsePositiveDecimalOrNull(order.qty);
        const reduceOnly = Boolean(order.reduceOnly) || Boolean(order.closeOnTrigger);
        if (!triggerPx || !qty) continue;
        if (reduceOnly) {
          anyReduceOnly = true;
          coveredQty = addDecimals(coveredQty, qty);
        }
        if (!activeStopPrice) activeStopPrice = triggerPx;
      }

      return evaluateProtectionCoverage({
        symbol: position.symbol,
        positionKey: position.positionKey,
        side: position.side,
        requiredQty: position.qty,
        coveredQty,
        stopPrice: activeStopPrice,
        tpPrice: posTp,
        reduceOnlyOrPositionBound: anyReduceOnly,
        observedAt
      });
    },

    async protect(
      position: NativePosition,
      protection: NativeProtection
    ): Promise<ProtectionEvidence> {
      const positionIdx = positionIdxForOrder(position.positionMode, position.hedgeLeg);
      const rules = await adapter.instruments(position.symbol);
      const quantizedStop = quantize(
        protection.stopPrice,
        rules.tickSize,
        position.side === 'LONG' ? 'floor' : 'ceil'
      );
      const quantizedTp = protection.tpPrice
        ? quantize(
            protection.tpPrice,
            rules.tickSize,
            position.side === 'LONG' ? 'ceil' : 'floor'
          )
        : undefined;
      const triggerBy = mapTriggerBy(protection.triggerBy);

      await req('POST', '/v5/position/trading-stop', {
        category: 'linear',
        symbol: position.nativeSymbol,
        tpslMode: 'Full',
        positionIdx,
        stopLoss: quantizedStop,
        slTriggerBy: triggerBy,
        takeProfit: quantizedTp,
        tpTriggerBy: quantizedTp ? triggerBy : undefined
      });

      return adapter.protection(position);
    },

    async close(position: NativePosition, clientOrderId: string): Promise<NativeOrderReceipt> {
      const positionIdx = positionIdxForOrder(position.positionMode, position.hedgeLeg);
      const rules = await adapter.instruments(position.symbol);
      const qty = quantize(position.qty, rules.qtyStep, 'floor');
      const created = await req('POST', '/v5/order/create', {
        category: 'linear',
        symbol: position.nativeSymbol,
        side: position.side === 'LONG' ? 'Sell' : 'Buy',
        orderType: 'Market',
        qty,
        reduceOnly: true,
        positionIdx,
        orderLinkId: clientOrderId
      });
      return {
        clientOrderId,
        venueOrderId: typeof created.orderId === 'string' && created.orderId ? created.orderId : null,
        symbol: position.symbol,
        state: 'ACCEPTED',
        filledQty: null,
        avgFillPrice: null,
        observedAt: Date.now(),
        reason: null
      };
    },

    async financialHistory(cursor: string | null): Promise<FinancialPage> {
      const parsedCursor = cursor
        ? (JSON.parse(cursor) as {
            fills?: string;
            income?: string;
            fillsDone?: boolean;
            incomeDone?: boolean;
          })
        : {};
      const [fillsRes, incomeRes] = await Promise.all([
        parsedCursor.fillsDone
          ? Promise.resolve({ list: [], nextPageCursor: '' })
          : req('GET', '/v5/execution/list', {
              category: 'linear',
              cursor: parsedCursor.fills,
              limit: 100
            }),
        parsedCursor.incomeDone
          ? Promise.resolve({ list: [], nextPageCursor: '' })
          : req('GET', '/v5/account/transaction-log', {
              category: 'linear',
              accountType: 'UNIFIED',
              cursor: parsedCursor.income,
              limit: 50
            })
      ]);

      const records: NativeFinancialRecord[] = [];
      const fillsList = Array.isArray(fillsRes.list)
        ? (fillsRes.list as Array<Record<string, unknown>>)
        : [];
      for (const f of fillsList) {
        const id = String(f.execId ?? '');
        if (!id) continue;
        const sideRaw = String(f.side ?? '');
        records.push({
          id: `fill:${id}`,
          kind: 'fill',
          symbol: f.symbol ? String(f.symbol) : null,
          side: sideRaw === 'Buy' ? 'LONG' : sideRaw === 'Sell' ? 'SHORT' : null,
          qty: parseOptionalDecimal(f.execQty),
          price: parseOptionalDecimal(f.execPrice),
          feeAmount: parseOptionalDecimal(f.execFee),
          feeCurrency: f.feeCurrency ? String(f.feeCurrency) : f.execFee ? 'USDT' : null,
          realizedPnl: parseOptionalDecimal(f.closedPnl),
          fundingAmount: null,
          currency: 'USDT',
          occurredAt: Number(f.execTime ?? Date.now())
        });
      }

      const incomeList = Array.isArray(incomeRes.list)
        ? (incomeRes.list as Array<Record<string, unknown>>)
        : [];
      for (const item of incomeList) {
        const id = String(item.id ?? item.transactionTime ?? '');
        if (!id) continue;
        const rawType = String(item.type ?? '').toUpperCase();
        const isFunding = rawType.includes('FUNDING') || rawType === 'SETTLEMENT';
        records.push({
          id: `tx:${id}`,
          kind: isFunding ? 'funding' : 'fee',
          symbol: item.symbol ? String(item.symbol) : null,
          side: null,
          qty: parseOptionalDecimal(item.qty),
          price: parseOptionalDecimal(item.tradePrice),
          feeAmount: isFunding ? null : parseOptionalDecimal(item.fee ?? item.cashFlow),
          feeCurrency: item.currency ? String(item.currency) : null,
          realizedPnl: parseOptionalDecimal(item.change),
          fundingAmount: isFunding ? parseOptionalDecimal(item.funding ?? item.cashFlow) : null,
          currency: item.currency ? String(item.currency) : 'USDT',
          occurredAt: Number(item.transactionTime ?? Date.now())
        });
      }

      const fCursor = typeof fillsRes.nextPageCursor === 'string' ? fillsRes.nextPageCursor : '';
      const iCursor = typeof incomeRes.nextPageCursor === 'string' ? incomeRes.nextPageCursor : '';
      const complete = !fCursor && !iCursor;

      return {
        records,
        nextCursor: complete
          ? null
          : JSON.stringify({
              fills: fCursor,
              income: iCursor,
              fillsDone: !fCursor,
              incomeDone: !iCursor
            }),
        complete,
        supported: ['fills', 'fees', 'funding']
      };
    }
  };

  return adapter;
}
