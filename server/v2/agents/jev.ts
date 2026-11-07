import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { registerSecrets, safe } from '../../redact.js';

// JevReview carries zero permission, approval or veto fields.
export interface JevReview {
  status: 'completed' | 'disabled' | 'unavailable';
  reviewId: string;
  claimRefs: string[];
  contraryRefs: string[];
  reason: string | null;
  market_regime?: string | null;
}

export interface JevReviewInput {
  cycleId: string;
  symbol: string;
  evidenceId: string;
  state: unknown;
}

export interface JevClientOptions {
  enabled: boolean;
  apiKey?: string | null;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  fallbackCaller?: (prompt: string, systemPrompt?: string) => Promise<string | null>;
}

const SECRET_FIELD_RE = /(key|secret|token|password|private|authorization|seed|mnemonic|webhook)/i;

export function sanitizeJevPayload(input: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (input === null || input === undefined) return input;
  if (typeof input === 'string') return input.length > 1000 ? `${input.slice(0, 1000)}...` : input;
  if (typeof input === 'number' || typeof input === 'boolean') return input;
  if (Array.isArray(input)) return input.slice(0, 16).map((item) => sanitizeJevPayload(item, depth + 1));
  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (SECRET_FIELD_RE.test(k)) continue;
      out[k] = sanitizeJevPayload(v, depth + 1);
    }
    return out;
  }
  return String(input).slice(0, 200);
}

const RemoteJevPayloadSchema = z
  .object({
    reviewId: z.string().min(1).optional(),
    market_regime: z.string().optional(),
    claimRefs: z.array(z.string()).default([]),
    contraryRefs: z.array(z.string()).default([]),
    reason: z.string().nullable().optional()
  })
  .passthrough();

export class JevClient {
  private readonly enabled: boolean;
  private readonly apiKey: string | null;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly fallbackCaller?: (prompt: string, systemPrompt?: string) => Promise<string | null>;
  private requests = 0;
  private success = 0;
  private errors = 0;
  private timeouts = 0;
  private lastLatencyMs: number | null = null;
  private lastError: string | null = null;
  private lastSource: 'remote' | 'heuristic' | 'disabled' = 'disabled';
  private lastCost: number | null = null;

  constructor(options: JevClientOptions) {
    this.enabled = options.enabled;
    this.apiKey = options.apiKey?.trim() || null;
    this.model = (options.model ?? 'typesafe/jev-1.14').trim();
    if (!options.endpoint) {
      this.endpoint = this.model.startsWith('typesafe/jev')
        ? 'https://openrouter.ai/api/alpha/decisions'
        : 'https://openrouter.ai/api/v1/chat/completions';
    } else {
      this.endpoint = options.endpoint.trim();
    }
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.fallbackCaller = options.fallbackCaller;

    if (this.apiKey) {
      registerSecrets([this.apiKey]);
    }
  }

  telemetry(): {
    configHealth: 'off' | 'unconfigured' | 'configured';
    remoteHealth: 'unused' | 'ok' | 'timeout' | 'error' | 'heuristic';
    requests: number;
    success: number;
    errors: number;
    timeouts: number;
    lastLatencyMs: number | null;
    lastModel: string;
    lastError: string | null;
    lastSource: 'remote' | 'heuristic' | 'disabled';
    lastCost: number | null;
  } {
    const configHealth = !this.enabled ? 'off' : this.apiKey ? 'configured' : 'unconfigured';
    const remoteHealth =
      this.lastSource === 'disabled'
        ? 'unused'
        : this.lastSource === 'heuristic'
          ? (this.timeouts > 0 && this.lastError?.toLowerCase().includes('timeout') ? 'timeout' : 'heuristic')
          : this.lastSource === 'remote'
            ? 'ok'
            : 'unused';
    return {
      configHealth,
      remoteHealth: this.timeouts > 0 && this.lastSource === 'heuristic' && (this.lastError ?? '').toLowerCase().includes('abort')
        ? 'timeout'
        : remoteHealth,
      requests: this.requests,
      success: this.success,
      errors: this.errors,
      timeouts: this.timeouts,
      lastLatencyMs: this.lastLatencyMs,
      lastModel: this.model,
      lastError: this.lastError,
      lastSource: this.lastSource,
      lastCost: this.lastCost
    };
  }

  async review(input: JevReviewInput): Promise<JevReview> {
    const fallbackId = `jev-${randomUUID()}`;
    if (!this.enabled) {
      this.lastSource = 'disabled';
      return {
        status: 'disabled',
        reviewId: fallbackId,
        claimRefs: [],
        contraryRefs: [],
        reason: 'Jev review is disabled.',
        market_regime: 'NOT_YET_EVALUATED'
      };
    }

    if (!this.apiKey) {
      if (this.fallbackCaller) {
        return this.invokeFallback(input, fallbackId);
      }
      this.lastSource = 'heuristic';
      return this.evaluateHeuristic(input, fallbackId, 'Jev API key is not configured; using local heuristic');
    }

    const rawInputState = input.state as Record<string, unknown> | null | undefined;
    const isStructuredState = rawInputState && typeof rawInputState === 'object' && ('timeframes' in rawInputState || 'marketSummary' in rawInputState || 'observations' in rawInputState);
    const sanitizedState = sanitizeJevPayload(
      isStructuredState
        ? {
            cycleId: input.cycleId,
            symbol: input.symbol,
            evidenceId: input.evidenceId,
            ...rawInputState
          }
        : {
            cycleId: input.cycleId,
            symbol: input.symbol,
            evidenceId: input.evidenceId,
            state: input.state
          }
    );

    try {
      this.requests += 1;
      const started = Date.now();
      const isDecisions = this.endpoint.includes('/decisions') || this.model.startsWith('typesafe/jev');
      const systemPrompt = 'You are Jev, the trading desk objective evidence and market regime reviewer. Analyze market context and role observations. You carry ZERO execution or veto authority. Return JSON with keys: "reviewId", "market_regime" (one of TRENDING_BULL, TRENDING_BEAR, RANGING, VOLATILE, UNCERTAIN), "claimRefs" (array of strings), "contraryRefs" (array of strings), "reason" (concise string).';

      const reqBody = isDecisions
        ? JSON.stringify({
            model: this.model,
            state: [
              typeof sanitizedState === 'string' ? sanitizedState : JSON.stringify(sanitizedState)
            ],
            questions: {
              market_regime: {
                type: 'choice',
                instructions: 'Which market regime best describes the current market condition?',
                criteria: {
                  TRENDING_BULL: 'Higher-timeframe (1h/4h/1d) structure or momentum leans bullish (including pullbacks/retests within an uptrend)',
                  TRENDING_BEAR: 'Higher-timeframe (1h/4h/1d) structure or momentum leans bearish (including bounces/retests within a downtrend)',
                  RANGING: 'Price consolidating or mean-reverting between intraday support and resistance with mixed timeframe momentum',
                  VOLATILE: 'High-volatility expansion or wide liquidation wicks across timeframes',
                  UNCERTAIN: 'Corrupted, missing, or completely uninitialized market data only (never use UNCERTAIN for normal timeframe conflicts or consolidation)'
                }
              },
              contrary_risk: {
                type: 'noul',
                instructions: 'Is entering the current move high risk due to support/resistance exhaustion or reversal divergence?',
                criteria: {
                  true: 'High risk of adverse move or trapped entry',
                  false: 'Clean edge or continuation opportunity'
                }
              }
            }
          })
        : JSON.stringify({
            model: this.model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: JSON.stringify(sanitizedState) }
            ],
            response_format: { type: 'json_object' }
          });

      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`
        },
        body: reqBody,
        signal: AbortSignal.timeout(this.timeoutMs)
      });

      if (!res.ok) {
        this.errors += 1;
        this.lastLatencyMs = Date.now() - started;
        this.lastError = `Jev HTTP ${res.status}`;
        if (this.fallbackCaller) {
          return this.invokeFallback(input, fallbackId);
        }
        this.lastSource = 'heuristic';
        return this.evaluateHeuristic(input, fallbackId, `Jev HTTP ${res.status}`);
      }

      const rawJson: unknown = await res.json();
      if (rawJson && typeof rawJson === 'object' && 'answers' in rawJson) {
        const answers = (rawJson as {
          id?: string;
          answers?: {
            market_regime?: { choice?: string; confidence?: number };
            contrary_risk?: { noul?: number };
          };
          usage?: { cost?: number };
        }).answers;
        let regimeChoice = answers?.market_regime?.choice || 'RANGING';
        const rawState = input.state as any;
        const hasMarketData = Boolean(
          (rawState?.marketSummary && Object.keys(rawState.marketSummary).length > 0) ||
          (rawState?.timeframes && Object.keys(rawState.timeframes).length > 0) ||
          rawState?.lastPrice
        );
        if (regimeChoice === 'UNCERTAIN' && hasMarketData) {
          regimeChoice = 'RANGING';
        }
        const regimeConf = typeof answers?.market_regime?.confidence === 'number' ? answers.market_regime.confidence : null;
        const contraryRisk = typeof answers?.contrary_risk?.noul === 'number' ? answers.contrary_risk.noul : 0;
        const claimRefs = contraryRisk < 0.5 ? ['Jev: Low contrary risk confirmation'] : [];
        const contraryRefs = contraryRisk >= 0.7 ? ['Jev: Elevated contrary risk alert'] : [];
        const confStr = regimeConf !== null ? ` (confidence: ${(regimeConf * 100).toFixed(0)}%)` : '';
        const reason = `TypeSafe Jev: ${regimeChoice}${confStr} (informational context only, zero veto authority)`;
        this.success += 1;
        this.lastLatencyMs = Date.now() - started;
        this.lastError = null;
        this.lastSource = 'remote';
        const usageCost = (rawJson as { usage?: { cost?: unknown } })?.usage?.cost;
        this.lastCost = typeof usageCost === 'number' ? usageCost : null;
        return {
          status: 'completed',
          reviewId: (rawJson as { id?: string }).id ?? fallbackId,
          claimRefs,
          contraryRefs,
          reason,
          market_regime: regimeChoice
        };
      }

      let candidate: unknown = rawJson;
      if (
        rawJson &&
        typeof rawJson === 'object' &&
        'choices' in rawJson &&
        Array.isArray((rawJson as { choices?: Array<{ message?: { content?: unknown } }> }).choices)
      ) {
        const text = (rawJson as { choices: Array<{ message?: { content?: unknown } }> }).choices[0]?.message?.content;
        if (typeof text === 'string') {
          try {
            candidate = JSON.parse(text);
          } catch {
            candidate = rawJson;
          }
        }
      }

      const parsed = RemoteJevPayloadSchema.safeParse(candidate);
      if (!parsed.success) {
        this.errors += 1;
        this.lastLatencyMs = Date.now() - started;
        this.lastError = 'Jev response schema mismatch';
        this.lastSource = 'heuristic';
        return this.evaluateHeuristic(input, fallbackId, 'Jev response schema mismatch');
      }

      this.success += 1;
      this.lastLatencyMs = Date.now() - started;
      this.lastError = null;
      this.lastSource = 'remote';
      return {
        status: 'completed',
        reviewId: parsed.data.reviewId ?? fallbackId,
        claimRefs: parsed.data.claimRefs,
        contraryRefs: parsed.data.contraryRefs,
        reason: parsed.data.reason ?? null,
        ...(parsed.data.market_regime ? { market_regime: parsed.data.market_regime } : {})
      };
    } catch (err) {
      const message = safe(err instanceof Error ? err.message : 'Jev request failed');
      const timedOut = /timeout|abort/i.test(message);
      if (timedOut) this.timeouts += 1;
      else this.errors += 1;
      this.lastError = message;
      if (this.fallbackCaller) {
        return this.invokeFallback(input, fallbackId);
      }
      this.lastSource = 'heuristic';
      this.lastLatencyMs = this.timeoutMs;
      return this.evaluateHeuristic(input, fallbackId, message);
    }
  }

  private async invokeFallback(input: JevReviewInput, fallbackId: string): Promise<JevReview> {
    if (!this.fallbackCaller) {
      return this.evaluateHeuristic(input, fallbackId, 'No fallback caller configured');
    }
    const started = Date.now();
    try {
      this.requests += 1;
      const systemPrompt = 'You are Jev, the trading desk objective evidence and market regime reviewer. Analyze market context and role observations. You carry ZERO execution or veto authority. Return JSON with keys: "reviewId", "market_regime" (one of TRENDING_BULL, TRENDING_BEAR, RANGING, VOLATILE, UNCERTAIN), "claimRefs" (array of strings), "contraryRefs" (array of strings), "reason" (concise string).';
      const prompt = JSON.stringify(sanitizeJevPayload({
        cycleId: input.cycleId,
        symbol: input.symbol,
        evidenceId: input.evidenceId,
        state: input.state
      }));
      const raw = await this.fallbackCaller(prompt, systemPrompt);
      if (!raw) {
        this.errors += 1;
        this.lastSource = 'heuristic';
        return this.evaluateHeuristic(input, fallbackId, 'Fallback caller returned empty response');
      }
      let cleaned = raw.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      }
      const parsedJson = JSON.parse(cleaned);
      const validated = RemoteJevPayloadSchema.safeParse(parsedJson);
      if (!validated.success) {
        this.errors += 1;
        this.lastSource = 'heuristic';
        return this.evaluateHeuristic(input, fallbackId, 'Fallback caller response schema mismatch');
      }
      this.success += 1;
      this.lastLatencyMs = Date.now() - started;
      this.lastError = null;
      this.lastSource = 'remote';
      return {
        status: 'completed',
        reviewId: validated.data.reviewId ?? fallbackId,
        claimRefs: validated.data.claimRefs,
        contraryRefs: validated.data.contraryRefs,
        reason: validated.data.reason ?? null,
        ...(validated.data.market_regime ? { market_regime: validated.data.market_regime } : {})
      };
    } catch (err) {
      this.errors += 1;
      this.lastSource = 'heuristic';
      return this.evaluateHeuristic(input, fallbackId, `Fallback caller failed: ${(err as Error).message}`);
    }
  }

  private evaluateHeuristic(input: JevReviewInput, fallbackId: string, note: string): JevReview {
    const rawState = input.state as { observations?: Array<{ stance?: string }>; marketSummary?: { opposingFacts?: Array<{ code?: string }> } } | undefined;
    const obs = rawState?.observations ?? [];
    const bulls = obs.filter((o) => o.stance === 'LONG').length;
    const bears = obs.filter((o) => o.stance === 'SHORT').length;
    const regime = bulls > bears ? 'TRENDING_BULL' : bears > bulls ? 'TRENDING_BEAR' : (rawState?.marketSummary?.opposingFacts?.length ? 'RANGING' : 'UNCERTAIN');

    return {
      status: 'unavailable',
      reviewId: fallbackId,
      claimRefs: [`heuristic:bulls=${bulls}`, `heuristic:bears=${bears}`],
      contraryRefs: [],
      reason: `${note} · Local regime heuristic: ${regime}`,
      market_regime: regime
    };
  }
}
