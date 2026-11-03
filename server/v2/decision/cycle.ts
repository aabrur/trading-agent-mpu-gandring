import { randomUUID } from 'node:crypto';
import type { RoleId } from '../contracts.js';
import type { JevClient, JevReview } from '../agents/jev.js';
import {
  RoleRunner,
  type RiskRoleResult,
  type RoleResult,
  type RoleRoute,
  type RoleTask
} from '../agents/runner.js';
import type { VerifiedExit } from './exits.js';
import type { TradeThesis } from './revalidate.js';

export type CycleReason = 'owner' | 'schedule' | 'market-event' | 'position-event';

export interface CyclePolicy {
  minEntryConfidencePct: number;
  requireTwoOfThreeAnalysts: boolean;
  maxLeverage?: number;
  defaultStopPct?: number;
  takeProfitPct?: number;
  availableCapitalUsdt?: number;
  allocationPerOrderUsdt?: number;
  maxPositions?: number;
  orderSizePct?: number | null;
  dailyLossLimitPct?: number;
}

export interface RunCycleInput {
  cycleId?: string;
  reason: CycleReason;
  accountRef: string;
  symbol: string;
  evidenceId: string;
  configVersion: number;
  policy: CyclePolicy;
  marketSummary: Record<string, unknown>;
  routeForRole?: (role: RoleId) => RoleRoute;
  deadlineMs?: number;
  signal?: AbortSignal;
  onRoleStart?: (task: RoleTask) => void;
  onRoleResult?: (result: RoleResult) => void;
}

export interface CycleResult {
  cycleId: string;
  reason: CycleReason;
  status: 'completed' | 'incomplete' | 'cancelled';
  verdict: {
    action: 'OPEN_LONG' | 'OPEN_SHORT' | 'HOLD' | 'CLOSE';
    symbol: string;
    thesis: TradeThesis | null;
    exit: VerifiedExit | null;
    rejectionReason: string | null;
  } | null;
  roleResults: RoleResult[];
  jevReview: JevReview | null;
  jevReviewId: string | null;
  configVersion: number;
  evidenceId: string;
}

const ANALYST_ROLES: readonly Exclude<RoleId, 'risk' | 'execution' | 'lead'>[] = [
  'market',
  'research',
  'strategist'
];

interface CandidateOrder {
  side: 'LONG' | 'SHORT' | null;
  orderType: 'MARKET' | 'LIMIT_GTC' | null;
  limitPrice: string | null;
  stop: string | null;
  tp: string | null;
  leverage: number | null;
  allocationPerOrderUsdt: number | null;
  availableCapitalUsdt: number | null;
  orderSizePct: number | null;
  maxPositions: number | null;
  dailyLossLimitPct: number | null;
}

function ticketSide(stance: string | null | undefined): 'LONG' | 'SHORT' | null {
  return stance === 'LONG' || stance === 'SHORT' ? stance : null;
}

function leadChangedTicket(lead: RoleResult, ticket: CandidateOrder): boolean {
  const side = ticketSide(lead.stance);
  if (side && side !== ticket.side) return true;
  if (lead.proposedOrderType && lead.proposedOrderType !== ticket.orderType) return true;
  if (lead.proposedLimitPrice !== undefined && lead.proposedLimitPrice !== ticket.limitPrice) return true;
  if (lead.proposedStop && lead.proposedStop !== ticket.stop) return true;
  if (lead.proposedTp != null && lead.proposedTp !== ticket.tp) return true;
  return false;
}

function reviseTicket(lead: RoleResult, ticket: CandidateOrder): CandidateOrder {
  const orderType = lead.proposedOrderType ?? ticket.orderType;
  const limitPrice = orderType === 'MARKET'
    ? null
    : lead.proposedLimitPrice === undefined
      ? ticket.limitPrice
      : lead.proposedLimitPrice;
  return {
    ...ticket,
    side: ticketSide(lead.stance) ?? ticket.side,
    orderType,
    limitPrice,
    stop: lead.proposedStop ?? ticket.stop,
    tp: lead.proposedTp ?? ticket.tp
  };
}

export interface CycleRunnerOptions {
  roleRunner: RoleRunner;
  jevClient?: JevClient;
}

export class CycleRunner {
  private readonly roleRunner: RoleRunner;
  private readonly jevClient?: JevClient;

  constructor(options: CycleRunnerOptions) {
    this.roleRunner = options.roleRunner;
    this.jevClient = options.jevClient;
  }

  async run(input: RunCycleInput): Promise<CycleResult> {
    const cycleId = input.cycleId ?? `cycle-${randomUUID()}`;
    const deadlineAt = Date.now() + (input.deadlineMs ?? 360_000);
    const routeOf = (role: RoleId): RoleRoute => input.routeForRole?.(role) ?? 'LOCAL';
    const roleResults: RoleResult[] = [];

    if (input.signal?.aborted) {
      return {
        cycleId,
        reason: input.reason,
        status: 'cancelled',
        verdict: null,
        roleResults,
        jevReview: null,
        jevReviewId: null,
        configVersion: input.configVersion,
        evidenceId: input.evidenceId
      };
    }

    const runRole = async (task: import('../agents/runner.js').RoleTask): Promise<RoleResult> => {
      input.onRoleStart?.(task);
      const res = await this.roleRunner.run(task, input.signal);
      input.onRoleResult?.(res);
      return res;
    };

    try {
      // 1. Observe phase across the 3 analyst roles.
      const observeResults = await Promise.all(
      ANALYST_ROLES.map((role) =>
        runRole({
          cycleId,
          role,
          phase: 'observe',
          taskAttempt: 1,
          evidenceId: input.evidenceId,
          configVersion: input.configVersion,
          accountRef: input.accountRef,
          route: routeOf(role),
          deadlineAt,
          symbol: input.symbol,
          promptContext: {
            marketSummary: input.marketSummary
          }
        })
      )
    );
    roleResults.push(...observeResults);

    // 2. Optional Jev evidence review (never a seventh role or permission gate).
    let jevReview: JevReview | null = null;
    if (this.jevClient) {
      jevReview = await this.jevClient.review({
        cycleId,
        symbol: input.symbol,
        evidenceId: input.evidenceId,
        state: {
          marketSummary: input.marketSummary,
          observations: observeResults.map((r) => ({
            role: r.role,
            status: r.status,
            stance: r.stance,
            claimRefs: r.claimRefs,
            contraryRefs: r.contraryRefs
          }))
        }
      });
    }
    const jevReviewId = jevReview?.status === 'completed' ? jevReview.reviewId : null;

    // 3. Structured challenge phase across the 3 analyst roles with visible observations + Jev review.
    const challengeResults = await Promise.all(
      ANALYST_ROLES.map((role) =>
        runRole({
          cycleId,
          role,
          phase: 'challenge',
          taskAttempt: 1,
          evidenceId: input.evidenceId,
          configVersion: input.configVersion,
          accountRef: input.accountRef,
          route: routeOf(role),
          deadlineAt,
          symbol: input.symbol,
          promptContext: {
            marketSummary: input.marketSummary,
            peerObservations: observeResults,
            jevReview
          }
        })
      )
    );
    roleResults.push(...challengeResults);

    // 4. Execution proposes the candidate order, then Risk evaluates that candidate.
    const executionResult = await runRole({
      cycleId,
      role: 'execution',
      phase: 'final',
      taskAttempt: 1,
      evidenceId: input.evidenceId,
      configVersion: input.configVersion,
      accountRef: input.accountRef,
      route: routeOf('execution'),
      deadlineAt,
      symbol: input.symbol,
      promptContext: {
        marketSummary: input.marketSummary,
        observations: observeResults,
        challenges: challengeResults,
        jevReview,
        policy: input.policy
      }
    });
    const executionSide = ticketSide(executionResult.stance);
    let resolvedCandidateSide = executionSide;
    if (!resolvedCandidateSide) {
      let longVotes = 0;
      let shortVotes = 0;
      for (const r of [...challengeResults, ...observeResults]) {
        if (r.stance === 'LONG') longVotes++;
        if (r.stance === 'SHORT') shortVotes++;
      }
      if (longVotes > shortVotes && longVotes >= 2) resolvedCandidateSide = 'LONG';
      else if (shortVotes > longVotes && shortVotes >= 2) resolvedCandidateSide = 'SHORT';
    }

    const fallbackStop =
      challengeResults.find((r) => r.proposedStop)?.proposedStop ??
      observeResults.find((r) => r.proposedStop)?.proposedStop ??
      null;
    const fallbackTp =
      challengeResults.find((r) => r.proposedTp)?.proposedTp ??
      observeResults.find((r) => r.proposedTp)?.proposedTp ??
      null;

    const candidateOrder: CandidateOrder = {
      side: resolvedCandidateSide,
      orderType: executionResult.proposedOrderType ?? 'MARKET',
      limitPrice: executionResult.proposedLimitPrice ?? null,
      stop: executionResult.proposedStop ?? fallbackStop,
      tp: executionResult.proposedTp ?? fallbackTp,
      leverage: input.policy.maxLeverage ?? null,
      allocationPerOrderUsdt: input.policy.allocationPerOrderUsdt ?? null,
      availableCapitalUsdt: input.policy.availableCapitalUsdt ?? null,
      orderSizePct: input.policy.orderSizePct ?? null,
      maxPositions: input.policy.maxPositions ?? null,
      dailyLossLimitPct: input.policy.dailyLossLimitPct ?? null
    };
    const riskResult = await runRole({
      cycleId,
      role: 'risk',
      phase: 'final',
      taskAttempt: 1,
      evidenceId: input.evidenceId,
      configVersion: input.configVersion,
      accountRef: input.accountRef,
      route: routeOf('risk'),
      deadlineAt,
      symbol: input.symbol,
      promptContext: {
        marketSummary: input.marketSummary,
        observations: observeResults,
        challenges: challengeResults,
        jevReview,
        policy: input.policy,
        candidateOrder
      }
    });
    roleResults.push(riskResult, executionResult);

    // 5. Desk Lead final synthesis seeing all available role results and Jev review.
    const leadResult = await runRole({
      cycleId,
      role: 'lead',
      phase: 'final',
      taskAttempt: 1,
      evidenceId: input.evidenceId,
      configVersion: input.configVersion,
      accountRef: input.accountRef,
      route: routeOf('lead'),
      deadlineAt,
      symbol: input.symbol,
      promptContext: {
        marketSummary: input.marketSummary,
        observations: observeResults,
        challenges: challengeResults,
        riskResult,
        executionResult,
        jevReview,
        policy: input.policy,
        candidateOrder
      }
    });
    roleResults.push(leadResult);

    if (roleResults.some((r) => r.status === 'cancelled') || input.signal?.aborted) {
      return {
        cycleId,
        reason: input.reason,
        status: 'cancelled',
        verdict: null,
        roleResults,
        jevReview,
        jevReviewId,
        configVersion: input.configVersion,
        evidenceId: input.evidenceId
      };
    }

    // Authoritative decision requires completed Risk, Execution and Lead results, plus analyst coverage.
    // Never fabricate a HOLD success when a required role failed.
    const latestAnalystByRole = new Map<RoleId, RoleResult>();
    for (const role of ANALYST_ROLES) {
      const challenge = challengeResults.find((r) => r.role === role && r.status === 'completed');
      const observe = observeResults.find((r) => r.role === role && r.status === 'completed');
      const chosen = challenge ?? observe;
      if (chosen) {
        latestAnalystByRole.set(role, chosen);
      }
    }

    if (
      riskResult.status !== 'completed' ||
      executionResult.status !== 'completed' ||
      leadResult.status !== 'completed' ||
      latestAnalystByRole.size < ANALYST_ROLES.length
    ) {
      return {
        cycleId,
        reason: input.reason,
        status: 'incomplete',
        verdict: null,
        roleResults,
        jevReview,
        jevReviewId,
        configVersion: input.configVersion,
        evidenceId: input.evidenceId
      };
    }

    const typedRisk = riskResult as RiskRoleResult;
    const desiredStance = leadResult.stance;

    if (desiredStance !== 'LONG' && desiredStance !== 'SHORT') {
      return {
        cycleId,
        reason: input.reason,
        status: 'completed',
        verdict: {
          action: desiredStance === 'CLOSE' ? 'CLOSE' : 'HOLD',
          symbol: input.symbol,
          thesis: null,
          exit: null,
          rejectionReason: null
        },
        roleResults,
        jevReview,
        jevReviewId,
        configVersion: input.configVersion,
        evidenceId: input.evidenceId
      };
    }

    // Unchanged ticket: first Risk decision stands. A material Lead edit is re-checked below.
    if (!leadChangedTicket(leadResult, candidateOrder) && typedRisk.decision !== 'APPROVE') {
      return {
        cycleId,
        reason: input.reason,
        status: 'completed',
        verdict: {
          action: 'HOLD',
          symbol: input.symbol,
          thesis: null,
          exit: null,
          rejectionReason: typedRisk.reasoning ?? 'Rejected by Head of Risk'
        },
        roleResults,
        jevReview,
        jevReviewId,
        configVersion: input.configVersion,
        evidenceId: input.evidenceId
      };
    }

    if (input.policy.requireTwoOfThreeAnalysts) {
      let alignedAnalysts = 0;
      for (const analyst of latestAnalystByRole.values()) {
        if (analyst.stance === desiredStance) {
          alignedAnalysts += 1;
        }
      }
      if (alignedAnalysts < 2) {
        return {
          cycleId,
          reason: input.reason,
          status: 'completed',
          verdict: {
            action: 'HOLD',
            symbol: input.symbol,
            thesis: null,
            exit: null,
            rejectionReason: `Selected 2-of-3 analyst consensus not met (${alignedAnalysts}/3 aligned with ${desiredStance})`
          },
          roleResults,
          jevReview,
          jevReviewId,
          configVersion: input.configVersion,
          evidenceId: input.evidenceId
        };
      }
    }

    let ticket = candidateOrder;
    let authorizingRisk = typedRisk;
    if (leadChangedTicket(leadResult, ticket)) {
      ticket = reviseTicket(leadResult, ticket);
      const again = await runRole({
        cycleId,
        role: 'risk',
        phase: 'final',
        taskAttempt: 2,
        evidenceId: input.evidenceId,
        configVersion: input.configVersion,
        accountRef: input.accountRef,
        route: routeOf('risk'),
        deadlineAt,
        symbol: input.symbol,
        promptContext: {
          marketSummary: input.marketSummary,
          observations: observeResults,
          challenges: challengeResults,
          jevReview,
          policy: input.policy,
          candidateOrder: ticket
        }
      });
      roleResults.push(again);
      if (again.status !== 'completed' || again.role !== 'risk') {
        return {
          cycleId,
          reason: input.reason,
          status: 'incomplete',
          verdict: null,
          roleResults,
          jevReview,
          jevReviewId,
          configVersion: input.configVersion,
          evidenceId: input.evidenceId
        };
      }
      authorizingRisk = again;
    }
    if (authorizingRisk.decision !== 'APPROVE') {
      return {
        cycleId,
        reason: input.reason,
        status: 'completed',
        verdict: {
          action: 'HOLD',
          symbol: input.symbol,
          thesis: null,
          exit: null,
          rejectionReason: authorizingRisk.reasoning ?? 'Rejected by Head of Risk'
        },
        roleResults,
        jevReview,
        jevReviewId,
        configVersion: input.configVersion,
        evidenceId: input.evidenceId
      };
    }

    const thesisSide = ticket.side;
    const proposedStop = ticket.stop;
    if (thesisSide !== 'LONG' && thesisSide !== 'SHORT') {
      return {
        cycleId,
        reason: input.reason,
        status: 'completed',
        verdict: {
          action: 'HOLD',
          symbol: input.symbol,
          thesis: null,
          exit: null,
          rejectionReason: 'Entry ticket has no side'
        },
        roleResults,
        jevReview,
        jevReviewId,
        configVersion: input.configVersion,
        evidenceId: input.evidenceId
      };
    }
    if (!proposedStop) {
      return {
        cycleId,
        reason: input.reason,
        status: 'completed',
        verdict: {
          action: 'HOLD',
          symbol: input.symbol,
          thesis: null,
          exit: null,
          rejectionReason: 'Entry requires an explicit stop price'
        },
        roleResults,
        jevReview,
        jevReviewId,
        configVersion: input.configVersion,
        evidenceId: input.evidenceId
      };
    }

    const predicate = leadResult.invalidationPredicate ?? {
      kind: thesisSide === 'LONG' ? ('PRICE_BELOW' as const) : ('PRICE_ABOVE' as const),
      level: proposedStop,
      description: `Stop invalidation at ${proposedStop}`
    };

    const thesis: TradeThesis = {
      id: `thesis-${randomUUID()}`,
      cycleId,
      accountRef: input.accountRef,
      symbol: input.symbol,
      side: thesisSide,
      evidenceId: input.evidenceId,
      configVersion: input.configVersion,
      claims: [...new Set([...leadResult.claimRefs, ...(jevReview?.claimRefs ?? [])])],
      invalidation: [predicate],
      stop: proposedStop,
      tp: ticket.tp,
      orderType: ticket.orderType ?? 'MARKET',
      limitPrice: ticket.limitPrice
    };

    return {
      cycleId,
      reason: input.reason,
      status: 'completed',
      verdict: {
        action: thesisSide === 'LONG' ? 'OPEN_LONG' : 'OPEN_SHORT',
        symbol: input.symbol,
        thesis,
        exit: null,
        rejectionReason: null
      },
      roleResults,
      jevReview,
      jevReviewId,
      configVersion: input.configVersion,
      evidenceId: input.evidenceId
    };
    } finally {
      this.roleRunner.cleanupCycle(cycleId);
    }
  }
}
