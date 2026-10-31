import { randomUUID } from 'node:crypto';
import type { RoleId } from '../contracts.js';
import type { JevClient, JevReview } from '../agents/jev.js';
import {
  RoleRunner,
  satisfiesLeadProbabilityThreshold,
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
    const deadlineAt = Date.now() + (input.deadlineMs ?? 60_000);
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

    // 4. Risk and Execution feasibility on final phase.
    const [riskResult, executionResult] = await Promise.all([
      runRole({
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
          policy: input.policy
        }
      }),
      runRole({
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
          jevReview
        }
      })
    ]);
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
        policy: input.policy
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

    // Entry authorization checks strictly follow active Owner policy and Risk judgment.
    if (typedRisk.decision !== 'APPROVE') {
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

    if (
      input.policy.minEntryConfidencePct > 0 &&
      !satisfiesLeadProbabilityThreshold('lead', leadResult.confidence, input.policy.minEntryConfidencePct)
    ) {
      return {
        cycleId,
        reason: input.reason,
        status: 'completed',
        verdict: {
          action: 'HOLD',
          symbol: input.symbol,
          thesis: null,
          exit: null,
          rejectionReason: `Lead probability_0_1 confidence did not meet Owner minimum ${input.policy.minEntryConfidencePct}%`
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

    const proposedStop =
      leadResult.proposedStop ??
      executionResult.proposedStop ??
      latestAnalystByRole.get('strategist')?.proposedStop ??
      null;

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
      kind: desiredStance === 'LONG' ? ('PRICE_BELOW' as const) : ('PRICE_ABOVE' as const),
      level: proposedStop,
      description: `Stop invalidation at ${proposedStop}`
    };

    const thesis: TradeThesis = {
      id: `thesis-${randomUUID()}`,
      cycleId,
      accountRef: input.accountRef,
      symbol: input.symbol,
      side: desiredStance,
      evidenceId: input.evidenceId,
      configVersion: input.configVersion,
      claims: [...new Set([...leadResult.claimRefs, ...(jevReview?.claimRefs ?? [])])],
      invalidation: [predicate],
      stop: proposedStop,
      tp: leadResult.proposedTp ?? executionResult.proposedTp ?? null,
      orderType: leadResult.proposedOrderType ?? executionResult.proposedOrderType ?? 'MARKET'
    };

    return {
      cycleId,
      reason: input.reason,
      status: 'completed',
      verdict: {
        action: desiredStance === 'LONG' ? 'OPEN_LONG' : 'OPEN_SHORT',
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
  }
}
