import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bech32 } from '@scure/base';
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

const INDEXER_URL: Record<Network, string> = {
  mainnet: 'https://indexer.dydx.trade/v4',
  testnet: 'https://indexer.v4testnet.dydx.exchange/v4'
};

const COND_GOOD_TIL_S = 28 * 24 * 3600;
const SLIPPAGE = 0.02;

export const TRADE_ONLY_MESSAGES = new Set([
  '/dydxprotocol.clob.MsgPlaceOrder',
  '/dydxprotocol.clob.MsgCancelOrder',
  '/dydxprotocol.clob.MsgBatchCancel'
]);

export const dydxMarket = (symbol: string): string =>
  `${symbol.replace(/USDT?$|USDC$/i, '')}-USD`;
export const fromDydxMarket = (m: string): string => `${m.replace(/-USD$/i, '')}USDT`;

export const dydxClientId = (clientId: string): number =>
  createHash('sha256').update(clientId).digest().readUInt32BE(0);

export function dydxAddressOf(privateKeyHex: string): { address: string; pubKey: Buffer } {
  const cleanKey = privateKeyHex.replace(/^0x/, '');
  const pub = secp256k1.getPublicKey(Buffer.from(cleanKey, 'hex'), true);
  const sha = createHash('sha256').update(pub).digest();
  const ripemd = createHash('ripemd160').update(sha).digest();
  return {
    address: bech32.encode('dydx', bech32.toWords(ripemd)),
    pubKey: Buffer.from(pub)
  };
}

export interface DydxAuthenticator {
  id: string;
  type: string;
  config: unknown;
}

export interface DydxOrderParams {
  market: string;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
  size: number;
  price: number;
  triggerPrice?: number;
  clientId: number;
  reduceOnly: boolean;
  goodTilTimeSec?: number;
}

export interface DydxCancelParams {
  market: string;
  clientId: number;
  orderFlags: number;
  goodTilBlock?: number;
  goodTilBlockTimeSec?: number;
}

export interface DydxChain {
  getAuthenticators(owner: string): Promise<DydxAuthenticator[]>;
  placeOrder(p: DydxOrderParams): Promise<{ txHash: string | null }>;
  cancelOrder(p: DydxCancelParams): Promise<void>;
}

function bytesOf(v: unknown): Buffer {
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (Array.isArray(v)) return Buffer.from(v as number[]);
  if (typeof v === 'string') {
    try {
      const b = Buffer.from(v, 'base64');
      if (b.toString('base64').replace(/=+$/, '') === v.replace(/=+$/, '')) return b;
    } catch {
      // plain string fallback
    }
    return Buffer.from(v, 'utf8');
  }
  return Buffer.alloc(0);
}

export interface FlatAuthenticator {
  types: string[];
  pubKeys: Buffer[];
  messages: string[];
  anyOf: boolean;
}

export function flattenAuthenticator(
  type: string,
  config: unknown,
  acc: FlatAuthenticator = { types: [], pubKeys: [], messages: [], anyOf: false }
): FlatAuthenticator {
  acc.types.push(type);
  if (type === 'AnyOf') acc.anyOf = true;
  if (type === 'AllOf' || type === 'AnyOf') {
    let subs: Array<Record<string, unknown>> = [];
    try {
      subs = JSON.parse(bytesOf(config).toString('utf8'));
    } catch {
      subs = [];
    }
    for (const s of subs) {
      flattenAuthenticator(String(s.type ?? s.Type), s.config ?? s.Config, acc);
    }
  } else if (type === 'SignatureVerification') {
    acc.pubKeys.push(bytesOf(config));
  } else if (type === 'MessageFilter') {
    acc.messages.push(
      ...bytesOf(config)
        .toString('utf8')
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean)
    );
  }
  return acc;
}

function mapDydxOrderState(rawStatus: unknown, filledSize: DecimalString): IntentState {
  const s = typeof rawStatus === 'string' ? rawStatus.toUpperCase() : '';
  if (s === 'FILLED') return 'FILLED';
  if (s === 'OPEN' || s === 'BEST_EFFORT_OPENED' || s === 'UNTRIGGERED') {
    return compareDecimals(filledSize, '0') > 0 ? 'PARTIAL' : 'ACCEPTED';
  }
  if (s === 'CANCELED' || s === 'BEST_EFFORT_CANCELED') return 'CANCELLED';
  return compareDecimals(filledSize, '0') > 0 ? 'PARTIAL' : 'UNKNOWN';
}

function sdkChain(
  network: Network,
  owner: string,
  apiKey: string,
  authenticatorId: string,
  subaccount: number
): DydxChain {
  let ctx: Promise<{ sdk: any; client: any; sub: any }> | null = null;
  const load = () =>
    (ctx ??= (async () => {
      let sdk: any;
      try {
        sdk = createRequire(import.meta.url)('@dydxprotocol/v4-client-js');
      } catch {
        throw new AdapterCapabilityError(
          'dYdX trading requires optional official SDK: run npm install @dydxprotocol/v4-client-js'
        );
      }
      const net =
        network === 'testnet'
          ? sdk.Network.testnet()
          : new sdk.Network(
              'mainnet',
              new sdk.IndexerConfig(sdk.IndexerApiHost.MAINNET, sdk.IndexerWSHost.MAINNET),
              new sdk.ValidatorConfig(
                sdk.ValidatorApiHost.MAINNET,
                'dydx-mainnet-1',
                {
                  CHAINTOKEN_DENOM: 'adydx',
                  USDC_DENOM:
                    'ibc/8E27BA2D5493AF5636760E354E46004562C46AB7EC0CC4C1CA14E9E20E2545B5',
                  USDC_GAS_DENOM: 'uusdc',
                  USDC_DECIMALS: 6,
                  CHAINTOKEN_DECIMALS: 18
                },
                undefined,
                'Trading Agent Mpu Gandring'
              )
            );
      const client = await sdk.CompositeClient.connect(net);
      const wallet = await sdk.LocalWallet.fromPrivateKey(apiKey.replace(/^0x/, ''), 'dydx');
      const sub = sdk.SubaccountInfo.forPermissionedWallet(wallet, owner, subaccount, [
        Number(authenticatorId)
      ]);
      return { sdk, client, sub };
    })());

  return {
    async getAuthenticators(addr) {
      const { client } = await load();
      const r = await client.validatorClient.get.getAuthenticators(addr);
      return (r?.accountAuthenticators ?? []).map((a: any) => ({
        id: String(a.id),
        type: String(a.type),
        config: a.config
      }));
    },
    async placeOrder(p) {
      const { sdk, client, sub } = await load();
      const isCond = p.type !== 'MARKET';
      const tx = await client.placeOrder(
        sub,
        p.market,
        sdk.OrderType[p.type],
        sdk.OrderSide[p.side],
        p.price,
        p.size,
        p.clientId,
        sdk.OrderTimeInForce.IOC,
        isCond ? p.goodTilTimeSec ?? COND_GOOD_TIL_S : 0,
        sdk.OrderExecution.IOC,
        false,
        p.reduceOnly,
        p.triggerPrice
      );
      return { txHash: tx?.hash ? Buffer.from(tx.hash).toString('hex') : null };
    },
    async cancelOrder(p) {
      const { client, sub } = await load();
      await client.cancelOrder(
        sub,
        p.clientId,
        p.orderFlags,
        p.market,
        p.goodTilBlock ?? 0,
        p.goodTilBlockTimeSec
          ? Math.max(0, p.goodTilBlockTimeSec - Math.floor(Date.now() / 1000))
          : 0
      );
    }
  };
}

export function createVenueAdapter(
  options: AdapterOptions & { chain?: DydxChain; subaccount?: number }
): VenueAdapter {
  const indexerBase = INDEXER_URL[options.network];
  const subaccount = options.subaccount ?? 0;

  async function loadCredentials(): Promise<{
    creds: DelegatedCredentials;
    apiAddress: string;
    pubKey: Buffer;
    authId: string;
  }> {
    const creds = await options.readSecret(options.credentialRef);
    validateDelegatedCredentialInput({
      venue: 'dydx',
      key: creds.key,
      secret: creds.secret,
      passphrase: creds.passphrase
    });
    if (!/^dydx1[02-9ac-hj-np-z]{38,58}$/.test(creds.key.trim())) {
      throw new AdapterCapabilityError('dYdX key must be the owner dydx1... address');
    }
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(creds.secret.trim())) {
      throw new AdapterCapabilityError(
        'dYdX secret must be a 64 hex char private key (from API Trading Keys)'
      );
    }
    const authId = creds.passphrase?.trim() ?? '0';
    const { address, pubKey } = dydxAddressOf(creds.secret.trim());
    return {
      creds: { ...creds, key: creds.key.trim(), secret: creds.secret.trim() },
      apiAddress: address,
      pubKey,
      authId
    };
  }

  function getChain(creds: DelegatedCredentials, authId?: string): DydxChain {
    if (options.chain) return options.chain;
    const finalAuthId = authId ?? creds.passphrase?.trim() ?? '0';
    return sdkChain(options.network, creds.key, creds.secret, finalAuthId, subaccount);
  }

  async function indexerGet(path: string): Promise<unknown> {
    try {
      return await fetchVenueJson(options.fetchImpl, `${indexerBase}${path}`);
    } catch (err) {
      throw new VenueTransportError(
        scrubAdapterError(err instanceof Error ? err.message : String(err))
      );
    }
  }

  async function marketInfo(symbol: string): Promise<Record<string, unknown>> {
    const ticker = dydxMarket(symbol);
    const r = ((await indexerGet(`/perpetualMarkets?ticker=${ticker}`)) ?? {}) as Record<
      string,
      unknown
    >;
    const markets = (r.markets ?? {}) as Record<string, unknown>;
    const m = markets[ticker] as Record<string, unknown> | undefined;
    if (!m) {
      throw new VenueTransportError(`dydx: unknown market ${ticker}`);
    }
    return m;
  }

  const adapter: VenueAdapter = {
    venue: 'dydx',
    network: options.network,
    status: VENUE_STATUS.dydx,
    capabilities: {
      exchangeStops: true,
      restingLimitGtcEntry: false,
      hedgeMode: false,
      financialHistory: ['fills', 'fees', 'funding']
    },

    async permissions(): Promise<PermissionEvidence> {
      const { creds, apiAddress, pubKey, authId } = await loadCredentials();
      const observedAt = Date.now();
      if (apiAddress.toLowerCase() === creds.key.toLowerCase()) {
        return {
          ok: false,
          canTrade: true,
          canWithdraw: true,
          verified: true,
          delegatedOnly: false,
          detail: 'Refused owner private key: dYdX requires an API Trading Key',
          observedAt
        };
      }

      const chain = getChain(creds, authId);
      const auths = await chain.getAuthenticators(creds.key);
      const a = auths.find((x) => String(x.id) === authId);
      if (!a) {
        return {
          ok: false,
          canTrade: false,
          canWithdraw: null,
          verified: true,
          delegatedOnly: true,
          detail: `Authenticator ${authId} not found on ${creds.key}`,
          observedAt
        };
      }

      const f = flattenAuthenticator(a.type, a.config);
      if (f.anyOf || a.type !== 'AllOf') {
        return {
          ok: false,
          canTrade: false,
          canWithdraw: null,
          verified: true,
          delegatedOnly: true,
          detail: `Authenticator ${a.id} is ${a.type}${f.anyOf ? ' with AnyOf' : ''}; trade-only cannot be proved`,
          observedAt
        };
      }
      if (!f.pubKeys.some((k) => k.equals(pubKey))) {
        return {
          ok: false,
          canTrade: false,
          canWithdraw: null,
          verified: true,
          delegatedOnly: true,
          detail: `Authenticator ${a.id} does not verify this key`,
          observedAt
        };
      }
      if (f.messages.length === 0) {
        return {
          ok: false,
          canTrade: true,
          canWithdraw: true,
          verified: true,
          delegatedOnly: false,
          detail: `Authenticator ${a.id} has no message filter (allows transfers)`,
          observedAt
        };
      }
      const wide = f.messages.filter((m) => !TRADE_ONLY_MESSAGES.has(m));
      if (wide.length > 0) {
        return {
          ok: false,
          canTrade: true,
          canWithdraw: true,
          verified: true,
          delegatedOnly: false,
          detail: `Authenticator ${a.id} allows non-trading messages: ${wide.join(', ')}`,
          observedAt
        };
      }

      return {
        ok: true,
        canTrade: f.messages.includes('/dydxprotocol.clob.MsgPlaceOrder'),
        canWithdraw: false,
        verified: true,
        delegatedOnly: true,
        detail: `Permissioned key ${apiAddress} with authenticator ${a.id}: trade-only verified`,
        observedAt
      };
    },

    async accountIdentity(): Promise<NativeAccountIdentity> {
      const { creds } = await loadCredentials();
      return {
        venue: 'dydx',
        network: options.network,
        publicAccountId: creds.key,
        subaccountRef: String(subaccount),
        positionMode: 'ONE_WAY',
        observedAt: Date.now()
      };
    },

    async balance(): Promise<NativeBalance> {
      const { creds } = await loadCredentials();
      const r = ((await indexerGet(
        `/addresses/${creds.key}/subaccountNumber/${subaccount}`
      )) ?? {}) as Record<string, unknown>;
      const observedAt = Date.now();
      const sub = (r.subaccount ?? {}) as Record<string, unknown>;
      const equity = parseOptionalDecimal(sub.equity);
      const available = parseOptionalDecimal(sub.freeCollateral);
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
      const m = await marketInfo(symbol);
      const step = parsePositiveDecimalOrNull(m.stepSize);
      const tick = parsePositiveDecimalOrNull(m.tickSize);
      if (!step || !tick) {
        throw new VenueTransportError(`dydx: missing stepSize or tickSize for ${symbol}`);
      }
      return {
        symbol,
        nativeSymbol: dydxMarket(symbol),
        tickSize: tick,
        qtyStep: step,
        minQty: step,
        maxQty: null,
        minNotional: null,
        contractMultiplier: '1',
        settlementCurrency: 'USDC',
        positionModeCapability: 'ONE_WAY',
        exchangeStops: true,
        restingLimitGtcEntry: false
      };
    },

    async quote(symbol: string): Promise<VenueQuote> {
      const m = await marketInfo(symbol);
      const last = parsePositiveDecimalOrNull(m.oraclePrice);
      if (!last) {
        throw new VenueTransportError(`dydx: missing oraclePrice for ${symbol}`);
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
      const { creds } = await loadCredentials();
      const r = ((await indexerGet(
        `/perpetualPositions?address=${creds.key}&subaccountNumber=${subaccount}&status=OPEN`
      )) ?? {}) as Record<string, unknown>;
      const rows = Array.isArray(r.positions)
        ? (r.positions as Array<Record<string, unknown>>)
        : [];
      const observedAt = Date.now();
      const out: NativePosition[] = [];
      for (const p of rows) {
        const sz = parseOptionalDecimal(p.size);
        if (!sz || compareDecimals(sz, '0') === 0) continue;
        const isNeg = compareDecimals(sz, '0') < 0;
        const absQty = isNeg ? sz.slice(1) : sz;
        const m = String(p.market ?? '');
        const sym = fromDydxMarket(m);
        const entryPx = parsePositiveDecimalOrNull(p.entryPrice);
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
          unrealizedPnl: parseOptionalDecimal(p.unrealizedPnl),
          observedAt
        });
      }
      return out;
    },

    async submit(intent: NativeOrder): Promise<NativeOrderReceipt> {
      const [rules, currentQuote, info] = await Promise.all([
        adapter.instruments(intent.symbol),
        adapter.quote(intent.symbol),
        loadCredentials()
      ]);
      const prepared = prepareNativeOrderQuantities(intent, rules, currentQuote.last);
      const chain = getChain(info.creds, info.authId);
      const isBuy = intent.side === 'LONG';
      const refPx = Number(currentQuote.last);
      const worstPx = isBuy ? refPx * (1 + SLIPPAGE) : refPx * (1 - SLIPPAGE);
      const numCid = dydxClientId(intent.clientOrderId);

      const r = await chain.placeOrder({
        market: rules.nativeSymbol,
        side: isBuy ? 'BUY' : 'SELL',
        type: 'MARKET',
        size: Number(prepared.quantity),
        price: worstPx,
        clientId: numCid,
        reduceOnly: false
      });

      return {
        clientOrderId: intent.clientOrderId,
        venueOrderId: r.txHash,
        symbol: intent.symbol,
        state: 'ACCEPTED',
        filledQty: null,
        avgFillPrice: null,
        observedAt: Date.now(),
        reason: null
      };
    },

    async lookupOrder(symbol: string, clientOrderId: string): Promise<NativeOrderReceipt> {
      const { creds } = await loadCredentials();
      const numCid = String(dydxClientId(clientOrderId));
      const ticker = dydxMarket(symbol);
      const rows = ((await indexerGet(
        `/orders?address=${creds.key}&subaccountNumber=${subaccount}&ticker=${ticker}&limit=100`
      )) ?? []) as Array<Record<string, unknown>>;
      const o = rows.find((x) => String(x.clientId) === numCid);
      const observedAt = Date.now();
      if (!o) {
        return {
          clientOrderId,
          venueOrderId: null,
          symbol,
          state: 'UNKNOWN',
          filledQty: null,
          avgFillPrice: null,
          observedAt,
          reason: 'Order not found on dYdX indexer'
        };
      }
      const filled = parseOptionalDecimal(o.totalFilled) ?? '0';
      const state = mapDydxOrderState(o.status, filled);

      let avgFillPrice: DecimalString | null = null;
      if (compareDecimals(filled, '0') > 0 && o.id) {
        const fillsWrap = ((await indexerGet(
          `/fills?address=${creds.key}&subaccountNumber=${subaccount}&market=${ticker}&marketType=PERPETUAL&limit=100`
        )) ?? {}) as Record<string, unknown>;
        const fillsList = Array.isArray(fillsWrap.fills)
          ? (fillsWrap.fills as Array<Record<string, unknown>>)
          : [];
        const mine = fillsList.filter((f) => String(f.orderId) === String(o.id));
        if (mine.length > 0) {
          const px = parsePositiveDecimalOrNull(mine[0]?.price);
          if (px) avgFillPrice = px;
        }
      }

      return {
        clientOrderId,
        venueOrderId: o.id ? String(o.id) : null,
        symbol,
        state,
        filledQty: compareDecimals(filled, '0') > 0 ? filled : null,
        avgFillPrice,
        observedAt,
        reason: null
      };
    },

    async cancelEntry(symbol: string, clientOrderId: string): Promise<NativeOrderReceipt> {
      const info = await loadCredentials();
      const numCid = dydxClientId(clientOrderId);
      const chain = getChain(info.creds, info.authId);
      try {
        await chain.cancelOrder({
          market: dydxMarket(symbol),
          clientId: numCid,
          orderFlags: 0
        });
      } catch (err) {
        if (!(err instanceof VenueTransportError)) throw err;
      }
      return adapter.lookupOrder(symbol, clientOrderId);
    },

    async protection(position: NativePosition): Promise<ProtectionEvidence> {
      const { creds } = await loadCredentials();
      const ticker = dydxMarket(position.symbol);
      const rows = ((await indexerGet(
        `/orders?address=${creds.key}&subaccountNumber=${subaccount}&ticker=${ticker}&limit=100&status=UNTRIGGERED`
      )) ?? []) as Array<Record<string, unknown>>;
      const observedAt = Date.now();
      const exitSide = position.side === 'LONG' ? 'SELL' : 'BUY';

      let stopPrice: DecimalString | null = null;
      let tpPrice: DecimalString | null = null;
      let coveredQty: DecimalString = '0';
      let reduceOnlyOrPositionBound = false;

      for (const o of rows) {
        if (String(o.side ?? '').toUpperCase() !== exitSide) continue;
        const trigPx = parsePositiveDecimalOrNull(o.triggerPrice);
        const oType = String(o.type ?? '').toUpperCase();
        const reduceOnly = o.reduceOnly === true || o.reduceOnly === 'true';
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
      const info = await loadCredentials();
      const rules = await adapter.instruments(position.symbol);
      const chain = getChain(info.creds, info.authId);
      const isExitBuy = position.side === 'SHORT';
      const tick = Number(rules.tickSize);
      const stopPx = Number(protection.stopPrice);
      const worstStop = isExitBuy ? stopPx * (1 + SLIPPAGE) : stopPx * (1 - SLIPPAGE);
      const numCid = dydxClientId(`${protection.clientOrderId}s`);

      await chain.placeOrder({
        market: rules.nativeSymbol,
        side: isExitBuy ? 'BUY' : 'SELL',
        type: 'STOP_MARKET',
        size: Number(position.qty),
        price: worstStop,
        triggerPrice: Number(quantize(protection.stopPrice, rules.tickSize, 'floor')),
        clientId: numCid,
        reduceOnly: true,
        goodTilTimeSec: COND_GOOD_TIL_S
      });

      return adapter.protection(position);
    },

    async close(position: NativePosition, clientOrderId: string): Promise<NativeOrderReceipt> {
      const [rules, info, currentQuote] = await Promise.all([
        adapter.instruments(position.symbol),
        loadCredentials(),
        adapter.quote(position.symbol)
      ]);
      const chain = getChain(info.creds, info.authId);
      const isExitBuy = position.side === 'SHORT';
      const refPx = Number(currentQuote.last);
      const worstPx = isExitBuy ? refPx * (1 + SLIPPAGE) : refPx * (1 - SLIPPAGE);
      const numCid = dydxClientId(clientOrderId);

      const r = await chain.placeOrder({
        market: rules.nativeSymbol,
        side: isExitBuy ? 'BUY' : 'SELL',
        type: 'MARKET',
        size: Number(quantize(position.qty, rules.qtyStep, 'floor')),
        price: worstPx,
        clientId: numCid,
        reduceOnly: true
      });

      return {
        clientOrderId,
        venueOrderId: r.txHash,
        symbol: position.symbol,
        state: 'ACCEPTED',
        filledQty: null,
        avgFillPrice: null,
        observedAt: Date.now(),
        reason: null
      };
    },

    async financialHistory(_cursor: string | null): Promise<FinancialPage> {
      const { creds } = await loadCredentials();
      const fillsWrap = ((await indexerGet(
        `/fills?address=${creds.key}&subaccountNumber=${subaccount}&marketType=PERPETUAL&limit=100`
      )) ?? {}) as Record<string, unknown>;
      const fillsList = Array.isArray(fillsWrap.fills)
        ? (fillsWrap.fills as Array<Record<string, unknown>>)
        : [];
      const records: NativeFinancialRecord[] = [];
      for (const f of fillsList) {
        const id = String(f.id ?? f.orderId ?? '');
        if (!id) continue;
        const sideRaw = String(f.side ?? '').toUpperCase();
        records.push({
          id: `dydx-fill:${id}`,
          kind: 'fill',
          symbol: f.market ? fromDydxMarket(String(f.market)) : null,
          side: sideRaw === 'BUY' ? 'LONG' : sideRaw === 'SELL' ? 'SHORT' : null,
          qty: parseOptionalDecimal(f.size),
          price: parseOptionalDecimal(f.price),
          feeAmount: parseOptionalDecimal(f.fee),
          feeCurrency: 'USDC',
          realizedPnl: parseOptionalDecimal(f.closedPnl),
          fundingAmount: null,
          currency: 'USDC',
          occurredAt: f.createdAt ? Date.parse(String(f.createdAt)) : Date.now()
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
