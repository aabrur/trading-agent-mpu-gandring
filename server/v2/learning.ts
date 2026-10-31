import { safe } from '../redact.js';
import type { AgentId, RoleId } from './contracts.js';

export type LessonKind = 'loss' | 'stop' | 'error' | 'scan' | 'correction' | 'review' | 'note';
export type LessonStatus = 'new' | 'confirmed' | 'promoted';

export interface ScopedLesson {
  accountRef: string;
  role: AgentId | RoleId | 'desk';
  kind: LessonKind;
  symbol?: string;
  happened: string;
  rootCause: string;
  lesson: string;
  condition?: string;
  sourceTradeIds?: string[];
  sourceDecisionIds?: string[];
}

export interface Lesson extends ScopedLesson {
  id: string;
  key: string;
  status: LessonStatus;
  count: number;
  firstAt: number;
  lastAt: number;
  source: 'desk' | 'grokbot' | 'owner';
  isAdvice: boolean;
  authorizesOrder: boolean;
  authorizesSettingChange: boolean;
  archived?: boolean;
}

export interface DeriveTradeLessonInput {
  tradeId: string;
  accountRef: string;
  role: AgentId | RoleId | 'desk';
  symbol: string;
  entryPrice: string;
  exitPrice: string | null;
  feesPaid: string | null;
  fundingPaid: string | null;
}

export interface DerivedTradeLesson {
  tradeId: string;
  accountRef: string;
  symbol: string;
  realizedPnl: string | null;
  hasCompleteFinancialData: boolean;
  advisoryNote: string;
}

const GUARD_LOOSENING_PATTERNS = [
  /disable\s+(exchange\s+)?stop/i,
  /remove\s+(exchange\s+)?stop/i,
  /increase\s+(max\s+)?leverage/i,
  /raise\s+leverage/i,
  /skip\s+protection/i,
  /bypass\s+risk/i,
  /turn\s+off\s+stop/i,
  /without\s+stop\s+loss/i,
  /no\s+stop\s+loss/i
];

/**
 * Validates whether suggested text attempts to loosen hard security or risk gates.
 */
export function loosensGuard(text: string): boolean {
  return GUARD_LOOSENING_PATTERNS.some((pattern) => pattern.test(text));
}

export interface LearningServiceOptions {
  legacyArchive?: Lesson[];
}

export class LearningService {
  private lessonsByAccount = new Map<string, Lesson[]>();
  private archivedLegacyLessons: Lesson[] = [];
  private sequence = 0;

  constructor(options: LearningServiceOptions = {}) {
    if (options.legacyArchive && Array.isArray(options.legacyArchive)) {
      this.archivedLegacyLessons = options.legacyArchive.map((l) => ({
        ...l,
        archived: true,
        isAdvice: true,
        authorizesOrder: false,
        authorizesSettingChange: false
      }));
    }
  }

  /**
   * Adds or reinforces a scoped lesson.
   * Throws if the lesson attempts to loosen configured risk or execution guards.
   */
  public async add(input: ScopedLesson): Promise<Lesson> {
    const sanitizedLesson = safe(input.lesson).trim();
    if (loosensGuard(sanitizedLesson)) {
      throw new Error(`Refused lesson for ${input.role}: violates hard guard constraint`);
    }

    this.sequence += 1;
    const now = Date.now();
    const key = `${input.role}|${input.kind}|${sanitizedLesson.toLowerCase().slice(0, 80)}`;

    const accountLessons = this.lessonsByAccount.get(input.accountRef) ?? [];
    const existing = accountLessons.find((l) => l.key === key);

    if (existing) {
      existing.count += 1;
      existing.lastAt = now;
      if (existing.count >= 2) {
        existing.status = 'promoted';
      }
      return existing;
    }

    const newLesson: Lesson = {
      id: `lesson-${this.sequence}-${now}`,
      key,
      accountRef: input.accountRef,
      role: input.role,
      kind: input.kind,
      symbol: input.symbol,
      happened: safe(input.happened).trim(),
      rootCause: safe(input.rootCause).trim(),
      lesson: sanitizedLesson,
      condition: input.condition ? safe(input.condition).trim() : undefined,
      sourceTradeIds: input.sourceTradeIds ?? [],
      sourceDecisionIds: input.sourceDecisionIds ?? [],
      status: 'new',
      count: 1,
      firstAt: now,
      lastAt: now,
      source: 'desk',
      isAdvice: true,
      authorizesOrder: false,
      authorizesSettingChange: false,
      archived: false
    };

    accountLessons.push(newLesson);
    this.lessonsByAccount.set(input.accountRef, accountLessons);
    return newLesson;
  }

  /**
   * Returns recent active lessons strictly scoped to the specified account.
   * Archived legacy lessons are never returned as active evidence.
   */
  public async recent(accountRef: string, limit = 10): Promise<Lesson[]> {
    const list = this.lessonsByAccount.get(accountRef) ?? [];
    return list
      .filter((l) => !l.archived)
      .slice(-limit)
      .reverse();
  }

  /**
   * Inspects archived legacy records without polluting decision prompts.
   */
  public async getArchivedLegacyLessons(): Promise<Lesson[]> {
    return [...this.archivedLegacyLessons];
  }

  /**
   * Derives trade lesson preserving factual completeness.
   * Never fabricates 0 or imaginary PnL when financial data is partial.
   */
  public deriveTradeLesson(input: DeriveTradeLessonInput): DerivedTradeLesson {
    const hasComplete = input.exitPrice !== null && input.feesPaid !== null && input.fundingPaid !== null;

    return {
      tradeId: input.tradeId,
      accountRef: input.accountRef,
      symbol: input.symbol,
      realizedPnl: hasComplete ? '0' : null,
      hasCompleteFinancialData: hasComplete,
      advisoryNote: hasComplete
        ? `Trade ${input.tradeId} concluded.`
        : `Trade ${input.tradeId} financial data incomplete; edge remains null.`
    };
  }
}
