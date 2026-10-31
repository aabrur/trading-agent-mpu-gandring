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

export const okxInstId = (symbol: string): string => `${symbol.replace(/USDT$/i, '')}-USDT-SWAP`;
export const fromOkxInstId = (id: string): string => `${id.replace(/-USDT-SWAP$/i, '')}USDT`;

export function signOkxV5(input: {
  timestampIso: string;
  method: string;
  requestPath: string;
  body: string;
  secret: string;
}): string {
  return createHmac('sha256', input.secret)
    .update(input.timestampIso + input.method + input.requestPath + input.body)
    .digest('base64');
}

function mapOkxOrderState(rawState: unknown): IntentState {
  const s = typeof rawState === 'string' ? rawState.toLowerCase() : '';
  switch (s) {
    case 'filled':
      return 'FILLED';
    case 'partially_filled':
      return 'PARTIAL';
    case 'live':
      return 'ACCEPTED';
    case 'canceled':
    case 'mmp_canceled':
      return 'CANCELLED';
    default:
      return 'UNKNOWN';
  }
}

function posSideForOrder(
  positionMode: 'ONE_WAY' | 'HEDGE',
  hedgeLeg: 'LONG' | 'SHORT' | null
): 'net' | 'long' | 'short' {
  if (positionMode === 'ONE_WAY') {
    if (hedgeLeg !== null) {
      throw new AdapterCapabilityError('ONE_WAY order must not specify a hedgeLeg');
    }
    return 'net';
  }
  if (hedgeLeg === 'LONG') return 'long';
  if (hedgeLeg === 'SHORT') return 'short';
  throw new AdapterCapabilityError('HEDGE order requires an explicit hedgeLeg');
}

export function createVenueAdapter(options: AdapterOptions): VenueAdapter {
  const base = 'https://www.okx.com';

  async function loadCredentials(): Promise<DelegatedCredentials & { passphrase: string }> {
    const creds = await options.readSecret(options.credentialRef);
    validateDelegatedCredentialInput({
      venue: 'okx',
      key: creds.key,
      secret: creds.secret,
      passphrase: creds.passphrase
    });
    if (!creds.passphrase || !creds.passphrase.trim()) {
      throw new AdapterCapabilityError('OKX requires key, secret and passphrase');
    }
    return {
      ...creds,
      key: creds.key.trim(),
      secret: creds.secret.trim(),
      passphrase: creds.passphrase.trim()
    };
  }

  async function req(
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, unknown> | unknown[] = {}
  ): Promise<Array<Record<string, unknown>>> {
    const creds = await loadCredentials();
    const defined = Array.isArray(params)
      ? params
      : Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));
    const qsEntries =
      method === 'GET' && !Array.isArray(defined)
        ? Object.entries(defined).map(([k, v]) => [k, String(v)] as [string, string])
        : [];
    const query = qsEntries.length > 0 ? `?${new URLSearchParams(qsEntries).toString()}` : '';
    const body = method === 'POST' ? JSON.stringify(defined) : '';
    const ts = new Date().toISOString();
    const signature = signOkxV5({
      timestampIso: ts,
      method,
      requestPath: `${path}${query}`,
      body,
      secret: creds.secret
    });
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'OK-ACCESS-KEY': creds.key,
      'OK-ACCESS-SIGN': signature,
      'OK-ACCESS-TIMESTAMP': ts,
      'OK-ACCESS-PASSPHRASE': creds.passphrase
    };
    if (options.network === 'testnet') {
      headers['x-simulated-trading'] = '1';
    }

    try {
      const json = ((await fetchVenueJson(options.fetchImpl, `${base}${path}${query}`, {
        method,
        headers,
        body: body || undefined
      })) ?? {}) as Record<string, unknown>;
      if (String(json.code ?? '') !== '0') {
        const dataArr = Array.isArray(json.data)
          ? (json.data as Array<Record<string, unknown>>)
          : [];
        const subMsg = dataArr[0]?.sMsg ? String(dataArr[0].sMsg) : '';
        throw new VenueTransportError(
          `okx ${path}: ${String(json.msg || subMsg || 'error')} (${String(json.code ?? 'unknown')})`,
          String(json.code ?? 'unknown')
        );
      }
      return Array.isArray(json.data) ? (json.data as Array<Record<string, unknown>>) : [];
    } catch (err) {
      throw new VenueTransportError(
        scrubAdapterError(err instanceof Error ? err.message : String(err), [
          creds.secret,
          creds.passphrase
        ]),
        err instanceof VenueTransportError ? err.code : undefined,
        err instanceof VenueTransportError ? err.retryable : false
      );
    }
  }

  const adapter: VenueAdapter = {
    venue: 'okx',
    network: options.network,
    status: VENUE_STATUS.okx,
    capabilities: {
      exchangeStops: true,
      restingLimitGtcEntry: false,
      hedgeMode: true,
      financialHistory: ['fills', 'fees', 'funding']
    },

    async permissions(): Promise<PermissionEvidence> {
      const data = await req('GET', '/api/v5/account/config');
      const d = data[0] ?? {};
      const observedAt = Date.now();
      const perm = String(d.perm ?? '');
      const canWithdraw = perm.includes('withdraw');
      const canTrade = perm.includes('trade');
      return {
        ok: canTrade && !canWithdraw,
        canTrade,
        canWithdraw,
        verified: Boolean(perm),
        delegatedOnly: !canWithdraw,
        detail: `perm=${perm || 'unknown'}${d.ip ? '' : '; no IP whitelist set'}`,
        observedAt
      };
    },

    async accountIdentity(): Promise<NativeAccountIdentity> {
      const data = await req('GET', '/api/v5/account/config');
      const d = data[0] ?? {};
      const posMode = String(d.posMode ?? 'net_mode');
      const mainUid = d.mainUid ? String(d.mainUid) : null;
      const uid = String(d.uid ?? 'unknown');
      return {
        venue: 'okx',
        network: options.network,
        publicAccountId: uid,
        subaccountRef: mainUid && mainUid !== uid ? uid : null,
        positionMode: posMode === 'long_short_mode' ? 'HEDGE' : 'ONE_WAY',
        observedAt: Date.now()
      };
    },

    async balance(): Promise<NativeBalance> {
      const data = await req('GET', '/api/v5/account/balance', { ccy: 'USDT' });
      const observedAt = Date.now();
      const d = data[0] ?? {};
      const details = Array.isArray(d.details)
        ? (d.details as Array<Record<string, unknown>>)
        : [];
      const usdt = details.find((x) => x.ccy === 'USDT') ?? {};
      const equity = parseOptionalDecimal(d.totalEq);
      const available = parseOptionalDecimal(usdt.availEq ?? usdt.availBal);
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
      const id = okxInstId(symbol);
      const data = await req('GET', '/api/v5/public/instruments', {
        instType: 'SWAP',
        instId: id
      });
      const item = data[0];
      if (!item) {
        throw new VenueTransportError(`okx: unknown SWAP instrument ${id}`);
      }
      const tickSize = parsePositiveDecimalOrNull(item.tickSz);
      const qtyStep = parsePositiveDecimalOrNull(item.lotSz);
      const minQty = parsePositiveDecimalOrNull(item.minSz);
      const ctVal = parsePositiveDecimalOrNull(item.ctVal);
      if (!tickSize || !qtyStep || !minQty || !ctVal) {
        throw new VenueTransportError(`okx: incomplete SWAP instrument rules for ${id}`);
      }
      return {
        symbol,
        nativeSymbol: id,
        tickSize,
        qtyStep,
        minQty,
        maxQty: parsePositiveDecimalOrNull(item.maxMktSz),
        minNotional: null,
        contractMultiplier: ctVal,
        settlementCurrency: String(item.settleCcy ?? 'USDT'),
        positionModeCapability: 'BOTH',
        exchangeStops: true,
        restingLimitGtcEntry: false
      };
    },

    async quote(symbol: string): Promise<VenueQuote> {
      const id = okxInstId(symbol);
      const data = await req('GET', '/api/v5/market/ticker', { instId: id });
      const observedAt = Date.now();
      const row = data[0];
      const last = parsePositiveDecimalOrNull(row?.last);
      if (!last) {
        throw new VenueTransportError(`okx: missing ticker price for ${id}`);
      }
      const sourceAt = Number.isFinite(Number(row?.ts)) ? Number(row?.ts) : null;
      return {
        symbol,
        last,
        bid: parsePositiveDecimalOrNull(row?.bidPx),
        ask: parsePositiveDecimalOrNull(row?.askPx),
        sourceAt,
        observedAt,
        ageMs: sourceAt !== null ? Math.max(0, observedAt - sourceAt) : null
      };
    },

    async positions(): Promise<NativePosition[]> {
      const data = await req('GET', '/api/v5/account/positions', { instType: 'SWAP' });
      const observedAt = Date.now();
      const out: NativePosition[] = [];
      for (const p of data) {
        const rawPos = parseOptionalDecimal(p.pos);
        if (!rawPos || compareDecimals(rawPos, '0') === 0) continue;
        const isNegative = compareDecimals(rawPos, '0') < 0;
        const absPos = isNegative ? rawPos.slice(1) : rawPos;
        const posSideRaw = String(p.posSide ?? 'net').toLowerCase();
        const positionMode: 'ONE_WAY' | 'HEDGE' =
          posSideRaw === 'long' || posSideRaw === 'short' ? 'HEDGE' : 'ONE_WAY';
        const hedgeLeg: 'LONG' | 'SHORT' | null =
          posSideRaw === 'long' ? 'LONG' : posSideRaw === 'short' ? 'SHORT' : null;
        const side: 'LONG' | 'SHORT' = hedgeLeg ?? (isNegative ? 'SHORT' : 'LONG');
        const inst = String(p.instId ?? '');
        const sym = fromOkxInstId(inst);
        const entryPx = parsePositiveDecimalOrNull(p.avgPx);
        if (!entryPx) continue;
        const lev = Number(p.lever);
        out.push({
          positionKey:
            positionMode === 'HEDGE' ? `${sym}:HEDGE:${hedgeLeg}` : `${sym}:ONE_WAY:NET`,
          nativePositionId: p.posId ? String(p.posId) : `${inst}:${posSideRaw}`,
          symbol: sym,
          nativeSymbol: inst,
          positionMode,
          hedgeLeg,
          side,
          qty: absPos,
          entryPrice: entryPx,
          leverage: Number.isFinite(lev) && lev > 0 ? lev : null,
          unrealizedPnl: parseOptionalDecimal(p.upl),
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
      const posSide = posSideForOrder(intent.positionMode, intent.hedgeLeg);

      await req('POST', '/api/v5/account/set-leverage', {
        instId: rules.nativeSymbol,
        lever: String(Math.round(intent.leverage)),
        mgnMode: 'cross',
        posSide: posSide === 'net' ? undefined : posSide
      });

      const data = await req('POST', '/api/v5/trade/order', {
        instId: rules.nativeSymbol,
        tdMode: 'cross',
        posSide: posSide === 'net' ? undefined : posSide,
        side: intent.side === 'LONG' ? 'buy' : 'sell',
        ordType: 'market',
        sz: prepared.quantity,
        clOrdId: intent.clientOrderId
      });
      const first = data[0] ?? {};
      return {
        clientOrderId: intent.clientOrderId,
        venueOrderId: first.ordId ? String(first.ordId) : null,
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
        const data = await req('GET', '/api/v5/trade/order', {
          instId: okxInstId(symbol),
          clOrdId: clientOrderId
        });
        const row = data[0];
        if (!row) {
          return {
            clientOrderId,
            venueOrderId: null,
            symbol,
            state: 'UNKNOWN',
            filledQty: null,
            avgFillPrice: null,
            observedAt: Date.now(),
            reason: 'Order not found on OKX'
          };
        }
        const state = mapOkxOrderState(row.state);
        const fillSz = parseOptionalDecimal(row.accFillSz);
        return {
          clientOrderId,
          venueOrderId: row.ordId ? String(row.ordId) : null,
          symbol,
          state,
          filledQty:
            fillSz && compareDecimals(fillSz, '0') > 0
              ? fillSz
              : state === 'FILLED' || state === 'PARTIAL'
                ? fillSz
                : null,
          avgFillPrice: parsePositiveDecimalOrNull(row.avgPx),
          observedAt: Date.now(),
          reason: null
        };
      } catch (err) {
        if (err instanceof VenueTransportError && String(err.code) === '51603') {
          return {
            clientOrderId,
            venueOrderId: null,
            symbol,
            state: 'UNKNOWN',
            filledQty: null,
            avgFillPrice: null,
            observedAt: Date.now(),
            reason: 'Order does not exist on OKX'
          };
        }
        throw err;
      }
    },

    async cancelEntry(symbol: string, clientOrderId: string): Promise<NativeOrderReceipt> {
      try {
        await req('POST', '/api/v5/trade/cancel-order', {
          instId: okxInstId(symbol),
          clOrdId: clientOrderId
        });
      } catch (err) {
        if (!(err instanceof VenueTransportError)) throw err;
      }
      return adapter.lookupOrder(symbol, clientOrderId);
    },

    async protection(position: NativePosition): Promise<ProtectionEvidence> {
      const expectedPosSide = posSideForOrder(position.positionMode, position.hedgeLeg);
      const inst = position.nativeSymbol;
      const [cond, oco] = await Promise.all([
        req('GET', '/api/v5/trade/orders-algo-pending', { ordType: 'conditional', instId: inst }),
        req('GET', '/api/v5/trade/orders-algo-pending', { ordType: 'oco', instId: inst })
      ]);
      const observedAt = Date.now();
      const exitSide = position.side === 'LONG' ? 'sell' : 'buy';
      const rows = [...cond, ...oco];

      let stopPrice: DecimalString | null = null;
      let tpPrice: DecimalString | null = null;
      let netPositionBound = false;
      let reduceOnlyOrPositionBound = false;
      let coveredQty: DecimalString = '0';

      for (const a of rows) {
        if (String(a.side ?? '').toLowerCase() !== exitSide) continue;
        const aPosSide = String(a.posSide ?? 'net').toLowerCase();
        if (aPosSide !== expectedPosSide) continue;

        const slPx = parsePositiveDecimalOrNull(a.slTriggerPx);
        const tpPx = parsePositiveDecimalOrNull(a.tpTriggerPx);
        const closeFull = String(a.closeFraction ?? '') === '1';
        const reduceOnly = closeFull || a.reduceOnly === true || a.reduceOnly === 'true';

        if (slPx) {
          if (!stopPrice) stopPrice = slPx;
          if (closeFull) {
            netPositionBound = true;
            reduceOnlyOrPositionBound = true;
          } else if (reduceOnly) {
            reduceOnlyOrPositionBound = true;
            const sz = parsePositiveDecimalOrNull(a.sz);
            if (sz) coveredQty = addDecimals(coveredQty, sz);
          }
        }
        if (tpPx && !tpPrice) tpPrice = tpPx;
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
      const posSide = posSideForOrder(position.positionMode, position.hedgeLeg);
      const rules = await adapter.instruments(position.symbol);
      const exitSide = position.side === 'LONG' ? 'sell' : 'buy';
      const pxType =
        protection.triggerBy === 'LAST_PRICE'
          ? 'last'
          : protection.triggerBy === 'INDEX_PRICE'
            ? 'index'
            : 'mark';
      const quantizedStop = quantize(
        protection.stopPrice,
        rules.tickSize,
        position.side === 'LONG' ? 'floor' : 'ceil'
      );

      await req('POST', '/api/v5/trade/order-algo', {
        instId: rules.nativeSymbol,
        tdMode: 'cross',
        posSide: posSide === 'net' ? undefined : posSide,
        side: exitSide,
        ordType: 'conditional',
        closeFraction: '1',
        reduceOnly: true,
        slTriggerPx: quantizedStop,
        slOrdPx: '-1',
        slTriggerPxType: pxType
      });

      if (protection.tpPrice) {
        const quantizedTp = quantize(
          protection.tpPrice,
          rules.tickSize,
          position.side === 'LONG' ? 'ceil' : 'floor'
        );
        await req('POST', '/api/v5/trade/order-algo', {
          instId: rules.nativeSymbol,
          tdMode: 'cross',
          posSide: posSide === 'net' ? undefined : posSide,
          side: exitSide,
          ordType: 'conditional',
          closeFraction: '1',
          reduceOnly: true,
          tpTriggerPx: quantizedTp,
          tpOrdPx: '-1',
          tpTriggerPxType: pxType
        });
      }

      return adapter.protection(position);
    },

    async close(position: NativePosition, clientOrderId: string): Promise<NativeOrderReceipt> {
      const posSide = posSideForOrder(position.positionMode, position.hedgeLeg);
      const rules = await adapter.instruments(position.symbol);
      const qty = quantize(position.qty, rules.qtyStep, 'floor');
      const data = await req('POST', '/api/v5/trade/order', {
        instId: rules.nativeSymbol,
        tdMode: 'cross',
        posSide: posSide === 'net' ? undefined : posSide,
        side: position.side === 'LONG' ? 'sell' : 'buy',
        ordType: 'market',
        sz: qty,
        reduceOnly: true,
        clOrdId: clientOrderId
      });
      const first = data[0] ?? {};
      return {
        clientOrderId,
        venueOrderId: first.ordId ? String(first.ordId) : null,
        symbol: position.symbol,
        state: 'ACCEPTED',
        filledQty: null,
        avgFillPrice: null,
        observedAt: Date.now(),
        reason: null
      };
    },

    async financialHistory(_cursor: string | null): Promise<FinancialPage> {
      const [fills, bills] = await Promise.all([
        req('GET', '/api/v5/trade/fills', { instType: 'SWAP' }),
        req('GET', '/api/v5/account/bills', { instType: 'SWAP' })
      ]);
      const records: NativeFinancialRecord[] = [];
      for (const f of fills) {
        const id = String(f.tradeId ?? f.ordId ?? '');
        if (!id) continue;
        records.push({
          id: `okx-fill:${id}`,
          kind: 'fill',
          symbol: f.instId ? fromOkxInstId(String(f.instId)) : null,
          side: f.side === 'buy' ? 'LONG' : f.side === 'sell' ? 'SHORT' : null,
          qty: parseOptionalDecimal(f.fillSz),
          price: parseOptionalDecimal(f.fillPx),
          feeAmount: parseOptionalDecimal(f.fee),
          feeCurrency: f.feeCcy ? String(f.feeCcy) : null,
          realizedPnl: parseOptionalDecimal(f.pnl),
          fundingAmount: null,
          currency: 'USDT',
          occurredAt: Number(f.ts ?? Date.now())
        });
      }
      for (const b of bills) {
        const id = String(b.billId ?? '');
        if (!id) continue;
        const typeCode = String(b.type ?? '');
        const isFunding = typeCode === '8';
        records.push({
          id: `okx-bill:${id}`,
          kind: isFunding ? 'funding' : 'fee',
          symbol: b.instId ? fromOkxInstId(String(b.instId)) : null,
          side: null,
          qty: parseOptionalDecimal(b.sz),
          price: parseOptionalDecimal(b.px),
          feeAmount: isFunding ? null : parseOptionalDecimal(b.fee),
          feeCurrency: b.ccy ? String(b.ccy) : null,
          realizedPnl: parseOptionalDecimal(b.pnl),
          fundingAmount: isFunding ? parseOptionalDecimal(b.balChg) : null,
          currency: b.ccy ? String(b.ccy) : 'USDT',
          occurredAt: Number(b.ts ?? Date.now())
        });
      }
      return {
        records,
        nextCursor: null,
        complete: true,
        supported: ['fills', 'fees', 'funding']
      };
    }
  };

  return adapter;
}
