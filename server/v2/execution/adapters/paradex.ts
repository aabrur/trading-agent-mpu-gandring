import { ec, shortString, typedData } from 'starknet';
import type { DecimalString, IntentState, Network } from '../../contracts.js';
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

const BASE_URL: Record<Network, string> = {
  mainnet: 'https://api.prod.paradex.trade/v1',
  testnet: 'https://api.testnet.paradex.trade/v1'
};

const DOMAIN_TYPES = [
  { name: 'name', type: 'felt' },
  { name: 'chainId', type: 'felt' },
  { name: 'version', type: 'felt' }
];

export const paradexMarket = (symbol: string): string =>
  `${symbol.replace(/USDT?$|USDC$/i, '')}-USD-PERP`;
export const fromParadexMarket = (m: string): string => `${m.replace(/-USD-PERP$/i, '')}USDT`;

export function chainNumber(v: number): string {
  return BigInt(Math.round(v * 1e8)).toString();
}

function mapParadexOrderState(
  status: string,
  filledQty: DecimalString,
  totalQty: DecimalString
): IntentState {
  const s = status.toUpperCase();
  if (s === 'CLOSED') {
    if (compareDecimals(filledQty, totalQty) >= 0 && compareDecimals(filledQty, '0') > 0) {
      return 'FILLED';
    }
    return compareDecimals(filledQty, '0') > 0 ? 'PARTIAL' : 'CANCELLED';
  }
  if (s === 'NEW' || s === 'OPEN' || s === 'UNTRIGGERED') {
    return compareDecimals(filledQty, '0') > 0 ? 'PARTIAL' : 'ACCEPTED';
  }
  return compareDecimals(filledQty, '0') > 0 ? 'PARTIAL' : 'UNKNOWN';
}

export function createVenueAdapter(options: AdapterOptions): VenueAdapter {
  const base = BASE_URL[options.network];
  let chainId: string | null = null;
  let jwtToken: { token: string; until: number } | null = null;

  async function loadCredentials(): Promise<{
    creds: DelegatedCredentials;
    subkey: string;
    subkeyPublic: string;
  }> {
    const creds = await options.readSecret(options.credentialRef);
    validateDelegatedCredentialInput({
      venue: 'paradex',
      key: creds.key,
      secret: creds.secret,
      passphrase: creds.passphrase
    });
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(creds.key.trim())) {
      throw new AdapterCapabilityError('Paradex account must be a 0x hex address');
    }
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(creds.secret.trim())) {
      throw new AdapterCapabilityError('Paradex subkey must be a 0x hex Starknet private key');
    }
    const cleanSubkey = `0x${creds.secret.trim().slice(2).padStart(64, '0')}`;
    let subkeyPublic = '';
    try {
      subkeyPublic = ec.starkCurve.getStarkKey(cleanSubkey);
    } catch {
      if (creds.secret.trim().toLowerCase() === creds.key.trim().toLowerCase()) {
        subkeyPublic = '0x0';
      } else {
        throw new AdapterCapabilityError('Invalid Paradex Starknet subkey private key');
      }
    }
    return {
      creds: { ...creds, key: creds.key.trim(), secret: cleanSubkey },
      subkey: cleanSubkey,
      subkeyPublic
    };
  }

  async function getChainId(): Promise<string> {
    if (chainId) return chainId;
    try {
      const c = ((await fetchVenueJson(options.fetchImpl, `${base}/system/config`)) ?? {}) as Record<
        string,
        unknown
      >;
      if (!c.starknet_chain_id) {
        throw new VenueTransportError('paradex: missing starknet_chain_id in system config');
      }
      chainId = shortString.encodeShortString(String(c.starknet_chain_id));
      return chainId;
    } catch (err) {
      throw new VenueTransportError(
        scrubAdapterError(err instanceof Error ? err.message : String(err))
      );
    }
  }

  async function signTyped(
    subkey: string,
    account: string,
    primaryType: string,
    fields: { name: string; type: string }[],
    message: Record<string, unknown>
  ): Promise<{ hash: string; signature: string }> {
    const cId = await getChainId();
    const td = {
      domain: { name: 'Paradex', chainId: cId, version: '1' },
      primaryType,
      types: { StarkNetDomain: DOMAIN_TYPES, [primaryType]: fields },
      message
    };
    const hash = typedData.getMessageHash(td as any, account);
    const sig = ec.starkCurve.sign(hash, subkey);
    return { hash, signature: `["${sig.r.toString()}","${sig.s.toString()}"]` };
  }

  async function authHeaders(subkey: string, account: string): Promise<Record<string, string>> {
    const now = Math.floor(Date.now() / 1000);
    const expiration = now + 30 * 60;
    const { signature } = await signTyped(
      subkey,
      account,
      'Request',
      [
        { name: 'method', type: 'felt' },
        { name: 'path', type: 'felt' },
        { name: 'body', type: 'felt' },
        { name: 'timestamp', type: 'felt' },
        { name: 'expiration', type: 'felt' }
      ],
      { method: 'POST', path: '/v1/auth', body: '', timestamp: now, expiration }
    );
    return {
      'PARADEX-STARKNET-ACCOUNT': account,
      'PARADEX-STARKNET-SIGNATURE': signature,
      'PARADEX-TIMESTAMP': String(now),
      'PARADEX-SIGNATURE-EXPIRATION': String(expiration)
    };
  }

  async function token(): Promise<string> {
    if (jwtToken && jwtToken.until > Date.now()) return jwtToken.token;
    const { creds, subkey, subkeyPublic } = await loadCredentials();
    const headers = await authHeaders(subkey, creds.key);
    try {
      const r = ((await fetchVenueJson(options.fetchImpl, `${base}/auth/${subkeyPublic}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' }
      })) ?? {}) as Record<string, unknown>;
      if (!r.jwt_token) {
        throw new VenueTransportError('paradex: missing jwt_token in auth response');
      }
      const tok = String(r.jwt_token);
      jwtToken = { token: tok, until: Date.now() + 3 * 60_000 };
      return tok;
    } catch (err) {
      throw new VenueTransportError(
        scrubAdapterError(err instanceof Error ? err.message : String(err), [creds.secret])
      );
    }
  }

  async function req(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: Record<string, unknown>
  ): Promise<unknown> {
    const tok = await token();
    try {
      return await fetchVenueJson(options.fetchImpl, `${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${tok}`,
          'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (err) {
      throw new VenueTransportError(
        scrubAdapterError(err instanceof Error ? err.message : String(err))
      );
    }
  }

  async function buildSignedOrderBody(o: {
    market: string;
    side: 'BUY' | 'SELL';
    type: 'MARKET' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
    size: number;
    clientId: string;
    trigger?: number;
    reduceOnly?: boolean;
  }): Promise<Record<string, unknown>> {
    const { creds, subkey } = await loadCredentials();
    const ts = Date.now();
    const { signature } = await signTyped(
      subkey,
      creds.key,
      'Order',
      [
        { name: 'timestamp', type: 'felt' },
        { name: 'market', type: 'felt' },
        { name: 'side', type: 'felt' },
        { name: 'orderType', type: 'felt' },
        { name: 'size', type: 'felt' },
        { name: 'price', type: 'felt' }
      ],
      {
        timestamp: String(ts),
        market: o.market,
        side: o.side === 'BUY' ? '1' : '2',
        orderType: o.type,
        size: chainNumber(o.size),
        price: '0'
      }
    );
    return {
      market: o.market,
      side: o.side,
      size: String(o.size),
      type: o.type,
      client_id: o.clientId,
      instruction: 'GTC',
      signature,
      signature_timestamp: ts,
      ...(o.trigger ? { trigger_price: String(o.trigger) } : {}),
      ...(o.reduceOnly ? { flags: ['REDUCE_ONLY'] } : {})
    };
  }

  const adapter: VenueAdapter = {
    venue: 'paradex',
    network: options.network,
    status: VENUE_STATUS.paradex,
    capabilities: {
      exchangeStops: true,
      restingLimitGtcEntry: false,
      hedgeMode: false,
      financialHistory: ['fills', 'fees', 'funding']
    },

    async permissions(): Promise<PermissionEvidence> {
      const { creds, subkeyPublic } = await loadCredentials();
      const observedAt = Date.now();
      if (creds.secret.toLowerCase() === creds.key.toLowerCase()) {
        return {
          ok: false,
          canTrade: true,
          canWithdraw: true,
          verified: true,
          delegatedOnly: false,
          detail: 'Refused main account key: Paradex requires a registered subkey',
          observedAt
        };
      }

      let sub: Record<string, unknown>;
      try {
        sub = ((await req('GET', `/account/keys/subkeys/${subkeyPublic}`)) ?? {}) as Record<
          string,
          unknown
        >;
      } catch (err) {
        return {
          ok: false,
          canTrade: false,
          canWithdraw: null,
          verified: true,
          delegatedOnly: true,
          detail: `Subkey is not registered on ${creds.key} (${err instanceof Error ? err.message : String(err)})`,
          observedAt
        };
      }

      if (!sub || (sub.public_key && BigInt(String(sub.public_key)) !== BigInt(subkeyPublic))) {
        return {
          ok: false,
          canTrade: false,
          canWithdraw: null,
          verified: true,
          delegatedOnly: true,
          detail: 'Subkey lookup did not match registered public key',
          observedAt
        };
      }
      if (Number(sub.revoked_at ?? 0) > 0 || /revoked/i.test(String(sub.state ?? ''))) {
        return {
          ok: false,
          canTrade: false,
          canWithdraw: false,
          verified: true,
          delegatedOnly: true,
          detail: 'Subkey is revoked on Paradex',
          observedAt
        };
      }

      return {
        ok: true,
        canTrade: true,
        canWithdraw: false,
        verified: true,
        delegatedOnly: true,
        detail: `Registered Paradex subkey (state=${String(sub.state ?? 'ACTIVE')}); subkeys cannot withdraw`,
        observedAt
      };
    },

    async accountIdentity(): Promise<NativeAccountIdentity> {
      const { creds } = await loadCredentials();
      return {
        venue: 'paradex',
        network: options.network,
        publicAccountId: creds.key,
        subaccountRef: null,
        positionMode: 'ONE_WAY',
        observedAt: Date.now()
      };
    },

    async balance(): Promise<NativeBalance> {
      const r = ((await req('GET', '/account')) ?? {}) as Record<string, unknown>;
      const observedAt = Date.now();
      const equity = parseOptionalDecimal(r.account_value);
      const available = parseOptionalDecimal(r.free_collateral);
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
      const mkt = paradexMarket(symbol);
      const r = ((await fetchVenueJson(options.fetchImpl, `${base}/markets?market=${mkt}`)) ??
        {}) as Record<string, unknown>;
      const results = Array.isArray(r.results)
        ? (r.results as Array<Record<string, unknown>>)
        : [];
      const m = results[0];
      if (!m) {
        throw new VenueTransportError(`paradex: unknown market ${mkt}`);
      }
      const step = parsePositiveDecimalOrNull(m.order_size_increment);
      const tick = parsePositiveDecimalOrNull(m.price_tick_size);
      if (!step || !tick) {
        throw new VenueTransportError(`paradex: missing filters for ${mkt}`);
      }
      return {
        symbol,
        nativeSymbol: mkt,
        tickSize: tick,
        qtyStep: step,
        minQty: step,
        maxQty: null,
        minNotional: parsePositiveDecimalOrNull(m.min_notional),
        contractMultiplier: '1',
        settlementCurrency: 'USDC',
        positionModeCapability: 'ONE_WAY',
        exchangeStops: true,
        restingLimitGtcEntry: false
      };
    },

    async quote(symbol: string): Promise<VenueQuote> {
      const mkt = paradexMarket(symbol);
      const r = ((await fetchVenueJson(
        options.fetchImpl,
        `${base}/markets/summary?market=${mkt}`
      )) ?? {}) as Record<string, unknown>;
      const results = Array.isArray(r.results)
        ? (r.results as Array<Record<string, unknown>>)
        : [];
      const m = results[0];
      const last = parsePositiveDecimalOrNull(m?.last_traded_price ?? m?.mark_price);
      if (!last) {
        throw new VenueTransportError(`paradex: missing price for ${mkt}`);
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
      const r = ((await req('GET', '/positions')) ?? {}) as Record<string, unknown>;
      const results = Array.isArray(r.results)
        ? (r.results as Array<Record<string, unknown>>)
        : [];
      const observedAt = Date.now();
      const out: NativePosition[] = [];
      for (const p of results) {
        if (String(p.status ?? '').toUpperCase() === 'CLOSED') continue;
        const sz = parseOptionalDecimal(p.size);
        if (!sz || compareDecimals(sz, '0') === 0) continue;
        const isNeg = compareDecimals(sz, '0') < 0;
        const absQty = isNeg ? sz.slice(1) : sz;
        const m = String(p.market ?? '');
        const sym = fromParadexMarket(m);
        const entryPx = parsePositiveDecimalOrNull(p.average_entry_price);
        if (!entryPx) continue;
        out.push({
          positionKey: `${sym}:ONE_WAY:NET`,
          nativePositionId: m,
          symbol: sym,
          nativeSymbol: m,
          positionMode: 'ONE_WAY',
          hedgeLeg: null,
          side: isNeg || String(p.side ?? '').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG',
          qty: absQty,
          entryPrice: entryPx,
          leverage: null,
          unrealizedPnl: parseOptionalDecimal(p.unrealized_pnl),
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
      const isBuy = intent.side === 'LONG';
      const body = await buildSignedOrderBody({
        market: rules.nativeSymbol,
        side: isBuy ? 'BUY' : 'SELL',
        type: 'MARKET',
        size: Number(prepared.quantity),
        clientId: intent.clientOrderId
      });
      const res = ((await req('POST', '/orders', body)) ?? {}) as Record<string, unknown>;

      return {
        clientOrderId: intent.clientOrderId,
        venueOrderId: res.id ? String(res.id) : null,
        symbol: intent.symbol,
        state: 'ACCEPTED',
        filledQty: null,
        avgFillPrice: null,
        observedAt: Date.now(),
        reason: null
      };
    },

    async lookupOrder(symbol: string, clientOrderId: string): Promise<NativeOrderReceipt> {
      const d = ((await req(
        'GET',
        `/orders/by_client_id/${encodeURIComponent(clientOrderId)}`
      )) ?? {}) as Record<string, unknown>;
      const observedAt = Date.now();
      if (!d || !d.id) {
        return {
          clientOrderId,
          venueOrderId: null,
          symbol,
          state: 'UNKNOWN',
          filledQty: null,
          avgFillPrice: null,
          observedAt,
          reason: 'Order not found on Paradex'
        };
      }
      const sz = parseOptionalDecimal(d.size) ?? '0';
      const rem = parseOptionalDecimal(d.remaining_size) ?? sz;
      const filledQty = compareDecimals(sz, rem) > 0 ? subDecimals(sz, rem) : '0';
      const state = mapParadexOrderState(String(d.status ?? ''), filledQty, sz);

      return {
        clientOrderId,
        venueOrderId: String(d.id),
        symbol,
        state,
        filledQty: compareDecimals(filledQty, '0') > 0 ? filledQty : null,
        avgFillPrice: parsePositiveDecimalOrNull(d.avg_fill_price),
        observedAt,
        reason: d.cancel_reason ? String(d.cancel_reason) : null
      };
    },

    async cancelEntry(symbol: string, clientOrderId: string): Promise<NativeOrderReceipt> {
      try {
        await req('DELETE', `/orders/by_client_id/${encodeURIComponent(clientOrderId)}`);
      } catch (err) {
        if (!(err instanceof VenueTransportError)) throw err;
      }
      return adapter.lookupOrder(symbol, clientOrderId);
    },

    async protection(position: NativePosition): Promise<ProtectionEvidence> {
      const r = ((await req('GET', `/orders?market=${position.nativeSymbol}`)) ?? {}) as Record<
        string,
        unknown
      >;
      const rows = Array.isArray(r.results)
        ? (r.results as Array<Record<string, unknown>>)
        : [];
      const observedAt = Date.now();
      const exitSide = position.side === 'LONG' ? 'SELL' : 'BUY';

      let stopPrice: DecimalString | null = null;
      let tpPrice: DecimalString | null = null;
      let coveredQty: DecimalString = '0';
      let reduceOnlyOrPositionBound = false;

      for (const o of rows) {
        if (String(o.side ?? '').toUpperCase() !== exitSide) continue;
        const trigPx = parsePositiveDecimalOrNull(o.trigger_price);
        const oType = String(o.type ?? '').toUpperCase();
        const flags = Array.isArray(o.flags) ? (o.flags as string[]) : [];
        const reduceOnly = flags.includes('REDUCE_ONLY');

        if (oType.includes('STOP') && trigPx) {
          if (!stopPrice) stopPrice = trigPx;
          if (reduceOnly) {
            reduceOnlyOrPositionBound = true;
            const sz = parsePositiveDecimalOrNull(o.size);
            if (sz) coveredQty = addDecimals(coveredQty, sz);
          }
        } else if (oType.includes('TAKE_PROFIT') && trigPx && !tpPrice) {
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
        observedAt
      });
    },

    async protect(
      position: NativePosition,
      protection: NativeProtection
    ): Promise<ProtectionEvidence> {
      const rules = await adapter.instruments(position.symbol);
      const exitSide = position.side === 'LONG' ? 'SELL' : 'BUY';
      const stopBody = await buildSignedOrderBody({
        market: rules.nativeSymbol,
        side: exitSide,
        type: 'STOP_MARKET',
        size: Number(position.qty),
        clientId: `${protection.clientOrderId}s`,
        trigger: Number(quantize(protection.stopPrice, rules.tickSize, 'floor')),
        reduceOnly: true
      });
      await req('POST', '/orders', stopBody);

      if (protection.tpPrice) {
        const tpBody = await buildSignedOrderBody({
          market: rules.nativeSymbol,
          side: exitSide,
          type: 'TAKE_PROFIT_MARKET',
          size: Number(position.qty),
          clientId: `${protection.clientOrderId}t`,
          trigger: Number(quantize(protection.tpPrice, rules.tickSize, 'ceil')),
          reduceOnly: true
        });
        await req('POST', '/orders', tpBody);
      }

      return adapter.protection(position);
    },

    async close(position: NativePosition, clientOrderId: string): Promise<NativeOrderReceipt> {
      const rules = await adapter.instruments(position.symbol);
      const exitSide = position.side === 'LONG' ? 'SELL' : 'BUY';
      const body = await buildSignedOrderBody({
        market: rules.nativeSymbol,
        side: exitSide,
        type: 'MARKET',
        size: Number(quantize(position.qty, rules.qtyStep, 'floor')),
        clientId: clientOrderId,
        reduceOnly: true
      });
      const res = ((await req('POST', '/orders', body)) ?? {}) as Record<string, unknown>;

      return {
        clientOrderId,
        venueOrderId: res.id ? String(res.id) : null,
        symbol: position.symbol,
        state: 'ACCEPTED',
        filledQty: null,
        avgFillPrice: null,
        observedAt: Date.now(),
        reason: null
      };
    },

    async financialHistory(_cursor: string | null): Promise<FinancialPage> {
      const r = ((await req('GET', '/fills')) ?? {}) as Record<string, unknown>;
      const results = Array.isArray(r.results)
        ? (r.results as Array<Record<string, unknown>>)
        : [];
      const records: NativeFinancialRecord[] = [];
      for (const f of results) {
        const id = String(f.id ?? '');
        if (!id) continue;
        const sideRaw = String(f.side ?? '').toUpperCase();
        records.push({
          id: `para-fill:${id}`,
          kind: 'fill',
          symbol: f.market ? fromParadexMarket(String(f.market)) : null,
          side: sideRaw === 'BUY' ? 'LONG' : sideRaw === 'SELL' ? 'SHORT' : null,
          qty: parseOptionalDecimal(f.size),
          price: parseOptionalDecimal(f.price),
          feeAmount: parseOptionalDecimal(f.fee),
          feeCurrency: f.fee_currency ? String(f.fee_currency) : 'USDC',
          realizedPnl: null,
          fundingAmount: null,
          currency: 'USDC',
          occurredAt: Number(f.created_at ?? Date.now())
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
