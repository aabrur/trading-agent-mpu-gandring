import { EXIT_TRIGGERS, type ExitTrigger } from '../contracts.js';

export interface VerifiedExit {
  trigger: ExitTrigger;
  positionRef: string;
  evidenceRefs: string[];
  observedAt: number;
  reason: string;
}

export interface PositionExitCandidate {
  positionRef: string;
  accountRef: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  openedAt: number;
  verifiedTriggers: Array<{
    trigger: ExitTrigger;
    evidenceRefs: string[];
    reason: string;
  }>;
}

export interface EvaluateExitsInput {
  observedAt: number;
  // Entry gates are accepted as read-only context to prove they never block verified exits.
  entryGateState?: {
    leadProbability?: number | null;
    occupiedSlots?: number;
    maxPositions?: number;
    freeMarginUsdt?: string | null;
    jevStatus?: string;
    browserStatus?: string;
  };
  positions: readonly PositionExitCandidate[];
}

const VALID_TRIGGER_SET = new Set<string>(EXIT_TRIGGERS);

/**
 * Evaluates verified exit conditions for open managed positions.
 * Invariants:
 * 1. Entry confidence, slot occupancy, free margin, Jev outage and browser outage never block CLOSE.
 * 2. Hold duration alone never triggers an autonomous exit.
 * 3. One verified trigger with non-empty evidenceRefs suffices for autonomous CLOSE.
 */
export function evaluateExits(input: EvaluateExitsInput): VerifiedExit[] {
  const exits: VerifiedExit[] = [];

  for (const pos of input.positions) {
    if (!pos.verifiedTriggers || pos.verifiedTriggers.length === 0) {
      continue;
    }

    for (const candidate of pos.verifiedTriggers) {
      if (!VALID_TRIGGER_SET.has(candidate.trigger)) {
        continue;
      }
      if (!candidate.evidenceRefs || candidate.evidenceRefs.length === 0) {
        continue;
      }

      exits.push({
        trigger: candidate.trigger,
        positionRef: pos.positionRef,
        evidenceRefs: [...candidate.evidenceRefs],
        observedAt: input.observedAt,
        reason: candidate.reason
      });
      break;
    }
  }

  return exits;
}

export interface OwnerCloseAuthorizationInput {
  ownerVerified: boolean;
  requestId: string;
  observedAt: number;
  position: {
    positionRef: string;
    accountRef: string;
    symbol: string;
    side: 'LONG' | 'SHORT';
  };
}

export interface OwnerCloseAuthorization {
  authorized: boolean;
  requestId: string;
  positionRef: string;
  accountRef: string;
  symbol: string;
  observedAt: number;
  reason: string;
}

export function authorizeOwnerClose(input: OwnerCloseAuthorizationInput): OwnerCloseAuthorization {
  if (!input.ownerVerified) {
    return {
      authorized: false,
      requestId: input.requestId,
      positionRef: input.position.positionRef,
      accountRef: input.position.accountRef,
      symbol: input.position.symbol,
      observedAt: input.observedAt,
      reason: 'Owner identity verification is required for direct close.'
    };
  }

  return {
    authorized: true,
    requestId: input.requestId,
    positionRef: input.position.positionRef,
    accountRef: input.position.accountRef,
    symbol: input.position.symbol,
    observedAt: input.observedAt,
    reason: 'Direct Owner close authorized immediately without entry gate checks.'
  };
}
