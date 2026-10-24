export type SuiEvidenceStatus = 'DATA_AVAILABLE' | 'NO_RELEVANT_EVENTS' | 'UNCONFIGURED' | 'UNAVAILABLE';
export type SuiEventCategory = 'MOVE_EVENT';

export interface SuiObservedEvent {
  digest: string;
  eventIndex: number;
  type: string;
  category: SuiEventCategory;
  timestamp: number | null;
  sender: string | null;
  payload: unknown;
  source: 'Sui GraphQL event';
}

export interface SuiEventBriefing {
  symbol: string;
  status: SuiEvidenceStatus;
  source: string;
  observedAt: number;
  events: SuiObservedEvent[];
  coverage: 'recent_sample' | 'sender_filtered_recent_sample' | 'unconfigured' | 'unavailable';
  note: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function timestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed < 1e12 ? parsed * 1000 : parsed;
    const date = Date.parse(value);
    return Number.isFinite(date) ? date : null;
  }
  return null;
}

function senderAddress(value: unknown): string | null {
  if (!isRecord(value) || typeof value.address !== 'string') return null;
  return /^0x[a-f\d]{64}$/i.test(value.address) ? value.address : null;
}

/** Reads recent indexed Move events; this is a bounded chain sample, not token-flow or trade-intent analysis. */
export async function getSuiEventBriefing(
  symbol: string,
  env: { SUI_GRAPHQL_URL?: string; SUI_SENDER_ADDRESS?: string } = process.env,
  fetchImpl: typeof fetch = fetch
): Promise<SuiEventBriefing> {
  const observedAt = Date.now();
  const configuredUrl = env.SUI_GRAPHQL_URL?.trim();
  if (!configuredUrl) return {
    symbol, status: 'UNCONFIGURED', source: 'Sui GraphQL RPC', observedAt, events: [], coverage: 'unconfigured',
    note: 'Sui GraphQL endpoint is not configured; no Sui event coverage is available.'
  };
  let endpoint: URL;
  try {
    endpoint = new URL(configuredUrl);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error();
  } catch {
    return { symbol, status: 'UNAVAILABLE', source: 'Sui GraphQL RPC', observedAt, events: [], coverage: 'unavailable', note: 'Sui GraphQL endpoint is invalid; use HTTPS without URL credentials.' };
  }

  const sender = env.SUI_SENDER_ADDRESS?.trim();
  const senderIsValid = !!sender && /^0x[a-f\d]{64}$/i.test(sender);
  const query = senderIsValid
    ? 'query RecentEvents($sender: String!) { events(first: 50, filter: { sender: $sender }) { nodes { transaction { digest } sequenceNumber timestamp sender { address } contents { type { repr } json } } } }'
    : 'query RecentEvents { events(first: 50) { nodes { transaction { digest } sequenceNumber timestamp sender { address } contents { type { repr } json } } } }';
  const variables = senderIsValid ? { sender } : undefined;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetchImpl(endpoint.href, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, ...(variables ? { variables } : {}) }), signal: controller.signal
    });
    if (!response.ok) throw new Error();
    const data: unknown = await response.json();
    if (!isRecord(data) || (Array.isArray(data.errors) && data.errors.length)) throw new Error();
    const dataRoot = data.data;
    const eventsRoot = isRecord(dataRoot) ? dataRoot.events : undefined;
    const nodes = isRecord(eventsRoot) ? eventsRoot.nodes : undefined;
    if (!Array.isArray(nodes)) throw new Error();
    const seen = new Set<string>();
    const events: SuiObservedEvent[] = [];
    for (const node of nodes) {
      if (!isRecord(node)) continue;
      const tx = node.transaction;
      const contents = node.contents;
      const digest = isRecord(tx) && typeof tx.digest === 'string' ? tx.digest : '';
      const index = typeof node.sequenceNumber === 'number' ? node.sequenceNumber : typeof node.sequenceNumber === 'string' ? Number(node.sequenceNumber) : NaN;
      const moveContents = isRecord(contents) ? contents : null;
      const typeObject = moveContents && isRecord(moveContents.type) ? moveContents.type : null;
      const type = typeObject && typeof typeObject.repr === 'string' ? typeObject.repr : '';
      if (!digest || !Number.isSafeInteger(index) || index < 0 || !type) continue;
      const key = `${digest}:${index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push({
        digest, eventIndex: index, type, category: 'MOVE_EVENT', timestamp: timestamp(node.timestamp),
        sender: senderAddress(node.sender), payload: moveContents?.json ?? null, source: 'Sui GraphQL event'
      });
    }
    return {
      symbol, status: events.length ? 'DATA_AVAILABLE' : 'NO_RELEVANT_EVENTS', source: endpoint.origin,
      observedAt, events, coverage: senderIsValid ? 'sender_filtered_recent_sample' : 'recent_sample',
      note: senderIsValid
        ? 'Up to 50 recent indexed Move events for the configured sender address. This is not full-chain coverage and does not imply token transfers or selling intent.'
        : 'Up to 50 recent indexed Move events. This is a bounded recent sample, not full-chain coverage or token-flow analysis.'
    };
  } catch {
    return {
      symbol, status: 'UNAVAILABLE', source: endpoint.origin, observedAt, events: [], coverage: 'unavailable',
      note: 'Sui GraphQL request failed or returned an unsupported event response.'
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** @deprecated Use getSuiEventBriefing; this collector returns Move events, not verified transfers. */
export const getSuiTransferBriefing = getSuiEventBriefing;
