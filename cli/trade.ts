// npm run trade: one command that starts the backend and the office UI with full auto ON, using the saved .env.
//   local mode   -> the desk runs its own debate and trade loop (AUTO_TRADING forced on for this run)
//   grokbot mode -> just starts the office; your Grok Bot team drives it from the cloud
// The UI is the built one, served by the backend on the same port (npm run build happens once if needed).
// Flags: --rebuild (build again first), --service (used by autostart: restart on crash with backoff,
// and a guard refusal (exit 2) ends the service quietly instead of looping).
// Keys are never passed on the command line; the backend reads .env itself. Not financial advice.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const service = argv.includes('--service');
const envFile = path.join(root, '.env');
const fileEnv = existsSync(envFile) ? parse(readFileSync(envFile)) : {};
const get = (k: string, d = '') => (process.env[k] ?? fileEnv[k] ?? d).trim();

export function tradeEnv(base: NodeJS.ProcessEnv, file: Record<string, string>): NodeJS.ProcessEnv {
  const appMode = (base.APP_MODE ?? file.APP_MODE ?? 'local').trim().toLowerCase();
  const out: NodeJS.ProcessEnv = { ...base, NODE_ENV: 'production' };
  if (appMode !== 'grokbot') out.AUTO_TRADING = 'on'; // full auto in local mode
  return out;
}
/** launchd and systemd start services with a minimal PATH (no Homebrew or nvm), so npm sits next to the node that runs us. */
export function buildEnv(base: NodeJS.ProcessEnv, nodePath: string): NodeJS.ProcessEnv {
  const key = Object.keys(base).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  return { ...base, [key]: [path.dirname(nodePath), base[key]].filter(Boolean).join(path.delimiter) };
}
export function officeUrl(host: string, port: string) { return `http://${host === '0.0.0.0' || host === '' || host === '::' ? '127.0.0.1' : host}:${port}`; }

function needsBuild() {
  const server = path.join(root, 'dist/server/server/index.js'), web = path.join(root, 'dist/web/index.html');
  if (argv.includes('--rebuild') || !existsSync(server) || !existsSync(web)) return true;
  const pkg = statSync(path.join(root, 'package.json')).mtimeMs;
  return statSync(server).mtimeMs < pkg;
}

function log(s: string) { console.log(`[trade ${new Date().toLocaleTimeString()}] ${s}`); }

async function main() {
  if (!existsSync(envFile)) log('no .env yet. Run npm run setup first (PAPER is the default). Starting with defaults.');
  if (needsBuild()) {
    log('building the backend and office UI once (npm run build)...');
    const b = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', env: buildEnv(process.env, process.execPath) });
    if (b.status !== 0) { log('build failed'); process.exit(1); }
  }
  const appMode = get('APP_MODE', 'local').toLowerCase();
  const mode = get('TRADING_MODE', 'PAPER').toUpperCase();
  const port = get('PORT', '8787');
  const host = mode === 'LIVE' ? '127.0.0.1' : get('HOST', '127.0.0.1');
  const url = officeUrl(host, port);
  log(`Trading Agent Mpu Gandring: ${mode}, ${appMode === 'grokbot' ? 'Grok Bot mode (your Grok Bot team drives the desk)' : 'local mode, full auto ON'}`);
  if (mode === 'LIVE') log('LIVE: real money, full auto. You can lose money. Not financial advice. Kill switch is in the office.');
  log('local trading runs only while this computer is on and awake. Stops rest on the exchange in TESTNET/LIVE.');

  let backoff = 5_000, stopping = false;
  let child: ReturnType<typeof spawn> | null = null;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { stopping = true; child?.kill(sig); });
  for (;;) {
    const startedAt = Date.now();
    child = spawn(process.execPath, [path.join(root, 'dist/server/server/index.js')], { cwd: root, env: tradeEnv(process.env, fileEnv), stdio: 'inherit' });
    const ready = setTimeout(() => log(`office: ${url}`), 2500);
    const code: number = await new Promise((r) => child!.on('exit', (c) => r(c ?? 1)));
    clearTimeout(ready);
    if (stopping || code === 0) process.exit(0);
    if (code === 2) { log('the backend refused to start (a safety guard said no; see the message above). Not restarting.'); process.exit(service ? 0 : 2); }
    if (!service) process.exit(code);
    if (Date.now() - startedAt > 10 * 60_000) backoff = 5_000;
    log(`backend exited with code ${code}. Restarting in ${Math.round(backoff / 1000)}s.`);
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 120_000);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || /trade\.(ts|js)$/.test(process.argv[1] ?? '')) void main();
