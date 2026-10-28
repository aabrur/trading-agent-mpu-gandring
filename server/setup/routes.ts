import { ReasoningSchema, reasoningStatus, requireReasoning, refreshRouterReasoning } from '../providers/reasoning.js';
// Office routes for the Setup wizard and the Desk ops panel. Same shared modules as the CLI (server/setup/*, server/sizing.ts).
// Every route here answers only to a browser on this computer (loopback client, localhost Host header, same-origin).
// Key entry additionally needs local mode and an office bound to 127.0.0.1 (the Connect wallet rule).
// Not possible here, on purpose: releasing the kill switch (CLI only: npm run unkill -- --yes).
import type express from 'express';
import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Desk } from '../desk.js';
import type { AutoTrader } from '../auto.js';
import type { Reporter } from '../reports.js';
import { AGENT_IDS, PROVIDERS, loadConfig } from '../config.js';
import { EXCHANGES, ADAPTER_STATUS, type ExchangeName } from '../exchange/index.js';
import { walletAccess } from '../wallet.js';
import { safe } from '../redact.js';
import { sanitizeUntrusted } from '../untrusted.js';
import { VENUE_GUIDES, guideSteps, envFields, MODES, MODE_INFO, LIVE_CONFIRM_PHRASE, LINKS_CHECKED_ON } from './guide.js';
import { saveVenueKeys, setVenue, setTradingMode, setupEnv, maskedStatus, venueFieldStatus } from './core.js';
import { doctor } from './doctor.js';
import { MODEL_KEY_ENV, modelSetupInfo, modelUpdates } from './models.js';
import { setEnv } from '../../cli/envfile.js';
import { discoverLocalModels, LOCAL_AGENTS, localAgentStatus, localLoginStatus, openAgentLogin, runLocalAgent, localSelection, localMcpInventory, localResearchActivity, validateResearchConnections, localAgentSettings, localAgentSettingsUpdate } from '../providers/local.js';
import { ResearchPolicyBody, researchPolicy } from '../providers/research-policy.js';
import { preferencesInfo, savePreferences } from './preferences.js';
import { AgentCloseSchema, AgentOpenSchema, extractJson, SCHEMAS } from '../schemas.js';
import { saveTradingLimits, TradingLimitsBody, saveTradingProfile, tradingSetupInfo, TradingProfileBody } from './trading.js';
import { tradingSettingsFromConfig } from '../trading-settings.js';
import { JevSetupBody, jevSetupInfo, saveJevSetup } from './jev.js';
import { DataSourcesBody, dataSourcesStatus, saveDataSources } from './data-sources.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const hostOk = (h: string) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(h);
/** A request from a browser or CLI on this computer, not from the network and not cross-site. */
export function localClient(o: { remoteAddress?: string | null; hostHeader?: string | null; origin?: string | null }): { ok: boolean; reason: string } {
  if (!o.remoteAddress || !LOOPBACK.has(o.remoteAddress)) return { ok: false, reason: 'only available from this computer (localhost).' };
  if (!o.hostHeader || !hostOk(o.hostHeader)) return { ok: false, reason: 'open the office at http://127.0.0.1 or http://localhost.' };
  if (o.origin && !hostOk(o.origin.replace(/^https?:\/\//, ''))) return { ok: false, reason: 'cross-origin request refused.' };
  return { ok: true, reason: 'local' };
}

export const UNKILL_COMMAND = 'npm run unkill -- --yes';
type Limiter = (k: string) => boolean;
export interface RouteCtx { cfg: AppConfig; desk: Desk; auto?: AutoTrader; reporter?: Reporter; envFile: string; fetchImpl?: typeof fetch; limiter: (n: number, ms: number) => Limiter }

function applyDeskPreferences(c: RouteCtx, next: AppConfig) {
  c.desk.applyDeskPreferences(next);
  c.auto?.configure({ on: next.auto.on, intervalMin: next.auto.intervalMin, symbols: next.auto.symbols, maxHoldHours: next.auto.maxHoldHours });
  c.reporter?.reschedule();
}

function restartOffice(req: express.Request, res: express.Response, c: RouteCtx) {
  try {
    const next = loadConfig(setupEnv(c.envFile));
    if (process.env.MPU_MANAGED === '1' && process.send) {
      res.json({ ok: true, restart: 'process', detail: 'Restarting the office managed process...' });
      setTimeout(() => process.send?.({ type: 'mpu:restart' }), 250).unref();
      return;
    }
    if (req.body?.forceExit || req.body?.restartProcess || req.query?.force === 'true') {
      res.json({ ok: true, restart: 'exit', detail: 'Stopping the server for the launcher to restart it...' });
      setTimeout(() => process.exit(0), 150).unref();
      return;
    }
    if (next.tradingMode !== c.cfg.tradingMode || next.exchange.name !== c.cfg.exchange.name) {
      return res.status(409).json({ ok: false, detail: 'Use the Exchange & Safety flow to change the active trading mode or venue.' });
    }
    c.desk.applyModelConfig(next);
    applyDeskPreferences(c, next);
    res.json({ ok: true, restart: 'in-place', detail: 'Saved model and desk settings applied to the running office.' });
  } catch {
    res.status(400).json({ ok: false, detail: 'Saved settings could not be applied. Check the saved configuration; the office was not restarted.' });
  }
}

const Venue = z.enum(EXCHANGES as unknown as [ExchangeName, ...ExchangeName[]]);
const KeysBody = z.object({ venue: Venue, network: z.enum(['testnet', 'mainnet']), key: z.string().max(300), secret: z.string().max(400), third: z.string().max(300).optional() }).strict();
const ModeBody = z.object({ mode: z.enum(MODES), confirm: z.string().max(100).optional() }).strict();
const Provider = z.enum(PROVIDERS as [typeof PROVIDERS[number], ...typeof PROVIDERS[number][]]);
const Selection = z.object({ provider: Provider, model: z.string().min(1).max(200) }).strict();
const ModelsBody = z.object({ defaultReasoning: ReasoningSchema.nullable().optional(), reasoning: z.object(Object.fromEntries(AGENT_IDS.map(id => [id, ReasoningSchema.nullable().optional()]))).strict().optional(), defaultProvider: Provider, defaultModel: z.string().min(1).max(200), agents: z.object({ lead: Selection.optional(), market: Selection.optional(), research: Selection.optional(), strategist: Selection.optional(), risk: Selection.optional(), execution: Selection.optional() }).strict().optional(), keys: z.object({ xai: z.string().max(400).optional(), openai: z.string().max(400).optional(), anthropic: z.string().max(400).optional(), gemini: z.string().max(400).optional(), deepseek: z.string().max(400).optional(), openrouter: z.string().max(400).optional(), groq: z.string().max(400).optional(), mistral: z.string().max(400).optional(), together: z.string().max(400).optional(), fireworks: z.string().max(400).optional() }).strict().optional() }).strict();
const OpenBody = z.object({ symbol: z.string().min(2).max(20), side: z.enum(['LONG', 'SHORT']), stop: z.number().positive().optional(), tp: z.number().positive().optional(), leverage: z.number().positive().max(100).optional(), confidence: z.number().min(0).max(1).optional(), autonomous: z.boolean().optional() }).strict();
const SizeBody = z.object({ symbol: z.string().min(2).max(20), side: z.enum(['LONG', 'SHORT']), entry: z.number().positive().optional(), stop: z.number().positive().optional(), leverage: z.number().positive().max(100).optional() }).strict();
const LessonBody = z.object({ role: z.enum([...AGENT_IDS, 'desk'] as unknown as [string, ...string[]]), lesson: z.string().min(2).max(300), kind: z.enum(['loss', 'stop', 'error', 'scan', 'correction', 'review', 'note']).default('note'), happened: z.string().max(400).default(''), rootCause: z.string().max(300).default('') }).strict();
const AutoBody = z.object({ on: z.boolean().optional(), intervalMin: z.number().int().min(1).max(1440).optional(), symbols: z.array(z.string().min(2).max(20)).min(1).max(10).optional(), maxHoldHours: z.number().int().min(0).max(720).optional(), n: z.number().int().min(1).max(4).optional(), runNow: z.boolean().optional(), debateMode: z.enum(['normal', 'fast']).optional() }).strict();

export function mountSetupRoutes(app: express.Express, c: RouteCtx) {
  const writeLim = c.limiter(30, 60_000);
  // Reads (guides, status) get a roomier limit so clicking through the wizard never locks it; writes stay at the tight limit.
  const readLim = c.limiter(300, 60_000);
  const lim = (k: string, req?: { method?: string }) => (req?.method === 'GET' ? readLim(k) : writeLim(k));
  const local = (req: express.Request) => localClient({ remoteAddress: req.socket.remoteAddress, hostHeader: req.headers.host ?? null, origin: (req.headers.origin as string | undefined) ?? null });
  const keyEntry = (req: express.Request) => walletAccess({ appMode: c.cfg.appMode, host: c.cfg.host, remoteAddress: req.socket.remoteAddress, hostHeader: req.headers.host ?? null, origin: (req.headers.origin as string | undefined) ?? null });
  const gate = (req: express.Request, res: express.Response, keys = false) => {
    const a = keys ? keyEntry(req) : local(req);
    if (!a.ok) { res.status(403).json({ ok: false, error: a.reason }); return false; }
    if (!lim(req.socket.remoteAddress ?? '', req)) { res.status(429).json({ ok: false, error: 'slow down' }); return false; }
    return true;
  };

  app.get('/api/setup', (req, res) => {
    if (!gate(req, res)) return;
    const k = keyEntry(req);
    res.json({ ok: true, linksCheckedOn: LINKS_CHECKED_ON, modes: MODES.map((m) => ({ mode: m, info: MODE_INFO[m] })), liveConfirmPhrase: LIVE_CONFIRM_PHRASE,
      keyEntry: { available: k.ok, reason: k.reason }, running: { mode: c.cfg.tradingMode, appMode: c.cfg.appMode }, status: maskedStatus(setupEnv(c.envFile)), unkill: UNKILL_COMMAND,
      venues: EXCHANGES.map((v) => ({ venue: v, label: VENUE_GUIDES[v].label, kind: VENUE_GUIDES[v].kind, status: ADAPTER_STATUS[v], connectWallet: VENUE_GUIDES[v].connectWallet, login: VENUE_GUIDES[v].login, extra: VENUE_GUIDES[v].extra ?? null })) });
  });
  app.get('/api/setup/guide/:venue', (req, res) => {
    if (!gate(req, res)) return;
    const v = Venue.safeParse(req.params.venue); const net = req.query.network === 'mainnet' ? 'mainnet' : 'testnet';
    if (!v.success) return res.status(404).json({ ok: false, error: 'unknown venue' });
    const g = VENUE_GUIDES[v.data];
    const env = setupEnv(c.envFile);
    res.json({ ok: true, venue: v.data, network: net, note: g.networks[net].note ?? null, steps: guideSteps(v.data, net, c.cfg.appMode === 'grokbot' ? 'grokbot' : 'local'), fields: envFields(v.data, net), venues: venueFieldStatus(env, v.data), permissionsOn: g.permissionsOn, permissionsOff: g.permissionsOff, ip: g.ip, docs: g.docs, connectWallet: g.connectWallet });
  });
  app.get('/api/setup/models', async (req, res) => {
    if (!gate(req, res)) return;
    try { if (c.cfg.defaultProvider === 'openrouter' || Object.values(c.cfg.agents).some(a => a.provider === 'openrouter')) await refreshRouterReasoning(); } catch { /* Capability status remains unverified. */ }
    res.json({ ok: true, ...modelSetupInfo(setupEnv(c.envFile)), runningAgents: AGENT_IDS.map((id) => ({ id, ...c.cfg.agents[id] })) });
  });
  app.get('/api/setup/preferences', (req, res) => {
    if (!gate(req, res)) return;
    res.json({ ok: true, values: preferencesInfo(setupEnv(c.envFile)), canRestart: process.env.MPU_MANAGED === '1' && !!process.send });
  });
  app.get('/api/setup/trading', (req, res) => {
    if (!gate(req, res)) return;
    try { res.json({ ok: true, ...tradingSetupInfo(setupEnv(c.envFile)), running: { mode: c.cfg.tradingMode, network: c.cfg.live?.network ?? null, profile: c.cfg.tradingProfile, values: tradingSettingsFromConfig(c.cfg) } }); }
    catch { res.status(400).json({ ok: false, detail: 'Saved trading settings are invalid. Check the network profile values.' }); }
  });
  app.post('/api/setup/trading/limits', async (req, res) => {
    if (!gate(req, res)) return;
    const parsed = TradingLimitsBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ok: false, detail: 'Use finite, nonnegative trade values. Zero disables the corresponding application limit.'});
    try {
      const saved = saveTradingLimits(c.envFile, parsed.data);
      const applied = await c.desk.applyTradingLimits(saved.network, parsed.data.minOrderUsdt, parsed.data.maxOrderUsdt);
      res.json({ok: true, applied, detail: applied ? 'Trading limits saved and applied.' : 'Trading limits saved for the selected network.'});
    } catch { res.status(400).json({ok: false, detail: 'Trading limits could not be saved.'}); }
  });
  app.post('/api/setup/trading', async (req, res) => {
    if (!gate(req, res)) return;
    const parsed = TradingProfileBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    try {
      const saved = saveTradingProfile(c.envFile, parsed.data);
      const applied = await c.desk.applyTradingSettings(saved.network, saved.profile, saved.values);
      res.json({ ok: true, applied, detail: applied ? `Saved and applied to ${saved.network}. Active orders and the daily loss latch are preserved.` : `Saved for ${saved.network}. The running ${c.cfg.tradingMode} mode is unchanged; this profile applies when that network is started.` });
    } catch { res.status(500).json({ ok: false, detail: 'Trading settings could not be saved or applied. Refresh to verify the saved profile.' }); }
  });
  app.post('/api/setup/preferences', (req, res) => {
    if (!gate(req, res)) return;
    try {
      const result = savePreferences(c.envFile, setupEnv(c.envFile), req.body);
      if (!result.ok) return res.status(400).json(result);
      applyDeskPreferences(c, loadConfig(setupEnv(c.envFile)));
      res.json({ ...result, applied: true, detail: 'Desk settings saved and applied to the running office.' });
    }
    catch { res.status(500).json({ ok: false, applied: false, detail: 'Settings could not be saved or applied. Check the saved configuration and local file permissions.' }); }
  });
  app.post('/api/setup/restart', (req, res) => {
    if (!gate(req, res)) return;
    return restartOffice(req, res, c);
  });
  app.get('/api/setup/local-agents', (req, res) => {
    if (!gate(req, res)) return;
    res.json({ ok: true, agents: localAgentStatus().map(agent => ({...agent, activeModel: c.cfg.defaultProvider === 'local' && c.cfg.defaultModels.local.startsWith(`${agent.id}:`) ? c.cfg.defaultModels.local : null})), settings: localAgentSettings(setupEnv(c.envFile)) });
  });
  app.post('/api/setup/local-agents/models', async (req, res) => {
    if (!gate(req, res, true)) return;
    const agent = LOCAL_AGENTS.find(a => a.id === req.body?.id);
    if (!agent) return res.status(400).json({ ok: false, detail: 'Unknown local agent.' });
    try { res.json({ ok: true, discovery: await discoverLocalModels(agent.id, true), agents: localAgentStatus() }); }
    catch { res.status(503).json({ ok: false, detail: 'Model metadata could not be refreshed.' }); }
  });
  app.post('/api/setup/local-agents/settings', (req, res) => {
    if (!gate(req, res, true)) return;
    const { id, settings } = req.body ?? {};
    try {
      const currentEnv = setupEnv(c.envFile);
      const updatedJson = localAgentSettingsUpdate(String(id), settings ?? {}, currentEnv);
      const updates = { LOCAL_AGENT_SETTINGS: updatedJson };
      setEnv(c.envFile, updates);
      Object.assign(process.env, updates);
      res.json({ ok: true, detail: 'Agent settings saved.', settings: localAgentSettings(process.env) });
    } catch (e) {
      res.status(400).json({ ok: false, detail: (e as Error).message });
    }
  });
  app.get('/api/setup/data-sources', (req, res) => {
    if (!gate(req, res)) return;
    res.json({ ok: true, ...dataSourcesStatus(setupEnv(c.envFile)) });
  });
  app.post('/api/setup/data-sources', (req, res) => {
    if (!gate(req, res, true)) return;
    const values = DataSourcesBody.safeParse(req.body);
    if (!values.success) return res.status(400).json({ ok: false, detail: 'Use the masked inputs for news and on-chain provider keys.' });
    try { res.json(saveDataSources(c.envFile, c.cfg, values.data)); }
    catch { res.status(400).json({ ok: false, detail: 'Data source settings could not be saved.' }); }
  });
  app.get('/api/setup/local-agents/research', async (req, res) => {
    if (!gate(req, res)) return;
    try { res.json({ ok: true, policy: researchPolicy(setupEnv(c.envFile)), connections: await localMcpInventory(), activity: localResearchActivity() }); }
    catch { res.status(503).json({ ok: false, detail: 'Codex research connections could not be inspected. Configuration alone does not confirm a live connection.' }); }
  });
  app.post('/api/setup/local-agents/research', async (req, res) => {
    if (!gate(req, res, true)) return;
    const parsed = ResearchPolicyBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, detail: 'Choose research access and explicit MCP tool names.' });
    try {
      await validateResearchConnections(parsed.data);
      const updates = { LOCAL_CODEX_RESEARCH_TOOLS: parsed.data.enabled ? 'on' : 'off', LOCAL_CODEX_MCP_TOOLS: JSON.stringify(parsed.data.mcpTools) };
      setEnv(c.envFile, updates);
      Object.assign(process.env, updates);
      res.json({ ok: true, detail: 'Research access saved. It applies to subsequent Codex calls. A connection is verified only after a successful tool call.' });
    } catch { res.status(503).json({ ok: false, detail: 'Research settings were not saved. Use configured MCP servers, explicit read tools, and OAuth or environment credential references.' }); }
  });
  const connecting = new Map<string, Promise<Record<string, unknown>>>();
  app.post('/api/setup/local-agents/connect', async (req, res) => {
    if (!gate(req, res, true)) return;
    const agent = LOCAL_AGENTS.find(a => a.id === req.body?.id);
    if (!agent) return res.status(400).json({ ok: false, state: 'CONFIGURATION FAILED', detail: 'Unknown local agent.' });
    let operation = connecting.get(agent.id);
    if (!operation) {
      operation = (async () => {
        const connectionSignal = AbortSignal.timeout(Number(process.env.LOCAL_AGENT_TEST_TIMEOUT_MS) || 40_000);
        const auth = await localLoginStatus(agent.id);
        if (auth.state === 'missing') return { ok: false, state: 'NOT INSTALLED', detail: 'Install the CLI first.' };
        if (!auth.connected && auth.state !== 'unknown' && req.body?.continue !== true) {
          if (auth.state !== 'pending') await openAgentLogin(agent.id);
          return { ok: true, active: false, state: 'AUTHENTICATING', detail: 'Complete native sign-in. Configuration continues automatically.' };
        }
        if (auth.state === 'pending') return { ok: true, active: false, state: 'AUTHENTICATING' };
        const discovery = await discoverLocalModels(agent.id);
        if (connectionSignal.aborted) return { ok: false, active: false, state: 'VERIFICATION FAILED', detail: 'Connection check timed out. Existing configuration preserved.' };
        const selected = discovery.configuredModel !== 'default' ? discovery.configuredModel
          : discovery.models.filter(m => m.source === 'cli' || m.source === 'metadata').find(m => m.reasoningLevels.includes('high'))?.id || 'default';
        const model = `${agent.id}:${selected}`;
        const current = setupEnv(c.envFile);
        const requestedReasoning = current.DEFAULT_REASONING_EFFORT ? loadConfig({...current, TRADING_MODE: 'PAPER'}).defaultReasoning : undefined;
        const selectedReasoning = reasoningStatus('local', model, requestedReasoning).effective || undefined;
        // This read-only probe, rather than process existence or cached auth, establishes model readiness.
        try {
          const reply = await runLocalAgent(model, 'Reply with exactly this JSON object: {"reply":"connected"}. Use no tools.', connectionSignal, undefined, { timeoutMs: Number(process.env.LOCAL_AGENT_TEST_TIMEOUT_MS) || 30_000 });
          const parsed = SCHEMAS.chat.safeParse(extractJson(reply));
          if (!parsed.success || parsed.data.reply !== 'connected') throw new Error();
        } catch (error) {
          if (/needs native CLI sign-in/i.test((error as Error).message) && req.body?.continue !== true) {
            await openAgentLogin(agent.id);
            return { ok: true, active: false, state: 'AUTHENTICATING', detail: 'Complete native sign-in. Configuration continues automatically.' };
          }
          return { ok: false, active: false, state: 'VERIFICATION FAILED', detail: safe((error as Error).message) || 'The selected CLI model did not return a valid reply. Existing configuration preserved.' };
        }
        // Read again after discovery/probe so edits made while login was pending are preserved.
        if (connectionSignal.aborted) return { ok: false, active: false, state: 'VERIFICATION FAILED', detail: 'Connection check timed out. Existing configuration preserved.' };
        const env = setupEnv(c.envFile);
        const updates: Record<string, string | null> = { DEFAULT_PROVIDER: 'local', LOCAL_MODEL: model, DEFAULT_REASONING_EFFORT: selectedReasoning ?? null };
        if (req.body?.assignAll === true) for (const id of AGENT_IDS) {
          for (const suffix of ['PROVIDER', 'MODEL', 'REASONING']) updates[`AGENT_${id.toUpperCase()}_${suffix}`] = null;
        }
        const next = loadConfig(Object.fromEntries(Object.entries({ ...env, ...updates }).filter(([, value]) => value !== null)) as NodeJS.ProcessEnv);
        const original = readFileSync(c.envFile);
        const temporary = `${c.envFile}.models-${randomUUID()}`;
        try {
          writeFileSync(temporary, original, { mode: 0o600 });
          setEnv(temporary, updates);
          renameSync(temporary, c.envFile);
          c.desk.applyModelConfig(next);
          for (const [key, value] of Object.entries(updates)) {
            if (value === null) delete process.env[key]; else process.env[key] = value;
          }
        } catch {
          writeFileSync(c.envFile, original, { mode: 0o600 });
          return { ok: false, active: false, state: 'CONFIGURATION FAILED', detail: 'Model configuration could not be applied. Previous saved settings restored.' };
        } finally { rmSync(temporary, { force: true }); }
        return { ok: true, active: true, state: 'CONNECTED & ACTIVE', model, reasoning: reasoningStatus('local', model, next.defaultReasoning), discovery, detail: `Connected & Active: ${model}. ${req.body?.assignAll === true ? 'Applied to all six agents.' : 'Explicit role assignments preserved.'}` };
      })();
      connecting.set(agent.id, operation);
    }
    try { const result = await operation; res.status(result.ok ? 200 : 400).json(result); }
    catch { res.status(400).json({ ok: false, active: false, state: 'CONFIGURATION FAILED', detail: 'Connection could not be configured. Check native CLI sign-in.' }); }
    finally { connecting.delete(agent.id); }
  });
  app.post('/api/setup/local-agents/login', async (req, res) => {
    if (!gate(req, res, true)) return;
    try { res.json({ ok: true, detail: await openAgentLogin(String(req.body?.id ?? '')) }); }
    catch { res.status(400).json({ ok: false, detail: 'Install that agent on PATH first, then reopen Setup.' }); }
  });
  app.post('/api/setup/local-agents/status', async (req, res) => {
    if (!gate(req, res, true)) return;
    const id = String(req.body?.id ?? '');
    try { localSelection(`${id}:default`); res.json({ ok: true, ...await localLoginStatus(id, req.body?.verify === true) }); }
    catch { res.status(400).json({ ok: false, detail: 'Choose a local agent first.' }); }
  });
  const testLim = c.limiter(3, 60_000);
  app.post('/api/setup/local-agents/test', async (req, res) => {
    if (!gate(req, res, true)) return;
    if (!testLim('local-test')) return res.status(429).json({ ok: false, detail: 'Wait a minute before testing again.' });
    const model = String(req.body?.model ?? '');
    try { localSelection(model); } catch { return res.status(400).json({ ok: false, detail: 'Choose a local agent first.' }); }
    try {
      const reply = await runLocalAgent(model, 'Reply with exactly this JSON object: {"reply":"connected"}. Use no tools.', undefined, undefined, { timeoutMs: Number(process.env.LOCAL_AGENT_TEST_TIMEOUT_MS) || 30_000 });
      const result = SCHEMAS.chat.safeParse(extractJson(reply));
      const ok = result.success && result.data.reply === 'connected';
      res.json({ ok, detail: ok ? 'Connection verified: the agent returned a valid model reply.' : 'The agent ran, but its reply did not match the expected JSON. Check its model settings.' });
    } catch (e) { res.status(400).json({ ok: false, detail: safe((e as Error).message) }); }
  });
  app.post('/api/setup/models', (req, res) => {
    if (!gate(req, res, true)) return;
    const p = ModelsBody.safeParse(req.body);
    if (!p.success) return res.status(400).json({ ok: false, detail: 'Invalid provider, model or key input.' });
    try {
      const env = setupEnv(c.envFile);
      const updates = modelUpdates(env, p.data);
      const next = loadConfig(Object.fromEntries(Object.entries({ ...env, ...updates }).filter(([, value]) => value !== null)) as NodeJS.ProcessEnv);
      setEnv(c.envFile, updates);
      for (const [key, value] of Object.entries(updates)) {
        if (value === null) delete process.env[key]; else process.env[key] = value;
      }
      c.desk.applyModelConfig(next);
      const missing = Object.entries(MODEL_KEY_ENV).filter(([provider, key]) => (provider === p.data.defaultProvider || Object.values(p.data.agents ?? {}).some((a) => a.provider === provider)) && !(updates[key] || env[key])).map(([provider]) => provider);
      res.json({ ok: true, applied: true, detail: `Provider and model choices saved and applied to the running agents.${missing.length ? ` No key set for ${missing.join(', ')}; those agents will use mock.` : ''}` });
    } catch { res.status(400).json({ ok: false, detail: 'Choose a model from the selected provider; keys must not contain whitespace.' }); }
  });
  app.get('/api/setup/jev', (req, res) => {
    if (!gate(req, res)) return;
    res.json({ ok: true, ...jevSetupInfo(setupEnv(c.envFile), c.cfg.tradingMode, c.desk.jev.metrics, c.desk.jevLast), dataCollection: c.desk.collectionLast });
  });
  app.post('/api/setup/jev', (req, res) => {
    if (!gate(req, res, true)) return;
    const p = JevSetupBody.safeParse(req.body);
    if (!p.success) return res.status(400).json({ ok: false, detail: 'Invalid Jev settings.' });
    try {
      saveJevSetup(c.envFile, p.data);
      const env = setupEnv(c.envFile);
      c.desk.jev.reload(env, c.cfg.tradingMode);
      const info = jevSetupInfo(env, c.cfg.tradingMode, c.desk.jev.metrics, c.desk.jevLast);
      res.json({ ok: true, detail: 'Jev settings saved. Enabling Jev does not place orders.', ...info });
    } catch { res.status(400).json({ ok: false, detail: 'Jev settings could not be saved.' }); }
  });
  app.post('/api/setup/jev/test', async (req, res) => {
    if (!gate(req, res, true)) return;
    if (!testLim('jev-test')) return res.status(429).json({ ok: false, detail: 'Wait a minute before testing again.' });
    const result = await c.desk.jev.testConnection();
    const body = { ok: result.ok, health: result.health, detail: result.error ?? (result.ok ? 'Jev Decisions API reachable.' : 'Jev test failed.'), latencyMs: result.latencyMs, model: result.response?.model ?? null };
    res.status(result.ok ? 200 : 400).json(body);
  });
  // Masked inputs from the Setup wizard. The body is never logged or echoed; the answer names the saved variables only.
  app.post('/api/setup/keys', async (req, res) => {
    if (!gate(req, res, true)) return;
    const p = KeysBody.safeParse(req.body);
    if (!p.success) return res.status(400).json({ ok: false, error: 'bad request: venue, network, key, secret (and third for OKX/dYdX)' });
    try {
      const r = await saveVenueKeys(c.envFile, p.data.venue, p.data.network, p.data, { fetchImpl: c.fetchImpl });
      if (r.ok) {
        const env = setupEnv(c.envFile);
        loadConfig(env);
        await c.desk.reloadRuntimeConfig(env, c.fetchImpl);
        c.desk.emit('state', c.desk.snapshot());
      }
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) { res.status(400).json({ ok: false, detail: safe((e as Error).message) }); }
  });
  app.post('/api/setup/venue', async (req, res) => {
    if (!gate(req, res, true)) return;
    const v = String(req.body?.venue ?? '');
    const r = setVenue(c.envFile, v);
    if (r.ok && EXCHANGES.includes(v as ExchangeName)) {
      try {
        const env = setupEnv(c.envFile);
        loadConfig(env);
        await c.desk.reloadRuntimeConfig(env, c.fetchImpl);
        c.desk.emit('state', c.desk.snapshot());
      } catch (e) {
        return res.status(409).json({ ok: false, detail: `Settings saved but active scope could not be changed: ${safe((e as Error).message)}` });
      }
    }
    res.status(r.ok ? 200 : 400).json(r);
  });
  app.post('/api/setup/mode', async (req, res) => {
    if (!gate(req, res, true)) return;
    const p = ModeBody.safeParse(req.body);
    if (!p.success) return res.status(400).json({ ok: false, detail: 'mode must be PAPER, TESTNET or LIVE' });
    const r = await setTradingMode(c.envFile, p.data.mode, { confirm: p.data.confirm, fetchImpl: c.fetchImpl });
    if (r.ok) {
      try {
        const env = setupEnv(c.envFile);
        loadConfig(env);
        await c.desk.reloadRuntimeConfig(env, c.fetchImpl);
        c.desk.emit('state', c.desk.snapshot());
      } catch (e) {
        return res.status(409).json({ ok: false, detail: `Settings saved but active scope could not be changed: ${safe((e as Error).message)}` });
      }
    }
    res.status(r.ok ? 200 : 400).json(r);
  });
  app.post('/api/setup/doctor', async (req, res) => {
    if (!gate(req, res)) return;
    try { res.json({ ok: true, lines: await doctor(setupEnv(c.envFile), c.fetchImpl ?? fetch) }); }
    catch (e) { res.status(500).json({ ok: false, error: safe((e as Error).message) }); }
  });
}

export function mountOpsRoutes(app: express.Express, c: RouteCtx) {
  const writeLim = c.limiter(60, 60_000);
  // Reads (guides, status) get a roomier limit so clicking through the wizard never locks it; writes stay at the tight limit.
  const readLim = c.limiter(300, 60_000);
  const lim = (k: string, req?: { method?: string }) => (req?.method === 'GET' ? readLim(k) : writeLim(k));
  const gate = (req: express.Request, res: express.Response) => {
    const a = localClient({ remoteAddress: req.socket.remoteAddress, hostHeader: req.headers.host ?? null, origin: (req.headers.origin as string | undefined) ?? null });
    if (!a.ok) { res.status(403).json({ ok: false, error: a.reason }); return false; }
    if (!lim(req.socket.remoteAddress ?? '', req)) { res.status(429).json({ ok: false, error: 'slow down' }); return false; }
    return true;
  };
  app.post('/api/ops/size', async (req, res) => {
    if (!gate(req, res)) return;
    const p = SizeBody.safeParse(req.body); if (!p.success) return res.status(400).json({ ok: false, text: 'symbol, side, stop (entry optional: live price)' });
    res.json(await c.desk.previewTicket(p.data));
  });
  // Same single execution path as everything else: risk gate caps, money split, required stop, daily stop, kill switch.
  app.post('/api/ops/open', async (req, res) => {
    if (!gate(req, res)) return;
    const p = OpenBody.safeParse(req.body);
    if (!p.success) return res.status(400).json({ ok: false, reply: 'no stop: every ticket needs a stop price. Not opening without one.' });
    res.json(await c.desk.gbOpen({ ...p.data, agent: 'execution' }, p.data.autonomous ?? false));
  });
  app.post('/api/ops/close', async (req, res) => {
    if (!gate(req, res)) return;
    const target = String(req.body?.symbol ?? '').slice(0, 20); if (!target) return res.status(400).json({ ok: false, reply: 'symbol or all' });
    res.json(await c.desk.gbClose(target, 'owner command: closed from the office'));
  });
  app.post('/api/ops/agent-close', async (req, res) => {
    if (!gate(req, res)) return;
    const parsed = AgentCloseSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: 'A typed CLOSE trigger, positionId, expectedQty and reason are required.' });
    res.json(await c.desk.agentClose(parsed.data));
  });
  app.post('/api/ops/agent-open', async (req, res) => {
    if (!gate(req, res)) return;
    const parsed = AgentOpenSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: 'Agent OPEN requires Risk APPROVE, actual Lead confidence and a reason.' });
    res.json(await c.desk.gbOpen({ ...parsed.data, agent: 'execution' }, true));
  });
  app.post('/api/ops/scan', (req, res) => { if (!gate(req, res)) return; res.json({ ok: true, findings: c.desk.scan() }); });
  app.get('/api/ops/lessons', (req, res) => { if (!gate(req, res)) return; res.json({ ok: true, lessons: c.desk.learnings.recent(30, c.desk.accountScope()), standingRules: c.desk.learnings.standingRules(undefined, c.desk.accountScope()), refused: c.desk.learnings.refused }); });
  app.post('/api/ops/lessons', (req, res) => {
    if (!gate(req, res)) return;
    const p = LessonBody.safeParse(req.body); if (!p.success) return res.status(400).json({ ok: false, error: 'role and a lesson of 2+ characters' });
    const r = c.desk.learn({ ...p.data, role: p.data.role as never, lesson: sanitizeUntrusted(p.data.lesson, 300).text, source: 'owner' });
    if (!r) return res.status(422).json({ ok: false, error: 'refused: empty, learning off, or it would loosen a guard' });
    res.json({ ok: true, lesson: r.lesson });
  });
  app.get('/api/ops/kill', (req, res) => {
    if (!gate(req, res)) return;
    res.json({ ok: true, killed: c.desk.killed, killedAt: c.desk.killedAt || null, release: c.desk.killed ? `Use the local Office OFF button or ${UNKILL_COMMAND}. Auto Trading is unchanged.` : null, unkillCommand: UNKILL_COMMAND });
  });
  app.post('/api/ops/kill', async (req, res) => {
    if (!gate(req, res)) return;
    const on = typeof req.body?.on === 'boolean' ? req.body.on : req.body?.action === 'release' ? false : typeof req.body?.killed === 'boolean' ? req.body.killed : undefined;
    if (on === undefined) return res.status(400).json({ ok: false, error: 'Explicit kill ON or OFF is required.' });
    let notes: string[] = [];
    if (on) {
      c.auto?.stop();
      notes = await c.desk.kill();
    } else {
      try { c.desk.unkill(); } catch (error) { return res.status(409).json({ ok: false, error: safe((error as Error).message) }); }
    }
    res.json({ ok: true, killed: c.desk.killed, killedAt: c.desk.killedAt || null, notes, unkillCommand: UNKILL_COMMAND });
  });
  app.post('/api/ops/restart', async (req, res) => {
    if (!gate(req, res)) return;
    return restartOffice(req, res, c);
  });
  app.post('/api/ops/auto', (req, res) => {
    if (!gate(req, res)) return;
    const p = AutoBody.safeParse(req.body);
    if (!p.success) return res.status(400).json({ ok: false, error: 'invalid auto trading settings' });
    if (c.desk.killed && p.data.on) return res.status(409).json({ ok: false, error: 'Kill switch is ON. Release it first before enabling Auto Trade.' });
    const envUpd: Record<string, string> = {};
    if (typeof p.data.on === 'boolean') envUpd.AUTO_TRADING = p.data.on ? 'on' : 'off';
    if (typeof p.data.intervalMin === 'number') envUpd.DEBATE_INTERVAL_MIN = String(p.data.intervalMin);
    if (Array.isArray(p.data.symbols)) envUpd.AUTO_SYMBOLS = p.data.symbols.map((s) => s.trim().toUpperCase()).filter(Boolean).join(',');
    if (typeof p.data.maxHoldHours === 'number') envUpd.MAX_HOLD_HOURS = String(p.data.maxHoldHours);
    if (typeof p.data.n === 'number') envUpd.OPEN_ORDERS_N = String(p.data.n);
    if (p.data.debateMode) envUpd.DEBATE_MODE = p.data.debateMode;
    if (Object.keys(envUpd).length > 0) setEnv(c.envFile, envUpd);
    const autoSnap = c.auto
      ? c.auto.configure(p.data)
      : (() => {
          if (typeof p.data.on === 'boolean') { c.cfg.auto.on = p.data.on; c.desk.autoState.on = p.data.on; }
          if (typeof p.data.intervalMin === 'number') { c.cfg.auto.intervalMin = p.data.intervalMin; c.desk.autoState.intervalMin = p.data.intervalMin; }
          if (Array.isArray(p.data.symbols)) c.cfg.auto.symbols = p.data.symbols.map((s) => s.trim().toUpperCase()).filter(Boolean);
          if (typeof p.data.maxHoldHours === 'number') c.cfg.auto.maxHoldHours = p.data.maxHoldHours;
          if (typeof p.data.n === 'number' && [1, 2, 3, 4].includes(p.data.n)) {
            c.desk.book.n = p.data.n as 1 | 2 | 3 | 4;
            c.cfg.paper.n = p.data.n as 1 | 2 | 3 | 4;
          }
          if (p.data.debateMode) c.cfg.debate.mode = p.data.debateMode;
          c.desk.emit('state', c.desk.snapshot());
          return c.desk.snapshot().auto;
        })();
    if (p.data.debateMode) {
      c.cfg.debate.mode = p.data.debateMode;
      c.desk.emit('state', c.desk.snapshot());
    }
    if (p.data.runNow && !c.desk.killed && c.auto) {
      void c.auto.cycle();
    }
    res.json({ ok: true, auto: autoSnap, n: c.desk.book.n });
  });
}
