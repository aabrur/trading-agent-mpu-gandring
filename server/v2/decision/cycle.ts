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
  takeProfitR?: number;
  availableCapitalUsdt?: number;
  allocationPerOrderUsdt?: number;
  maxPositions?: number;
  orderSizePct?: number | null;
  dailyLossLimitPct?: number;
  maxLossPerTradePct?: number;
  safetyNet?: number;
  sizingMode?: 'FIXED_PCT_OF_MONEY_TRADE' | 'AUTO_EQUAL_SLOTS_MONEY_TRADE_DIV_N';
  tradingProfile?: string;
  profileBaselineStopPrice?: { long: string | null; short: string | null };
  profileBaselineTpPrice?: { long: string | null; short: string | null };
  supportsLimitGtc?: boolean;
  accountCapital?: Record<string, unknown>;
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

function resolveBaselinePrice(
  baseline: { long: string | null; short: string | null } | string | null | undefined,
  side: 'LONG' | 'SHORT' | null | undefined
): string | null {
  if (!baseline) return null;
  if (typeof baseline === 'string') return baseline;
  if (side === 'LONG') return baseline.long;
  if (side === 'SHORT') return baseline.short;
  return null;
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

function computeBaselinePricesForReference(
  refPrice: number,
  side: 'LONG' | 'SHORT',
  policy: CyclePolicy
): { stop: string; tp: string } {
  const activeLev = policy.maxLeverage ?? 5;
  const stopPctRoe = policy.defaultStopPct ?? 30;
  const stopPricePct = (stopPctRoe / Math.max(1, activeLev)) / 100;
  const tpPctRoe = policy.takeProfitPct ?? (stopPctRoe * (policy.takeProfitR ?? 2));
  const tpPricePct = (tpPctRoe / Math.max(1, activeLev)) / 100;

  const stop = side === 'LONG'
    ? (refPrice * (1 - stopPricePct)).toFixed(4)
    : (refPrice * (1 + stopPricePct)).toFixed(4);
  const tp = side === 'LONG'
    ? (refPrice * (1 + tpPricePct)).toFixed(4)
    : (refPrice * (1 - tpPricePct)).toFixed(4);

  return { stop, tp };
}

function reviseTicket(lead: RoleResult, ticket: CandidateOrder, policy?: CyclePolicy): CandidateOrder {
  let orderType = lead.proposedOrderType ?? ticket.orderType;
  if (orderType === 'LIMIT_GTC' && policy?.supportsLimitGtc === false) {
    orderType = 'MARKET';
  }
  const limitPrice = orderType === 'MARKET'
    ? null
    : lead.proposedLimitPrice === undefined
      ? ticket.limitPrice
      : lead.proposedLimitPrice;

  const side = ticketSide(lead.stance) ?? ticket.side;
  let stop = lead.proposedStop ?? ticket.stop;
  let tp = lead.proposedTp ?? ticket.tp;

  if (orderType === 'LIMIT_GTC' && limitPrice && Number(limitPrice) > 0 && side && policy) {
    const isLimitChanged = lead.proposedLimitPrice !== undefined && lead.proposedLimitPrice !== ticket.limitPrice;
    const isOrderTypeChangedToLimit = ticket.orderType !== 'LIMIT_GTC';
    if (!lead.proposedStop || isLimitChanged || isOrderTypeChangedToLimit) {
      const baselines = computeBaselinePricesForReference(Number(limitPrice), side, policy);
      stop = lead.proposedStop ?? baselines.stop;
      tp = lead.proposedTp ?? baselines.tp;
    }
  }

  return {
    ...ticket,
    side,
    orderType,
    limitPrice,
    stop,
    tp
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

    const baselineStop = resolveBaselinePrice(input.policy.profileBaselineStopPrice, resolvedCandidateSide);
    const baselineTp = resolveBaselinePrice(input.policy.profileBaselineTpPrice, resolvedCandidateSide);
    const fallbackStop =
      challengeResults.find((r) => r.proposedStop)?.proposedStop ??
      observeResults.find((r) => r.proposedStop)?.proposedStop ??
      baselineStop;
    const fallbackTp =
      challengeResults.find((r) => r.proposedTp)?.proposedTp ??
      observeResults.find((r) => r.proposedTp)?.proposedTp ??
      baselineTp;

    const initialOrderType = (executionResult.proposedOrderType === 'LIMIT_GTC' && input.policy.supportsLimitGtc === false)
      ? 'MARKET'
      : (executionResult.proposedOrderType ?? 'MARKET');
    const initialLimitPrice = initialOrderType === 'MARKET' ? null : (executionResult.proposedLimitPrice ?? null);

    let initialStop = executionResult.proposedStop ?? fallbackStop;
    let initialTp = executionResult.proposedTp ?? fallbackTp;

    if (initialOrderType === 'LIMIT_GTC' && initialLimitPrice && Number(initialLimitPrice) > 0 && resolvedCandidateSide) {
      if (!executionResult.proposedStop) {
        const baselines = computeBaselinePricesForReference(Number(initialLimitPrice), resolvedCandidateSide, input.policy);
        initialStop = baselines.stop;
        initialTp = executionResult.proposedTp ?? baselines.tp;
      }
    }

    const candidateOrder: CandidateOrder = {
      side: resolvedCandidateSide,
      orderType: initialOrderType,
      limitPrice: initialLimitPrice,
      stop: initialStop,
      tp: initialTp,
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
      ticket = reviseTicket(leadResult, ticket, input.policy);
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
    let proposedStop = ticket.stop;
    let proposedTp = ticket.tp;

    if (ticket.orderType === 'LIMIT_GTC' && ticket.limitPrice && Number(ticket.limitPrice) > 0 && (thesisSide === 'LONG' || thesisSide === 'SHORT')) {
      const baselines = computeBaselinePricesForReference(Number(ticket.limitPrice), thesisSide, input.policy);
      const marketBaselineStop = resolveBaselinePrice(input.policy.profileBaselineStopPrice, thesisSide);
      if (!proposedStop || proposedStop === marketBaselineStop) {
        proposedStop = baselines.stop;
      }
      const marketBaselineTp = resolveBaselinePrice(input.policy.profileBaselineTpPrice, thesisSide);
      if (!proposedTp || proposedTp === marketBaselineTp) {
        proposedTp = baselines.tp;
      }
    } else {
      const baselineThesisStop = resolveBaselinePrice(input.policy.profileBaselineStopPrice, thesisSide);
      const baselineThesisTp = resolveBaselinePrice(input.policy.profileBaselineTpPrice, thesisSide);
      proposedStop = proposedStop ?? baselineThesisStop;
      proposedTp = proposedTp ?? baselineThesisTp;
    }
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
      tp: proposedTp,
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
