import type { NewsItem } from '../types.js';
import { sanitizeUntrusted } from '../untrusted.js';
import { safe } from '../redact.js';

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
export type NewsFreshness = 'fresh' | 'stale' | 'archived';

export interface NormalizedNewsEvent {
  id: string;
  title: string;
  source: string;
  sourceUrl: string | null;
  publishedAt: number;
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
  vetoReason: string | null;
  summary: string;
  observedAt: number;
}

// Normalize headline strings into a slug to identify duplicates
export function titleSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 80);
}

// Categorize news based on keyword presence
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
export function assessImpact(category: NewsCategory, sentiment: string, title: string): { impactAssessment: string; isVeto: boolean; vetoReason: string | null } {
  if (category === 'exploit_hack') {
    return {
      impactAssessment: 'High severe negative risk. Exploit or security compromise reported.',
      isVeto: true,
      vetoReason: `Security exploit or hack reported: ${title.slice(0, 80)}`
    };
  }
  if (category === 'blockchain_outage') {
    return {
      impactAssessment: 'Network halt or infrastructure failure. Liquidity and settlement impaired.',
      isVeto: true,
      vetoReason: `Chain outage or trading halt reported: ${title.slice(0, 80)}`
    };
  }
  if (category === 'listing_delisting' && sentiment === 'severe') {
    return {
      impactAssessment: 'Asset delisting event. Structural liquidity removal.',
      isVeto: true,
      vetoReason: `Delisting event reported: ${title.slice(0, 80)}`
    };
  }
  if (category === 'stablecoin' && sentiment === 'severe') {
    return {
      impactAssessment: 'Severe stablecoin depeg warning. Collateral risk elevated.',
      isVeto: true,
      vetoReason: `Critical stablecoin instability reported: ${title.slice(0, 80)}`
    };
  }
  if (category === 'regulation' || category === 'fed' || category === 'macro') {
    return {
      impactAssessment: 'High-volatility macroeconomic or regulatory driver. Directional catalyst.',
      isVeto: false,
      vetoReason: null
    };
  }
  return {
    impactAssessment: 'Moderate catalyst event. Price context required.',
    isVeto: false,
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
export function normalizeLegacyItem(item: NewsItem, symbol: string): NormalizedNewsEvent {
  const now = Date.now();
  const cat = categorizeNews(`${item.headline} ${item.body}`);
  const { impactAssessment, isVeto, vetoReason } = assessImpact(cat, item.sentiment, item.headline);
  const status: EvidenceStatus = item.example ? 'UNAVAILABLE' : 'REPORTED';
  return {
    id: item.id,
    title: item.headline,
    source: item.source,
    sourceUrl: null,
    publishedAt: now,
    observedAt: now,
    affectedAssets: [symbol.replace(/USDT?$|USDC$/, '')],
    category: cat,
    evidenceStatus: status,
    impactAssessment,
    sentiment: item.sentiment,
    freshness: 'fresh',
    duplicateGroup: titleSlug(item.headline),
    provider: item.example ? 'sample' : 'cryptopanic',
    example: item.example,
    flagged: item.flagged
  };
}

// Produce a unified news briefing for a symbol
export function buildNewsBriefing(symbol: string, events: NormalizedNewsEvent[], providerStatus: NewsBriefing['providerStatus']): NewsBriefing {
  const deduped = deduplicateEvents(events);
  let criticalVetoFound = false;
  let vetoReason: string | null = null;

  for (const ev of deduped) {
    const { isVeto, vetoReason: vr } = assessImpact(ev.category, ev.sentiment, ev.title);
    if (isVeto && ev.evidenceStatus !== 'UNAVAILABLE') {
      criticalVetoFound = true;
      vetoReason = vr;
      break;
    }
  }

  const summary = deduped.length === 0
    ? `No active news catalysts recorded for ${symbol}. Provider status: ${providerStatus}.`
    : `${deduped.length} catalyst(s) processed. Provider: ${providerStatus}. Top headline: "${deduped[0].title.slice(0, 90)}"${criticalVetoFound ? ` [CRITICAL VETO: ${vetoReason}]` : ''}`;

  return {
    symbol,
    providerStatus,
    events: deduped,
    criticalVetoFound,
    vetoReason,
    summary,
    observedAt: Date.now()
  };
}
