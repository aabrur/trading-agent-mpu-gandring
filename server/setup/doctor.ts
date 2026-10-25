// Doctor: checks config and keys with harmless reads. Never prints a secret. Shared by npm run doctor and the office Setup wizard.
import { loadConfig, ConfigError, type ApiProviderName } from '../config.js';
import { localExecutable, localSelection } from '../providers/local.js';
import { createRequire } from 'node:module';
import { exchangeSettings, makeAdapter, ADAPTER_STATUS, VENUE_KIND, VENUE_LABEL, type Network } from '../exchange/index.js';
import { checkTradingMode, type TradingMode } from '../live/guard.js';
import { roundTripCheck, localKeyCheck } from '../live/steps.js';
import { safe } from '../redact.js';
import { loadJevSettings } from '../decision/jev.js';
import { checkCoinMarketCapKey } from '../market/coinmarketcap.js';

type Line = { ok: boolean | null; label: string; detail: string };

export async function doctor(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch, opts: { roundtrip?: boolean } = {}): Promise<Line[]> {
  const out: Line[] = [];
  const add = (ok: boolean | null, label: string, detail: string) => out.push({ ok, label, detail: safe(detail) });
  let cfg;
  const mode = (env.TRADING_MODE ?? 'PAPER').trim().toUpperCase() as TradingMode;
  try { cfg = loadConfig({ ...env, TRADING_MODE: 'PAPER' }); add(true, 'config', `APP_MODE ${cfg.appMode}, market ${cfg.marketSource}, N ${cfg.paper.n}, auto ${cfg.auto.on ? `every ${cfg.auto.intervalMin} min` : 'off'}, reports every ${cfg.reports.intervalMin} min`); }
  catch (e) { add(false, 'config', (e as Error).message); return out; }
  if (mode !== 'PAPER') {
    const c = checkTradingMode(env, mode);
    add(c.ok, 'trading mode', c.ok ? `${mode} ready (key permissions checked below)` : `${mode}: ${c.reasons.join('; ')}`);
  } else add(true, 'trading mode', 'PAPER');

  const probes: Record<ApiProviderName, (k: string) => [string, RequestInit]> = {
    xai: (k) => [`${cfg.baseUrls.xai}/models`, { headers: { Authorization: `Bearer ${k}` } }],
    openai: (k) => [`${cfg.baseUrls.openai}/models`, { headers: { Authorization: `Bearer ${k}` } }],
    deepseek: (k) => [`${cfg.baseUrls.deepseek}/models`, { headers: { Authorization: `Bearer ${k}` } }],
    openrouter: (k) => [`${cfg.baseUrls.openrouter}/key`, { headers: { Authorization: `Bearer ${k}` } }],
    groq: (k) => [`${cfg.baseUrls.groq}/models`, { headers: { Authorization: `Bearer ${k}` } }],
    mistral: (k) => [`${cfg.baseUrls.mistral}/models`, { headers: { Authorization: `Bearer ${k}` } }],
    together: (k) => [`${cfg.baseUrls.together}/models`, { headers: { Authorization: `Bearer ${k}` } }],
    fireworks: (k) => [`${cfg.baseUrls.fireworks}/models`, { headers: { Authorization: `Bearer ${k}` } }],
    anthropic: (k) => ['https://api.anthropic.com/v1/models', { headers: { 'x-api-key': k, 'anthropic-version': '2023-06-01' } }],
    gemini: (k) => ['https://generativelanguage.googleapis.com/v1beta/models', { headers: { 'x-goog-api-key': k } }]
  };
  for (const [p, key] of Object.entries(cfg.keys) as [ApiProviderName, string][]) {
    if (!key) continue;
    const [url, init] = probes[p](key);
    try { const r = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(8000) }); add(r.ok, `${p} key`, r.ok ? 'model list readable' : `HTTP ${r.status}`); }
    catch (e) { add(false, `${p} key`, (e as Error).message); }
  }
  for (const [id, a] of Object.entries(cfg.agents)) if (a.provider === 'local') {
    try { const selection = localSelection(a.model); add(!!localExecutable(selection.id), `agent ${id}`, `${selection.id}: installation checked; use Setup to test sign-in and a model reply`); }
    catch { add(false, `agent ${id}`, 'unknown local agent or model'); }
  }
  if (cfg.appMode === 'grokbot') add(true, 'agents', 'Grok Bot mode: six Grok Bot agents, no model keys needed, internal debate engine off');
  else for (const [id, a] of Object.entries(cfg.agents)) if (a.fellBackToMock) add(null, `agent ${id}`, 'provider has no key, using mock');
  add(cfg.learning.on ? true : null, 'learning', cfg.learning.on ? `self-improving on (promote after ${cfg.learning.promoteAfter}), proaktif-agent scan ${cfg.learning.scan ? 'on' : 'off'}, lessons in ${cfg.learning.path ?? 'memory only'}` : 'off (LEARNING=off)');
  if (env.AGENT_REVIEWER_PROVIDER || env.AGENT_REVIEWER_MODEL) add(null, 'agent reviewer', 'ignored: the desk has six agents now, the Desk Lead keeps the journal. Remove AGENT_REVIEWER_*.');

  let ex;
  try { ex = exchangeSettings(env); } catch (e) { add(false, 'exchange', (e as Error).message); return out; }
  if (ex.name) {
    const mainVars = Object.keys(env).filter((k) => /(^|_)(MAIN_PRIVATE_KEY|MAIN_WALLET_KEY|SEED|SEED_PHRASE|MNEMONIC)$/.test(k) || k === 'HYPERLIQUID_PRIVATE_KEY');
    if (mainVars.length) add(false, 'main wallet keys', `${mainVars.join(', ')} set. Remove ${mainVars.length > 1 ? 'them' : 'it'}. Only delegated trading keys belong here, never a main wallet key or seed.`);
    add(null, `${ex.name} venue`, `${VENUE_LABEL[ex.name]} (${VENUE_KIND[ex.name]}), stops placed on the exchange: yes`);
    if (ex.name === 'dydx') {
      let sdk = false; try { createRequire(import.meta.url).resolve('@dydxprotocol/v4-client-js'); sdk = true; } catch { /* missing */ }
      add(sdk ? true : null, 'dydx SDK', sdk ? '@dydxprotocol/v4-client-js installed (needed to place orders)' : 'not installed. Reads work; to trade run: npm install @dydxprotocol/v4-client-js');
    }
    for (const net of ['testnet', 'mainnet'] as Network[]) {
      const c = ex.creds[net];
      if (!c) { add(null, `${ex.name} ${net}`, 'no keys'); continue; }
      const bad = localKeyCheck(ex.name, c.key, c.secret, c.passphrase);
      if (bad) { add(false, `${ex.name} ${net} key`, `REFUSED: ${bad}`); continue; }
      try {
        const a = makeAdapter(ex.name, net, c, fetchImpl);
        const ping = await a.ping();
        add(ping.ok, `${ex.name} ${net} read`, ping.detail);
        const perm = await a.permissions();
        add(perm.ok && perm.canWithdraw !== true, `${ex.name} ${net} permissions`, `${perm.canWithdraw === true ? 'WITHDRAW ENABLED, will be refused. ' : ''}${perm.detail}`);
      } catch (e) { add(false, `${ex.name} ${net}`, (e as Error).message); }
    }
    add(null, `${ex.name} adapter`, ADAPTER_STATUS[ex.name]);
    if (opts.roundtrip) {
      try { const rt = await roundTripCheck(env, { factory: (n, net, c) => makeAdapter(n, net, c, fetchImpl) }); add(rt.ok, 'testnet round trip', rt.steps.join(' | ')); }
      catch (e) { add(false, 'testnet round trip', (e as Error).message); }
    }
  } else add(null, 'exchange', 'none (paper only)');
  add(cfg.tradingview.webhookEnabled ? true : null, 'TradingView webhook', cfg.tradingview.webhookEnabled ? 'on, POST /api/tradingview' : 'off');
  add(cfg.agentEvents.enabled ? true : null, 'Grok Bot agent events', cfg.agentEvents.enabled ? 'on, POST /api/agent-event' : 'off');
  const ch = cfg.channels; const chOn = (['telegram', 'discord', 'slack', 'whatsapp'] as const).filter((n) => ch[n].enabled);
  add(chOn.length ? true : null, 'chat channels', chOn.length ? `${chOn.join(', ')}; Desk Lead ${ch.supervisor.on ? 'on' : 'off'}; chat commands ${ch.commands ? 'on (allowlisted ids only)' : 'off'}` : 'none (npm run channels -- setup <channel>)');
  add(cfg.news.provider === 'sample' ? null : !!cfg.news.key, 'news plugin', cfg.news.provider === 'sample' ? 'sample news' : cfg.news.key ? 'cryptopanic key set' : 'cryptopanic selected but no key');
  const cmcKey = (env.COINMARKETCAP_API_KEY || env.CMC_API_KEY || '').trim();
  if (cmcKey) {
    const cmc = await checkCoinMarketCapKey(cmcKey, fetchImpl);
    add(cmc.ok, 'coinmarketcap', cmc.ok ? `${cmc.plan ?? 'Basic'} plan (${cmc.creditsLeft !== undefined ? cmc.creditsLeft + ' credits left today' : 'verified'})` : `key error: ${cmc.error ?? 'invalid'}`);
  }
  const jev = loadJevSettings(env, mode);
  if (!jev.enabled) add(null, 'jev', 'off (optional decision sidecar; enable in Setup > Models)');
  else if (jev.health === 'MISSING_KEY') add(false, 'jev', 'enabled but no OpenRouter key (OPENROUTER_API_KEY or JEV_OPENROUTER_API_KEY)');
  else add(true, 'jev', `${jev.effectiveMode} · ${jev.provider} · ${jev.model}; LIVE assist ${jev.allowLive ? 'allowed' : 'blocked'}`);
  return out;
}

