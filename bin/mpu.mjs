#!/usr/bin/env node
// One local launcher. Reads saved settings; first launch starts a PAPER desk with auto off.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse } from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Trading Agent Mpu Gandring\n\nmpu               Start the desk and open the web UI\nmpu setup         Open settings\nmpu --no-open     Start without opening a browser\n\nSaved trading mode and auto settings are respected. First launch uses PAPER, auto off. Ctrl+C stops the desk.');
  process.exit(0);
}
if (args.some((v) => !['setup', '--no-open'].includes(v))) { console.error('Unknown option. Use mpu --help.'); process.exit(1); }
const envFile = path.join(root, '.env');
const firstRun = !existsSync(envFile);
if (firstRun) writeFileSync(envFile, 'APP_MODE=local\nTRADING_MODE=PAPER\nDEFAULT_PROVIDER=mock\nAUTO_TRADING=off\n', { mode: 0o600 });
const env = { ...parse(readFileSync(envFile)), ...process.env };
const mode = (env.TRADING_MODE || 'PAPER').toUpperCase();
const host = mode === 'LIVE' ? '127.0.0.1' : env.HOST || '127.0.0.1';
const browserHost = ['0.0.0.0', '::'].includes(host) ? '127.0.0.1' : host;
const url = `http://${browserHost}:${env.PORT || 8787}`;
const target = `${url}/${firstRun || args.includes('setup') ? '#setup' : ''}`;
const latest = (dir) => Math.max(0, ...readdirSync(dir, { withFileTypes: true }).filter((e) => e.name !== 'node_modules').map((e) => e.isDirectory() ? latest(path.join(dir, e.name)) : statSync(path.join(dir, e.name)).mtimeMs));
const serverFile = path.join(root, 'dist/server/server/index.js');
if (!existsSync(serverFile) || !existsSync(path.join(root, 'dist/web/index.html')) || Math.max(...['server', 'web', 'cli'].filter((p) => existsSync(path.join(root, p))).map((p) => latest(path.join(root, p)))) > statSync(serverFile).mtimeMs) {
  console.log('Building Trading Agent Mpu Gandring...');
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) process.exit(result.status || 1);
}
async function healthy() {
  try { const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) }); return r.ok && (await r.json()).app === 'trading-agent-mpu-gandring'; } catch { return false; }
}
function open() {
  if (args.includes('--no-open')) return;
  const command = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', target]] : process.platform === 'darwin' ? ['open', [target]] : ['xdg-open', [target]];
  const p = spawn(command[0], command[1], { detached: true, stdio: 'ignore', windowsHide: true });
  p.on('error', () => console.log(`Open the office at ${target}`)); p.unref();
}
if (await healthy()) { console.log(`Trading Agent Mpu Gandring is already running: ${target}`); open(); process.exit(0); }
let child, stopping = false, restart = false, opened = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; child?.kill(signal); });
do {
  restart = false;
  child = spawn(process.execPath, [serverFile], { cwd: root, env: { ...process.env, NODE_ENV: 'production', MPU_MANAGED: '1' }, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: true });
  let exited = false;
  child.on('message', (m) => { if (m?.type === 'mpu:restart') { restart = true; child.kill('SIGTERM'); } });
  const done = new Promise((resolve) => { child.once('error', () => { exited = true; resolve(1); }); child.once('exit', (code) => { exited = true; resolve(code ?? 1); }); });
  for (let i = 0; i < 120 && !exited; i++) {
    if (await healthy()) { console.log(`Office ready: ${target}`); if (!opened) { open(); opened = true; } break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  const code = await done;
  if (!restart || stopping) process.exit(stopping ? 0 : code);
} while (!stopping);
