import { ed25519 } from '@noble/curves/ed25519.js';
import { base58 } from '@scure/base';
import type { DecimalString, IntentState, Network } from '../../contracts.js';
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

const BASE_URL: Record<Network, string> = {
  mainnet: 'https://api.orderly.org',
  testnet: 'https://testnet-api.orderly.org'
};

const ALLOWED_SCOPES = new Set(['read', 'trading']);

export const orderlySymbol = (symbol: string): string =>
  `PERP_${symbol.replace(/USDT?$|USDC$/i, '')}_USDC`;
export const fromOrderlySymbol = (s: string): string =>
  `${s.replace(/^PERP_/, '').replace(/_USDC$/, '')}USDT`;

export function parseOrderlySecret(secret: string): Uint8Array {
  const s = secret.trim().replace(/^ed25519:/, '');
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(s)) {
    throw new AdapterCapabilityError(
      'Refused EVM wallet private key: Orderly requires an ed25519 base58 Orderly key secret'
    );
  }
  let b: Uint8Array;
  try {
    b = base58.decode(s);
  } catch {
    throw new AdapterCapabilityError('Orderly key secret must be base58 ed25519');
  }
  if (b.length === 64) b = b.slice(0, 32);
  if (b.length !== 32) {
    throw new AdapterCapabilityError('Orderly key secret must decode to 32 bytes');
  }
  return b;
}

export function signOrderlyRequest(input: {
  timestamp: number;
  method: string;
  pathWithQuery: string;
  body: string;
  secret: Uint8Array;
}): { message: string; signature: string } {
  const message = `${input.timestamp}${input.method.toUpperCase()}${input.pathWithQuery}${input.body}`;
  const sigBytes = ed25519.sign(new TextEncoder().encode(message), input.secret);
  return {
    message,
    signature: Buffer.from(sigBytes).toString('base64url')
  };
}

function mapOrderlyOrderState(rawStatus: unknown, hasFills: boolean): IntentState {
  const s = typeof rawStatus === 'string' ? rawStatus.toUpperCase() : '';
  if (s === 'FILLED') return 'FILLED';
  if (s === 'PARTIAL_FILLED') return 'PARTIAL';
  if (s === 'NEW') return hasFills ? 'PARTIAL' : 'ACCEPTED';
  if (s === 'CANCELLED') return 'CANCELLED';
  if (s === 'REJECTED') return 'REJECTED';
  return hasFills ? 'PARTIAL' : 'UNKNOWN';
}

export function createVenueAdapter(options: AdapterOptions): VenueAdapter {
  const base = BASE_URL[options.network];

  async function loadCredentials(): Promise<{
    creds: DelegatedCredentials;
    secretBytes: Uint8Array;
    orderlyKey: string;
  }> {
    const creds = await options.readSecret(options.credentialRef);
    validateDelegatedCredentialInput({
      venue: 'orderly',
      key: creds.key,
      secret: creds.secret,
      passphrase: creds.passphrase
    });
    if (!/^0x[0-9a-fA-F]{64}$/.test(creds.key.trim())) {
      throw new AdapterCapabilityError('Orderly account id must be a 0x 32-byte hex string');
    }
    const secretBytes = parseOrderlySecret(creds.secret);
    const pubKeyBytes = ed25519.getPublicKey(secretBytes);
    const orderlyKey = `ed25519:${base58.encode(pubKeyBytes)}`;
    return {
      creds: { ...creds, key: creds.key.trim(), secret: creds.secret.trim() },
      secretBytes,
      orderlyKey
    };
  }

  async function req(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: Record<string, unknown>
  ): Promise<unknown> {
    const { creds, secretBytes, orderlyKey } = await loadCredentials();
    const ts = Date.now();
    const jsonBody = body ? JSON.stringify(body) : '';
    const { signature } = signOrderlyRequest({
      timestamp: ts,
      method,
      pathWithQuery: path,
      body: jsonBody,
      secret: secretBytes
    });

    try {
      const res = ((await fetchVenueJson(options.fetchImpl, `${base}${path}`, {
        method,
        body: jsonBody || undefined,
        headers: {
          'Content-Type':
            method === 'POST'
              ? 'application/json'
              : 'application/x-www-form-urlencoded',
          'orderly-account-id': creds.key,
          'orderly-key': orderlyKey,
          'orderly-timestamp': String(ts),
          'orderly-signature': signature
        }
      })) ?? {}) as Record<string, unknown>;

      if (res.success === false) {
        throw new VenueTransportError(
          `orderly ${path.split('?')[0]}: ${String(res.message ?? 'error')} (${String(res.code ?? '?')})`,
          String(res.code ?? '?')
        );
      }
      return res.data;
    } catch (err) {
      throw new VenueTransportError(
        scrubAdapterError(err instanceof Error ? err.message : String(err), [creds.secret]),
        err instanceof VenueTransportError ? err.code : undefined,
        err instanceof VenueTransportError ? err.retryable : false
      );
    }
  }

  async function pub(path: string): Promise<unknown> {
    try {
      const res = ((await fetchVenueJson(options.fetchImpl, `${base}${path}`)) ?? {}) as Record<
        string,
        unknown
      >;
      if (res.success === false) {
        throw new VenueTransportError(
          `orderly ${path}: ${String(res.message ?? 'error')}`
        );
      }
      return res.data;
    } catch (err) {
      throw new VenueTransportError(
        scrubAdapterError(err instanceof Error ? err.message : String(err))
      );
    }
  }

  const adapter: VenueAdapter = {
    venue: 'orderly',
    network: options.network,
    status: VENUE_STATUS.orderly,
    capabilities: {
      exchangeStops: true,
      restingLimitGtcEntry: false,
      hedgeMode: false,
      financialHistory: ['fills', 'fees', 'funding']
    },

    async permissions(): Promise<PermissionEvidence> {
      const { orderlyKey } = await loadCredentials();
      const d = ((await req('GET', '/v1/client/key_info')) ?? {}) as Record<string, unknown>;
      const rows = Array.isArray(d.rows) ? (d.rows as Array<Record<string, unknown>>) : [];
      const row = rows.find((r) => r.orderly_key === orderlyKey);
      const observedAt = Date.now();
      if (!row) {
        return {
          ok: false,
          canTrade: false,
          canWithdraw: null,
          verified: true,
          delegatedOnly: true,
          detail: 'Orderly key is not registered on this account',
          observedAt
        };
      }
      if (row.key_status && row.key_status !== 'ACTIVE') {
        return {
          ok: false,
          canTrade: false,
          canWithdraw: false,
          verified: true,
          delegatedOnly: true,
          detail: `Orderly key status is ${String(row.key_status)}`,
          observedAt
        };
      }
      if (row.expiration && Number(row.expiration) < observedAt) {
        return {
          ok: false,
          canTrade: false,
          canWithdraw: false,
          verified: true,
          delegatedOnly: true,
          detail: 'Orderly key is expired',
          observedAt
        };
      }
      const scopes = String(row.scope ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const extra = scopes.filter((s) => !ALLOWED_SCOPES.has(s));
      if (extra.length > 0) {
        return {
          ok: false,
          canTrade: scopes.includes('trading'),
          canWithdraw: true,
          verified: true,
          delegatedOnly: false,
          detail: `Orderly key has scopes beyond read,trading: ${extra.join(', ')}`,
          observedAt
        };
      }
      const canTrade = scopes.includes('trading');
      return {
        ok: canTrade,
        canTrade,
        canWithdraw: false,
        verified: true,
        delegatedOnly: true,
        detail: `Orderly key scope=${scopes.join(',')}; Orderly keys cannot withdraw without wallet signature`,
        observedAt
      };
    },

    async accountIdentity(): Promise<NativeAccountIdentity> {
      const { creds } = await loadCredentials();
      return {
        venue: 'orderly',
        network: options.network,
        publicAccountId: creds.key,
        subaccountRef: null,
        positionMode: 'ONE_WAY',
        observedAt: Date.now()
      };
    },

    async balance(): Promise<NativeBalance> {
      const d = ((await req('GET', '/v1/positions')) ?? {}) as Record<string, unknown>;
      const observedAt = Date.now();
      const equity = parseOptionalDecimal(d.total_collateral_value);
      const available = parseOptionalDecimal(d.free_collateral);
      return {
        settlementCurrency: 'USDC',
        equity,
        available,
        realizedDailyPnl: null,
        observedAt,
        availability: equity && available ? 'AVAILABLE' : 'UNAVAILABLE'
      };
    },

    async instruments(symbol: string): Promise<NativeRules> {
      const sym = orderlySymbol(symbol);
      const d = ((await pub(`/v1/public/info/${sym}`)) ?? {}) as Record<string, unknown>;
      const step = parsePositiveDecimalOrNull(d.base_tick);
      const minQty = parsePositiveDecimalOrNull(d.base_min);
      const tick = parsePositiveDecimalOrNull(d.quote_tick);
      if (!step || !tick) {
        throw new VenueTransportError(`orderly: missing base_tick or quote_tick for ${sym}`);
      }
      const effectiveMin = minQty && compareDecimals(minQty, step) > 0 ? minQty : step;
      return {
        symbol,
        nativeSymbol: sym,
        tickSize: tick,
        qtyStep: step,
        minQty: effectiveMin,
        maxQty: parsePositiveDecimalOrNull(d.base_max),
        minNotional: parsePositiveDecimalOrNull(d.min_notional),
        contractMultiplier: '1',
        settlementCurrency: 'USDC',
        positionModeCapability: 'ONE_WAY',
        exchangeStops: true,
        restingLimitGtcEntry: false
      };
    },

    async quote(symbol: string): Promise<VenueQuote> {
      const sym = orderlySymbol(symbol);
      const d = ((await pub(`/v1/public/futures/${sym}`)) ?? {}) as Record<string, unknown>;
      const last = parsePositiveDecimalOrNull(d.mark_price ?? d.index_price);
      if (!last) {
        throw new VenueTransportError(`orderly: missing mark_price for ${sym}`);
      }
      return {
        symbol,
        last,
        bid: null,
        ask: null,
        sourceAt: null,
        observedAt: Date.now(),
        ageMs: null
      };
    },

    async positions(): Promise<NativePosition[]> {
      const d = ((await req('GET', '/v1/positions')) ?? {}) as Record<string, unknown>;
      const rows = Array.isArray(d.rows) ? (d.rows as Array<Record<string, unknown>>) : [];
      const observedAt = Date.now();
      const out: NativePosition[] = [];
      for (const p of rows) {
        const qty = parseOptionalDecimal(p.position_qty);
        if (!qty || compareDecimals(qty, '0') === 0) continue;
        const isNeg = compareDecimals(qty, '0') < 0;
        const absQty = isNeg ? qty.slice(1) : qty;
        const sym = fromOrderlySymbol(String(p.symbol ?? ''));
        const entryPx = parsePositiveDecimalOrNull(p.average_open_price);
        if (!entryPx) continue;
        out.push({
          positionKey: `${sym}:ONE_WAY:NET`,
          nativePositionId: String(p.symbol ?? sym),
          symbol: sym,
          nativeSymbol: String(p.symbol ?? sym),
          positionMode: 'ONE_WAY',
          hedgeLeg: null,
          side: isNeg ? 'SHORT' : 'LONG',
          qty: absQty,
          entryPrice: entryPx,
          leverage: null,
          unrealizedPnl: parseOptionalDecimal(p.unsettled_pnl),
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
      const res = ((await req('POST', '/v1/order', {
        symbol: rules.nativeSymbol,
        client_order_id: intent.clientOrderId,
        order_type: 'MARKET',
        order_quantity: prepared.quantity,
        side: intent.side === 'LONG' ? 'BUY' : 'SELL'
      })) ?? {}) as Record<string, unknown>;

      return {
        clientOrderId: intent.clientOrderId,
        venueOrderId: res.order_id ? String(res.order_id) : null,
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
        const d = ((await req(
          'GET',
          `/v1/client/order/${encodeURIComponent(clientOrderId)}`
        )) ?? {}) as Record<string, unknown>;
        const observedAt = Date.now();
        if (!d || !d.order_id) {
          return {
            clientOrderId,
            venueOrderId: null,
            symbol,
            state: 'UNKNOWN',
            filledQty: null,
            avgFillPrice: null,
            observedAt,
            reason: 'Order not found on Orderly'
          };
        }
        const filled = parseOptionalDecimal(d.total_executed_quantity ?? d.executed_quantity);
        const hasFills = Boolean(filled && compareDecimals(filled, '0') > 0);
        const state = mapOrderlyOrderState(d.status, hasFills);
        return {
          clientOrderId,
          venueOrderId: String(d.order_id),
          symbol,
          state,
          filledQty: hasFills ? filled : null,
          avgFillPrice: parsePositiveDecimalOrNull(d.average_executed_price),
          observedAt,
          reason: null
        };
      } catch (err) {
        return {
          clientOrderId,
          venueOrderId: null,
          symbol,
          state: 'UNKNOWN',
          filledQty: null,
          avgFillPrice: null,
          observedAt: Date.now(),
          reason: err instanceof Error ? err.message : 'Orderly lookup failed'
        };
      }
    },

    async cancelEntry(symbol: string, clientOrderId: string): Promise<NativeOrderReceipt> {
      try {
        await req('DELETE', `/v1/client/order/${encodeURIComponent(clientOrderId)}`);
      } catch (err) {
        if (!(err instanceof VenueTransportError)) throw err;
      }
      return adapter.lookupOrder(symbol, clientOrderId);
    },

    async protection(position: NativePosition): Promise<ProtectionEvidence> {
      const d = ((await req(
        'GET',
        `/v1/algo/orders?symbol=${position.nativeSymbol}&status=INCOMPLETE`
      )) ?? {}) as Record<string, unknown>;
      const rows: Array<Record<string, unknown>> = [];
      const walk = (items: unknown[]) => {
        for (const it of items) {
          if (!it || typeof it !== 'object') continue;
          rows.push(it as Record<string, unknown>);
          if (Array.isArray((it as Record<string, unknown>).child_orders)) {
            walk((it as Record<string, unknown>).child_orders as unknown[]);
          }
        }
      };
      walk(Array.isArray(d.rows) ? (d.rows as unknown[]) : []);

      const observedAt = Date.now();
      const exitSide = position.side === 'LONG' ? 'SELL' : 'BUY';

      let stopPrice: DecimalString | null = null;
      let tpPrice: DecimalString | null = null;
      let netPositionBound = false;
      let reduceOnlyOrPositionBound = false;
      let coveredQty: DecimalString = '0';

      for (const a of rows) {
        if (String(a.side ?? '').toUpperCase() !== exitSide) continue;
        const trigPx = parsePositiveDecimalOrNull(a.trigger_price);
        const algoType = String(a.algo_type ?? '').toUpperCase();
        const ordType = String(a.type ?? '').toUpperCase();
        const closePos = ordType === 'CLOSE_POSITION' || a.algo_type === 'POSITIONAL_TP_SL';
        const reduceOnly = closePos || a.reduce_only === true || a.reduce_only === 'true';

        if (algoType.includes('STOP') && trigPx) {
          if (!stopPrice) stopPrice = trigPx;
          if (closePos) {
            netPositionBound = true;
            reduceOnlyOrPositionBound = true;
          } else if (reduceOnly) {
            reduceOnlyOrPositionBound = true;
            const q = parsePositiveDecimalOrNull(a.quantity);
            if (q) coveredQty = addDecimals(coveredQty, q);
          }
        } else if (algoType.includes('TAKE_PROFIT') && trigPx && !tpPrice) {
          tpPrice = trigPx;
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
      const rules = await adapter.instruments(position.symbol);
      const exitSide = position.side === 'LONG' ? 'SELL' : 'BUY';
      const stopChild = {
        symbol: rules.nativeSymbol,
        algo_type: 'STOP_LOSS',
        side: exitSide,
        type: 'CLOSE_POSITION',
        trigger_price_type: 'MARK_PRICE',
        trigger_price: quantize(protection.stopPrice, rules.tickSize, 'floor'),
        reduce_only: true
      };
      const children: Array<Record<string, unknown>> = [stopChild];
      if (protection.tpPrice) {
        children.push({
          symbol: rules.nativeSymbol,
          algo_type: 'TAKE_PROFIT',
          side: exitSide,
          type: 'CLOSE_POSITION',
          trigger_price_type: 'MARK_PRICE',
          trigger_price: quantize(protection.tpPrice, rules.tickSize, 'ceil'),
          reduce_only: true
        });
      }

      await req('POST', '/v1/algo/order', {
        symbol: rules.nativeSymbol,
        algo_type: 'POSITIONAL_TP_SL',
        trigger_price_type: 'MARK_PRICE',
        child_orders: children
      });

      return adapter.protection(position);
    },

    async close(position: NativePosition, clientOrderId: string): Promise<NativeOrderReceipt> {
      const rules = await adapter.instruments(position.symbol);
      const exitSide = position.side === 'LONG' ? 'SELL' : 'BUY';
      const res = ((await req('POST', '/v1/order', {
        symbol: rules.nativeSymbol,
        client_order_id: clientOrderId,
        order_type: 'MARKET',
        order_quantity: quantize(position.qty, rules.qtyStep, 'floor'),
        side: exitSide,
        reduce_only: true
      })) ?? {}) as Record<string, unknown>;

      return {
        clientOrderId,
        venueOrderId: res.order_id ? String(res.order_id) : null,
        symbol: position.symbol,
        state: 'ACCEPTED',
        filledQty: null,
        avgFillPrice: null,
        observedAt: Date.now(),
        reason: null
      };
    },

    async financialHistory(_cursor: string | null): Promise<FinancialPage> {
      const d = ((await req('GET', '/v1/trades')) ?? {}) as Record<string, unknown>;
      const rows = Array.isArray(d.rows) ? (d.rows as Array<Record<string, unknown>>) : [];
      const records: NativeFinancialRecord[] = [];
      for (const t of rows) {
        const id = String(t.id ?? '');
        if (!id) continue;
        const sideRaw = String(t.side ?? '').toUpperCase();
        records.push({
          id: `ord-fill:${id}`,
          kind: 'fill',
          symbol: t.symbol ? fromOrderlySymbol(String(t.symbol)) : null,
          side: sideRaw === 'BUY' ? 'LONG' : sideRaw === 'SELL' ? 'SHORT' : null,
          qty: parseOptionalDecimal(t.executed_quantity),
          price: parseOptionalDecimal(t.executed_price),
          feeAmount: parseOptionalDecimal(t.fee),
          feeCurrency: t.fee_asset ? String(t.fee_asset) : 'USDC',
          realizedPnl: parseOptionalDecimal(t.realized_pnl),
          fundingAmount: null,
          currency: 'USDC',
          occurredAt: Number(t.executed_timestamp ?? Date.now())
        });
      }
      return {
        records,
        nextCursor: null,
        complete: true,
        supported: ['fills', 'fees']
      };
    }
  };

  return adapter;
}
