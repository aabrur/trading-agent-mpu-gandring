import type { NewsItem } from '../types.js';

export type NewsCategory =
  | 'macro'
  | 'fed'
  | 'cpi'
  | 'geopolitics'
  | 'regulation'
  | 'etf'
  | 'listing_delisting'
  | 'exchange_status'
  | 'blockchain_outage'
  | 'exploit_hack'
  | 'token_unlock'
  | 'token_burn'
  | 'stablecoin'
  | 'protocol_governance'
  | 'general_market';

export type EvidenceStatus = 'VERIFIED' | 'REPORTED' | 'UNAVAILABLE';
export type NewsFreshness = 'fresh' | 'stale' | 'archived' | 'unknown';
export type ClaimVerification = 'verified' | 'reported_claim' | 'inferred' | 'unavailable' | 'sample';

export interface NormalizedNewsEvent {
  id: string;
  title: string;
  source: string;
  sourceUrl: string | null;
  publishedAt: number | null;
  observedAt: number;
  affectedAssets: string[];
  category: NewsCategory;
  evidenceStatus: EvidenceStatus;
  impactAssessment: string;
  sentiment: 'bullish' | 'bearish' | 'neutral' | 'severe';
  freshness: NewsFreshness;
  duplicateGroup: string | null;
  provider: 'cryptopanic' | 'rss' | 'sample' | 'unconfigured';
  example: boolean;
  flagged?: boolean;
}

export interface NewsBriefing {
  symbol: string;
  providerStatus: 'CONFIGURED_LIVE' | 'SAMPLE_FALLBACK' | 'UNAVAILABLE' | 'UNCONFIGURED';
  events: NormalizedNewsEvent[];
  criticalVetoFound: boolean;
  criticalClaimFound: boolean;
  vetoReason: string | null;
  summary: string;
  observedAt: number;
}

// Normalize headline strings into a slug to identify duplicates
const FRESH_MS = 6 * 60 * 60 * 1000;
const STALE_MS = 48 * 60 * 60 * 1000;

export function parsePublishedAt(value: unknown): number | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? Math.round(value * 1000) : value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+(\.\d+)?$/.test(trimmed)) return parsePublishedAt(Number(trimmed));
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

export function newsFreshness(publishedAt: number | null, now: number = Date.now()): NewsFreshness {
  if (publishedAt == null || !Number.isFinite(publishedAt) || publishedAt <= 0) return 'unknown';
  const age = now - publishedAt;
  if (age < 0) return 'unknown';
  if (age <= FRESH_MS) return 'fresh';
  if (age <= STALE_MS) return 'stale';
  return 'archived';
}

export function titleSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 80);
}

export function coinOf(symbol: string): string {
  return symbol.replace(/USDT?$|USDC$/i, '').toUpperCase();
}

export function eventRelevantToSymbol(event: NormalizedNewsEvent, symbol: string): boolean {
  const coin = coinOf(symbol);
  if (!event.affectedAssets.length) return false;
  return event.affectedAssets.some((a) => {
    const asset = a.replace(/USDT?$|USDC$/i, '').toUpperCase();
    return asset === coin || asset === '*' || asset === 'CRYPTO' || asset === 'MARKET';
  });
}

export function categorizeNews(text: string): NewsCategory {
  const t = text.toLowerCase();
  if (/\b(hack|exploit|drained|stolen|breach|reentrancy|vulnerability|rugpull|phishing)\b/.test(t)) return 'exploit_hack';
  if (/\b(outage|halt|halted|suspended|downtime|offline|chain halt|reorg)\b/.test(t)) return 'blockchain_outage';
  if (/\b(sec|cftc|doj|lawsuit|indictment|subpoena|regulatory|ban|banned|crackdown)\b/.test(t)) return 'regulation';
  if (/\b(delist|delisting|delisted)\b/.test(t)) return 'listing_delisting';
  if (/\b(depeg|depegged|usdt|usdc|dai|stablecoin|mint|burn|redemption)\b/.test(t)) return 'stablecoin';
  if (/\b(etf|inflow|outflow|blackrock|fidelity|grayscale|spot etf)\b/.test(t)) return 'etf';
  if (/\b(fed|fomc|rate hike|rate cut|interest rate|powell|central bank)\b/.test(t)) return 'fed';
  if (/\b(cpi|ppi|inflation|jobs report|nonfarm|unemployment|gdp)\b/.test(t)) return 'cpi';
  if (/\b(unlock|vesting|cliff|token unlock)\b/.test(t)) return 'token_unlock';
  if (/\b(war|sanctions|geopolitical|tariff|conflict|strait)\b/.test(t)) return 'geopolitics';
  if (/\b(insolvent|insolvency|bankrupt|bankruptcy|ch 11)\b/.test(t)) return 'exchange_status';
  if (/\b(governance|dao|proposal|vote|voting)\b/.test(t)) return 'protocol_governance';
  if (/\b(macro|treasury|liquidity|yield curve)\b/.test(t)) return 'macro';
  return 'general_market';
}

// Assess potential impact and whether a critical VETO is warranted
export function assessImpact(category: NewsCategory, sentiment: string, title: string): {
  impactAssessment: string;
  isVeto: boolean;
  isVetoCandidate: boolean;
  verification: ClaimVerification;
  vetoReason: string | null;
} {
  const reported = (impactAssessment: string, vetoReason: string) => ({
    impactAssessment,
    isVeto: true,
    isVetoCandidate: true,
    verification: 'reported_claim' as const,
    vetoReason
  });
  if (category === 'exploit_hack') {
    return reported('High severe negative risk. Exploit or security compromise reported, not independently verified by this desk.', `Security exploit or hack reported: ${title.slice(0, 80)}`);
  }
  if (category === 'blockchain_outage') {
    return reported('Network halt or infrastructure failure reported. Liquidity and settlement may be impaired.', `Chain outage or trading halt reported: ${title.slice(0, 80)}`);
  }
  if (category === 'listing_delisting' && sentiment === 'severe') {
    return reported('Asset delisting claim. Structural liquidity removal if confirmed.', `Delisting event reported: ${title.slice(0, 80)}`);
  }
  if (category === 'stablecoin' && sentiment === 'severe') {
    return reported('Severe stablecoin depeg warning. Collateral risk elevated if confirmed.', `Critical stablecoin instability reported: ${title.slice(0, 80)}`);
  }
  if (category === 'regulation' || category === 'fed' || category === 'macro') {
    return {
      impactAssessment: 'High-volatility macroeconomic or regulatory driver. Directional catalyst.',
      isVeto: false,
      isVetoCandidate: false,
      verification: 'reported_claim',
      vetoReason: null
    };
  }
  return {
    impactAssessment: 'Moderate catalyst event. Price context required.',
    isVeto: false,
    isVetoCandidate: false,
    verification: 'reported_claim',
    vetoReason: null
  };
}

// Deduplicate headlines using slug matching and temporal clustering
export function deduplicateEvents(events: NormalizedNewsEvent[]): NormalizedNewsEvent[] {
  const seen = new Map<string, NormalizedNewsEvent>();
  for (const ev of events) {
    const slug = titleSlug(ev.title);
    if (!seen.has(slug)) {
      ev.duplicateGroup = slug;
      seen.set(slug, ev);
    } else {
      const existing = seen.get(slug)!;
      // If the incoming event is VERIFIED and existing is not, prioritize verified
      if (ev.evidenceStatus === 'VERIFIED' && existing.evidenceStatus !== 'VERIFIED') {
        seen.set(slug, ev);
      }
    }
  }
  return Array.from(seen.values());
}

// Convert legacy NewsItem into NormalizedNewsEvent
export function normalizeLegacyItem(item: NewsItem, symbol: string, now: number = Date.now()): NormalizedNewsEvent {
  const cat = categorizeNews(`${item.headline} ${item.body}`);
  const { impactAssessment } = assessImpact(cat, item.sentiment, item.headline);
  const status: EvidenceStatus = item.example ? 'UNAVAILABLE' : 'REPORTED';
  const publishedAt = parsePublishedAt(item.publishedAt);
  return {
    id: item.id,
    title: item.headline,
    source: item.source,
    sourceUrl: item.sourceUrl ?? null,
    publishedAt,
    observedAt: now,
    affectedAssets: [coinOf(symbol)],
    category: cat,
    evidenceStatus: status,
    impactAssessment,
    sentiment: item.sentiment,
    freshness: newsFreshness(publishedAt, now),
    duplicateGroup: titleSlug(item.headline),
    provider: item.example ? 'sample' : 'cryptopanic',
    example: item.example,
    flagged: item.flagged
  };
}

// Produce a unified news briefing for a symbol
function canAutoVeto(ev: NormalizedNewsEvent, symbol: string): { ok: boolean; reason: string | null } {
  if (ev.example || ev.provider === 'sample') return { ok: false, reason: null };
  if (ev.evidenceStatus !== 'VERIFIED') return { ok: false, reason: null };
  if (ev.freshness !== 'fresh') return { ok: false, reason: null };
  if (!eventRelevantToSymbol(ev, symbol)) return { ok: false, reason: null };
  const { isVetoCandidate, vetoReason } = assessImpact(ev.category, ev.sentiment, ev.title);
  if (!isVetoCandidate) return { ok: false, reason: null };
  return { ok: true, reason: vetoReason };
}

export function buildNewsBriefing(symbol: string, events: NormalizedNewsEvent[], providerStatus: NewsBriefing['providerStatus']): NewsBriefing {
  const deduped = deduplicateEvents(events);
  let criticalVetoFound = false;
  let criticalClaimFound = false;
  let vetoReason: string | null = null;

  for (const ev of deduped) {
    const { isVetoCandidate, vetoReason: vr } = assessImpact(ev.category, ev.sentiment, ev.title);
    if (isVetoCandidate && ev.evidenceStatus !== 'UNAVAILABLE' && !ev.example) {
      criticalClaimFound = true;
    }
    const auto = canAutoVeto(ev, symbol);
    if (auto.ok) {
      criticalVetoFound = true;
      vetoReason = auto.reason;
      break;
    }
    if (isVetoCandidate && !vetoReason) vetoReason = vr;
  }

  const claimNote = criticalVetoFound
    ? ` [CRITICAL VETO: ${vetoReason}]`
    : criticalClaimFound
      ? ` [CRITICAL CLAIM, unverified: ${vetoReason}]`
      : '';
  const summary = deduped.length === 0
    ? `No active news catalysts recorded for ${symbol}. Provider status: ${providerStatus}.`
    : `${deduped.length} catalyst(s) processed. Provider: ${providerStatus}. Top headline: "${deduped[0].title.slice(0, 90)}"${claimNote}`;

  return {
    symbol,
    providerStatus,
    events: deduped,
    criticalVetoFound,
    criticalClaimFound,
    vetoReason: criticalVetoFound || criticalClaimFound ? vetoReason : null,
    summary,
    observedAt: Date.now()
  };
}
