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

  constructor(options: JevClientOptions) {
    this.enabled = options.enabled;
    this.apiKey = options.apiKey?.trim() || null;
    this.endpoint = (options.endpoint ?? 'https://openrouter.ai/api/v1/chat/completions').trim();
    this.model = (options.model ?? 'openai/gpt-5-mini').trim();
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? fetch;

    if (this.apiKey) {
      registerSecrets([this.apiKey]);
    }
  }

  async review(input: JevReviewInput): Promise<JevReview> {
    const fallbackId = `jev-${randomUUID()}`;
    if (!this.enabled) {
      return {
        status: 'disabled',
        reviewId: fallbackId,
        claimRefs: [],
        contraryRefs: [],
        reason: 'Jev review is disabled.'
      };
    }

    if (!this.apiKey) {
      return {
        status: 'unavailable',
        reviewId: fallbackId,
        claimRefs: [],
        contraryRefs: [],
        reason: 'Jev API key is not configured.'
      };
    }

    const sanitizedState = sanitizeJevPayload({
      cycleId: input.cycleId,
      symbol: input.symbol,
      evidenceId: input.evidenceId,
      state: input.state
    });

    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          state: sanitizedState
        }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });

      if (!res.ok) {
        return {
          status: 'unavailable',
          reviewId: fallbackId,
          claimRefs: [],
          contraryRefs: [],
          reason: `Jev HTTP ${res.status}`
        };
      }

      const rawJson: unknown = await res.json();
      let candidate: unknown = rawJson;
      if (
        rawJson &&
        typeof rawJson === 'object' &&
        'choices' in rawJson &&
        Array.isArray((rawJson as { choices?: Array<{ message?: { content?: unknown } }> }).choices)
      ) {
        const text = (rawJson as { choices: Array<{ message?: { content?: unknown } }> }).choices[0]?.message?.content;
        if (typeof text === 'string') {
          candidate = JSON.parse(text);
        }
      }

      const parsed = RemoteJevPayloadSchema.safeParse(candidate);
      if (!parsed.success) {
        return {
          status: 'unavailable',
          reviewId: fallbackId,
          claimRefs: [],
          contraryRefs: [],
          reason: 'Jev response failed schema validation.'
        };
      }

      // Explicitly return only the five non-permission fields.
      return {
        status: 'completed',
        reviewId: parsed.data.reviewId ?? fallbackId,
        claimRefs: parsed.data.claimRefs,
        contraryRefs: parsed.data.contraryRefs,
        reason: parsed.data.reason ?? null
      };
    } catch (err) {
      return {
        status: 'unavailable',
        reviewId: fallbackId,
        claimRefs: [],
        contraryRefs: [],
        reason: safe(err instanceof Error ? err.message : 'Jev request failed')
      };
    }
  }
}
