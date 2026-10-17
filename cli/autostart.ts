// npm run autostart:install | autostart:remove | autostart:status
// Optional: start `npm run trade` when you log in to this laptop, and restart it if it crashes.
//   macOS   -> launchd agent   ~/Library/LaunchAgents/com.mpugandring.trading-agent.plist
//   Windows -> Task Scheduler  task "TradingAgentMpuGandring", at logon (schtasks)
//   Linux   -> systemd --user  ~/.config/systemd/user/trading-agent-mpu-gandring.service
// The service file holds NO keys. It only points at this folder; the app reads .env from here.
// Local trading runs only while the laptop is on and awake. Grok Bot mode runs in the cloud with the laptop off.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LABEL = 'com.mpugandring.trading-agent';
export const UNIT = 'trading-agent-mpu-gandring.service';
export const TASK = 'TradingAgentMpuGandring';
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface ServicePlan { platform: NodeJS.Platform; file: string | null; content: string; install: string[][]; remove: string[][]; status: string[][]; notes: string[] }

/** Pure: what would be written and run. Exposed for tests (no keys, ever). */
export function servicePlan(platform: NodeJS.Platform, o: { node: string; repo: string; home: string; uid?: number }): ServicePlan {
  const args = [o.node, '--import', 'tsx', path.join(o.repo, 'cli', 'trade.ts'), '--service'];
  if (platform === 'darwin') {
    const file = path.join(o.home, 'Library/LaunchAgents', `${LABEL}.plist`);
    const logf = path.join(o.home, 'Library/Logs/trading-agent-mpu-gandring.log');
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>${args.map((a) => `<string>${xml(a)}</string>`).join('')}</array>
  <key>WorkingDirectory</key><string>${xml(o.repo)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xml(logf)}</string>
  <key>StandardErrorPath</key><string>${xml(logf)}</string>
</dict>
</plist>
`;
    const domain = `gui/${o.uid ?? 501}`;
    return { platform, file, content, install: [['launchctl', 'bootout', domain, file], ['launchctl', 'bootstrap', domain, file]], remove: [['launchctl', 'bootout', domain, file]], status: [['launchctl', 'print', `${domain}/${LABEL}`]], notes: [`log: ${logf}`] };
  }
  if (platform === 'win32') {
    const tr = `cmd /c cd /d "${o.repo}" && "${o.node}" --import tsx "cli\\trade.ts" --service`;
    return { platform, file: null, content: tr, install: [['schtasks', '/Create', '/F', '/TN', TASK, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TR', tr]], remove: [['schtasks', '/Delete', '/F', '/TN', TASK]], status: [['schtasks', '/Query', '/TN', TASK, '/V', '/FO', 'LIST']], notes: ['restart on crash is done by npm run trade --service itself (backoff 5s to 2 min)'] };
  }
  const file = path.join(o.home, '.config/systemd/user', UNIT);
  const q = (a: string) => (/[\s"\\]/.test(a) ? JSON.stringify(a) : a);
  const content = `[Unit]
Description=Trading Agent Mpu Gandring (npm run trade)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${o.repo}
ExecStart=${args.map(q).join(' ')}
Restart=on-failure
RestartSec=15
RestartPreventExitStatus=2

[Install]
WantedBy=default.target
`;
  return { platform, file, content, install: [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', UNIT]], remove: [['systemctl', '--user', 'disable', '--now', UNIT]], status: [['systemctl', '--user', 'status', '--no-pager', UNIT]], notes: [`to start at boot before you log in: loginctl enable-linger ${os.userInfo().username}`, `logs: journalctl --user -u ${UNIT} -f`] };
}

function run(cmds: string[][], quietFail = false) {
  for (const [c, ...a] of cmds) {
    const r = spawnSync(c, a, { stdio: quietFail ? 'ignore' : 'inherit' });
    if (r.error && !quietFail) console.log(`  could not run ${c}: ${r.error.message}`);
  }
}

function main() {
  const sub = process.argv[2] ?? 'status';
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const plan = servicePlan(process.platform, { node: process.execPath, repo, home: os.homedir(), uid: process.getuid?.() });
  const dry = process.argv.includes('--dry-run');
  if (dry) { console.log(plan.file ? `${plan.file}\n\n${plan.content}` : plan.content); return; }
  if (sub === 'install') {
    if (!existsSync(path.join(repo, '.env'))) console.log('note: no .env yet. Run npm run setup first; the service will start in PAPER with defaults.');
    if (plan.file) { mkdirSync(path.dirname(plan.file), { recursive: true }); writeFileSync(plan.file, plan.content, { mode: 0o644 }); console.log(`wrote ${plan.file} (no keys in it; the app reads ${path.join(repo, '.env')})`); }
    if (process.platform === 'darwin') { run(plan.install.slice(0, 1), true); run(plan.install.slice(1)); } else run(plan.install);
    console.log('autostart installed: npm run trade starts when you log in and restarts on crash.');
    for (const n of plan.notes) console.log(`  ${n}`);
    console.log('Local trading runs only while this laptop is on and awake. Grok Bot mode runs in the cloud with the laptop off.');
  } else if (sub === 'remove') {
    run(plan.remove, true);
    if (plan.file && existsSync(plan.file)) rmSync(plan.file);
    console.log('autostart removed. Open positions keep their exchange-side stops.');
  } else if (sub === 'status') {
    if (plan.file) console.log(`${plan.file}: ${existsSync(plan.file) ? 'present' : 'not installed'}`);
    run(plan.status);
  } else { console.log('usage: npm run autostart:install | autostart:remove | autostart:status  (add -- --dry-run to preview)'); process.exitCode = 1; }
}

if (/autostart\.(ts|js)$/.test(process.argv[1] ?? '')) main();
