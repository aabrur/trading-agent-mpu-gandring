// npm run setup                      interactive wizard (writes .env; PAPER unless you pick TESTNET or LIVE)
// npm run setup -- --yes [flags]     non-interactive, for coding agents (see AGENTS.md)
// npm run setup -- check-key         re-run the automatic withdraw-permission check
// npm run setup -- paper             back to PAPER (alias: lock)
// npm run setup -- status            what is configured, secrets masked
// npm run setup -- channel <telegram|discord|slack|whatsapp>   chat channel for the Desk Lead (same as npm run channels -- setup)
// npm run setup -- guide <venue> [--network testnet|mainnet]   the direct links for that venue, step by step
// The venue guide, key checks, mode checks and doctor are shared with the office Setup wizard (server/setup/*).
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { config as loadDotenv } from 'dotenv';
import { readEnv, setEnv, ensureEnv, mask } from './envfile.js';
import { ask, askSecret, askYes, choose, isInteractive } from './prompt.js';
import { channelWizard } from './channels.js';
import { CHANNELS } from '../server/channels/config.js';
import { isChannel } from '../server/channels/setup.js';
import { PROVIDERS, AGENT_IDS, type ProviderName } from '../server/config.js';
import { EXCHANGES, envNames, ADAPTER_STATUS, VENUE_KIND, VENUE_LABEL, VENUE_KEY_HINT, PUBLIC_KEY_FIELD, PUBLIC_THIRD_FIELD, type ExchangeName } from '../server/exchange/index.js';
import { checkTradingMode, networkFor, type TradingMode } from '../server/live/guard.js';
import { checkKeyStep } from '../server/live/steps.js';
import { spawn } from 'node:child_process';
import { guideSteps, VENUE_GUIDES, LIVE_CONFIRM_PHRASE, type GuideStep } from '../server/setup/guide.js';
import { checkKeyInput, saveVenueKeys, checkMode, openUrlCommand } from '../server/setup/core.js';
import { doctor } from '../server/setup/doctor.js';
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
  console.log('With full auto on (you choose below) the desk trades on its own. PAPER is the default. LIVE uses real money and can lose it. Not financial advice.\n');

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
    const bad = k && sct ? checkKeyInput(exName, net, { key: k, secret: sct, third: n.passphrase ? up[n.passphrase] ?? undefined : undefined }) : null;
    if (bad) { console.log(`  REFUSED ${net} keys from the environment: ${bad}`); up[n.key] = null; up[n.secret] = null; if (n.passphrase) up[n.passphrase] = null; }
  }
  if (exName !== 'none') {
    if (ADAPTER_STATUS[exName] === 'experimental') console.log(`  note: the ${exName} adapter is EXPERIMENTAL and untested against a real account`);
    if (!nonInteractive) {
      console.log(`  ${VENUE_LABEL[exName]}: ${VENUE_KEY_HINT[exName]}.`);
      console.log(`  Sign-in: ${VENUE_GUIDES[exName].login}`);
      if (VENUE_GUIDES[exName].extra) console.log(`  ${VENUE_GUIDES[exName].extra}`);
      for (const net of ['testnet', 'mainnet'] as const) {
        if (!(await askYes(`  Set up ${net === 'testnet' ? 'TESTNET (test money, recommended first)' : 'MAINNET (real money, for LIVE later)'} keys now?`, net === 'testnet'))) continue;
        await walkSteps(guideSteps(exName, net, appMode === 'grokbot' ? 'grokbot' : 'local'));
        if (appMode === 'grokbot') { console.log('    Grok Bot mode: keys go only through the Grok Bot secret request card. Nothing to type here.'); continue; }
        if (VENUE_GUIDES[exName].connectWallet && await askYes('    Use Connect wallet in the office instead of typing a key? (one wallet signature, opens your browser)', true)) { await openConnectWallet(env); continue; }
        const n = envNames(exName, net);
        const k = PUBLIC_KEY_FIELD.has(exName) ? await ask(`    ${n.key}`, env[n.key] || '') : await askSecret(`    ${n.key}`);
        const sct = await askSecret(`    ${n.secret}`);
        const pp = n.passphrase ? (PUBLIC_THIRD_FIELD.has(exName) ? await ask(`    ${n.passphrase}`, env[n.passphrase] || '') : await askSecret(`    ${n.passphrase}`)) : '';
        if (!k && !sct) continue;
        console.log('    checking the key on the venue (one read)...');
        const r = await saveVenueKeys(ENV_FILE, exName, net, { key: k, secret: sct, third: pp || undefined });
        console.log(`    ${r.ok ? 'OK' : 'REFUSED'}: ${r.detail}${r.warning ? ` (${r.warning})` : ''}`);
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
  // chat channel for the Desk Lead (alerts, reports, safe commands). Saved by the shared channel module.
  let channelPick: string | undefined = opt('channel');
  if (!channelPick && !nonInteractive) channelPick = await choose('Chat channel for Desk Lead alerts and reports', ['none', ...CHANNELS] as const, env.TELEGRAM_BOT_TOKEN ? 'telegram' : 'none');

  // 8. trading mode, last, with the automatic key check
  let mode = (opt('trading-mode') ?? (nonInteractive ? 'PAPER' : (await choose('Trading mode', ['paper', 'testnet', 'live'] as const, 'paper')))).toUpperCase() as TradingMode;
  if (!['PAPER', 'TESTNET', 'LIVE'].includes(mode)) throw new Error('--trading-mode must be paper, testnet or live');
  if (mode !== 'PAPER') {
    const merged = { ...currentEnv(), ...Object.fromEntries(Object.entries(up).filter(([, v]) => v !== null)) } as NodeJS.ProcessEnv;
    let confirm = opt('confirm-live');
    if (mode === 'LIVE' && !confirm && !nonInteractive) {
      console.log('\n  LIVE trades real money on its own (full auto). You can lose it. Not financial advice.');
      confirm = await ask(`  Type exactly "${LIVE_CONFIRM_PHRASE}" to continue`);
    }
    const r = await checkMode(merged, mode, { confirm });
    if (!r.ok) { console.log(`\n  ${r.detail}\n  Staying in PAPER.`); mode = 'PAPER'; process.exitCode = 2; }
    else { console.log(`  key check: ${r.detail}`); if (mode === 'LIVE') console.log('\n  LIVE selected. Real money, full auto. You can lose the whole Money Trade part. Not financial advice. Kill switch is in the office.'); }
  }
  up.TRADING_MODE = mode;

  setEnv(ENV_FILE, up);
  console.log(`\nSaved ${ENV_FILE}. TRADING_MODE=${mode}.`);
  if (channelPick && channelPick !== 'none') { if (isChannel(channelPick) && !nonInteractive) await channelWizard(channelPick, ENV_FILE); else console.log(`  Chat channel: run npm run channels -- setup ${channelPick} (interactive, secrets hidden).`); }
  status();
  if (!flag('no-doctor')) await runDoctor();
  console.log('Next: npm run dev (office at http://localhost:5173, Setup button top right). The same setup is in the office Setup wizard.');
}

/** One step at a time: title, what to do, the direct links. */
async function walkSteps(steps: GuideStep[]) {
  for (const [i, st] of steps.entries()) {
    console.log(`\n    Step ${i + 1}/${steps.length}: ${st.title}\n      ${st.text}`);
    for (const l of st.links) console.log(`      -> ${l.label}: ${l.url}${l.login ? ' (sign in / connect wallet first)' : ''}${l.note ? ` (${l.note})` : ''}`);
    if (isInteractive() && i < steps.length - 1) await ask('      Enter for the next step');
  }
}

/** Connect wallet lives in the office (browser wallet). Opens it in the default browser; the office must be running. */
async function openConnectWallet(env: NodeJS.ProcessEnv) {
  const url = `http://127.0.0.1:${env.WEB_PORT || 5173}/#setup`;
  const up = await fetch(`http://127.0.0.1:${env.PORT || 8787}/api/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false);
  if (!up) console.log('    The office is not running. In another terminal run: npm run dev   (then come back here)');
  if (up || await askYes('    Open the office in your browser now?', true)) {
    try { const [cmd, args] = openUrlCommand(process.platform, url); spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* print below */ }
  }
  console.log(`    Office: ${url}  -> Setup, pick the venue, Connect wallet, sign once. The agent key is saved to .env (chmod 600).`);
}

async function runDoctor() {
  console.log('\nDoctor (harmless reads, never prints a secret):');
  try { for (const l of await doctor(currentEnv())) console.log(`  ${l.ok === true ? 'OK  ' : l.ok === false ? 'FAIL' : '--  '} ${l.label.padEnd(26)} ${l.detail}`); }
  catch (e) { console.log(`  doctor failed: ${(e as Error).message}`); }
}

function guide() {
  const v = argv[1] as ExchangeName;
  if (!EXCHANGES.includes(v)) { console.error(`usage: npm run setup -- guide <${EXCHANGES.join('|')}> [--network testnet|mainnet]`); process.exitCode = 1; return; }
  const net = opt('network') === 'mainnet' ? 'mainnet' : 'testnet';
  const g = VENUE_GUIDES[v];
  console.log(`\n${g.label} (${g.kind}, ${g.status}) ${net} setup${g.networks[net].note ? `\n  ${g.networks[net].note}` : ''}\n  Sign-in: ${g.login}`);
  guideSteps(v, net, (process.env.APP_MODE === 'grokbot' ? 'grokbot' : 'local')).forEach((st, i) => { console.log(`\n  ${i + 1}. ${st.title}\n     ${st.text}`); for (const l of st.links) console.log(`     -> ${l.label}: ${l.url}${l.login ? ' (sign in first)' : ''}`); });
  console.log(`\n  Docs: ${g.docs.map((d) => d.url).join(' , ')}\n  Full guide: docs/setup/${v}.md`);
}

async function main() {
  switch (sub) {
    case 'wizard': return wizard();
    case 'status': return status();
    case 'guide': return guide();
    case 'channel': { const ch = argv[1]; if (!isChannel(ch)) { console.error(`usage: npm run setup -- channel <${CHANNELS.join('|')}>`); process.exitCode = 1; return; } await channelWizard(ch, ENV_FILE); return; }
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
