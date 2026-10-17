// npm run setup                      interactive wizard (writes .env, PAPER mode)
// npm run setup -- --yes [flags]     non-interactive, for coding agents (see AGENTS.md)
// npm run setup -- testnet           testnet round trip, step 1 of the LIVE unlock
// npm run setup -- check-key         mainnet key permission check, step 2
// npm run setup -- unlock-live       typed confirmation, step 3 (needs a human at a terminal)
// npm run setup -- lock              back to PAPER
// npm run setup -- status            what is configured, secrets masked
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { config as loadDotenv } from 'dotenv';
import { readEnv, setEnv, ensureEnv, mask } from './envfile.js';
import { ask, askSecret, askYes, choose, isInteractive } from './prompt.js';
import { PROVIDERS, AGENT_IDS, type ProviderName } from '../server/config.js';
import { EXCHANGES, envNames, ADAPTER_STATUS, type ExchangeName } from '../server/exchange/index.js';
import { stateDir, readState, CONFIRM_PHRASE } from '../server/live/state.js';
import { testnetStep, checkKeyStep, unlockStep, hyperliquidMainKeyCheck } from '../server/live/steps.js';
import { registerSecrets } from '../server/redact.js';
import { exchangeSecrets } from '../server/exchange/index.js';

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
  registerSecrets([...exchangeSecrets(env), ...Object.values(KEY_VARS).map((k) => env[k]), env.AGENT_EVENT_SECRET, env.TRADINGVIEW_PASSPHRASE, env.GROKBOT_WEBHOOK_KEY, env.CRYPTOPANIC_API_KEY]);
  return env;
}

function status() {
  const env = currentEnv();
  const ex = (env.EXCHANGE || 'none') as ExchangeName | 'none';
  const st = readState(stateDir(env));
  console.log(`\nTrading Agent Mpu Gandring setup (${ENV_FILE})`);
  console.log(`  TRADING_MODE      ${env.TRADING_MODE || 'PAPER'}`);
  console.log(`  APP_MODE          ${env.APP_MODE || 'local'}`);
  console.log(`  model keys        ${Object.entries(KEY_VARS).map(([p, k]) => `${p}:${env[k] ? 'yes' : 'no'}`).join(' ')}`);
  console.log(`  agents            ${AGENT_IDS.map((a) => `${a}=${env[`AGENT_${a.toUpperCase()}_PROVIDER`] || env.DEFAULT_PROVIDER || 'mock'}`).join(' ')}`);
  console.log(`  TradingView       widget ${env.TRADINGVIEW_WIDGET || 'off'}, webhook ${env.TRADINGVIEW_PASSPHRASE ? 'on' : 'off'}`);
  console.log(`  news plugin       ${env.NEWS_PROVIDER || 'sample'}${env.CRYPTOPANIC_API_KEY ? ' (key set)' : ''}`);
  console.log(`  exchange          ${ex}${ex !== 'none' ? ` (${ADAPTER_STATUS[ex]})` : ''}`);
  if (ex !== 'none') for (const net of ['testnet', 'mainnet'] as const) { const n = envNames(ex, net); console.log(`    ${net.padEnd(8)} ${n.key} ${ex === 'hyperliquid' ? env[n.key] || '(empty)' : mask(env[n.key])}, ${n.secret} ${mask(env[n.secret])}`); }
  console.log(`  LIVE unlock       testnet ${st.testnet ? `passed ${new Date(st.testnet.passedAt).toISOString()}` : 'not yet'}, key check ${st.permission ? 'passed' : 'not yet'}, confirmation ${st.confirmation ? 'typed' : 'not yet'}`);
  console.log('');
}

async function wizard() {
  const nonInteractive = flag('yes') || !isInteractive();
  const env = currentEnv();
  const up: Record<string, string | null> = { TRADING_MODE: 'PAPER', LIVE_CONFIRMED: null };
  console.log('\nTrading Agent Mpu Gandring setup. Everything goes into .env on this computer. Nothing is sent anywhere.');
  console.log('Paper trading is the default. LIVE has its own three-step unlock later (npm run setup -- testnet / check-key / unlock-live).\n');

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
    for (const k of [...Object.values(KEY_VARS), 'CRYPTOPANIC_API_KEY', 'GROKBOT_WEBHOOK_URL', 'GROKBOT_WEBHOOK_KEY']) if (process.env[k]) up[k] = process.env[k]!;
    for (const name of EXCHANGES) for (const net of ['testnet', 'mainnet'] as const) for (const k of Object.values(envNames(name, net))) if (process.env[k]) up[k] = process.env[k]!;
    console.log('  copied keys that were set in the current shell environment');
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
  if (!nonInteractive && await askYes('Give each agent its own provider?', false)) {
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
  const exName = (opt('exchange') ?? (nonInteractive ? env.EXCHANGE || 'none' : await choose('Exchange for testnet and (later) live', ['none', ...EXCHANGES] as const, (env.EXCHANGE as 'none') || 'none'))) as ExchangeName | 'none';
  if (exName !== 'none' && !EXCHANGES.includes(exName)) throw new Error(`unknown exchange ${exName}`);
  up.EXCHANGE = exName;
  if (exName !== 'none') {
    if (ADAPTER_STATUS[exName] === 'experimental') console.log(`  note: the ${exName} adapter is EXPERIMENTAL and untested against a real account`);
    if (!nonInteractive) {
      console.log(exName === 'hyperliquid'
        ? '  Hyperliquid: give the MAIN account address (public) and the private key of an API AGENT wallet. Never the main wallet key.'
        : '  Create keys with trading permission only. Withdrawals OFF. An IP whitelist is a good idea.');
      for (const net of ['testnet', 'mainnet'] as const) {
        const n = envNames(exName, net);
        if (!(await askYes(`  Enter ${net} keys now?`, net === 'testnet'))) continue;
        const k = exName === 'hyperliquid' ? await ask(`    ${n.key}`, env[n.key] || '') : await askSecret(`    ${n.key}`);
        const sct = await askSecret(`    ${n.secret}`);
        const pp = n.passphrase ? await askSecret(`    ${n.passphrase}`) : '';
        if (exName === 'hyperliquid' && k && sct) { const bad = hyperliquidMainKeyCheck(k, sct); if (bad) { console.log(`    REFUSED: ${bad}`); continue; } }
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

  setEnv(ENV_FILE, up);
  console.log(`\nSaved ${ENV_FILE}. TRADING_MODE=PAPER.`);
  status();
  console.log('Next: npm run doctor, then npm run dev.');
}

async function main() {
  const dir = stateDir(currentEnv());
  switch (sub) {
    case 'wizard': return wizard();
    case 'status': return status();
    case 'lock': setEnv(ENV_FILE, { TRADING_MODE: 'PAPER', LIVE_CONFIRMED: null }); console.log('Back to PAPER. LIVE_CONFIRMED removed.'); return;
    case 'testnet': {
      console.log('Running the testnet round trip (place with stop, reconcile, close, cancel). Testnet funds only.');
      const r = await testnetStep(currentEnv(), dir, { symbol: opt('symbol') });
      for (const s of r.steps) console.log(`  ${s}`);
      console.log(r.ok ? `PASSED on ${r.exchange} testnet. Recorded.` : 'FAILED. Nothing recorded.');
      process.exitCode = r.ok ? 0 : 1; return;
    }
    case 'check-key': {
      const r = await checkKeyStep(currentEnv(), dir);
      console.log(`${r.ok ? 'OK' : 'NOT OK'} (${r.exchange} mainnet): ${r.detail}`);
      process.exitCode = r.ok ? 0 : 1; return;
    }
    case 'unlock-live': {
      if (!isInteractive()) { console.error('unlock-live needs a person at a real terminal. A script or agent cannot unlock LIVE.'); process.exitCode = 2; return; }
      console.log('\nLIVE TRADING USES REAL MONEY. You can lose all of the Money Trade part of your balance.');
      console.log('This is not financial advice. The desk can be wrong, exchanges can fail, stops can slip.\n');
      const phrase = await ask(`Type exactly: ${CONFIRM_PHRASE}\n>`);
      try {
        const r = await unlockStep(currentEnv(), dir, phrase);
        setEnv(ENV_FILE, r.env);
        console.log('LIVE unlocked. TRADING_MODE=LIVE and LIVE_CONFIRMED written to .env. The server re-checks the key on every start.');
        console.log('To go back: npm run setup -- lock');
      } catch (e) { console.error(`LIVE stays locked: ${(e as Error).message}`); process.exitCode = 2; }
      return;
    }
    default: console.error(`unknown command ${sub}`); process.exitCode = 1;
  }
}
main().catch((e) => { console.error(`setup failed: ${(e as Error).message}`); process.exit(1); });
