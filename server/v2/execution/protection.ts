import { createHash } from 'node:crypto';
import type { DecimalString, ProtectionState } from '../contracts.js';
import { compareDecimals } from './decimal.js';

export interface NativeExposurePosition {
  positionKey: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  qty: DecimalString;
  entryPrice: DecimalString;
  positionMode?: 'ONE_WAY' | 'HEDGE';
}

export interface ProtectionSnapshot {
  state: 'VERIFIED' | 'UNVERIFIED' | 'MISSING';
  coveredQty: DecimalString;
  stopPrice: DecimalString | null;
  reduceOnly: boolean;
}

export interface EnsureExposureProtectionInput {
  position: NativeExposurePosition;
  desiredStopPrice: DecimalString;
  maxRepairAttempts?: number;
  readProtection: (position: NativeExposurePosition) => Promise<ProtectionSnapshot>;
  placeProtection: (
    position: NativeExposurePosition,
    stopPrice: DecimalString
  ) => Promise<ProtectionSnapshot>;
  emergencyClose: (
    position: NativeExposurePosition,
    emergencyClientOrderId: string
  ) => Promise<void>;
}

export interface EnsureExposureProtectionResult {
  protectionState: ProtectionState;
  coveredQty: DecimalString;
  emergencyClosed: boolean;
  reason: string | null;
}

function isSnapshotCoveringExposure(
  snapshot: ProtectionSnapshot,
  exposureQty: DecimalString
): boolean {
  if (snapshot.state !== 'VERIFIED') return false;
  if (!snapshot.reduceOnly) return false;
  if (!snapshot.stopPrice) return false;
  return compareDecimals(snapshot.coveredQty, exposureQty) === 0;
}

/**
 * Ensures any positive native position exposure has a verified reduce-only or position-bound stop
 * covering the exact current exposure quantity. Never cancels an existing stop before replacement
 * succeeds; triggers bounded repair and emergency flatten if protection remains missing.
 */
export async function ensureExposureProtection(
  input: EnsureExposureProtectionInput
): Promise<EnsureExposureProtectionResult> {
  const { position, desiredStopPrice } = input;
  if (compareDecimals(position.qty, '0') <= 0) {
    return {
      protectionState: 'NOT_APPLICABLE',
      coveredQty: '0',
      emergencyClosed: false,
      reason: null
    };
  }

  try {
    const current = await input.readProtection(position);
    if (isSnapshotCoveringExposure(current, position.qty)) {
      return {
        protectionState: 'VERIFIED',
        coveredQty: current.coveredQty,
        emergencyClosed: false,
        reason: null
      };
    }
  } catch {
    // Proceed to repair attempts when initial readback fails.
  }

  const maxAttempts = input.maxRepairAttempts ?? 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const placed = await input.placeProtection(position, desiredStopPrice);
      if (isSnapshotCoveringExposure(placed, position.qty)) {
        return {
          protectionState: 'VERIFIED',
          coveredQty: placed.coveredQty,
          emergencyClosed: false,
          reason: null
        };
      }
      const reread = await input.readProtection(position);
      if (isSnapshotCoveringExposure(reread, position.qty)) {
        return {
          protectionState: 'VERIFIED',
          coveredQty: reread.coveredQty,
          emergencyClosed: false,
          reason: null
        };
      }
    } catch {
      // Retry up to maxAttempts before emergency close.
    }
  }

  const digest = createHash('sha256')
    .update(`${position.positionKey}:${position.qty}:emerg`, 'utf8')
    .digest('hex')
    .slice(0, 20);
  await input.emergencyClose(position, `emerg-${digest}`);

  return {
    protectionState: 'MISSING',
    coveredQty: '0',
    emergencyClosed: true,
    reason: `Emergency flatten executed because stop protection could not be verified for ${position.symbol}`
  };
}
