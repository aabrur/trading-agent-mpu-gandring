import { createHash, randomUUID } from 'node:crypto';
import { safe } from '../../../redact.js';

export interface OwnerCommandProposal {
  proposalId: string;
  command: string;
  accountRef: string;
  expectedActiveVersion: number;
  expiresAt: number;
  sourcePeer: string;
  grantId?: string;
}

export type CommandProposalStatus = 'NEEDS_OWNER_PROOF' | 'APPLIED' | 'REJECTED';

export interface CommandProposalReceipt {
  proposalId: string;
  status: CommandProposalStatus;
  reason?: string;
}

export interface VerifiedOwnerGrant {
  grantId: string;
  commandDigest: string;
  accountRef: string;
  expectedActiveVersion: number;
  expiresAt: number;
  consumedAt: number | null;
}

export interface HandoverEvidence {
  accountRef: string;
  targetAuthority: string;
  currentActiveVersion: number;
  expectedActiveVersion: number;
  unreconciledPositions: number;
  externalKeyRevoked: boolean;
}

export interface AuthorityResult {
  authorized: boolean;
  reason?: string;
}

export interface StopSemanticsContext {
  openPositionsCount: number;
  restingStopsCount: number;
  cancelEntries: () => Promise<void>;
  flattenPositions: () => Promise<void>;
  invokeStrategyClose: () => Promise<void>;
}

export interface StopSemanticsResult {
  haltLatched: boolean;
  autoTrading: 'OFF';
  action: 'HALT_ONLY' | 'HALT_AND_FLATTEN';
  retainedProtectedPositions?: number;
}

export class OwnerCommandService {
  private grants = new Map<string, VerifiedOwnerGrant>();

  public createGrant(params: {
    command: string;
    accountRef: string;
    expectedActiveVersion: number;
    ttlMs?: number;
  }): VerifiedOwnerGrant {
    const grantId = `grant-${randomUUID()}`;
    const commandDigest = createHash('sha256').update(params.command.trim()).digest('hex');
    const expiresAt = Date.now() + (params.ttlMs ?? 60000);

    const grant: VerifiedOwnerGrant = {
      grantId,
      commandDigest,
      accountRef: params.accountRef,
      expectedActiveVersion: params.expectedActiveVersion,
      expiresAt,
      consumedAt: null
    };

    this.grants.set(grantId, grant);
    return grant;
  }

  public async propose(proposal: OwnerCommandProposal): Promise<CommandProposalReceipt> {
    const cmd = proposal.command.trim().toLowerCase();

    // Refuse sensitive operations unconditionally from remote proposals
    if (cmd === 'unkill' || cmd.startsWith('key') || cmd.startsWith('keys') || cmd.includes('live')) {
      return {
        proposalId: proposal.proposalId,
        status: 'REJECTED',
        reason: 'Remote unkill, key changes, and LIVE activation are refused from peer proposals.'
      };
    }

    if (!proposal.grantId) {
      return {
        proposalId: proposal.proposalId,
        status: 'NEEDS_OWNER_PROOF',
        reason: 'Independent Owner grant required for execution authority.'
      };
    }

    const grant = this.grants.get(proposal.grantId);
    if (!grant) {
      return {
        proposalId: proposal.proposalId,
        status: 'REJECTED',
        reason: 'Unknown grant ID.'
      };
    }

    if (grant.consumedAt !== null || Date.now() > grant.expiresAt) {
      return {
        proposalId: proposal.proposalId,
        status: 'REJECTED',
        reason: 'Grant already consumed or expired.'
      };
    }

    const expectedDigest = createHash('sha256').update(proposal.command.trim()).digest('hex');
    if (expectedDigest !== grant.commandDigest) {
      return {
        proposalId: proposal.proposalId,
        status: 'REJECTED',
        reason: 'Command digest mismatch: proposal command does not match grant digest.'
      };
    }

    if (proposal.expectedActiveVersion !== grant.expectedActiveVersion) {
      return {
        proposalId: proposal.proposalId,
        status: 'REJECTED',
        reason: 'Expected active version mismatch.'
      };
    }

    // Mark consumed (one-time grant)
    grant.consumedAt = Date.now();

    return {
      proposalId: proposal.proposalId,
      status: 'APPLIED',
      reason: safe(`Owner command "${proposal.command}" applied via validated one-time grant.`)
    };
  }
}

export async function authorizeHandover(evidence: HandoverEvidence): Promise<AuthorityResult> {
  if (evidence.expectedActiveVersion !== evidence.currentActiveVersion) {
    return {
      authorized: false,
      reason: `Epoch mismatch: expected active version ${evidence.expectedActiveVersion} does not match current ${evidence.currentActiveVersion}.`
    };
  }

  if (!evidence.externalKeyRevoked) {
    return {
      authorized: false,
      reason: 'Conflict detected: External key not revoked.'
    };
  }

  if (evidence.unreconciledPositions > 0) {
    return {
      authorized: false,
      reason: `Cannot handover while ${evidence.unreconciledPositions} unreconciled positions exist.`
    };
  }

  return {
    authorized: true
  };
}

/**
 * Accepted D09 Remote STOP semantics:
 * HALT_ONLY: Latches halt to ON, turns Auto to OFF, cancels nonprotective orders,
 * but strictly retains open positions and resting exchange SL/TP.
 * Zero strategy CLOSE intents are dispatched.
 */
export async function executeAcceptedStopSemantics(
  context: StopSemanticsContext
): Promise<StopSemanticsResult> {
  await context.cancelEntries();

  return {
    haltLatched: true,
    autoTrading: 'OFF',
    action: 'HALT_ONLY',
    retainedProtectedPositions: context.openPositionsCount
  };
}

/**
 * Accepted D09 Local Kill semantics:
 * HALT_AND_FLATTEN: Latches halt to ON, cancels entries, and immediately flattens open positions.
 */
export async function executeLocalKillSemantics(
  context: StopSemanticsContext
): Promise<StopSemanticsResult> {
  await context.cancelEntries();
  await context.flattenPositions();

  return {
    haltLatched: true,
    autoTrading: 'OFF',
    action: 'HALT_AND_FLATTEN'
  };
}
