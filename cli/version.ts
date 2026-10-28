import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse } from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface VersionInfo {
  app: string;
  appVersion: string;
  version: string;
  commit: string | null;
  branch: string | null;
  tag: string | null;
  node: string;
  platform: string;
  arch: string;
  tradingMode: string;
  appMode: string;
  running: boolean;
  officeUrl: string;
}

export async function getVersionInfo(): Promise<VersionInfo> {
  let pkg = { name: 'trading-agent-mpu-gandring', version: '0.4.5', appVersion: '0.0.0.4.5' };
  try {
    pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    /* Use default fallback */
  }

  let commit: string | null = null;
  let branch: string | null = null;
  let tag: string | null = null;
  try {
    const c = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 2000 });
    if (c.status === 0) commit = c.stdout.trim() || null;
    const b = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 2000 });
    if (b.status === 0) branch = b.stdout.trim() || null;
    const t = spawnSync('git', ['describe', '--tags', '--always'], { cwd: root, encoding: 'utf8', timeout: 2000 });
    if (t.status === 0) tag = t.stdout.trim() || null;
  } catch {
    /* Git command not available in this environment */
  }

  let env: Record<string, string> = {};
  const envFile = path.join(root, '.env');
  if (existsSync(envFile)) {
    try {
      env = parse(readFileSync(envFile));
    } catch {
      /* Ignore parse error */
    }
  }

  const tradingMode = (env.TRADING_MODE || process.env.TRADING_MODE || 'PAPER').toUpperCase();
  const appMode = (env.APP_MODE || process.env.APP_MODE || 'local').toLowerCase();
  const port = env.PORT || process.env.PORT || '8787';
  const officeUrl = `http://127.0.0.1:${port}`;

  let running = false;
  try {
    const r = await fetch(`${officeUrl}/api/health`, { signal: AbortSignal.timeout(600) });
    if (r.ok) {
      const body = await r.json() as { app?: string };
      if (body && body.app === 'trading-agent-mpu-gandring') running = true;
    }
  } catch {
    running = false;
  }

  return {
    app: pkg.name || 'trading-agent-mpu-gandring',
    appVersion: pkg.appVersion || '0.0.0.4.5',
    version: pkg.version || '0.4.5',
    commit,
    branch,
    tag,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    tradingMode,
    appMode,
    running,
    officeUrl
  };
}

export async function runVersionCli(args: string[] = process.argv.slice(2)): Promise<void> {
  const info = await getVersionInfo();

  if (args.includes('--short') || args.includes('-s')) {
    console.log(info.appVersion);
    return;
  }

  if (args.includes('--json')) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }

  if (args.includes('-v') || args.includes('--version') || args.includes('-V')) {
    console.log(`Trading Agent Mpu Gandring v${info.appVersion} (${info.commit ? `${info.commit}, ` : ''}${info.tradingMode})`);
    return;
  }

  console.log('\nTrading Agent Mpu Gandring');
  console.log(`  App Version:   ${info.appVersion}`);
  console.log(`  Package:       ${info.version}`);
  if (info.commit) {
    console.log(`  Git:           ${info.commit} (${info.branch || 'detached'})${info.tag ? ` [${info.tag}]` : ''}`);
  }
  console.log(`  Trading Mode:  ${info.tradingMode} (${info.appMode})`);
  console.log(`  Office Desk:   ${info.officeUrl} (${info.running ? 'RUNNING' : 'STOPPED'})`);
  console.log(`  Runtime:       Node ${info.node} on ${info.platform} ${info.arch}\n`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('version.ts') || process.argv[1]?.endsWith('version.js')) {
  await runVersionCli();
}
