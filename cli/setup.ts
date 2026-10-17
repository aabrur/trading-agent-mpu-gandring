// npm run setup                      interactive wizard (writes .env; PAPER unless you pick TESTNET or LIVE)
// npm run setup -- --yes [flags]     non-interactive, for coding agents (see AGENTS.md)
// npm run setup -- check-key         re-run the automatic withdraw-permission check
// npm run setup -- paper             back to PAPER (alias: lock)
// npm run setup -- status            what is configured, secrets masked
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { config as loadDotenv } from 'dotenv';
import { readEnv, setEnv, ensureEnv, mask } from './envfile.js';
import { ask, askSecret, askYes, choose, isInteractive } from './prompt.js';
import { PROVIDERS, AGENT_IDS, type ProviderName } from '../server/config.js';
import { EXCHANGES, envNames, ADAPTER_STATUS, VENUE_KIND, VENUE_LABEL, VENUE_KEY_HINT, PUBLIC_KEY_FIELD, PUBLIC_THIRD_FIELD, type ExchangeName } from '../server/exchange/index.js';
import { checkTradingMode, networkFor, type TradingMode } from '../server/live/guard.js';
import { checkKeyStep, localKeyCheck } from '../server/live/steps.js';
import { registerSecrets } from '../server/redact.js';
import { exchangeSecrets } from '../server/exchange/index.js';

// The shell environment as it was at start (dotenv/config never overrides it). --keys-from-env reads from here,
// because currentEnv() loads the .env file with override and would blank values that are empty in .env.
const shellEnv: NodeJS.ProcessEnv = { ...process.env };
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const many = (name: string) => argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] ? [argv[i + 1]] : []));
const ENV_FILE = opt('dotenv') ?? '.env';
const sub = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'wizard';
const secret = () => randomBytes(32).toString('base64url');
const KEY_VARS: Record<Exclude<ProviderName, 'mock'>, string> = { xai: 'XAI_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY', deepseek: 'DEEPSEEK_API_KEY', openrouter: 'OPENROUTER_API_KEY' };

function currentEnv() {
  ensureEnv(ENV_FILE);
  const fileEnv = readEnv(ENV_FILE);
  loadDotenv({ path: ENV_FILE, override: true, quiet: true } as never);
  const env = { ...process.env, ...fileEnv };
  registerSecrets([...exchangeSecrets(env), ...Object.values(KEY_VARS).map((k) => env[k]), env.AGENT_EVENT_SECRET, env.TRADINGVIEW_PASSPHRASE, env.GROKBOT_WEBHOOK_KEY, env.CRYPTOPANIC_API_KEY, env.TELEGRAM_BOT_TOKEN]);
  return env;
}

function status() {
  const env = currentEnv();
  const ex = (env.EXCHANGE || 'none') as ExchangeName | 'none';
  console.log(`\nTrading Agent Mpu Gandring setup (${ENV_FILE})`);
  console.log(`  TRADING_MODE      ${env.TRADING_MODE || 'PAPER'}`);
  console.log(`  APP_MODE          ${env.APP_MODE || 'local'}`);
  console.log(`  model keys        ${Object.entries(KEY_VARS).map(([p, k]) => `${p}:${env[k] ? 'yes' : 'no'}`).join(' ')}`);
  console.log(`  agents            ${AGENT_IDS.map((a) => `${a}=${env[`AGENT_${a.toUpperCase()}_PROVIDER`] || env.DEFAULT_PROVIDER || 'mock'}`).join(' ')}`);
  console.log(`  TradingView       widget ${env.TRADINGVIEW_WIDGET || 'off'}, webhook ${env.TRADINGVIEW_PASSPHRASE ? 'on' : 'off'}`);
  console.log(`  news plugin       ${env.NEWS_PROVIDER || 'sample'}${env.CRYPTOPANIC_API_KEY ? ' (key set)' : ''}`);
  console.log(`  exchange          ${ex}${ex !== 'none' ? ` (${ADAPTER_STATUS[ex]})` : ''}`);
  if (ex !== 'none') for (const net of ['testnet', 'mainnet'] as const) { const n = envNames(ex, net); console.log(`    ${net.padEnd(8)} ${n.key} ${PUBLIC_KEY_FIELD.has(ex) ? env[n.key] || '(empty)' : mask(env[n.key])}, ${n.secret} ${mask(env[n.secret])}${n.passphrase ? `, ${n.passphrase} ${PUBLIC_THIRD_FIELD.has(ex) ? env[n.passphrase] || '(empty)' : mask(env[n.passphrase])}` : ''}`); }
  console.log(`  auto trading      ${env.AUTO_TRADING || 'off'}, debate every ${env.DEBATE_INTERVAL_MIN || 15} min, max hold ${env.MAX_HOLD_HOURS || 0}h (0 = off)`);
  console.log(`  reports           every ${env.REPORT_INTERVAL_MIN || 60} min${env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID ? ', Telegram on' : ''}${env.GROKBOT_WEBHOOK_URL ? ', Grok Bot bridge on' : ''}`);
  console.log(`  safety net        ${env.SAFETY_NET || 200} USDT, N ${env.OPEN_ORDERS_N || 4}, daily loss stop ${env.DAILY_LOSS_LIMIT_PCT || 3}%`);
  console.log('');
}

async function wizard() {
  const nonInteractive = flag('yes') || !isInteractive();
  const env = currentEnv();
  // LIVE_CONFIRMED (old unlock) and AGENT_REVIEWER_* (old 7th agent, now part of the Desk Lead) are cleaned up.
  const up: Record<string, string | null> = { LIVE_CONFIRMED: null, AGENT_REVIEWER_PROVIDER: null, AGENT_REVIEWER_MODEL: null };
  console.log('\nTrading Agent Mpu Gandring setup. Everything goes into .env on this computer. Keys are only sent to their own provider to check them.');
  console.log('After setup the desk trades on its own (full auto). PAPER is the default. LIVE uses real money and can lose it. Not financial advice.\n');

  // 1. app mode
  const appMode = (opt('app-mode') ?? (nonInteractive ? env.APP_MODE || 'local' : await choose('Who drives the agents? local = models on this computer, grokbot = your Grok Bot team', ['local', 'grokbot'] as const, (env.APP_MODE as 'local') || 'local'))) as string;
  up.APP_MODE = appMode;
  if (appMode === 'grokbot' && (!env.AGENT_EVENT_SECRET || flag('generate-agent-secret'))) { up.AGENT_EVENT_SECRET = secret(); console.log('  generated AGENT_EVENT_SECRET (in .env; paste it into your Grok Bot routine as a secret, never in chat)'); }
  if (appMode === 'grokbot' && !nonInteractive) {
    const url = await ask('Grok Bot webhook URL for commands and verdicts (Enter to skip)', env.GROKBOT_WEBHOOK_URL || '');
    if (url) { up.GROKBOT_WEBHOOK_URL = url; const k = await askSecret('Grok Bot webhook key'); if (k) up.GROKBOT_WEBHOOK_KEY = k; }
  }

  // 2. model keys and per-agent mapping
  if (flag('keys-from-env')) {
    for (const k of [...Object.values(KEY_VARS), 'CRYPTOPANIC_API_KEY', 'GROKBOT_WEBHOOK_URL', 'GROKBOT_WEBHOOK_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']) if (shellEnv[k]) up[k] = shellEnv[k]!;
    for (const name of EXCHANGES) for (const net of ['testnet', 'mainnet'] as const) for (const k of Object.values(envNames(name, net))) if (shellEnv[k]) up[k] = shellEnv[k]!;
    console.log('  copied keys that were set in the current shell environment');
  } else if (appMode === 'grokbot') {
    console.log('\nGrok Bot mode: no model API keys needed. Your six Grok Bot agents are the brains.');
  } else if (!nonInteractive) {
    console.log('\nModel API keys. Enter skips a provider. Agents without a key use the offline mock.');
    for (const [p, k] of Object.entries(KEY_VARS)) { const v = await askSecret(`  ${p} key${env[k] ? ' (already set, Enter keeps it)' : ''}`); if (v) up[k] = v; }
  }
  const have = (p: string) => p === 'mock' || !!(up[KEY_VARS[p as keyof typeof KEY_VARS]] ?? env[KEY_VARS[p as keyof typeof KEY_VARS]]);
  const def = opt('default-provider') ?? (nonInteractive ? env.DEFAULT_PROVIDER || 'mock' : await choose('Default provider for agents', PROVIDERS, (env.DEFAULT_PROVIDER as ProviderName) || 'mock'));
  if (!PROVIDERS.includes(def as ProviderName)) throw new Error(`unknown provider ${def}`);
  up.DEFAULT_PROVIDER = def;
  for (const m of many('agent')) { const [a, p] = m.split('='); if (!AGENT_IDS.includes(a as never) || !PROVIDERS.includes(p as never)) throw new Error(`--agent ${m}: use id=provider`); up[`AGENT_${a.toUpperCase()}_PROVIDER`] = p; }
  for (const m of many('model')) { const [a, ...rest] = m.split('='); if (!AGENT_IDS.includes(a as never)) throw new Error(`--model ${m}: use id=model`); up[`AGENT_${a.toUpperCase()}_MODEL`] = rest.join('='); }
  if (appMode !== 'grokbot' && !nonInteractive && await askYes('Give each of the six agents its own provider?', false)) {
    for (const a of AGENT_IDS) { const p = await choose(`  ${a}`, PROVIDERS, (env[`AGENT_${a.toUpperCase()}_PROVIDER`] as ProviderName) || (def as ProviderName)); up[`AGENT_${a.toUpperCase()}_PROVIDER`] = p; if (!have(p)) console.log(`    no ${p} key yet, ${a} will use mock until you add one`); }
  }

  // 3. TradingView
  const tvWidget = opt('tradingview-widget') ?? (nonInteractive ? env.TRADINGVIEW_WIDGET || 'off' : ((await askYes('Show a TradingView chart widget in the office? (loads tradingview.com in your browser)', env.TRADINGVIEW_WIDGET === 'on')) ? 'on' : 'off'));
  up.TRADINGVIEW_WIDGET = tvWidget;
  const tvHook = opt('tradingview-webhook') ?? (nonInteractive ? (env.TRADINGVIEW_PASSPHRASE ? 'on' : 'off') : ((await askYes('Accept TradingView alert webhooks? (alerts start a debate, never an order)', !!env.TRADINGVIEW_PASSPHRASE)) ? 'on' : 'off'));
  if (tvHook === 'on' && !env.TRADINGVIEW_PASSPHRASE) { up.TRADINGVIEW_PASSPHRASE = randomBytes(18).toString('base64url'); console.log('  generated TRADINGVIEW_PASSPHRASE (in .env; put it in the alert message JSON)'); }
  if (tvHook === 'off') up.TRADINGVIEW_PASSPHRASE = '';

  // 4. plugins
  const news = opt('news') ?? (nonInteractive ? env.NEWS_PROVIDER || 'sample' : await choose('News plugin (optional)', ['sample', 'cryptopanic'] as const, (env.NEWS_PROVIDER as 'sample') || 'sample'));
  up.NEWS_PROVIDER = news;
  if (news === 'cryptopanic' && !nonInteractive) { const k = await askSecret('  CryptoPanic API key'); if (k) up.CRYPTOPANIC_API_KEY = k; }

  // 5. exchange
  const cex = EXCHANGES.filter((x) => VENUE_KIND[x] === 'CEX'), dex = EXCHANGES.filter((x) => VENUE_KIND[x] === 'DEX');
  if (!nonInteractive && !opt('exchange')) {
    console.log('\nVenues (perpetual futures). Pick by the short name.');
    console.log(`  CEX (centralized): ${cex.map((x) => `${x} (${VENUE_LABEL[x]}${ADAPTER_STATUS[x] === 'experimental' ? ', experimental' : ''})`).join(', ')}`);
    console.log(`  DEX (perp DEX, delegated trade-only keys): ${dex.map((x) => `${x} (${VENUE_LABEL[x]}, experimental)`).join(', ')}`);
  }
  const exName = (opt('exchange') ?? (nonInteractive ? env.EXCHANGE || 'none' : await choose('Venue for testnet and (later) live', ['none', ...cex, ...dex] as const, (env.EXCHANGE as 'none') || 'none'))) as ExchangeName | 'none';
  if (exName !== 'none' && !EXCHANGES.includes(exName)) throw new Error(`unknown exchange ${exName}`);
  up.EXCHANGE = exName;
  if (exName !== 'none' && flag('keys-from-env')) for (const net of ['testnet', 'mainnet'] as const) {
    const n = envNames(exName, net), k = up[n.key] ?? '', sct = up[n.secret] ?? '';
    const bad = k && sct ? localKeyCheck(exName, k, sct, n.passphrase ? up[n.passphrase] ?? undefined : undefined) : null;
    if (bad) { console.log(`  REFUSED ${net} keys from the environment: ${bad}`); up[n.key] = null; up[n.secret] = null; if (n.passphrase) up[n.passphrase] = null; }
  }
  if (exName !== 'none') {
    if (ADAPTER_STATUS[exName] === 'experimental') console.log(`  note: the ${exName} adapter is EXPERIMENTAL and untested against a real account`);
    if (!nonInteractive) {
      console.log(`  ${VENUE_LABEL[exName]}: ${VENUE_KEY_HINT[exName]}.`);
      console.log(VENUE_KIND[exName] === 'DEX'
        ? '  Never the main wallet private key or seed phrase. Only a delegated trading key that cannot withdraw. See docs/venues.md.'
        : '  Create keys with trading permission only. Withdrawals OFF. An IP whitelist is a good idea.');
      if (exName === 'dydx') console.log('  dYdX trading also needs the official SDK on this computer: npm install @dydxprotocol/v4-client-js');
      for (const net of ['testnet', 'mainnet'] as const) {
        const n = envNames(exName, net);
        if (!(await askYes(`  Enter ${net} keys now?`, net === 'testnet'))) continue;
        const k = PUBLIC_KEY_FIELD.has(exName) ? await ask(`    ${n.key}`, env[n.key] || '') : await askSecret(`    ${n.key}`);
        const sct = await askSecret(`    ${n.secret}`);
        const pp = n.passphrase ? (PUBLIC_THIRD_FIELD.has(exName) ? await ask(`    ${n.passphrase}`, env[n.passphrase] || '') : await askSecret(`    ${n.passphrase}`)) : '';
        if (k && sct) { const bad = localKeyCheck(exName, k, sct, pp || undefined); if (bad) { console.log(`    REFUSED: ${bad}`); continue; } }
        if (k) up[n.key] = k; if (sct) up[n.secret] = sct; if (n.passphrase && pp) up[n.passphrase] = pp;
      }
    }
  }

  // 6. money and risk
  const num = async (k: string, flagName: string, q: string, d: string) => { const v = opt(flagName) ?? (nonInteractive ? env[k] || d : await ask(q, env[k] || d)); if (!Number.isFinite(Number(v))) throw new Error(`${k} must be a number`); up[k] = String(v); };
  await num('PAPER_BALANCE', 'balance', 'Paper balance (USDT)', '1000');
  await num('SAFETY_NET', 'safety-net', 'Safety net, never traded (USDT)', '200');
  await num('OPEN_ORDERS_N', 'n', 'Max open orders N (1 to 4)', '4');
  if (![1, 2, 3, 4].includes(Number(up.OPEN_ORDERS_N))) throw new Error('N must be 1, 2, 3 or 4');
  await num('DAILY_LOSS_LIMIT_PCT', 'daily-loss', 'Daily loss stop, percent of equity', '3');
  if (opt('market-source')) up.MARKET_SOURCE = opt('market-source')!;

  // 7. full auto and reports
  const auto = opt('auto') ?? (nonInteractive ? env.AUTO_TRADING || 'on' : ((await askYes('Full auto trading after setup? (agents open, close and size on their own)', (env.AUTO_TRADING ?? 'on') !== 'off')) ? 'on' : 'off'));
  up.AUTO_TRADING = auto === 'off' ? 'off' : 'on';
  await num('DEBATE_INTERVAL_MIN', 'debate-interval', 'Minutes between debate cycles', '15');
  await num('MAX_HOLD_HOURS', 'max-hold', 'Close positions after this many hours (0 = no limit)', '0');
  await num('REPORT_INTERVAL_MIN', 'report-interval', 'Report every how many minutes (e.g. 30, 60, 240)', '60');
  if (!nonInteractive && await askYes('Also send reports to Telegram? (experimental)', !!env.TELEGRAM_BOT_TOKEN)) {
    const t = await askSecret('  Telegram bot token'); if (t) up.TELEGRAM_BOT_TOKEN = t;
    const c = await ask('  Telegram chat id', env.TELEGRAM_CHAT_ID || ''); if (c) up.TELEGRAM_CHAT_ID = c;
  }

  // 8. trading mode, last, with the automatic key check
  let mode = (opt('trading-mode') ?? (nonInteractive ? 'PAPER' : (await choose('Trading mode', ['paper', 'testnet', 'live'] as const, 'paper')))).toUpperCase() as TradingMode;
  if (!['PAPER', 'TESTNET', 'LIVE'].includes(mode)) throw new Error('--trading-mode must be paper, testnet or live');
  if (mode !== 'PAPER') {
    const merged = { ...env, ...Object.fromEntries(Object.entries(up).filter(([, v]) => v !== null)) } as NodeJS.ProcessEnv;
    const pre = checkTradingMode(merged, mode);
    let why = pre.ok ? '' : pre.reasons.join('; ');
    if (!why) {
      const k = await checkKeyStep(merged, networkFor(mode)!).catch((e) => ({ ok: false, detail: (e as Error).message }));
      if (!k.ok) why = k.detail; else console.log(`  key check: ${k.detail}`);
    }
    if (why) { console.log(`\n  ${mode} refused: ${why}\n  Staying in PAPER.`); mode = 'PAPER'; process.exitCode = 2; }
    else if (mode === 'LIVE') console.log('\n  LIVE selected. Real money, full auto. You can lose the whole Money Trade part. Not financial advice. Kill switch is in the office.');
  }
  up.TRADING_MODE = mode;

  setEnv(ENV_FILE, up);
  console.log(`\nSaved ${ENV_FILE}. TRADING_MODE=${mode}.`);
  status();
  console.log('Next: npm run doctor, then npm run dev.');
}

async function main() {
  switch (sub) {
    case 'wizard': return wizard();
    case 'status': return status();
    case 'paper': case 'lock': setEnv(ENV_FILE, { TRADING_MODE: 'PAPER', LIVE_CONFIRMED: null }); console.log('Back to PAPER.'); return;
    case 'check-key': {
      const net = (opt('network') ?? 'mainnet') as 'mainnet' | 'testnet';
      const r = await checkKeyStep(currentEnv(), net);
      console.log(`${r.ok ? 'OK' : 'REFUSED'} (${r.exchange} ${net}): ${r.detail}`);
      process.exitCode = r.ok ? 0 : 1; return;
    }
    default: console.error(`unknown command ${sub}`); process.exitCode = 1;
  }
}
main().catch((e) => { console.error(`setup failed: ${(e as Error).message}`); process.exit(1); });
