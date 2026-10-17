// npm run doctor: checks config and keys with harmless reads. Never prints a secret.
import 'dotenv/config';
import { loadConfig, ConfigError, type ProviderName } from '../server/config.js';
import { exchangeSettings, makeAdapter, ADAPTER_STATUS, type Network } from '../server/exchange/index.js';
import { checkLiveUnlock, stateDir } from '../server/live/state.js';
import { safe } from '../server/redact.js';

type Line = { ok: boolean | null; label: string; detail: string };

export async function doctor(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<Line[]> {
  const out: Line[] = [];
  const add = (ok: boolean | null, label: string, detail: string) => out.push({ ok, label, detail: safe(detail) });
  let cfg;
  try { cfg = loadConfig({ ...env, TRADING_MODE: (env.TRADING_MODE ?? 'PAPER').toUpperCase() === 'LIVE' ? 'PAPER' : env.TRADING_MODE }); add(true, 'config', `APP_MODE ${cfg.appMode}, market ${cfg.marketSource}, N ${cfg.paper.n}`); }
  catch (e) { add(false, 'config', (e as Error).message); return out; }
  if ((env.TRADING_MODE ?? '').toUpperCase() === 'LIVE') {
    const c = checkLiveUnlock(env, stateDir(env));
    add(c.ok, 'LIVE unlock', c.ok ? 'signed state is valid' : c.reasons.join('; '));
  } else add(true, 'trading mode', 'PAPER');

  const probes: Record<Exclude<ProviderName, 'mock'>, (k: string) => [string, RequestInit]> = {
    xai: (k) => [`${cfg.baseUrls.xai}/models`, { headers: { Authorization: `Bearer ${k}` } }],
    openai: (k) => [`${cfg.baseUrls.openai}/models`, { headers: { Authorization: `Bearer ${k}` } }],
    deepseek: (k) => [`${cfg.baseUrls.deepseek}/models`, { headers: { Authorization: `Bearer ${k}` } }],
    openrouter: (k) => [`${cfg.baseUrls.openrouter}/key`, { headers: { Authorization: `Bearer ${k}` } }],
    anthropic: (k) => ['https://api.anthropic.com/v1/models', { headers: { 'x-api-key': k, 'anthropic-version': '2023-06-01' } }],
    gemini: (k) => ['https://generativelanguage.googleapis.com/v1beta/models', { headers: { 'x-goog-api-key': k } }]
  };
  for (const [p, key] of Object.entries(cfg.keys) as [Exclude<ProviderName, 'mock'>, string][]) {
    if (!key) continue;
    const [url, init] = probes[p](key);
    try { const r = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(8000) }); add(r.ok, `${p} key`, r.ok ? 'model list readable' : `HTTP ${r.status}`); }
    catch (e) { add(false, `${p} key`, (e as Error).message); }
  }
  for (const [id, a] of Object.entries(cfg.agents)) if (a.fellBackToMock) add(null, `agent ${id}`, 'provider has no key, using mock');

  let ex;
  try { ex = exchangeSettings(env); } catch (e) { add(false, 'exchange', (e as Error).message); return out; }
  if (ex.name) {
    if (env.HYPERLIQUID_PRIVATE_KEY || env.HYPERLIQUID_MAIN_PRIVATE_KEY) add(false, 'hyperliquid', 'a main wallet private key variable is set. Remove it. Only an API agent wallet key belongs here.');
    for (const net of ['testnet', 'mainnet'] as Network[]) {
      const c = ex.creds[net];
      if (!c) { add(null, `${ex.name} ${net}`, 'no keys'); continue; }
      try {
        const a = makeAdapter(ex.name, net, c, fetchImpl);
        const ping = await a.ping();
        add(ping.ok, `${ex.name} ${net} read`, ping.detail);
        const perm = await a.permissions();
        add(perm.ok && perm.canWithdraw !== true, `${ex.name} ${net} permissions`, perm.detail);
      } catch (e) { add(false, `${ex.name} ${net}`, (e as Error).message); }
    }
    add(null, `${ex.name} adapter`, ADAPTER_STATUS[ex.name]);
  } else add(null, 'exchange', 'none (paper only)');
  add(cfg.tradingview.webhookEnabled ? true : null, 'TradingView webhook', cfg.tradingview.webhookEnabled ? 'on, POST /api/tradingview' : 'off');
  add(cfg.agentEvents.enabled ? true : null, 'Grok Bot agent events', cfg.agentEvents.enabled ? 'on, POST /api/agent-event' : 'off');
  add(cfg.news.provider === 'sample' ? null : !!cfg.news.key, 'news plugin', cfg.news.provider === 'sample' ? 'sample news' : cfg.news.key ? 'cryptopanic key set' : 'cryptopanic selected but no key');
  return out;
}

const isMain = process.argv[1] && /doctor\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  doctor().then((lines) => {
    console.log('\nTrading Agent Mpu Gandring doctor');
    for (const l of lines) console.log(`  ${l.ok === true ? 'OK  ' : l.ok === false ? 'FAIL' : '--  '} ${l.label.padEnd(26)} ${l.detail}`);
    process.exitCode = lines.some((l) => l.ok === false) ? 1 : 0;
  }).catch((e) => { console.error(e instanceof ConfigError ? e.message : safe((e as Error).message)); process.exit(1); });
}
