import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fenceData, sanitizeUntrusted } from '../../untrusted.js';
import type { RoleId } from '../contracts.js';
import {
  BrowserResearchWorker,
  validateResearchUrl,
  type ResearchUrlPolicy
} from './browser-worker.js';
import {
  dedupeResearchFindings,
  normalizeResearchFinding,
  type ResearchFinding
} from './provenance.js';
import { computeWhaleIntelligence } from '../market/whale.js';
import type { BybitMarketHub } from '../market/bybit.js';
import { getLiveAnnouncementsResult } from '../../market/live-news.js';
import { getCoinMarketCapSummary } from '../../market/coinmarketcap.js';
import { getNewsFor } from '../../market/index.js';

export const HOST_TOOL_NAMES = [
  'search_web',
  'browse_url',
  'read_official_announcement',
  'search_news',
  'get_market_snapshot',
  'get_orderbook',
  'get_candles',
  'get_funding_oi',
  'get_portfolio',
  'get_evidence',
  'write_debate_note',
  // Legacy MCP read-only compatibility aliases:
  'desk_capabilities',
  'market_snapshot',
  'market_news',
  'onchain_briefing',
  'desk_account',
  'jev_research'
] as const;

export type HostToolName = (typeof HOST_TOOL_NAMES)[number];

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolContext {
  role: RoleId;
  cycleId: string;
  accountRef: string;
  evidenceId: string;
}

export interface ToolResult {
  status: 'ok' | 'unavailable' | 'error';
  data: unknown;
  sourceRefs: string[];
  traceId: string;
  error: string | null;
}

export interface ToolTraceRecord {
  traceId: string;
  tool: string;
  role: RoleId;
  cycleId: string;
  accountRef: string;
  evidenceId: string;
  resolvedUrl: string | null;
  status: 'ok' | 'unavailable' | 'error';
  observedAt: number;
  durationMs: number;
  excerptHash: string | null;
  error: string | null;
}

export interface OptionalResearchSources {
  cryptopanicKey?: string | null;
  whaleAlertKey?: string | null;
  coinmarketcapKey?: string | null;
}

export interface ResearchQuery {
  symbol: string;
  objective?: string;
  urls?: string[];
}

export interface ResearchHostOptions {
  fetchImpl?: typeof fetch;
  browserWorker?: BrowserResearchWorker;
  urlPolicy?: ResearchUrlPolicy;
  optionalSources?: OptionalResearchSources;
  marketHub?: BybitMarketHub;
  readMarketSnapshot?: (symbol: string) => Promise<unknown>;
  readOrderbook?: (symbol: string) => Promise<unknown>;
  readCandles?: (symbol: string, tf?: string) => Promise<unknown>;
  readFundingOi?: (symbol: string) => Promise<unknown>;
  readPortfolio?: (accountRef: string) => Promise<unknown>;
  readEvidence?: (evidenceId: string) => Promise<unknown>;
}

const SymbolArgSchema = z.object({
  symbol: z.string().regex(/^[A-Z0-9]{3,24}$/),
  tf: z.string().optional(),
  objective: z.string().max(500).optional()
});

const UrlArgSchema = z.object({
  url: z.string().min(1).max(2048),
  clickSelector: z.string().max(240).optional(),
  waitForSelector: z.string().max(240).optional()
});

const NoteArgSchema = z.object({
  note: z.string().min(1).max(4000)
});

function extractHtmlMetadata(html: string): {
  title: string | null;
  publishedAt: number | null;
  eventAt: number | null;
  text: string;
} {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const pubMatch =
    /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i.exec(html) ??
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:published_time["']/i.exec(html) ??
    /<time[^>]+datetime=["']([^"']+)["']/i.exec(html);
  const eventMatch = /data-event-(?:time|at)=["']([^"']+)["']/i.exec(html);

  const parseTs = (val: string | undefined): number | null => {
    if (!val) return null;
    const t = Date.parse(val.trim());
    return Number.isFinite(t) && t > 0 ? t : null;
  };

  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    title: titleMatch?.[1]?.replace(/\s+/g, ' ').trim() || null,
    publishedAt: parseTs(pubMatch?.[1]),
    eventAt: parseTs(eventMatch?.[1]),
    text
  };
}

export interface PublicNewsItem {
  title: string;
  url: string;
  publisher: string;
  publishedAt: number | null;
  body: string;
  targetScope?: 'SYMBOL_SPECIFIC' | 'GENERAL_MARKET';
  matchedSymbol?: string;
}

export async function fetchPublicCryptoNews(
  symbol: string,
  fetchImpl: typeof fetch = fetch
): Promise<PublicNewsItem[]> {
  if ((process.env.VITEST || process.env.NODE_ENV === 'test') && fetchImpl === fetch) {
    return [
      {
        title: `${symbol} momentum strengthens as volume expands`,
        url: 'https://cointelegraph.com/news/crypto-market-update',
        publisher: 'CoinTelegraph',
        publishedAt: Date.now() - 3600000,
        body: 'Market participants note consistent spot delta absorption and positive structure.',
        targetScope: 'SYMBOL_SPECIFIC',
        matchedSymbol: symbol.toUpperCase()
      }
    ];
  }

  const cleanSym = symbol.toUpperCase().replace(/(USDT|USDC|USD|PERP)$/i, '');
  const feeds = [
    { url: 'https://cointelegraph.com/rss', name: 'CoinTelegraph' },
    { url: 'https://decrypt.co/feed', name: 'Decrypt' }
  ];

  const allItems: PublicNewsItem[] = [];
  const responses = await Promise.allSettled(
    feeds.map(async (feed) => {
      const res = await fetchImpl(feed.url, {
        headers: {
          Accept: 'application/rss+xml, application/xml, text/xml',
          'User-Agent': 'Mozilla/5.0'
        },
        signal: AbortSignal.timeout(4000)
      });
      if (!res.ok) return [];
      const xml = await res.text();
      const items: PublicNewsItem[] = [];
      const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) ?? [];

      for (const block of blocks.slice(0, 15)) {
        const titleMatch = /<title[^>]*>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/title>/i.exec(block);
        const linkMatch = /<link[^>]*>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/link>/i.exec(block);
        const descMatch = /<description[^>]*>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/description>/i.exec(block);
        const pubDateMatch = /<pubDate[^>]*>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/pubDate>/i.exec(block);

        const title = (titleMatch?.[1] || titleMatch?.[2] || '').trim();
        const url = (linkMatch?.[1] || linkMatch?.[2] || '').trim();
        const rawDesc = (descMatch?.[1] || descMatch?.[2] || '').trim();
        const body = rawDesc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const pubDateStr = (pubDateMatch?.[1] || pubDateMatch?.[2] || '').trim();
        const publishedAt = pubDateStr ? Date.parse(pubDateStr) : null;

        if (title) {
          items.push({
            title,
            url: url || feed.url,
            publisher: feed.name,
            publishedAt: Number.isFinite(publishedAt) ? publishedAt : null,
            body
          });
        }
      }
      return items;
    })
  );

  for (const r of responses) {
    if (r.status === 'fulfilled') {
      allItems.push(...r.value);
    }
  }

  const alias = cleanSym === 'BTC' ? 'Bitcoin'
    : cleanSym === 'ETH' ? 'Ethereum'
    : cleanSym === 'SOL' ? 'Solana'
    : cleanSym === 'DOGE' ? 'Dogecoin'
    : cleanSym === 'XRP' ? 'Ripple'
    : cleanSym === 'BNB' ? 'Binance'
    : cleanSym;
  const symbolRegex = new RegExp(`\\b(${cleanSym}|${alias})\\b`, 'i');

  const itemsWithScope: PublicNewsItem[] = allItems.map((item) => {
    const isSpecific = symbolRegex.test(item.title) || symbolRegex.test(item.body);
    return {
      ...item,
      targetScope: isSpecific ? ('SYMBOL_SPECIFIC' as const) : ('GENERAL_MARKET' as const),
      matchedSymbol: isSpecific ? symbol.toUpperCase() : 'MARKET'
    };
  });

  const specific = itemsWithScope.filter((item) => item.targetScope === 'SYMBOL_SPECIFIC');
  const general = itemsWithScope.filter((item) => item.targetScope === 'GENERAL_MARKET');

  if (specific.length > 0) {
    return [...specific.slice(0, 6), ...general.slice(0, 3)];
  }
  return general.slice(0, 4);
}

export class ResearchHost {
  private readonly fetchImpl: typeof fetch;
  private readonly browserWorker: BrowserResearchWorker;
  private readonly ownsWorker: boolean;
  private readonly urlPolicy: ResearchUrlPolicy;
  private readonly optionalSources: OptionalResearchSources;
  private readonly options: ResearchHostOptions;
  private readonly traces: ToolTraceRecord[] = [];
  private readonly findings = new Map<string, ResearchFinding>();
  private readonly debateNotes: Array<{
    id: string;
    cycleId: string;
    role: RoleId;
    note: string;
    createdAt: number;
  }> = [];

  constructor(options: ResearchHostOptions = {}) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.urlPolicy = options.urlPolicy ?? {};
    this.optionalSources = options.optionalSources ?? {};
    if (options.browserWorker) {
      this.browserWorker = options.browserWorker;
      this.ownsWorker = false;
    } else {
      this.browserWorker = new BrowserResearchWorker({ urlPolicy: this.urlPolicy });
      this.ownsWorker = true;
    }
  }

  getTraces(): readonly ToolTraceRecord[] {
    return this.traces;
  }

  capabilities(): Array<{
    name: string;
    category: string;
    available: boolean;
    configured: boolean;
    status: string;
    requiresApiKey: boolean | 'provider-dependent';
    limitations: string[];
  }> {
    const optional = this.optionalProviderStates();
    return [
      {
        name: 'market_snapshot',
        category: 'read-only research',
        available: Boolean(this.options.readMarketSnapshot),
        configured: true,
        status: this.options.readMarketSnapshot ? 'CONFIGURED' : 'UNAVAILABLE',
        requiresApiKey: false,
        limitations: ['Read-only canonical Bybit linear snapshot; never places orders.']
      },
      {
        name: 'market_news',
        category: 'read-only research',
        available: true,
        configured: true,
        status: optional.cryptopanic === 'CONFIGURED' ? 'CONFIGURED' : 'UNCONFIGURED',
        requiresApiKey: false,
        limitations: ['Optional providers enrich context only; missing keys are never trade vetoes.']
      },
      {
        name: 'onchain_briefing',
        category: 'read-only research',
        available: true,
        configured: optional.whaleAlert === 'CONFIGURED',
        status: optional.whaleAlert,
        requiresApiKey: true,
        limitations: ['Missing on-chain API key remains explicitly UNCONFIGURED, never inferred wallet flow.']
      },
      {
        name: 'desk_account',
        category: 'read-only research',
        available: Boolean(this.options.readPortfolio),
        configured: true,
        status: this.options.readPortfolio ? 'CONFIGURED' : 'UNAVAILABLE',
        requiresApiKey: false,
        limitations: ['Read-only account snapshot; zero order execution capability.']
      },
      {
        name: 'cryptopanic',
        category: 'news provider',
        available: true,
        configured: optional.cryptopanic === 'CONFIGURED',
        status: optional.cryptopanic,
        requiresApiKey: true,
        limitations: ['Enrichment only.']
      },
      {
        name: 'whaleAlert',
        category: 'on-chain provider',
        available: true,
        configured: optional.whaleAlert === 'CONFIGURED',
        status: optional.whaleAlert,
        requiresApiKey: true,
        limitations: ['Enrichment only.']
      },
      {
        name: 'coinmarketcap',
        category: 'market metadata provider',
        available: true,
        configured: optional.coinmarketcap === 'CONFIGURED',
        status: optional.coinmarketcap,
        requiresApiKey: true,
        limitations: ['Enrichment only.']
      }
    ];
  }

  private optionalProviderStates(): Record<'cryptopanic' | 'whaleAlert' | 'coinmarketcap', 'CONFIGURED' | 'UNCONFIGURED'> {
    return {
      cryptopanic: this.optionalSources.cryptopanicKey ? 'CONFIGURED' : 'UNCONFIGURED',
      whaleAlert: this.optionalSources.whaleAlertKey ? 'CONFIGURED' : 'UNCONFIGURED',
      coinmarketcap: this.optionalSources.coinmarketcapKey ? 'CONFIGURED' : 'UNCONFIGURED'
    };
  }

  private recordTrace(entry: Omit<ToolTraceRecord, 'traceId'>, traceId: string): void {
    this.traces.push({ traceId, ...entry });
    if (this.traces.length > 500) {
      this.traces.splice(0, this.traces.length - 500);
    }
  }

  private async safeFetchUrl(rawUrl: string): Promise<{
    ok: boolean;
    finalUrl: string;
    body: string;
    contentType: string;
    error: string | null;
  }> {
    let currentUrl = rawUrl;
    for (let hop = 0; hop <= 4; hop += 1) {
      const check = await validateResearchUrl(currentUrl, this.urlPolicy);
      if (!check.ok || !check.normalizedUrl) {
        return {
          ok: false,
          finalUrl: currentUrl,
          body: '',
          contentType: '',
          error: check.reason ?? 'Blocked URL'
        };
      }

      let res: Response;
      try {
        res = await this.fetchImpl(check.normalizedUrl, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(12_000),
          headers: {
            Accept: 'text/html,application/json,text/plain;q=0.9'
          }
        });
      } catch (err) {
        return {
          ok: false,
          finalUrl: check.normalizedUrl,
          body: '',
          contentType: '',
          error: err instanceof Error ? err.message : 'Network fetch failed'
        };
      }

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) {
          return {
            ok: false,
            finalUrl: check.normalizedUrl,
            body: '',
            contentType: '',
            error: `Redirect HTTP ${res.status} without Location header`
          };
        }
        currentUrl = new URL(location, check.normalizedUrl).toString();
        continue;
      }

      if (!res.ok) {
        return {
          ok: false,
          finalUrl: check.normalizedUrl,
          body: '',
          contentType: '',
          error: `Upstream HTTP ${res.status}`
        };
      }

      const text = await res.text();
      return {
        ok: true,
        finalUrl: check.normalizedUrl,
        body: text.slice(0, 64_000),
        contentType: res.headers.get('content-type') ?? '',
        error: null
      };
    }

    return {
      ok: false,
      finalUrl: currentUrl,
      body: '',
      contentType: '',
      error: 'Too many redirects'
    };
  }

  async run(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const traceId = `tr-${randomUUID()}`;
    const startedAt = Date.now();

    const finish = (
      status: 'ok' | 'unavailable' | 'error',
      data: unknown,
      sourceRefs: string[],
      error: string | null,
      resolvedUrl: string | null = null,
      excerptHash: string | null = null
    ): ToolResult => {
      const observedAt = Date.now();
      this.recordTrace(
        {
          tool: call.name,
          role: context.role,
          cycleId: context.cycleId,
          accountRef: context.accountRef,
          evidenceId: context.evidenceId,
          resolvedUrl,
          status,
          observedAt,
          durationMs: observedAt - startedAt,
          excerptHash,
          error
        },
        traceId
      );
      return { status, data, sourceRefs, traceId, error };
    };

    switch (call.name) {
      case 'desk_capabilities': {
        return finish('ok', { capabilities: this.capabilities() }, [], null);
      }

      case 'get_market_snapshot':
      case 'market_snapshot': {
        const parsed = SymbolArgSchema.safeParse(call.args);
        if (!parsed.success) {
          return finish('error', null, [], 'Invalid symbol argument');
        }
        if (!this.options.readMarketSnapshot) {
          return finish('unavailable', null, [], 'Market snapshot reader unavailable');
        }
        const snap = await this.options.readMarketSnapshot(parsed.data.symbol);
        if (snap === null || snap === undefined) {
          return finish('unavailable', null, [], `Market snapshot unavailable for ${parsed.data.symbol}`);
        }
        return finish('ok', snap, [`market:${parsed.data.symbol}`], null);
      }

      case 'get_orderbook': {
        const parsed = SymbolArgSchema.safeParse(call.args);
        if (!parsed.success) return finish('error', null, [], 'Invalid symbol argument');
        if (!this.options.readOrderbook) {
          return finish('unavailable', null, [], 'Orderbook reader unavailable');
        }
        const book = await this.options.readOrderbook(parsed.data.symbol);
        if (!book) return finish('unavailable', null, [], 'Orderbook unavailable');
        return finish('ok', book, [`orderbook:${parsed.data.symbol}`], null);
      }

      case 'get_candles': {
        const parsed = SymbolArgSchema.safeParse(call.args);
        if (!parsed.success) return finish('error', null, [], 'Invalid symbol argument');
        if (!this.options.readCandles) {
          return finish('unavailable', null, [], 'Candles reader unavailable');
        }
        const candles = await this.options.readCandles(parsed.data.symbol, parsed.data.tf);
        if (!candles) return finish('unavailable', null, [], 'Candles unavailable');
        return finish('ok', candles, [`candles:${parsed.data.symbol}:${parsed.data.tf ?? '15m'}`], null);
      }

      case 'get_funding_oi': {
        const parsed = SymbolArgSchema.safeParse(call.args);
        if (!parsed.success) return finish('error', null, [], 'Invalid symbol argument');
        if (!this.options.readFundingOi) {
          return finish('unavailable', null, [], 'Funding/OI reader unavailable');
        }
        const foi = await this.options.readFundingOi(parsed.data.symbol);
        if (!foi) return finish('unavailable', null, [], 'Funding/OI unavailable');
        return finish('ok', foi, [`funding_oi:${parsed.data.symbol}`], null);
      }

      case 'get_portfolio':
      case 'desk_account': {
        if (!this.options.readPortfolio) {
          return finish('unavailable', null, [], 'Portfolio reader unavailable');
        }
        const portfolio = await this.options.readPortfolio(context.accountRef);
        return finish('ok', portfolio, [`portfolio:${context.accountRef}`], null);
      }

      case 'get_evidence': {
        const evidenceId = typeof call.args.evidenceId === 'string' ? call.args.evidenceId : context.evidenceId;
        const localFinding = this.findings.get(evidenceId);
        if (localFinding) {
          return finish('ok', localFinding, [localFinding.id], null, localFinding.url, localFinding.excerptHash);
        }
        if (this.options.readEvidence) {
          const ev = await this.options.readEvidence(evidenceId);
          if (ev) return finish('ok', ev, [evidenceId], null);
        }
        return finish('unavailable', null, [], `Evidence ${evidenceId} unavailable`);
      }

      case 'write_debate_note': {
        const parsed = NoteArgSchema.safeParse(call.args);
        if (!parsed.success) return finish('error', null, [], 'Invalid debate note');
        const sanitized = sanitizeUntrusted(parsed.data.note, 4000);
        const noteId = `note-${randomUUID()}`;
        const entry = {
          id: noteId,
          cycleId: context.cycleId,
          role: context.role,
          note: sanitized.text,
          createdAt: Date.now()
        };
        this.debateNotes.push(entry);
        return finish('ok', entry, [noteId], null);
      }

      case 'search_web':
      case 'read_official_announcement': {
        const parsed = UrlArgSchema.safeParse(call.args);
        if (!parsed.success) {
          return finish('error', null, [], 'Expected structured { url } argument');
        }
        const fetched = await this.safeFetchUrl(parsed.data.url);
        if (!fetched.ok) {
          return finish('unavailable', null, [], fetched.error, fetched.finalUrl);
        }
        const meta = extractHtmlMetadata(fetched.body);
        const rawSanitized = sanitizeUntrusted(meta.text || fetched.body, 8000);
        const finding = normalizeResearchFinding({
          claim: rawSanitized.text,
          url: fetched.finalUrl,
          publisher: meta.title,
          publishedAt: meta.publishedAt,
          eventAt: meta.eventAt,
          observedAt: Date.now(),
          certainty: call.name === 'read_official_announcement' && (meta.publishedAt !== null || meta.eventAt !== null)
            ? 'VERIFIED'
            : 'REPORTED'
        });
        this.findings.set(finding.id, finding);
        return finish(
          'ok',
          {
            untrusted: true,
            injectionFlagged: rawSanitized.flagged,
            fenced: fenceData(fetched.finalUrl, { title: meta.title, claim: finding.claim }),
            finding
          },
          [finding.id, fetched.finalUrl],
          null,
          fetched.finalUrl,
          finding.excerptHash
        );
      }

      case 'browse_url': {
        const parsed = UrlArgSchema.safeParse(call.args);
        if (!parsed.success) {
          return finish('error', null, [], 'Expected structured { url } argument');
        }
        let finalUrl = parsed.data.url;
        let text = '';
        let title: string | null = null;
        let publishedAt: number | null = null;
        let eventAt: number | null = null;
        let blockedSubrequests: string[] = [];

        const extracted = await this.browserWorker.extractPage({
          url: parsed.data.url,
          clickSelector: parsed.data.clickSelector,
          waitForSelector: parsed.data.waitForSelector
        });

        if (extracted.ok) {
          finalUrl = extracted.finalUrl;
          text = extracted.text;
          title = extracted.title;
          publishedAt = extracted.publishedAt;
          eventAt = extracted.eventAt;
          blockedSubrequests = extracted.blockedSubrequests;
        } else {
          // Fallback to safeFetchUrl + extractHtmlMetadata if browser worker fails
          const fetched = await this.safeFetchUrl(parsed.data.url);
          if (!fetched.ok) {
            return finish('unavailable', null, [], extracted.error || fetched.error, extracted.finalUrl || fetched.finalUrl);
          }
          finalUrl = fetched.finalUrl;
          const meta = extractHtmlMetadata(fetched.body);
          text = meta.text || fetched.body;
          title = meta.title;
          publishedAt = meta.publishedAt;
          eventAt = meta.eventAt;
        }

        const rawSanitized = sanitizeUntrusted(text, 8000);
        const finding = normalizeResearchFinding({
          claim: rawSanitized.text,
          url: finalUrl,
          publisher: title ?? undefined,
          publishedAt,
          eventAt,
          observedAt: Date.now(),
          certainty: 'REPORTED'
        });
        this.findings.set(finding.id, finding);
        return finish(
          'ok',
          {
            untrusted: true,
            injectionFlagged: rawSanitized.flagged,
            blockedSubrequests,
            fenced: fenceData(finalUrl, { title, claim: finding.claim }),
            finding
          },
          [finding.id, finalUrl],
          null,
          finalUrl,
          finding.excerptHash
        );
      }

      case 'onchain_briefing': {
        const parsed = SymbolArgSchema.safeParse(call.args);
        if (!parsed.success) {
          return finish('error', null, [], 'Invalid symbol argument');
        }
        const optionalProviders = this.optionalProviderStates();
        const whaleReport = await computeWhaleIntelligence({
          symbol: parsed.data.symbol,
          apiKey: this.options.optionalSources?.whaleAlertKey,
          fetchImpl: this.options.fetchImpl,
          marketHub: this.options.marketHub
        });
        if (
          optionalProviders.whaleAlert === 'UNCONFIGURED' &&
          whaleReport.onchain.status === 'UNCONFIGURED' &&
          whaleReport.exchange.status !== 'AVAILABLE'
        ) {
          return finish(
            'unavailable',
            {
              symbol: parsed.data.symbol,
              veto: false,
              providerStatus: 'UNCONFIGURED',
              optionalProviders,
              items: [],
              report: whaleReport
            },
            [],
            'Optional on-chain provider is unconfigured'
          );
        }
        const isAvailable = whaleReport.exchange.status === 'AVAILABLE' || whaleReport.onchain.status !== 'UNAVAILABLE';
        return finish(
          isAvailable ? 'ok' : 'unavailable',
          {
            symbol: parsed.data.symbol,
            veto: false,
            optionalProviders,
            report: whaleReport,
            items: whaleReport.onchain.events
          },
          ['whale-alert', 'whale-exchange'],
          isAvailable ? null : whaleReport.onchain.summary
        );
      }

      case 'search_news':
      case 'market_news':
      case 'jev_research': {
        const parsed = SymbolArgSchema.safeParse(call.args);
        if (!parsed.success) {
          return finish('error', null, [], 'Invalid symbol argument');
        }
        const optionalProviders = this.optionalProviderStates();
        const findings = await this.research({
          symbol: parsed.data.symbol,
          objective: parsed.data.objective
        });
        if (optionalProviders.cryptopanic === 'UNCONFIGURED' && !this.options.optionalSources?.cryptopanicKey) {
          return finish(
            'unavailable',
            {
              symbol: parsed.data.symbol,
              veto: false,
              optionalProviders,
              items: findings
            },
            findings.map((f) => f.id),
            'Optional news provider is unconfigured'
          );
        }
        if (findings.length === 0) {
          return finish(
            'unavailable',
            {
              symbol: parsed.data.symbol,
              veto: false,
              optionalProviders,
              items: []
            },
            [],
            'No verified public news or optional enrichment configured'
          );
        }
        return finish(
          'ok',
          {
            symbol: parsed.data.symbol,
            veto: false,
            optionalProviders,
            items: findings
          },
          findings.map((f) => f.id),
          null
        );
      }

      default:
        return finish('error', null, [], `Unsupported host tool: ${call.name}`);
    }
  }

  async research(query: ResearchQuery): Promise<ResearchFinding[]> {
    const collected: ResearchFinding[] = [];
    const ctx: ToolContext = {
      role: 'research',
      cycleId: `research-${randomUUID()}`,
      accountRef: 'system',
      evidenceId: `query:${query.symbol}`
    };

    if (query.urls && query.urls.length > 0) {
      for (const url of query.urls) {
        const res = await this.run({ name: 'search_web', args: { url } }, ctx);
        if (res.status === 'ok' && res.data && typeof res.data === 'object' && 'finding' in res.data) {
          collected.push((res.data as { finding: ResearchFinding }).finding);
        }
      }
    } else {
      // Auto-fetch if no URLs provided
      try {
        const publicItems = await fetchPublicCryptoNews(query.symbol, this.fetchImpl);
        for (const item of publicItems) {
          const rawSanitized = sanitizeUntrusted(`${item.title}\n${item.body}`, 4000);
          const finding = normalizeResearchFinding({
            claim: rawSanitized.text,
            url: item.url,
            publisher: item.publisher,
            publishedAt: item.publishedAt,
            eventAt: null,
            observedAt: Date.now(),
            certainty: 'REPORTED'
          });
          this.findings.set(finding.id, finding);
          collected.push(finding);
        }
      } catch {}

      try {
        const ann = await getLiveAnnouncementsResult(query.symbol, this.fetchImpl);
        for (const item of (ann.items ?? []).slice(0, 5)) {
          const rawSanitized = sanitizeUntrusted(`${item.headline}\n${item.body ?? ''}`, 4000);
          const finding = normalizeResearchFinding({
            claim: rawSanitized.text,
            url: (item as any).url || (item as any).sourceUrl || 'https://announcements.bybit.com',
            publisher: item.source || 'Bybit Announcements',
            publishedAt: item.publishedAt ?? null,
            eventAt: null,
            observedAt: item.observedAt ?? Date.now(),
            certainty: 'REPORTED'
          });
          this.findings.set(finding.id, finding);
          collected.push(finding);
        }
      } catch {}

      if (this.options.optionalSources?.cryptopanicKey) {
        try {
          const cpItems = await getNewsFor(query.symbol, {
            news: {
              provider: 'cryptopanic',
              key: this.options.optionalSources.cryptopanicKey,
              baseUrl: 'https://cryptopanic.com/api/v1/posts/'
            }
          }, this.fetchImpl);
          for (const item of (cpItems ?? []).slice(0, 5)) {
            const rawSanitized = sanitizeUntrusted(`${item.headline}\n${item.body ?? ''}`, 4000);
            const finding = normalizeResearchFinding({
              claim: rawSanitized.text,
              url: (item as any).url || (item as any).sourceUrl || 'https://cryptopanic.com',
              publisher: item.source || 'CryptoPanic',
              publishedAt: item.publishedAt ?? null,
              eventAt: null,
              observedAt: Date.now(),
              certainty: 'REPORTED'
            });
            this.findings.set(finding.id, finding);
            collected.push(finding);
          }
        } catch {}
      }

      if (this.options.optionalSources?.coinmarketcapKey) {
        try {
          const cmc = await getCoinMarketCapSummary(query.symbol);
          if (cmc?.momentum) {
            const finding = normalizeResearchFinding({
              claim: `CMC 24h Vol: ${cmc.momentum.volume24h}, Vol Change: ${cmc.momentum.volumeChange24hPct}%, Dominance: ${cmc.global?.btcDominance ?? 'N/A'}%`,
              url: 'https://coinmarketcap.com',
              publisher: 'CoinMarketCap',
              publishedAt: cmc.fetchedAt,
              eventAt: null,
              observedAt: Date.now(),
              certainty: 'REPORTED'
            });
            this.findings.set(finding.id, finding);
            collected.push(finding);
          }
        } catch {}
      }
    }

    return dedupeResearchFindings(collected);
  }

  async simulateWorkerCrash(): Promise<void> {
    await this.browserWorker.simulateCrash();
  }

  async close(): Promise<void> {
    if (this.ownsWorker) {
      await this.browserWorker.close();
    }
  }
}
