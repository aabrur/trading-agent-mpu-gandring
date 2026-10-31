import { createHash } from 'node:crypto';
import { encode } from '@msgpack/msgpack';
import { concat, keccak256, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { DecimalString, IntentState, Network } from '../../contracts.js';
import {
  addDecimals,
  compareDecimals,
  divDecimals,
  mulDecimals,
  quantize,
  subDecimals
} from '../decimal.js';
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

const HL_MIN_NOTIONAL = '10';
const HL_IOC_SLIPPAGE = 0.05;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

export function floatToWire(x: number): string {
  let s = x.toFixed(8);
  if (Math.abs(Number(s) - x) >= 1e-12) {
    throw new VenueTransportError(`Hyperliquid floatToWire rounding overflow: ${x}`);
  }
  s = s.replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

export function hlStepDecimal(szDecimals: number): DecimalString {
  if (szDecimals <= 0) return '1';
  return `0.${'0'.repeat(szDecimals - 1)}1`;
}

export function hlTickDecimal(px: number, szDecimals: number): DecimalString {
  const maxDec = Math.max(0, 6 - szDecimals);
  const sigTick = px > 0 ? 10 ** (Math.floor(Math.log10(px)) - 4) : 1;
  const t = Math.min(1, Math.max(sigTick, 10 ** -maxDec));
  return t.toFixed(Math.max(maxDec, 0)).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
}

export function hlPrice(px: number, szDecimals: number): number {
  const sig = Number(px.toPrecision(5));
  return Number(sig.toFixed(Math.max(0, 6 - szDecimals)));
}

export function actionHash(action: unknown, nonce: number): Hex {
  const packed = encode(action);
  const n = new Uint8Array(8);
  new DataView(n.buffer).setBigUint64(0, BigInt(nonce));
  return keccak256(concat([packed, n, new Uint8Array([0])]));
}

export function cloidFor(clientId: string): Hex {
  return `0x${createHash('sha256').update(clientId).digest('hex').slice(0, 32)}`;
}

export async function signHyperliquidAction(input: {
  network: Network;
  agentPrivateKey: string;
  action: Record<string, unknown>;
  nonce: number;
}): Promise<{ r: Hex; s: Hex; v: number; agentAddress: string }> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.agentPrivateKey)) {
    throw new AdapterCapabilityError('Hyperliquid signer secret must be a 0x64 API agent key');
  }
  const account = privateKeyToAccount(input.agentPrivateKey as Hex);
  const signature = await account.signTypedData({
    domain: {
      name: 'Exchange',
      version: '1',
      chainId: 1337,
      verifyingContract: ZERO_ADDRESS
    },
    types: {
      Agent: [
        { name: 'source', type: 'string' },
        { name: 'connectionId', type: 'bytes32' }
      ]
    },
    primaryType: 'Agent',
    message: {
      source: input.network === 'mainnet' ? 'a' : 'b',
      connectionId: actionHash(input.action, input.nonce)
    }
  });
  return {
    r: `0x${signature.slice(2, 66)}` as Hex,
    s: `0x${signature.slice(66, 130)}` as Hex,
    v: parseInt(signature.slice(130, 132), 16),
    agentAddress: account.address
  };
}

function mapHlOrderStatus(rawStatus: unknown, hasFills: boolean): IntentState {
  const s = typeof rawStatus === 'string' ? rawStatus.toLowerCase() : '';
  if (s === 'filled') return 'FILLED';
  if (s === 'open') return hasFills ? 'PARTIAL' : 'ACCEPTED';
  if (s === 'canceled' || s === 'margincanceled') return 'CANCELLED';
  if (s === 'rejected') return 'REJECTED';
  return hasFills ? 'PARTIAL' : 'UNKNOWN';
}

export function createVenueAdapter(options: AdapterOptions): VenueAdapter {
  const base =
    options.network === 'testnet'
      ? 'https://api.hyperliquid-testnet.xyz'
      : 'https://api.hyperliquid.xyz';
  let cachedMeta: { universe: Array<{ name: string; szDecimals: number }> } | null = null;

  async function loadCredentials(): Promise<{
    creds: DelegatedCredentials;
    agentAddress: string;
  }> {
    const creds = await options.readSecret(options.credentialRef);
    validateDelegatedCredentialInput({
      venue: 'hyperliquid',
      key: creds.key,
      secret: creds.secret,
      passphrase: creds.passphrase
    });
    if (!/^0x[0-9a-fA-F]{40}$/.test(creds.key.trim())) {
      throw new AdapterCapabilityError('Hyperliquid account key must be a 0x40 wallet address');
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(creds.secret.trim())) {
      throw new AdapterCapabilityError('Hyperliquid secret must be a 0x64 API agent private key');
    }
    const account = privateKeyToAccount(creds.secret.trim() as Hex);
    return {
      creds: { ...creds, key: creds.key.trim(), secret: creds.secret.trim() },
      agentAddress: account.address
    };
  }

  async function infoReq(body: Record<string, unknown>, secretToScrub?: string): Promise<unknown> {
    try {
      return await fetchVenueJson(options.fetchImpl, `${base}/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (err) {
      throw new VenueTransportError(
        scrubAdapterError(err instanceof Error ? err.message : String(err), [secretToScrub])
      );
    }
  }

  async function exchangeReq(action: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
    const { creds } = await loadCredentials();
    const nonce = Date.now();
    const sig = await signHyperliquidAction({
      network: options.network,
      agentPrivateKey: creds.secret,
      action,
      nonce
    });
    try {
      const r = ((await fetchVenueJson(options.fetchImpl, `${base}/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          nonce,
          signature: { r: sig.r, s: sig.s, v: sig.v },
          vaultAddress: null
        })
      })) ?? {}) as Record<string, unknown>;

      if (r.status !== 'ok') {
        throw new VenueTransportError(
          `hyperliquid: ${typeof r.response === 'string' ? r.response : JSON.stringify(r).slice(0, 180)}`
        );
      }
      const respObj =
        r.response && typeof r.response === 'object'
          ? (r.response as Record<string, unknown>)
          : {};
      const dataObj =
        respObj.data && typeof respObj.data === 'object'
          ? (respObj.data as Record<string, unknown>)
          : {};
      const statuses = Array.isArray(dataObj.statuses)
        ? (dataObj.statuses as Array<Record<string, unknown>>)
        : [];
      const errEntry = statuses.find((s) => typeof s?.error === 'string' && s.error);
      if (errEntry) {
        throw new VenueTransportError(`hyperliquid: ${String(errEntry.error)}`);
      }
      return statuses;
    } catch (err) {
      throw new VenueTransportError(
        scrubAdapterError(err instanceof Error ? err.message : String(err), [creds.secret])
      );
    }
  }

  async function resolveAsset(symbol: string): Promise<{
    idx: number;
    coin: string;
    szDecimals: number;
  }> {
    if (!cachedMeta) {
      const m = (await infoReq({ type: 'meta' })) as {
        universe?: Array<{ name: string; szDecimals: number }>;
      } | null;
      cachedMeta = { universe: Array.isArray(m?.universe) ? m.universe : [] };
    }
    const coin = symbol.replace(/USDT?$/i, '');
    const idx = cachedMeta.universe.findIndex((u) => u.name === coin);
    if (idx < 0) {
      throw new VenueTransportError(`hyperliquid: unknown coin ${coin}`);
    }
    return {
      idx,
      coin,
      szDecimals: cachedMeta.universe[idx]!.szDecimals
    };
  }

  async function midPrice(coin: string): Promise<DecimalString> {
    const mids = ((await infoReq({ type: 'allMids' })) ?? {}) as Record<string, unknown>;
    const px = parsePositiveDecimalOrNull(mids[coin]);
    if (!px) {
      throw new VenueTransportError(`hyperliquid: missing mid price for ${coin}`);
    }
    return px;
  }

  const adapter: VenueAdapter = {
    venue: 'hyperliquid',
    network: options.network,
    status: VENUE_STATUS.hyperliquid,
    capabilities: {
      exchangeStops: true,
      restingLimitGtcEntry: false,
      hedgeMode: false,
      financialHistory: ['fills', 'fees', 'funding']
    },

    async permissions(): Promise<PermissionEvidence> {
      const { creds, agentAddress } = await loadCredentials();
      const observedAt = Date.now();
      if (agentAddress.toLowerCase() === creds.key.toLowerCase()) {
        return {
          ok: false,
          canTrade: true,
          canWithdraw: true,
          verified: true,
          delegatedOnly: false,
          detail: 'Refused main wallet private key: Hyperliquid requires an API agent wallet key',
          observedAt
        };
      }
      const rawAgents = await infoReq({ type: 'extraAgents', user: creds.key }, creds.secret);
      const agents = Array.isArray(rawAgents)
        ? (rawAgents as Array<{ address?: string; name?: string; validUntil?: number | null }>)
        : [];
      const match = agents.find(
        (a) => typeof a.address === 'string' && a.address.toLowerCase() === agentAddress.toLowerCase()
      );
      if (!match) {
        return {
          ok: false,
          canTrade: false,
          canWithdraw: null,
          verified: true,
          delegatedOnly: true,
          detail: `Agent ${agentAddress} is not an approved API wallet of ${creds.key}`,
          observedAt
        };
      }
      if (match.validUntil && match.validUntil < observedAt) {
        return {
          ok: false,
          canTrade: false,
          canWithdraw: false,
          verified: true,
          delegatedOnly: true,
          detail: `Agent wallet "${match.name ?? ''}" is expired`,
          observedAt
        };
      }
      return {
        ok: true,
        canTrade: true,
        canWithdraw: false,
        verified: true,
        delegatedOnly: true,
        detail: `Approved Hyperliquid agent wallet "${match.name ?? agentAddress}"; agent wallets cannot withdraw`,
        observedAt
      };
    },

    async accountIdentity(): Promise<NativeAccountIdentity> {
      const { creds } = await loadCredentials();
      return {
        venue: 'hyperliquid',
        network: options.network,
        publicAccountId: creds.key,
        subaccountRef: null,
        positionMode: 'ONE_WAY',
        observedAt: Date.now()
      };
    },

    async balance(): Promise<NativeBalance> {
      const { creds } = await loadCredentials();
      const r = ((await infoReq(
        { type: 'clearinghouseState', user: creds.key },
        creds.secret
      )) ?? {}) as Record<string, unknown>;
      const observedAt = Date.now();
      const marginSummary = (r.marginSummary ?? {}) as Record<string, unknown>;
      const equity = parseOptionalDecimal(marginSummary.accountValue);
      const available = parseOptionalDecimal(r.withdrawable);
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
      const asset = await resolveAsset(symbol);
      const mid = await midPrice(asset.coin);
      const step = hlStepDecimal(asset.szDecimals);
      const tick = hlTickDecimal(Number(mid) * 1.1, asset.szDecimals);
      return {
        symbol,
        nativeSymbol: asset.coin,
        tickSize: tick,
        qtyStep: step,
        minQty: step,
        maxQty: null,
        minNotional: HL_MIN_NOTIONAL,
        contractMultiplier: '1',
        settlementCurrency: 'USDC',
        positionModeCapability: 'ONE_WAY',
        exchangeStops: true,
        restingLimitGtcEntry: false
      };
    },

    async quote(symbol: string): Promise<VenueQuote> {
      const asset = await resolveAsset(symbol);
      const last = await midPrice(asset.coin);
      const observedAt = Date.now();
      return {
        symbol,
        last,
        bid: null,
        ask: null,
        sourceAt: null,
        observedAt,
        ageMs: null
      };
    },

    async positions(): Promise<NativePosition[]> {
      const { creds } = await loadCredentials();
      const r = ((await infoReq(
        { type: 'clearinghouseState', user: creds.key },
        creds.secret
      )) ?? {}) as Record<string, unknown>;
      const observedAt = Date.now();
      const assetPositions = Array.isArray(r.assetPositions)
        ? (r.assetPositions as Array<Record<string, unknown>>)
        : [];
      const out: NativePosition[] = [];
      for (const item of assetPositions) {
        const p = (item.position ?? {}) as Record<string, unknown>;
        const szi = parseOptionalDecimal(p.szi);
        if (!szi || compareDecimals(szi, '0') === 0) continue;
        const isShort = compareDecimals(szi, '0') < 0;
        const qty = isShort ? szi.slice(1) : szi;
        const coin = String(p.coin ?? '');
        const sym = `${coin}USDT`;
        const entryPx = parsePositiveDecimalOrNull(p.entryPx);
        if (!entryPx) continue;
        const levObj = (p.leverage ?? {}) as Record<string, unknown>;
        const levVal = Number(levObj.value);
        out.push({
          positionKey: `${sym}:ONE_WAY:NET`,
          nativePositionId: coin,
          symbol: sym,
          nativeSymbol: coin,
          positionMode: 'ONE_WAY',
          hedgeLeg: null,
          side: isShort ? 'SHORT' : 'LONG',
          qty,
          entryPrice: entryPx,
          leverage: Number.isFinite(levVal) && levVal > 0 ? levVal : null,
          unrealizedPnl: parseOptionalDecimal(p.unrealizedPnl),
          observedAt
        });
      }
      return out;
    },

    async submit(intent: NativeOrder): Promise<NativeOrderReceipt> {
      const [rules, currentQuote, asset] = await Promise.all([
        adapter.instruments(intent.symbol),
        adapter.quote(intent.symbol),
        resolveAsset(intent.symbol)
      ]);
      const prepared = prepareNativeOrderQuantities(intent, rules, currentQuote.last);
      await exchangeReq({
        type: 'updateLeverage',
        asset: asset.idx,
        isCross: true,
        leverage: Math.round(intent.leverage)
      });

      const isBuy = intent.side === 'LONG';
      const refNum = Number(currentQuote.last);
      const slipPx = floatToWire(
        hlPrice(isBuy ? refNum * (1 + HL_IOC_SLIPPAGE) : refNum * (1 - HL_IOC_SLIPPAGE), asset.szDecimals)
      );
      const wireSz = floatToWire(Number(prepared.quantity));
      const statuses = await exchangeReq({
        type: 'order',
        orders: [
          {
            a: asset.idx,
            b: isBuy,
            p: slipPx,
            s: wireSz,
            r: false,
            t: { limit: { tif: 'Ioc' } },
            c: cloidFor(intent.clientOrderId)
          }
        ],
        grouping: 'na'
      });
      const first = statuses[0] ?? {};
      const filledObj = (first.filled ?? null) as Record<string, unknown> | null;
      const restingObj = (first.resting ?? null) as Record<string, unknown> | null;
      const oid =
        filledObj?.oid != null
          ? String(filledObj.oid)
          : restingObj?.oid != null
            ? String(restingObj.oid)
            : null;

      return {
        clientOrderId: intent.clientOrderId,
        venueOrderId: oid,
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
      const observedAt = Date.now();
      const r = ((await infoReq(
        { type: 'orderStatus', user: creds.key, oid: cloidFor(clientOrderId) },
        creds.secret
      )) ?? {}) as Record<string, unknown>;
      if (r.status !== 'order' || !r.order || typeof r.order !== 'object') {
        return {
          clientOrderId,
          venueOrderId: null,
          symbol,
          state: 'UNKNOWN',
          filledQty: null,
          avgFillPrice: null,
          observedAt,
          reason: 'Order not found on Hyperliquid'
        };
      }
      const orderWrap = r.order as Record<string, unknown>;
      const ord = (orderWrap.order ?? {}) as Record<string, unknown>;
      const origSz = parseOptionalDecimal(ord.origSz) ?? '0';
      const remSz = parseOptionalDecimal(ord.sz) ?? '0';
      const filledDiff = subDecimals(origSz, remSz);
      const hasPositiveFill = compareDecimals(filledDiff, '0') > 0;
      const state = mapHlOrderStatus(orderWrap.status, hasPositiveFill);

      let avgFillPrice: DecimalString | null = null;
      if (hasPositiveFill && ord.oid != null) {
        const fillsRaw = await infoReq({ type: 'userFills', user: creds.key }, creds.secret);
        const fills = Array.isArray(fillsRaw) ? (fillsRaw as Array<Record<string, unknown>>) : [];
        const matching = fills.filter((f) => String(f.oid ?? '') === String(ord.oid));
        let notional: DecimalString = '0';
        let qtySum: DecimalString = '0';
        for (const f of matching) {
          const px = parsePositiveDecimalOrNull(f.px);
          const sz = parsePositiveDecimalOrNull(f.sz);
          if (px && sz) {
            notional = addDecimals(notional, mulDecimals(px, sz));
            qtySum = addDecimals(qtySum, sz);
          }
        }
        if (compareDecimals(qtySum, '0') > 0) {
          avgFillPrice = divDecimals(notional, qtySum, 8, 'floor');
        }
      }

      return {
        clientOrderId,
        venueOrderId: ord.oid != null ? String(ord.oid) : null,
        symbol,
        state,
        filledQty: hasPositiveFill ? filledDiff : null,
        avgFillPrice,
        observedAt,
        reason: null
      };
    },

    async cancelEntry(symbol: string, clientOrderId: string): Promise<NativeOrderReceipt> {
      const asset = await resolveAsset(symbol);
      try {
        await exchangeReq({
          type: 'cancelByCloid',
          cancels: [{ asset: asset.idx, cloid: cloidFor(clientOrderId) }]
        });
      } catch (err) {
        if (!(err instanceof VenueTransportError)) throw err;
      }
      return adapter.lookupOrder(symbol, clientOrderId);
    },

    async protection(position: NativePosition): Promise<ProtectionEvidence> {
      if (position.positionMode === 'HEDGE') {
        throw new AdapterCapabilityError('Hyperliquid does not support HEDGE mode');
      }
      const { creds } = await loadCredentials();
      const asset = await resolveAsset(position.symbol);
      const openRaw = await infoReq(
        { type: 'frontendOpenOrders', user: creds.key },
        creds.secret
      );
      const open = Array.isArray(openRaw) ? (openRaw as Array<Record<string, unknown>>) : [];
      const observedAt = Date.now();
      const expectedSide = position.side === 'LONG' ? 'A' : 'B';

      let stopPrice: DecimalString | null = null;
      let tpPrice: DecimalString | null = null;
      let coveredQty: DecimalString = '0';
      let reduceOnlyOrPositionBound = false;

      for (const o of open) {
        if (String(o.coin ?? '') !== asset.coin || !o.isTrigger) continue;
        if (String(o.side ?? '') !== expectedSide) continue;
        const oType = String(o.orderType ?? '');
        const trigPx = parsePositiveDecimalOrNull(o.triggerPx);
        const reduceOnly = Boolean(o.reduceOnly) || Boolean(o.isPositionTpsl);
        if (/stop/i.test(oType) && trigPx) {
          if (!stopPrice) stopPrice = trigPx;
          if (reduceOnly) {
            reduceOnlyOrPositionBound = true;
            const sz = parsePositiveDecimalOrNull(o.sz ?? o.origSz);
            if (sz) {
              coveredQty = addDecimals(coveredQty, sz);
            } else if (o.isPositionTpsl) {
              coveredQty = position.qty;
            }
          }
        } else if (/take profit/i.test(oType) && trigPx && !tpPrice) {
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
      if (position.positionMode === 'HEDGE') {
        throw new AdapterCapabilityError('Hyperliquid does not support HEDGE mode');
      }
      const asset = await resolveAsset(position.symbol);
      const isBuyExit = position.side === 'SHORT';
      const sz = floatToWire(Number(Number(position.qty).toFixed(asset.szDecimals)));
      const buildTrigger = (pxStr: DecimalString, tpsl: 'sl' | 'tp') => {
        const pxNum = Number(pxStr);
        return {
          a: asset.idx,
          b: isBuyExit,
          p: floatToWire(
            hlPrice(
              isBuyExit ? pxNum * (1 + HL_IOC_SLIPPAGE) : pxNum * (1 - HL_IOC_SLIPPAGE),
              asset.szDecimals
            )
          ),
          s: sz,
          r: true,
          t: {
            trigger: {
              isMarket: true,
              triggerPx: floatToWire(hlPrice(pxNum, asset.szDecimals)),
              tpsl
            }
          }
        };
      };

      const orders: Array<Record<string, unknown>> = [
        buildTrigger(protection.stopPrice, 'sl')
      ];
      if (protection.tpPrice) {
        orders.push(buildTrigger(protection.tpPrice, 'tp'));
      }
      await exchangeReq({ type: 'order', orders, grouping: 'na' });
      return adapter.protection(position);
    },

    async close(position: NativePosition, clientOrderId: string): Promise<NativeOrderReceipt> {
      if (position.positionMode === 'HEDGE') {
        throw new AdapterCapabilityError('Hyperliquid does not support HEDGE mode');
      }
      const asset = await resolveAsset(position.symbol);
      const mid = Number(await midPrice(asset.coin));
      const isBuyExit = position.side === 'SHORT';
      const statuses = await exchangeReq({
        type: 'order',
        orders: [
          {
            a: asset.idx,
            b: isBuyExit,
            p: floatToWire(
              hlPrice(
                isBuyExit ? mid * (1 + HL_IOC_SLIPPAGE) : mid * (1 - HL_IOC_SLIPPAGE),
                asset.szDecimals
              )
            ),
            s: floatToWire(Number(Number(position.qty).toFixed(asset.szDecimals))),
            r: true,
            t: { limit: { tif: 'Ioc' } },
            c: cloidFor(clientOrderId)
          }
        ],
        grouping: 'na'
      });
      const first = statuses[0] ?? {};
      const filledObj = (first.filled ?? null) as Record<string, unknown> | null;
      return {
        clientOrderId,
        venueOrderId: filledObj?.oid != null ? String(filledObj.oid) : null,
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
      const [fillsRaw, fundingRaw] = await Promise.all([
        infoReq({ type: 'userFills', user: creds.key }, creds.secret),
        infoReq({ type: 'userFunding', user: creds.key, startTime: 0 }, creds.secret)
      ]);
      const records: NativeFinancialRecord[] = [];
      const fills = Array.isArray(fillsRaw) ? (fillsRaw as Array<Record<string, unknown>>) : [];
      for (const f of fills) {
        const id = String(f.tid ?? f.oid ?? '');
        if (!id) continue;
        records.push({
          id: `hl-fill:${id}`,
          kind: 'fill',
          symbol: f.coin ? `${String(f.coin)}USDT` : null,
          side: f.side === 'B' ? 'LONG' : f.side === 'A' ? 'SHORT' : null,
          qty: parseOptionalDecimal(f.sz),
          price: parseOptionalDecimal(f.px),
          feeAmount: parseOptionalDecimal(f.fee),
          feeCurrency: f.feeToken ? String(f.feeToken) : null,
          realizedPnl: parseOptionalDecimal(f.closedPnl),
          fundingAmount: null,
          currency: 'USDC',
          occurredAt: Number(f.time ?? Date.now())
        });
      }
      const fundings = Array.isArray(fundingRaw)
        ? (fundingRaw as Array<Record<string, unknown>>)
        : [];
      for (const fd of fundings) {
        const delta = (fd.delta ?? {}) as Record<string, unknown>;
        const id = String(fd.hash ?? fd.time ?? '');
        if (!id) continue;
        records.push({
          id: `hl-fund:${id}`,
          kind: 'funding',
          symbol: delta.coin ? `${String(delta.coin)}USDT` : null,
          side: null,
          qty: null,
          price: null,
          feeAmount: null,
          feeCurrency: null,
          realizedPnl: null,
          fundingAmount: parseOptionalDecimal(delta.usdc),
          currency: 'USDC',
          occurredAt: Number(fd.time ?? Date.now())
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
