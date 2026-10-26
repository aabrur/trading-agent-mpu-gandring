#!/usr/bin/env node
// Unified CLI router and local launcher for Trading Agent Mpu Gandring.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse } from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const first = args[0];
const sessionEntry = path.join(root, 'dist/server/server/session-entry.js');
if (!['test', 'build'].includes(first) && existsSync(sessionEntry)) {
  const { beginApplicationSession } = await import(new URL('../dist/server/server/session-entry.js', import.meta.url));
  const session = await beginApplicationSession('launcher:mpu', root);
  process.env.MPU_PARENT_SESSION_ID = session.session.sessionId;
}

if (args.includes('--help') || args.includes('-h') || first === 'help') {
  console.log(`Trading Agent Mpu Gandring (mpu)

Usage:
  mpu                      Start the desk and open the web office
  mpu dev                  Run local dev server and web UI concurrently
  mpu restart              Restart the desk server and open the web office
  mpu office               Start the desk and open the web office
  mpu status               Check setup status, mode, and key permissions
  mpu doctor [args]        Run key, network, and permission health checks
  mpu setup [args]         Setup wizard, status, or guide (e.g. mpu setup)
  mpu paper                Quick shortcut to set TRADING_MODE=PAPER
  mpu testnet [args]       Quick shortcut to set TRADING_MODE=TESTNET
  mpu live [args]          Quick shortcut to set TRADING_MODE=LIVE
  mpu positions [args]     Show open positions with SL/TP and PnL
  mpu account [args]       Show balance, equity, and safety net status
  mpu scan [args]          Run proactive scan (loss cap, stops, errors)
  mpu report [args]        Generate and display latest desk report
  mpu analyze <symbol>     Run agent debate and analysis for symbol
  mpu debate [args]        Run autonomous agent debate in terminal
  mpu open <sym> <side>    Open position using active settings
  mpu close <sym|all>      Close position for symbol or all
  mpu size [args]          Preview ticket sizing and risk check
  mpu lessons [list|add]   List or add self-improving lessons
  mpu kill [confirm]       Trip emergency kill switch
  mpu unkill [--yes]       Release emergency kill switch
  mpu channels [args]      Manage chat channels (Telegram, Discord, Slack, WhatsApp)
  mpu trade                Run the trade supervisor loop
  mpu test [args]          Run test suite
  mpu typecheck            Run TypeScript typecheck
  mpu build                Build backend and frontend artifacts
  mpu autostart            Manage background autostart service
  mpu gb [cmd] [args]      Direct Grok Bot agent CLI interface
  mpu --no-open            Start the desk without opening a browser
`);
  process.exit(0);
}

const CLI_TARGETS = {
  setup: 'setup',
  doctor: 'doctor',
  debate: 'debate',
  gb: 'gb',
  channels: 'channels',
  kill: 'kill',
  unkill: 'unkill',
  trade: 'trade',
  autostart: 'autostart',
  backtest: 'backtest',
  'office:status': 'office-status'
};

const GB_SUBCOMMANDS = new Set([
  'positions', 'account', 'balance', 'scan', 'report', 'lessons',
  'open', 'close', 'size', 'split', 'market', 'candles', 'venues', 'event'
]);

function runCli(cmdName, subArgs) {
  const jsFile = path.join(root, 'dist/server/cli', `${cmdName}.js`);
  const tsFile = path.join(root, 'cli', `${cmdName}.ts`);

  if (existsSync(jsFile)) {
    const wrapper = path.join(root, 'dist/server/cli/session-entry.js');
    const res = spawnSync(process.execPath, existsSync(wrapper) ? [wrapper, cmdName, ...subArgs] : [jsFile, ...subArgs], { cwd: root, stdio: 'inherit' });
    process.exit(res.status ?? 0);
  } else if (existsSync(tsFile)) {
    const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const res = spawnSync(npxCmd, ['tsx', path.join(root, 'cli/session-entry.ts'), cmdName, ...subArgs], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
    process.exit(res.status ?? 0);
  } else {
    console.error(`CLI target ${cmdName} not found.`);
    process.exit(1);
  }
}

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

if (first === 'paper') {
  runCli('setup', ['paper']);
} else if (first === 'testnet') {
  runCli('setup', ['--trading-mode', 'testnet', ...args.slice(1)]);
} else if (first === 'live') {
  runCli('setup', ['--trading-mode', 'live', ...args.slice(1)]);
} else if (first === 'status') {
  runCli('setup', ['status']);
} else if (first === 'analyze') {
  runCli('debate', ['--symbol', args[1] || 'BTCUSDT', ...args.slice(2)]);
} else if (first === 'dev') {
  const res = spawnSync(npmCmd, ['run', 'dev'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  process.exit(res.status ?? 0);
} else if (first === 'test') {
  const res = spawnSync(npmCmd, ['test', ...args.slice(1)], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  process.exit(res.status ?? 0);
} else if (first === 'typecheck') {
  const res = spawnSync(npmCmd, ['run', 'typecheck', ...args.slice(1)], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  process.exit(res.status ?? 0);
} else if (first === 'build') {
  const res = spawnSync(npmCmd, ['run', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  process.exit(res.status ?? 0);
} else if (first && GB_SUBCOMMANDS.has(first)) {
  const subCmd = first === 'balance' ? 'account' : first;
  runCli('gb', [subCmd, ...args.slice(1)]);
} else if (first && CLI_TARGETS[first]) {
  runCli(CLI_TARGETS[first], args.slice(1));
} else if (first && first !== 'office' && first !== 'restart' && !first.startsWith('-')) {
  console.error(`Unknown option "${first}". Use mpu --help.`);
  process.exit(1);
}

// Default: launch desk and open web office
const envFile = path.join(root, '.env');
const firstRun = !existsSync(envFile);
if (firstRun) writeFileSync(envFile, 'APP_MODE=local\nTRADING_MODE=PAPER\nDEFAULT_PROVIDER=mock\nAUTO_TRADING=off\n', { mode: 0o600 });
const env = { ...parse(readFileSync(envFile)), ...process.env };
const mode = (env.TRADING_MODE || 'PAPER').toUpperCase();
const host = mode === 'LIVE' ? '127.0.0.1' : env.HOST || '127.0.0.1';
const browserHost = ['0.0.0.0', '::'].includes(host) ? '127.0.0.1' : host;
const url = `http://${browserHost}:${env.PORT || 8787}`;
const target = `${url}/${firstRun ? '#setup' : ''}`;
const latest = (dir) => Math.max(0, ...readdirSync(dir, { withFileTypes: true }).filter((e) => e.name !== 'node_modules').map((e) => e.isDirectory() ? latest(path.join(dir, e.name)) : statSync(path.join(dir, e.name)).mtimeMs));
const serverFile = path.join(root, 'dist/server/server/index.js');
if (!existsSync(serverFile) || !existsSync(path.join(root, 'dist/web/index.html')) || Math.max(...['server', 'web', 'cli'].filter((p) => existsSync(path.join(root, p))).map((p) => latest(path.join(root, p)))) > statSync(serverFile).mtimeMs) {
  console.log('Building Trading Agent Mpu Gandring...');
  const result = spawnSync(npmCmd, ['run', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) process.exit(result.status || 1);
}
async function getRunningHealth() {
  try {
    const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1200) });
    if (!r.ok) return null;
    const body = await r.json();
    return body && body.app === 'trading-agent-mpu-gandring' ? body : null;
  } catch {
    return null;
  }
}
const healthy = getRunningHealth;
function open() {
  if (args.includes('--no-open')) return;
  const command = process.platform === 'win32'
    ? ['cmd.exe', ['/c', 'start', '', target]]
    : process.platform === 'darwin'
    ? ['open', [target]]
    : ['xdg-open', [target]];
  const p = spawn(command[0], command[1], { detached: true, stdio: 'ignore', windowsHide: true });
  p.on('error', () => console.log(`Open the office at ${target}`));
  p.unref();
}

const runningHealth = await getRunningHealth();
const localPkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const localVer = String(localPkg.appVersion || localPkg.version || '').replace(/^v/i, '');
const runningVer = String(runningHealth?.version || '').replace(/^v/i, '');
const isOutdated = runningHealth && runningVer && runningVer !== localVer;

if (first === 'restart' || isOutdated) {
  if (runningHealth) {
    console.log(isOutdated
      ? `Running desk is on v${runningVer}, restarting to load v${localVer}...`
      : 'Restarting Trading Agent Mpu Gandring...');
    try {
      await fetch(`${url}/api/ops/restart`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ forceExit: true })
      });
    } catch { /* ignore */ }
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (!(await getRunningHealth())) break;
    }
  }
} else if (runningHealth) {
  console.log(`Trading Agent Mpu Gandring is already running: ${target}`);
  open();
  process.exit(0);
}
let child, stopping = false, restart = false, opened = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; child?.kill(signal); });
do {
  restart = false;
  child = spawn(process.execPath, [serverFile], { cwd: root, env: { ...process.env, NODE_ENV: 'production', MPU_MANAGED: '1' }, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: true });
  let exited = false;
  child.on('message', (m) => { if (m?.type === 'mpu:restart') { restart = true; child.kill('SIGTERM'); } });
  const done = new Promise((resolve) => { child.once('error', () => { exited = true; resolve(1); }); child.once('exit', (code) => { exited = true; resolve(code ?? 1); }); });
  for (let i = 0; i < 120 && !exited; i++) {
    if (await getRunningHealth()) { console.log(`Office ready: ${target}`); if (!opened) { open(); opened = true; } break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  const code = await done;
  if (!restart || stopping) process.exit(stopping ? 0 : code);
} while (!stopping);
