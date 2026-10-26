import { createHash } from 'node:crypto';
import { recordDiagnostic } from '../session-log.js';
import { safe, registerSecrets } from '../redact.js';
import {
  DecisionsRequestSchema,
  DecisionsResponseSchema,
  JEV_ENDPOINT,
  JEV_MODEL,
  JEV_PROVIDER,
  type DecisionsRequest,
  type DecisionsResponse,
  type JevHealth,
  type JevKeySource,
  type JevMode,
  type Question
} from './schemas.js';

export interface JevSettings {
  enabled: boolean;
  provider: typeof JEV_PROVIDER;
  model: string;
  mode: JevMode;
  effectiveMode: JevMode;
  endpoint: string;
  timeoutMs: number;
  allowLive: boolean;
  assistBudgetMs: number;
  keySource: JevKeySource;
  openrouterKeySet: boolean;
  dedicatedKeySet: boolean;
  health: JevHealth;
}

export interface JevCallResult {
  ok: boolean;
  health: JevHealth;
  error: string | null;
  response: DecisionsResponse | null;
  latencyMs: number;
  cached: boolean;
}

export interface JevMetrics {
  requests: number;
  success: number;
  errors: number;
  timeouts: number;
  lastLatencyMs: number | null;
  lastModel: string | null;
  lastCost: number | null;
  lastInputTokens: number | null;
  lastError: string | null;
}

const SECRET_KEY = /key|secret|token|password|private|authorization|seed|mnemonic/i;

export function parseJevMode(raw: string | undefined): JevMode {
  const v = (raw ?? 'shadow').trim().toLowerCase();
  if (v === 'off' || v === 'assist' || v === 'shadow') return v;
  return 'shadow';
}

export function resolveJevKey(env: NodeJS.ProcessEnv = process.env): { key: string; source: JevKeySource } {
  const dedicated = (env.JEV_OPENROUTER_API_KEY ?? '').trim();
  if (dedicated) return { key: dedicated, source: 'jev' };
  const shared = (env.OPENROUTER_API_KEY ?? '').trim();
  if (shared) return { key: shared, source: 'openrouter' };
  return { key: '', source: 'none' };
}

export function loadJevSettings(env: NodeJS.ProcessEnv = process.env, tradingMode: string = 'PAPER'): JevSettings {
  const enabled = /^(1|on|yes|true)$/i.test((env.JEV_ENABLED ?? 'false').trim());
  const mode = enabled ? parseJevMode(env.JEV_MODE) : 'off';
  const allowLive = /^(1|on|yes|true)$/i.test((env.JEV_ALLOW_LIVE ?? 'false').trim());
  const { key, source } = resolveJevKey(env);
  if (key) registerSecrets([key]);
  const openrouterKeySet = !!(env.OPENROUTER_API_KEY ?? '').trim();
  const dedicatedKeySet = !!(env.JEV_OPENROUTER_API_KEY ?? '').trim();
  let health: JevHealth = 'DISABLED';
  if (enabled && source === 'none') health = 'MISSING_KEY';
  else if (enabled) health = 'READY';
  let effectiveMode: JevMode = mode;
  if (!enabled || source === 'none') effectiveMode = 'off';
  else if (mode === 'assist' && tradingMode === 'LIVE' && !allowLive) effectiveMode = 'shadow';
  const timeoutMs = Math.min(60_000, Math.max(2_000, Number(env.JEV_TIMEOUT_MS ?? 15000) || 15000));
  const assistBudgetMs = Math.min(timeoutMs, Math.max(500, Number(env.JEV_ASSIST_BUDGET_MS ?? 4000) || 4000));
  return {
    enabled,
    provider: JEV_PROVIDER,
    model: (env.JEV_MODEL ?? JEV_MODEL).trim() || JEV_MODEL,
    mode,
    effectiveMode,
    endpoint: (env.JEV_ENDPOINT ?? JEV_ENDPOINT).trim() || JEV_ENDPOINT,
    timeoutMs,
    allowLive,
    assistBudgetMs,
    keySource: source,
    openrouterKeySet,
    dedicatedKeySet,
    health
  };
}

export function publicJevStatus(settings: JevSettings, metrics: JevMetrics, extras: Record<string, unknown> = {}) {
  return {
    enabled: settings.enabled,
    provider: settings.provider,
    model: settings.model,
    mode: settings.effectiveMode,
    configuredMode: settings.mode,
    health: settings.health,
    openrouterKeySet: settings.openrouterKeySet,
    dedicatedKeySet: settings.dedicatedKeySet,
    keySource: settings.keySource,
    allowLive: settings.allowLive,
    affectedContext: settings.effectiveMode === 'assist',
    ...extras,
    metrics: {
      requests: metrics.requests,
      success: metrics.success,
      errors: metrics.errors,
      timeouts: metrics.timeouts,
      lastLatencyMs: metrics.lastLatencyMs,
      lastModel: metrics.lastModel,
      lastCost: metrics.lastCost,
      lastInputTokens: metrics.lastInputTokens,
      lastError: metrics.lastError
    }
  };
}

export function sanitizeJevState(input: unknown, maxChars = 12_000): unknown {
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 6) return '[truncated]';
    if (v == null) return v;
    if (typeof v === 'string') return v.length > 800 ? `${v.slice(0, 800)}…` : v;
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (Array.isArray(v)) return v.slice(0, 8).map((x) => walk(x, depth + 1));
    if (typeof v === 'object') {
      const out: Record<string, unknown> = {};
      let n = 0;
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (SECRET_KEY.test(k)) continue;
        if (typeof val === 'string' && val.length >= 12 && SECRET_KEY.test(k)) continue;
        out[k] = walk(val, depth + 1);
        if (++n >= 24) break;
      }
      return out;
    }
    return String(v).slice(0, 200);
  };
  let cleaned = walk(input, 0);
  let json = JSON.stringify(cleaned);
  if (json.length > maxChars) cleaned = { note: 'state truncated', preview: json.slice(0, maxChars) };
  return cleaned;
}

function classifyHttp(status: number): JevHealth {
  if (status === 401 || status === 403) return 'AUTH_ERROR';
  if (status === 429 || status === 529) return 'RATE_LIMITED';
  if (status === 404) return 'PROVIDER_ERROR';
  return 'PROVIDER_ERROR';
}

export async function submitDecisions(opts: {
  settings: JevSettings;
  key: string;
  state: unknown;
  questions: Record<string, Question>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<JevCallResult> {
  const started = Date.now();
  if (!opts.settings.enabled) return { ok: false, health: 'DISABLED', error: 'Jev is disabled.', response: null, latencyMs: 0, cached: false };
  if (!opts.key) return { ok: false, health: 'MISSING_KEY', error: 'No OpenRouter API key is configured for Jev.', response: null, latencyMs: 0, cached: false };
  const body: DecisionsRequest = {
    model: opts.settings.model,
    state: sanitizeJevState(opts.state),
    questions: opts.questions
  };
  const parsedReq = DecisionsRequestSchema.safeParse(body);
  if (!parsedReq.success) {
    return { ok: false, health: 'PROVIDER_ERROR', error: 'Invalid Jev request.', response: null, latencyMs: Date.now() - started, cached: false };
  }
  const ctrl = new AbortController();
  const timeoutMs = opts.timeoutMs ?? opts.settings.timeoutMs;
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await (opts.fetchImpl ?? fetch)(opts.settings.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.key}`,
        'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'https://aabrur.github.io/trading-agent-mpu-gandring/',
        'X-Title': 'Trading Agent Mpu Gandring',
        'X-OpenRouter-Title': 'Trading Agent Mpu Gandring'
      },
      body: JSON.stringify(parsedReq.data),
      signal: ctrl.signal
    });
    if (!res.ok) {
      return {
        ok: false,
        health: classifyHttp(res.status),
        error: `Jev HTTP ${res.status}`,
        response: null,
        latencyMs: Date.now() - started,
        cached: false
      };
    }
    let json: unknown;
    try { json = await res.json(); } catch {
      return { ok: false, health: 'PROVIDER_ERROR', error: 'Jev returned a malformed body.', response: null, latencyMs: Date.now() - started, cached: false };
    }
    const parsed = DecisionsResponseSchema.safeParse(json);
    if (!parsed.success) {
      return { ok: false, health: 'PROVIDER_ERROR', error: 'Jev response failed schema validation.', response: null, latencyMs: Date.now() - started, cached: false };
    }
    return { ok: true, health: 'READY', error: null, response: parsed.data, latencyMs: Date.now() - started, cached: false };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const timeout = /abort/i.test(msg);
    return {
      ok: false,
      health: timeout ? 'TIMEOUT' : 'PROVIDER_ERROR',
      error: timeout ? 'Jev request timed out.' : safe(msg),
      response: null,
      latencyMs: Date.now() - started,
      cached: false
    };
  } finally {
    clearTimeout(t);
  }
}

export class JevService {
  settings: JevSettings;
  metrics: JevMetrics = { requests: 0, success: 0, errors: 0, timeouts: 0, lastLatencyMs: null, lastModel: null, lastCost: null, lastInputTokens: null, lastError: null };
  lastRecord: Record<string, unknown> | null = null;
  private cache = new Map<string, { at: number; result: JevCallResult }>();
  private generation = 0;
  private appliedGeneration = 0;
  private inflight = new Set<Promise<unknown>>();
  constructor(private env: NodeJS.ProcessEnv, private tradingMode: string, private fetchImpl: typeof fetch = fetch) {
    this.settings = loadJevSettings(env, tradingMode);
  }
  reload(env: NodeJS.ProcessEnv, tradingMode: string) {
    this.env = env;
    this.tradingMode = tradingMode;
    this.settings = loadJevSettings(env, tradingMode);
  }
  private key() { return resolveJevKey(this.env).key; }
  async flush() { await Promise.allSettled([...this.inflight]); }
  status() {
    this.settings = loadJevSettings(this.env, this.tradingMode);
    return publicJevStatus(this.settings, this.metrics, {
      lastDecision: this.lastRecord,
      affectedContext: this.settings.effectiveMode === 'assist'
    });
  }
  private remember(result: JevCallResult) {
    this.metrics.requests += 1;
    this.metrics.lastLatencyMs = result.latencyMs;
    if (result.ok) {
      this.metrics.success += 1;
      this.metrics.lastModel = result.response?.model ?? this.settings.model;
      this.metrics.lastCost = result.response?.usage?.cost ?? null;
      this.metrics.lastInputTokens = result.response?.usage?.input_tokens ?? null;
      this.metrics.lastError = null;
      this.settings.health = 'READY';
    } else {
      this.metrics.errors += 1;
      if (result.health === 'TIMEOUT') this.metrics.timeouts += 1;
      this.metrics.lastError = result.error;
      if (result.health !== 'DISABLED' && result.health !== 'MISSING_KEY') this.settings.health = result.health;
    }
  }
  async evaluate(state: unknown, questions: Record<string, Question>, cacheTtlMs = 45_000, opts?: { timeoutMs?: number; generation?: number; decisionId?: string }): Promise<JevCallResult> {
    this.settings = loadJevSettings(this.env, this.tradingMode);
    if (this.settings.effectiveMode === 'off') {
      const r: JevCallResult = { ok: false, health: this.settings.health, error: this.settings.health === 'MISSING_KEY' ? 'No OpenRouter API key is configured for Jev.' : 'Jev is off.', response: null, latencyMs: 0, cached: false };
      return r;
    }
    if (Object.keys(questions).length === 0) {
      return { ok: false, health: this.settings.health, error: 'No applicable Jev questions.', response: null, latencyMs: 0, cached: false };
    }
    const cacheKey = createHash('sha256').update(JSON.stringify({ m: this.settings.model, s: sanitizeJevState(state), q: questions })).digest('hex');
    const hit = this.cache.get(cacheKey);
    if (hit && Date.now() - hit.at < cacheTtlMs && hit.result.ok) {
      recordDiagnostic({ source: 'jev', category: 'PREDICTION', eventName: 'jev.cache_hit', status: 'cached', correlationId: opts?.decisionId, message: 'Jev cached result reused', details: { questionIds: Object.keys(questions), model: this.settings.model } });
      return { ...hit.result, cached: true };
    }
    const requestId = `jev-${cacheKey.slice(0, 12)}-${Date.now()}`;
    recordDiagnostic({ source: 'jev', category: 'PREDICTION', eventName: 'jev.dispatched', status: 'started', correlationId: opts?.decisionId ?? requestId, message: 'Jev decision request dispatched', details: { requestId, questionIds: Object.keys(questions), model: this.settings.model } });
    const result = await submitDecisions({ settings: this.settings, key: this.key(), state, questions, fetchImpl: this.fetchImpl, timeoutMs: opts?.timeoutMs });
    recordDiagnostic({ source: 'jev', category: 'PREDICTION', eventName: 'jev.completed', level: result.ok ? 'INFO' : 'WARN', status: result.health, correlationId: opts?.decisionId ?? requestId, durationMs: result.latencyMs, message: result.ok ? 'Jev decision request completed' : result.error ?? 'Jev decision request failed', details: { requestId, questionIds: Object.keys(questions), model: result.response?.model ?? this.settings.model, answers: result.response?.answers ?? null, fallback: !result.ok } });
    this.remember(result);
    const gen = opts?.generation ?? ++this.generation;
    if (result.ok && gen >= this.appliedGeneration) {
      this.appliedGeneration = gen;
      this.cache.set(cacheKey, { at: Date.now(), result });
      this.lastRecord = { at: Date.now(), decisionId: opts?.decisionId ?? null, model: result.response?.model ?? null, answers: result.response?.answers ?? {}, latencyMs: result.latencyMs };
    }
    return result;
  }
  evaluateBackground(state: unknown, questions: Record<string, Question>, opts?: { decisionId?: string }) {
    const generation = ++this.generation;
    const p = this.evaluate(state, questions, 45_000, { generation, decisionId: opts?.decisionId }).catch(() => null);
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
    return p;
  }
  async testConnection(): Promise<JevCallResult> {
    this.settings = loadJevSettings(this.env, this.tradingMode);
    if (!this.settings.enabled) return { ok: false, health: 'DISABLED', error: 'Enable Jev before testing the connection.', response: null, latencyMs: 0, cached: false };
    const result = await submitDecisions({
      settings: this.settings,
      key: this.key(),
      state: { ping: 'connection-test' },
      questions: { reachable: { type: 'noul', instructions: 'Is this a connection test payload?' } },
      fetchImpl: this.fetchImpl
    });
    this.remember(result);
    return result;
  }
}
