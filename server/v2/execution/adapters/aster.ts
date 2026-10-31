import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
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

export const ASTER_CHAIN_ID: Record<Network, number> = {
  mainnet: 1666,
  testnet: 714
};

const ASTER_BASE_URL: Record<Network, string> = {
  mainnet: 'https://fapi.asterdex.com',
  testnet: 'https://fapi.asterdex-testnet.com'
};

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

let lastAsterNonce = 0;

export function nextAsterNonce(nowMs = Date.now()): number {
  lastAsterNonce = Math.max(lastAsterNonce + 1, nowMs * 1000);
  return lastAsterNonce;
}

export async function signAsterV3Query(input: {
  network: Network;
  userAddress: string;
  signerPrivateKey: string;
  params: Record<string, string | number | boolean | undefined>;
  nonce?: number;
}): Promise<{ msg: string; signature: Hex; query: string; signerAddress: string }> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.userAddress)) {
    throw new AdapterCapabilityError('Aster user must be a 0x40 public wallet address');
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.signerPrivateKey)) {
    throw new AdapterCapabilityError('Aster signer secret must be a 0x64 Pro API agent private key');
  }
  const account = privateKeyToAccount(input.signerPrivateKey as Hex);
  const nonce = input.nonce ?? nextAsterNonce();
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(input.params)) {
    if (v !== undefined) qs.append(k, String(v));
  }
  qs.append('asterChain', input.network === 'mainnet' ? 'Mainnet' : 'Testnet');
  qs.append('user', input.userAddress);
  qs.append('signer', account.address);
  qs.append('nonce', String(nonce));
  const msg = qs.toString();
  const signature = await account.signTypedData({
    domain: {
      name: 'AsterSignTransaction',
      version: '1',
      chainId: ASTER_CHAIN_ID[input.network],
      verifyingContract: ZERO_ADDRESS
    },
    types: {
      Message: [{ name: 'msg', type: 'string' }]
    },
    primaryType: 'Message',
    message: { msg }
  });
  return {
    msg,
    signature,
    query: `${msg}&signature=${signature}`,
    signerAddress: account.address
  };
}

function mapAsterOrderState(rawStatus: unknown): IntentState {
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
      throw new AdapterCapabilityError('ONE_WAY order must not specify hedgeLeg');
    }
    return 'BOTH';
  }
  if (hedgeLeg === 'LONG' || hedgeLeg === 'SHORT') return hedgeLeg;
  throw new AdapterCapabilityError('HEDGE order requires an explicit hedgeLeg');
}

export function createVenueAdapter(options: AdapterOptions): VenueAdapter {
  const base = ASTER_BASE_URL[options.network];

  async function loadCredentials(): Promise<{
    creds: DelegatedCredentials;
    signerAddress: string;
  }> {
    const creds = await options.readSecret(options.credentialRef);
    validateDelegatedCredentialInput({
      venue: 'aster',
      key: creds.key,
      secret: creds.secret,
      passphrase: creds.passphrase
    });
    if (!/^0x[0-9a-fA-F]{40}$/.test(creds.key.trim())) {
      throw new AdapterCapabilityError('Aster user key must be a 0x40 public wallet address');
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(creds.secret.trim())) {
      throw new AdapterCapabilityError('Aster signer secret must be a 0x64 Pro API agent private key');
    }
    const account = privateKeyToAccount(creds.secret.trim() as Hex);
    return {
      creds: { ...creds, key: creds.key.trim(), secret: creds.secret.trim() },
      signerAddress: account.address
    };
  }

  async function req(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params: Record<string, string | number | boolean | undefined> = {}
  ): Promise<unknown> {
    const { creds } = await loadCredentials();
    const { query } = await signAsterV3Query({
      network: options.network,
      userAddress: creds.key,
      signerPrivateKey: creds.secret,
      params
    });

    try {
      const json = await fetchVenueJson(options.fetchImpl, `${base}${path}?${query}`, {
        method,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      if (
        json &&
        typeof json === 'object' &&
        !Array.isArray(json) &&
        typeof (json as Record<string, unknown>).code === 'number' &&
        Number((json as Record<string, unknown>).code) < 0
      ) {
        const obj = json as Record<string, unknown>;
        throw new VenueTransportError(
          `aster ${path}: ${String(obj.msg ?? 'error')} (${String(obj.code)})`,
          Number(obj.code)
        );
      }
      return json;
    } catch (err) {
      const clean = scrubAdapterError(
        err instanceof Error ? err.message : String(err),
        [creds.secret, creds.passphrase]
      );
      const code = err instanceof VenueTransportError ? err.code : undefined;
      const retryable = err instanceof VenueTransportError ? err.retryable : false;
      throw new VenueTransportError(clean, code, retryable);
    }
  }

  const adapter: VenueAdapter = {
    venue: 'aster',
    network: options.network,
    status: VENUE_STATUS.aster,
    capabilities: {
      exchangeStops: true,
      restingLimitGtcEntry: true,
      hedgeMode: true,
      financialHistory: ['fills', 'fees', 'funding']
    },

    async permissions(): Promise<PermissionEvidence> {
      const { creds, signerAddress } = await loadCredentials();
      const observedAt = Date.now();
      if (signerAddress.toLowerCase() === creds.key.toLowerCase()) {
        return {
          ok: false,
          canTrade: true,
          canWithdraw: true,
          verified: true,
          delegatedOnly: false,
          detail: 'Refused main wallet private key: Aster requires a Pro API agent wallet key',
          observedAt
        };
      }

      let acct: Record<string, unknown>;
      try {
        acct = ((await req('GET', '/fapi/v3/account')) ?? {}) as Record<string, unknown>;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/no agent found/i.test(msg)) {
          return {
            ok: false,
            canTrade: false,
            canWithdraw: null,
            verified: true,
            delegatedOnly: true,
            detail: `Agent ${signerAddress} is not registered for ${creds.key}`,
            observedAt
          };
        }
        throw err;
      }

      const acctWithdraw =
        acct.canWithdraw === false ? false : acct.canWithdraw === true ? true : null;
      const acctTrade = acct.canTrade !== false;
      const baseDetail = `agent ${signerAddress} for ${creds.key}; account canTrade=${String(acct.canTrade)}, canWithdraw=${String(acct.canWithdraw)}`;

      if (acctWithdraw === false) {
        return {
          ok: acctTrade,
          canTrade: acctTrade,
          canWithdraw: false,
          verified: true,
          delegatedOnly: true,
          detail: baseDetail,
          observedAt
        };
      }

      const pinned = creds.verifiedAgentAddress?.trim() ?? '';
      if (!pinned || pinned.toLowerCase() !== signerAddress.toLowerCase()) {
        return {
          ok: false,
          canTrade: acctTrade,
          canWithdraw: acctWithdraw,
          verified: false,
          delegatedOnly: true,
          detail: `${baseDetail}; per-agent withdraw-off verification is not pinned for signer ${signerAddress}`,
          observedAt
        };
      }

      if (acct.canTrade !== true) {
        return {
          ok: false,
          canTrade: false,
          canWithdraw: acctWithdraw,
          verified: false,
          delegatedOnly: true,
          detail: `${baseDetail}; account does not report canTrade=true`,
          observedAt
        };
      }

      const agentsRaw = await req('GET', '/fapi/v3/agent');
      if (!Array.isArray(agentsRaw)) {
        return {
          ok: false,
          canTrade: acctTrade,
          canWithdraw: acctWithdraw,
          verified: false,
          delegatedOnly: true,
          detail: `${baseDetail}; /fapi/v3/agent response not readable`,
          observedAt
        };
      }
      const matches = (agentsRaw as Array<Record<string, unknown>>).filter(
        (a) =>
          typeof a.agentAddress === 'string' &&
          a.agentAddress.toLowerCase() === signerAddress.toLowerCase()
      );
      if (matches.length !== 1) {
        return {
          ok: false,
          canTrade: acctTrade,
          canWithdraw: acctWithdraw,
          verified: false,
          delegatedOnly: true,
          detail: `${baseDetail}; signer ${signerAddress} not uniquely found in /fapi/v3/agent`,
          observedAt
        };
      }
      const agentRec = matches[0]!;
      const agentWithdrawOff = agentRec.canWithdraw === false;
      const agentCanPerpTrade = agentRec.canPerpTrade === true;
      const notExpired = Number(agentRec.expired) > observedAt;

      if (!agentWithdrawOff || !agentCanPerpTrade || !notExpired) {
        return {
          ok: false,
          canTrade: agentCanPerpTrade,
          canWithdraw: agentRec.canWithdraw === false ? false : true,
          verified: true,
          delegatedOnly: true,
          detail: `${baseDetail}; agent record failed trade-only/expiry check`,
          observedAt
        };
      }

      return {
        ok: true,
        canTrade: true,
        canWithdraw: false,
        verified: true,
        delegatedOnly: true,
        detail: `${baseDetail}; verified per-agent canWithdraw=false and canPerpTrade=true`,
        observedAt
      };
    },

    async accountIdentity(): Promise<NativeAccountIdentity> {
      const { creds } = await loadCredentials();
      let positionMode: 'ONE_WAY' | 'HEDGE' = 'ONE_WAY';
      try {
        const dual = (await req('GET', '/fapi/v3/positionSide/dual')) as Record<string, unknown> | null;
        if (dual?.dualSidePosition === true || dual?.dualSidePosition === 'true') {
          positionMode = 'HEDGE';
        }
      } catch {
        // Default ONE_WAY if endpoint unsupported on fixture
      }
      return {
        venue: 'aster',
        network: options.network,
        publicAccountId: creds.key,
        subaccountRef: null,
        positionMode,
        observedAt: Date.now()
      };
    },

    async balance(): Promise<NativeBalance> {
      const r = ((await req('GET', '/fapi/v3/account')) ?? {}) as Record<string, unknown>;
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
        `${base}/fapi/v3/exchangeInfo`
      )) ?? {}) as Record<string, unknown>;
      const symbols = Array.isArray(info.symbols)
        ? (info.symbols as Array<Record<string, unknown>>)
        : [];
      const row = symbols.find((s) => s.symbol === symbol);
      if (!row) {
        throw new VenueTransportError(`aster: unknown symbol ${symbol}`);
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
        throw new VenueTransportError(`aster: incomplete filters for ${symbol}`);
      }
      if (compareDecimals(minQty, qtyStep) < 0) {
        minQty = qtyStep;
      }

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
        restingLimitGtcEntry: true
      };
    },

    async quote(symbol: string): Promise<VenueQuote> {
      const r = ((await fetchVenueJson(
        options.fetchImpl,
        `${base}/fapi/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`
      )) ?? {}) as Record<string, unknown>;
      const observedAt = Date.now();
      const last = parsePositiveDecimalOrNull(r.price);
      if (!last) {
        throw new VenueTransportError(`aster: missing price for ${symbol}`);
      }
      const sourceAt = Number.isFinite(Number(r.time)) ? Number(r.time) : null;
      return {
        symbol,
        last,
        bid: parsePositiveDecimalOrNull(r.bidPrice),
        ask: parsePositiveDecimalOrNull(r.askPrice),
        sourceAt,
        observedAt,
        ageMs: sourceAt !== null ? Math.max(0, observedAt - sourceAt) : null
      };
    },

    async positions(): Promise<NativePosition[]> {
      const raw = await req('GET', '/fapi/v3/positionRisk');
      if (!Array.isArray(raw)) {
        throw new VenueTransportError('aster: invalid positionRisk payload');
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
      if (
        intent.orderType === 'LIMIT_GTC' &&
        intent.expireAt !== null &&
        intent.expireAt <= Date.now()
      ) {
        throw new AdapterCapabilityError('Invalid or already-expired LIMIT_GTC expiration');
      }
      const [rules, currentQuote] = await Promise.all([
        adapter.instruments(intent.symbol),
        adapter.quote(intent.symbol)
      ]);
      const prepared = prepareNativeOrderQuantities(intent, rules, currentQuote.last);
      const posSide = positionSideForOrder(intent.positionMode, intent.hedgeLeg);

      await req('POST', '/fapi/v3/leverage', {
        symbol: rules.nativeSymbol,
        leverage: Math.round(intent.leverage)
      });

      const orderParams: Record<string, string | number | boolean | undefined> = {
        symbol: rules.nativeSymbol,
        side: intent.side === 'LONG' ? 'BUY' : 'SELL',
        positionSide: posSide === 'BOTH' ? undefined : posSide,
        type: intent.orderType === 'LIMIT_GTC' ? 'LIMIT' : 'MARKET',
        timeInForce: intent.orderType === 'LIMIT_GTC' ? 'GTC' : undefined,
        quantity: prepared.quantity,
        price: intent.orderType === 'LIMIT_GTC' ? (prepared.limitPrice ?? undefined) : undefined,
        newClientOrderId: intent.clientOrderId
      };

      const created = ((await req('POST', '/fapi/v3/order', orderParams)) ?? {}) as Record<
        string,
        unknown
      >;
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
        const r = ((await req('GET', '/fapi/v3/order', {
          symbol,
          origClientOrderId: clientOrderId
        })) ?? {}) as Record<string, unknown>;
        const observedAt = Date.now();
        const state = mapAsterOrderState(r.status);
        const execQty = parseOptionalDecimal(r.executedQty);
        const avgPx = parsePositiveDecimalOrNull(r.avgPrice);
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
          avgFillPrice: avgPx,
          observedAt,
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
            reason: 'Order does not exist on venue'
          };
        }
        throw err;
      }
    },

    async cancelEntry(symbol: string, clientOrderId: string): Promise<NativeOrderReceipt> {
      try {
        await req('DELETE', '/fapi/v3/order', {
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
      const raw = await req('GET', '/fapi/v3/openOrders', { symbol: position.nativeSymbol });
      if (!Array.isArray(raw)) {
        throw new VenueTransportError('aster: invalid openOrders response');
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

      await req('POST', '/fapi/v3/order', {
        symbol: position.nativeSymbol,
        side: exitSide,
        positionSide: posSide === 'BOTH' ? undefined : posSide,
        type: 'STOP_MARKET',
        stopPrice: quantizedStop,
        closePosition: 'true',
        workingType,
        newClientOrderId: `${protection.clientOrderId}s`
      });

      if (protection.tpPrice) {
        const quantizedTp = quantize(
          protection.tpPrice,
          rules.tickSize,
          position.side === 'LONG' ? 'ceil' : 'floor'
        );
        await req('POST', '/fapi/v3/order', {
          symbol: position.nativeSymbol,
          side: exitSide,
          positionSide: posSide === 'BOTH' ? undefined : posSide,
          type: 'TAKE_PROFIT_MARKET',
          stopPrice: quantizedTp,
          closePosition: 'true',
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
      const created = ((await req('POST', '/fapi/v3/order', {
        symbol: position.nativeSymbol,
        side: position.side === 'LONG' ? 'SELL' : 'BUY',
        positionSide: posSide === 'BOTH' ? undefined : posSide,
        type: 'MARKET',
        quantity: qty,
        reduceOnly: posSide === 'BOTH' ? 'true' : undefined,
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
      const raw = await req('GET', '/fapi/v3/income', { limit: 1000 });
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
          id: `aster:${id}`,
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
