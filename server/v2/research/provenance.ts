import { createHash, randomUUID } from 'node:crypto';
import { sanitizeUntrusted } from '../../untrusted.js';
import type { Availability, Certainty, Freshness } from '../contracts.js';

export interface ResearchFinding {
  id: string;
  claim: string;
  url: string;
  publisher: string | null;
  publishedAt: number | null;
  eventAt: number | null;
  observedAt: number;
  metricWindow: string | null;
  certainty: Certainty;
  availability: Availability;
  freshness: Freshness;
  excerptHash: string;
}

export interface NormalizeResearchFindingInput {
  id?: string;
  claim: string;
  url: string;
  publisher?: string | null;
  publishedAt?: number | null;
  eventAt?: number | null;
  observedAt?: number;
  metricWindow?: string | null;
  certainty?: Certainty;
  availability?: Availability;
  maxFreshAgeMs?: number;
}

const DEFAULT_MAX_FRESH_AGE_MS = 24 * 60 * 60 * 1000;

function validTimestamp(ts: number | null | undefined): number | null {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) {
    return null;
  }
  return Math.trunc(ts);
}

export function normalizeClaimForHash(claim: string): string {
  return claim
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function computeExcerptHash(claim: string): string {
  return createHash('sha256').update(normalizeClaimForHash(claim), 'utf8').digest('hex');
}

export function classifyFindingFreshness(params: {
  publishedAt: number | null;
  eventAt: number | null;
  observedAt: number;
  maxFreshAgeMs?: number;
}): Freshness {
  const maxFreshAgeMs = params.maxFreshAgeMs ?? DEFAULT_MAX_FRESH_AGE_MS;
  const { publishedAt, eventAt, observedAt } = params;

  if (publishedAt === null && eventAt === null) {
    return 'UNKNOWN';
  }

  // Event age takes precedence over article publish time so a new article
  // summarizing an old event cannot masquerade as a current catalyst.
  const effectiveTime = eventAt ?? publishedAt;
  if (effectiveTime === null) {
    return 'UNKNOWN';
  }

  if (observedAt - effectiveTime > maxFreshAgeMs) {
    return 'STALE';
  }

  if (publishedAt !== null && observedAt - publishedAt > maxFreshAgeMs) {
    return 'STALE';
  }

  return 'CURRENT';
}

export function normalizeResearchFinding(input: NormalizeResearchFindingInput): ResearchFinding {
  const observedAt = validTimestamp(input.observedAt) ?? Date.now();
  const publishedAt = validTimestamp(input.publishedAt);
  const eventAt = validTimestamp(input.eventAt);
  const sanitized = sanitizeUntrusted(input.claim, 4000);
  const cleanClaim = sanitized.text.trim();
  const freshness = classifyFindingFreshness({
    publishedAt,
    eventAt,
    observedAt,
    maxFreshAgeMs: input.maxFreshAgeMs
  });

  // Undated claims cannot be treated as verified primary facts.
  let certainty: Certainty = input.certainty ?? 'REPORTED';
  if (publishedAt === null && eventAt === null && certainty === 'VERIFIED') {
    certainty = 'REPORTED';
  }

  return {
    id: input.id ?? `rf-${randomUUID()}`,
    claim: cleanClaim,
    url: input.url.trim(),
    publisher: input.publisher?.trim() || null,
    publishedAt,
    eventAt,
    observedAt,
    metricWindow: input.metricWindow?.trim() || null,
    certainty,
    availability: input.availability ?? 'AVAILABLE',
    freshness,
    excerptHash: computeExcerptHash(cleanClaim)
  };
}

/**
 * Deduplicate syndicated or repeated stories by normalized claim digest.
 * Repetition across multiple secondary outlets never upgrades REPORTED or INFERRED to VERIFIED.
 */
export function dedupeResearchFindings(findings: readonly ResearchFinding[]): ResearchFinding[] {
  const byHash = new Map<string, ResearchFinding>();
  for (const item of findings) {
    const existing = byHash.get(item.excerptHash);
    if (!existing) {
      byHash.set(item.excerptHash, { ...item });
      continue;
    }
    const existingAnchor = existing.eventAt ?? existing.publishedAt ?? Number.MAX_SAFE_INTEGER;
    const candidateAnchor = item.eventAt ?? item.publishedAt ?? Number.MAX_SAFE_INTEGER;
    if (candidateAnchor < existingAnchor) {
      byHash.set(item.excerptHash, {
        ...item,
        certainty: existing.certainty === 'VERIFIED' || item.certainty === 'VERIFIED'
          ? 'VERIFIED'
          : existing.certainty
      });
    }
  }
  return [...byHash.values()];
}
