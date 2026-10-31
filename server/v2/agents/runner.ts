import { z } from 'zod';
import { safe } from '../../redact.js';
import { fenceData } from '../../untrusted.js';
import type { ConfidenceReading, ConfidenceScale, RoleId } from '../contracts.js';
import type { ResearchHost } from '../research/host.js';
import {
  createOfficialProviderCaller,
  type ProviderAssignment,
  type ProviderCaller,
  type RolePhase
} from './providers.js';
import { buildRoleSystemPrompt } from './roles.js';

export type RoleRoute = 'LOCAL' | 'GROK' | 'MIRROR_READ_ONLY';
export type RoleStance = 'LONG' | 'SHORT' | 'HOLD' | 'CLOSE' | 'NEUTRAL';

export interface ThesisInvalidationPredicate {
  kind: 'PRICE_BELOW' | 'PRICE_ABOVE' | 'STRUCTURE_BREAK';
  level?: string;
  timeframe?: string;
  description: string;
}

export interface RoleTask {
  cycleId: string;
  role: RoleId;
  phase: RolePhase;
  taskAttempt: number;
  evidenceId: string;
  configVersion: number;
  accountRef: string;
  route: RoleRoute;
  deadlineAt: number;
  symbol?: string;
  promptContext?: Record<string, unknown>;
}

export interface BaseRoleResult {
  cycleId: string;
  role: RoleId;
  phase: RolePhase;
  taskAttempt: number;
  evidenceId: string;
  configVersion: number;
  accountRef: string;
  route: RoleRoute;
  deadlineAt: number;
  status: 'completed' | 'unavailable' | 'cancelled';
  stance: RoleStance | null;
  claimRefs: string[];
  contraryRefs: string[];
  reasoning: string | null;
  confidence: ConfidenceReading;
  provider: string | null;
  model: string | null;
  toolTraceIds: string[];
  invalidationPredicate?: ThesisInvalidationPredicate | null;
  proposedStop?: string | null;
  proposedTp?: string | null;
  proposedOrderType?: 'MARKET' | 'LIMIT_GTC' | null;
  errorReason?: string | null;
}

export interface RiskRoleResult extends BaseRoleResult {
  role: 'risk';
  decision: 'APPROVE' | 'REJECT' | null;
}

export type NonRiskRoleResult = BaseRoleResult & {
  role: Exclude<RoleId, 'risk'>;
  decision?: undefined;
};

export type RoleResult = RiskRoleResult | NonRiskRoleResult;

export function satisfiesLeadProbabilityThreshold(
  role: RoleId,
  confidence: ConfidenceReading,
  minEntryConfidencePct: number
): boolean {
  if (role !== 'lead') return false;
  if (confidence.scale !== 'probability_0_1') return false;
  if (confidence.value === null || !Number.isFinite(confidence.value)) return false;
  if (confidence.value < 0 || confidence.value > 1) return false;
  return confidence.value * 100 >= minEntryConfidencePct;
}

const ToolCallEnvelopeSchema = z
  .object({
    toolCalls: z
      .array(
        z.object({
          name: z.string().min(1),
          args: z.record(z.string(), z.unknown()).default({})
        })
      )
      .min(1)
  })
  .passthrough();

const ModelConfidenceSchema = z
  .object({
    value: z.number().nullable(),
    scale: z.enum(['probability_0_1', 'ordinal_1_5', 'score_0_100']).nullable()
  })
  .strict();

const PredicateSchema = z
  .object({
    kind: z.enum(['PRICE_BELOW', 'PRICE_ABOVE', 'STRUCTURE_BREAK']),
    level: z.string().optional(),
    timeframe: z.string().optional(),
    description: z.string().min(1)
  })
  .strict();

const BaseReplySchema = z.object({
  stance: z.enum(['LONG', 'SHORT', 'HOLD', 'CLOSE', 'NEUTRAL']),
  decision: z.enum(['APPROVE', 'REJECT']).optional(),
  claimRefs: z.array(z.string()).default([]),
  contraryRefs: z.array(z.string()).default([]),
  reasoning: z.string().min(1),
  confidence: ModelConfidenceSchema.optional(),
  invalidationPredicate: PredicateSchema.nullable().optional(),
  proposedStop: z.string().nullable().optional(),
  proposedTp: z.string().nullable().optional(),
  proposedOrderType: z.enum(['MARKET', 'LIMIT_GTC']).nullable().optional()
});

function validateScaleBounds(scale: ConfidenceScale | null, value: number | null): boolean {
  if (value === null || scale === null) return true;
  if (!Number.isFinite(value)) return false;
  if (scale === 'probability_0_1') return value >= 0 && value <= 1;
  if (scale === 'ordinal_1_5') return value >= 1 && value <= 5;
  if (scale === 'score_0_100') return value >= 0 && value <= 100;
  return false;
}

function tryParseJson(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
    if (fenced?.[1]) {
      return JSON.parse(fenced[1].trim());
    }
    throw new Error('Malformed JSON reply');
  }
}

export interface RoleRunnerOptions {
  researchHost?: ResearchHost;
  providerCaller?: ProviderCaller;
  resolveAssignment: (role: RoleId, configVersion: number) => ProviderAssignment;
}

export class RoleRunner {
  private readonly researchHost?: ResearchHost;
  private readonly providerCaller: ProviderCaller;
  private readonly resolveAssignment: (role: RoleId, configVersion: number) => ProviderAssignment;
  private readonly activeAttempts = new Map<string, { attempt: number; abort: AbortController }>();
  private readonly acceptedResults = new Map<string, RoleResult>();

  constructor(options: RoleRunnerOptions) {
    this.researchHost = options.researchHost;
    this.providerCaller = options.providerCaller ?? createOfficialProviderCaller();
    this.resolveAssignment = options.resolveAssignment;
  }

  private slotKey(cycleId: string, role: RoleId, phase: RolePhase): string {
    return `${cycleId}:${role}:${phase}`;
  }

  getAcceptedResult(cycleId: string, role: RoleId, phase: RolePhase): RoleResult | undefined {
    return this.acceptedResults.get(this.slotKey(cycleId, role, phase));
  }

  private makeEmptyResult(
    task: RoleTask,
    status: 'unavailable' | 'cancelled',
    provider: string | null,
    model: string | null,
    toolTraceIds: string[],
    reason: string
  ): RoleResult {
    const confidence: ConfidenceReading = {
      value: null,
      scale: null,
      source: `${provider ?? 'none'}:${task.role}`,
      availability: 'UNAVAILABLE',
      reason
    };

    const base: BaseRoleResult = {
      cycleId: task.cycleId,
      role: task.role,
      phase: task.phase,
      taskAttempt: task.taskAttempt,
      evidenceId: task.evidenceId,
      configVersion: task.configVersion,
      accountRef: task.accountRef,
      route: task.route,
      deadlineAt: task.deadlineAt,
      status,
      stance: null,
      claimRefs: [],
      contraryRefs: [],
      reasoning: null,
      confidence,
      provider,
      model,
      toolTraceIds,
      errorReason: safe(reason)
    };

    if (task.role === 'risk') {
      return { ...base, role: 'risk', decision: null };
    }
    return { ...base, role: task.role };
  }

  async run(task: RoleTask, signal?: AbortSignal): Promise<RoleResult> {
    const key = this.slotKey(task.cycleId, task.role, task.phase);
    const existing = this.activeAttempts.get(key);
    if (existing && existing.attempt > task.taskAttempt) {
      return this.makeEmptyResult(
        task,
        'cancelled',
        null,
        null,
        [],
        `Stale taskAttempt ${task.taskAttempt} superseded by ${existing.attempt}`
      );
    }
    if (existing && existing.attempt < task.taskAttempt) {
      existing.abort.abort();
    }

    const attemptAbort = new AbortController();
    this.activeAttempts.set(key, { attempt: task.taskAttempt, abort: attemptAbort });
    const combinedSignal = signal
      ? AbortSignal.any([signal, attemptAbort.signal])
      : attemptAbort.signal;

    const assignment = this.resolveAssignment(task.role, task.configVersion);
    const provider = assignment.provider.trim().toLowerCase();
    const model = assignment.model.trim();
    const toolTraceIds: string[] = [];

    if (combinedSignal.aborted) {
      return this.makeEmptyResult(task, 'cancelled', provider, model, toolTraceIds, 'Task cancelled before start');
    }

    if (provider === 'mock') {
      return this.makeEmptyResult(
        task,
        'unavailable',
        provider,
        model,
        toolTraceIds,
        'Mock provider is disabled; real provider or local CLI required.'
      );
    }

    if (provider !== 'local' && (!assignment.apiKey || !assignment.apiKey.trim())) {
      return this.makeEmptyResult(
        task,
        'unavailable',
        provider,
        model,
        toolTraceIds,
        `Missing API key for provider ${provider}`
      );
    }

    const remainingBudgetMs = Math.max(1_000, task.deadlineAt - Date.now());
    const system = buildRoleSystemPrompt(task.role);
    let userPrompt = JSON.stringify({
      cycleId: task.cycleId,
      role: task.role,
      phase: task.phase,
      evidenceId: task.evidenceId,
      symbol: task.symbol ?? null,
      context: task.promptContext ?? {}
    });

    try {
      let rawText = '';
      for (let turn = 0; turn < 4; turn += 1) {
        if (combinedSignal.aborted || this.activeAttempts.get(key)?.attempt !== task.taskAttempt) {
          return this.makeEmptyResult(task, 'cancelled', provider, model, toolTraceIds, 'Task cancelled or superseded');
        }

        rawText = await this.providerCaller({
          cycleId: task.cycleId,
          role: task.role,
          phase: task.phase,
          taskAttempt: task.taskAttempt,
          turn,
          provider,
          model,
          apiKey: assignment.apiKey ?? '',
          baseUrl: assignment.baseUrl,
          system,
          user: userPrompt,
          signal: combinedSignal,
          timeoutMs: remainingBudgetMs,
          reasoningEffort: assignment.reasoningEffort,
          provenOsSandbox: assignment.provenOsSandbox
        });

        if (combinedSignal.aborted || this.activeAttempts.get(key)?.attempt !== task.taskAttempt) {
          return this.makeEmptyResult(task, 'cancelled', provider, model, toolTraceIds, 'Late result discarded after cancellation');
        }

        let maybeToolObj: unknown = null;
        try {
          maybeToolObj = tryParseJson(rawText);
        } catch {
          break;
        }

        const toolParsed = ToolCallEnvelopeSchema.safeParse(maybeToolObj);
        if (!toolParsed.success) {
          break;
        }

        if (!this.researchHost) {
          return this.makeEmptyResult(
            task,
            'unavailable',
            provider,
            model,
            toolTraceIds,
            'Role requested host tools while ResearchHost is unavailable'
          );
        }

        const toolOutputs: unknown[] = [];
        for (const call of toolParsed.data.toolCalls) {
          const res = await this.researchHost.run(call, {
            role: task.role,
            cycleId: task.cycleId,
            accountRef: task.accountRef,
            evidenceId: task.evidenceId
          });
          toolTraceIds.push(res.traceId);
          toolOutputs.push({
            tool: call.name,
            traceId: res.traceId,
            status: res.status,
            sourceRefs: res.sourceRefs,
            data: res.data,
            error: res.error
          });
        }

        userPrompt = `${userPrompt}\n\n${fenceData('host_tool_results', toolOutputs)}`;
      }

      let parsedJson: unknown;
      try {
        parsedJson = tryParseJson(rawText);
      } catch {
        const repairedRaw = await this.providerCaller({
          cycleId: task.cycleId,
          role: task.role,
          phase: task.phase,
          taskAttempt: task.taskAttempt,
          turn: 99,
          provider,
          model,
          apiKey: assignment.apiKey ?? '',
          baseUrl: assignment.baseUrl,
          system,
          user: `Reformat the following draft strictly as valid JSON matching the schema without adding or changing any factual claims or references:\n\n${rawText}`,
          retryReason: 'format_repair',
          signal: combinedSignal,
          timeoutMs: remainingBudgetMs,
          reasoningEffort: assignment.reasoningEffort,
          provenOsSandbox: assignment.provenOsSandbox
        });
        parsedJson = tryParseJson(repairedRaw);
      }

      if (combinedSignal.aborted || this.activeAttempts.get(key)?.attempt !== task.taskAttempt) {
        return this.makeEmptyResult(task, 'cancelled', provider, model, toolTraceIds, 'Late result discarded after cancellation');
      }

      const validated = BaseReplySchema.safeParse(parsedJson);
      if (!validated.success) {
        return this.makeEmptyResult(
          task,
          'unavailable',
          provider,
          model,
          toolTraceIds,
          'Model output failed role schema validation'
        );
      }

      if (task.role === 'risk' && !validated.data.decision) {
        return this.makeEmptyResult(
          task,
          'unavailable',
          provider,
          model,
          toolTraceIds,
          'Risk role output missing explicit APPROVE or REJECT decision'
        );
      }

      const rawConf = validated.data.confidence;
      const confScale = rawConf?.scale ?? null;
      const confValue = rawConf?.value ?? null;
      if (!validateScaleBounds(confScale, confValue)) {
        return this.makeEmptyResult(
          task,
          'unavailable',
          provider,
          model,
          toolTraceIds,
          'Model output contained out-of-range confidence value for its declared scale'
        );
      }

      const confidence: ConfidenceReading = {
        value: confValue,
        scale: confScale,
        source: `${provider}:${task.role}`,
        availability: confValue !== null && confScale !== null ? 'AVAILABLE' : 'UNAVAILABLE',
        reason: confValue !== null && confScale !== null ? null : 'Confidence omitted'
      };

      const baseCompleted: BaseRoleResult = {
        cycleId: task.cycleId,
        role: task.role,
        phase: task.phase,
        taskAttempt: task.taskAttempt,
        evidenceId: task.evidenceId,
        configVersion: task.configVersion,
        accountRef: task.accountRef,
        route: task.route,
        deadlineAt: task.deadlineAt,
        status: 'completed',
        stance: validated.data.stance,
        claimRefs: validated.data.claimRefs,
        contraryRefs: validated.data.contraryRefs,
        reasoning: validated.data.reasoning,
        confidence,
        provider,
        model,
        toolTraceIds,
        invalidationPredicate: validated.data.invalidationPredicate ?? null,
        proposedStop: validated.data.proposedStop ?? null,
        proposedTp: validated.data.proposedTp ?? null,
        proposedOrderType: validated.data.proposedOrderType ?? null,
        errorReason: null
      };

      const finalResult: RoleResult =
        task.role === 'risk'
          ? { ...baseCompleted, role: 'risk', decision: validated.data.decision! }
          : { ...baseCompleted, role: task.role };

      this.acceptedResults.set(key, finalResult);
      return finalResult;
    } catch (err) {
      if (
        combinedSignal.aborted ||
        this.activeAttempts.get(key)?.attempt !== task.taskAttempt ||
        (err instanceof Error && /cancelled/i.test(err.message))
      ) {
        return this.makeEmptyResult(task, 'cancelled', provider, model, toolTraceIds, 'Task cancelled');
      }
      return this.makeEmptyResult(
        task,
        'unavailable',
        provider,
        model,
        toolTraceIds,
        err instanceof Error ? err.message : 'Role task execution failed'
      );
    }
  }
}
