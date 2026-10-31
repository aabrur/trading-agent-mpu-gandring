import type { VenueId } from '../../contracts.js';
import type { AdapterOptions, VenueAdapter, NativePosition } from './types.js';
import { createVenueAdapter as createAsterAdapter } from './aster.js';
import { createVenueAdapter as createBinanceAdapter } from './binance.js';
import { createVenueAdapter as createBybitAdapter } from './bybit.js';
import { createVenueAdapter as createDydxAdapter } from './dydx.js';
import { createVenueAdapter as createHyperliquidAdapter } from './hyperliquid.js';
import { createVenueAdapter as createOkxAdapter } from './okx.js';
import { createVenueAdapter as createOrderlyAdapter } from './orderly.js';
import { createVenueAdapter as createParadexAdapter } from './paradex.js';
import type { GatewayVenueTransport } from '../gateway.js';
import type { NativeExposurePosition, ProtectionSnapshot } from '../protection.js';

export function getVenueAdapter(venue: VenueId, options: AdapterOptions): VenueAdapter {
  switch (venue) {
    case 'aster':
      return createAsterAdapter(options);
    case 'binance':
      return createBinanceAdapter(options);
    case 'bybit':
      return createBybitAdapter(options);
    case 'dydx':
      return createDydxAdapter(options);
    case 'hyperliquid':
      return createHyperliquidAdapter(options);
    case 'okx':
      return createOkxAdapter(options);
    case 'orderly':
      return createOrderlyAdapter(options);
    case 'paradex':
      return createParadexAdapter(options);
    default:
      throw new Error(`Unsupported venue: ${venue}`);
  }
}

export function createTransportFromAdapter(adapter: VenueAdapter): GatewayVenueTransport {
  function toNativePosition(pos: NativeExposurePosition): NativePosition {
    return {
      positionKey: pos.positionKey,
      nativePositionId: pos.positionKey,
      symbol: pos.symbol,
      nativeSymbol: pos.symbol,
      positionMode: pos.positionMode ?? 'ONE_WAY',
      hedgeLeg: null,
      side: pos.side,
      qty: pos.qty,
      entryPrice: pos.entryPrice,
      leverage: null,
      unrealizedPnl: null,
      observedAt: Date.now()
    };
  }

  return {
    balance: async () => {
      const b = await adapter.balance();
      return {
        balanceUsdt: b.equity,
        availableUsdt: b.available,
        realizedDailyPnlUsdt: b.realizedDailyPnl ?? '0'
      };
    },
    positions: async (): Promise<NativeExposurePosition[]> => {
      const posList = await adapter.positions();
      return posList.map((p) => ({
        positionKey: p.positionKey,
        symbol: p.symbol,
        side: p.side,
        qty: p.qty,
        entryPrice: p.entryPrice,
        positionMode: p.positionMode
      }));
    },
    submitOrder: async (order) => {
      const r = await adapter.submit({
        clientOrderId: order.clientOrderId,
        symbol: order.symbol,
        side: order.side,
        positionMode: 'ONE_WAY',
        hedgeLeg: null,
        orderType: order.orderType,
        quantity: order.quantity,
        limitPrice: order.entryPrice,
        leverage: order.leverage,
        expireAt: null
      });
      return {
        clientOrderId: r.clientOrderId,
        venueOrderId: r.venueOrderId,
        state: r.state,
        filledQty: r.filledQty
      };
    },
    lookupOrder: async (symbol, clientOrderId) => {
      const r = await adapter.lookupOrder(symbol, clientOrderId);
      return {
        clientOrderId: r.clientOrderId,
        venueOrderId: r.venueOrderId,
        state: r.state,
        filledQty: r.filledQty
      };
    },
    cancelEntryOrder: async (symbol, clientOrderId) => {
      const r = await adapter.cancelEntry(symbol, clientOrderId);
      return {
        clientOrderId: r.clientOrderId,
        venueOrderId: r.venueOrderId,
        state: r.state,
        filledQty: r.filledQty
      };
    },
    readProtection: async (position): Promise<ProtectionSnapshot> => {
      const prot = await adapter.protection(toNativePosition(position));
      return {
        state: prot.state === 'VERIFIED' ? 'VERIFIED' : prot.state === 'UNVERIFIED' ? 'UNVERIFIED' : 'MISSING',
        coveredQty: prot.coveredQty,
        stopPrice: prot.stopPrice,
        reduceOnly: prot.reduceOnlyOrPositionBound
      };
    },
    placeProtection: async (position, stopPrice): Promise<ProtectionSnapshot> => {
      const prot = await adapter.protect(toNativePosition(position), {
        stopPrice,
        tpPrice: null,
        triggerBy: 'MARK_PRICE',
        clientOrderId: `prot-${Date.now()}`
      });
      return {
        state: prot.state === 'VERIFIED' ? 'VERIFIED' : prot.state === 'UNVERIFIED' ? 'UNVERIFIED' : 'MISSING',
        coveredQty: prot.coveredQty,
        stopPrice: prot.stopPrice,
        reduceOnly: prot.reduceOnlyOrPositionBound
      };
    },
    closePosition: async (position, clientOrderId) => {
      const r = await adapter.close(toNativePosition(position), clientOrderId);
      return {
        clientOrderId: r.clientOrderId,
        venueOrderId: r.venueOrderId,
        state: r.state,
        filledQty: r.filledQty
      };
    }
  };
}
