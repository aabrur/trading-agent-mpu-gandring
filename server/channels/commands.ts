// The ONLY things a chat channel can ask the desk to do. Read-only status, plus the kill switch (which only ever reduces risk).
// Opening or closing orders, switching modes (PAPER/TESTNET/LIVE), releasing the kill switch and changing keys are not here
// on purpose: they need the CLI or the office on the desk's own computer.
import type { Desk } from '../desk.js';
import { buildReport } from '../reports.js';
import { safe } from '../redact.js';

export const SAFE_COMMANDS = ['status', 'report', 'positions', 'kill', 'help'] as const;
export type SafeCommand = (typeof SAFE_COMMANDS)[number];
export type Parsed = { ok: true; cmd: SafeCommand; confirm: boolean } | { ok: false; reply: string };

const FORBIDDEN: Array<[RegExp, string]> = [
  [/^(open|buy|sell|long|short|order|trade|enter|close|flatten|exit|tp|sl|stop|size|leverage)\b/, 'Orders cannot be opened, closed or changed from chat. Use the office or npm run gb on the desk computer.'],
  [/^(live|testnet|paper|mode|go-?live|switch)\b/, 'The trading mode cannot be changed from chat. Use npm run setup on the desk computer.'],
  [/^(unkill|un-kill|resume|unpause|start|release|restart)\b/, 'The kill switch can only be released on the desk computer: npm run unkill -- --yes, then restart.'],
  [/^(key|keys|secret|api|token|env|set|config|wallet|withdraw|transfer)\b/, 'Keys and settings cannot be changed from chat. They live in the local .env only.']
];

export const HELP_TEXT = 'Commands: status, report, positions, kill (send "kill confirm" to flatten everything and stop). Nothing else is possible from chat: no orders, no mode changes, no un-kill, no key changes.';

/** Parse one chat message. Accepts "/status", "status", "/status@MyBot", "desk status". */
export function parseCommand(text: string): Parsed {
  const t = String(text ?? '').trim().toLowerCase().replace(/^\/?desk\s+/, '').replace(/^\//, '').replace(/^([a-z-]+)@\S+/, '$1').slice(0, 200);
  const [word = '', ...rest] = t.split(/\s+/);
  if (!word) return { ok: false, reply: HELP_TEXT };
  if ((SAFE_COMMANDS as readonly string[]).includes(word)) return { ok: true, cmd: word as SafeCommand, confirm: word === 'kill' && /^(confirm|yes)$/.test(rest.join(' ').replace(/^confirm:\s*/, '')) };
  for (const [re, reply] of FORBIDDEN) if (re.test(word)) return { ok: false, reply: `Refused. ${reply}` };
  return { ok: false, reply: `Unknown command. ${HELP_TEXT}` };
}

/** Is this sender allowed to command? Empty allowlist means nobody. */
export function allowed(list: readonly string[], id: string | number | null | undefined): boolean {
  if (id === null || id === undefined) return false;
  const v = String(id).replace(/^\+/, '').trim();
  return v !== '' && list.includes(v);
}

const fmt = (n: number) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 0);

export function statusText(desk: Desk): string {
  const s = desk.snapshot();
  const scan = desk.lastScan?.findings.filter((f) => f.level === 'warn' || f.level === 'alert') ?? [];
  return safe([
    `Desk Lead status: ${s.mode}${s.venue ? ` on ${s.venue.label}` : ''}${s.killed ? ', KILL SWITCH ON' : ''}${s.paused ? ', paused' : ''}.`,
    `Equity ${fmt(s.paper.equity)} USDT, balance ${fmt(s.paper.balance)}, safety net ${fmt(s.paper.safetyNet)}, open positions ${s.paper.positions.length}.`,
    `Daily loss stop ${s.dailyLoss.hit ? 'HIT' : 'not hit'} (limit ${s.dailyLoss.limitPct}%). Auto trading ${s.auto.on ? 'on' : 'off'}.`,
    scan.length ? `Open findings: ${scan.map((f) => `[${f.level}] ${f.text}`).join(' | ')}` : 'No open warnings.'
  ].join('\n'));
}

export function positionsText(desk: Desk): string {
  const ps = desk.book.positions;
  if (!ps.length) return 'No open positions.';
  return safe(ps.map((p) => `${p.symbol} ${p.side} qty ${p.qty} entry ${p.entry} stop ${p.stop > 0 ? p.stop : 'NONE (alert)'}${p.tp ? ` tp ${p.tp}` : ''}`).join('\n'));
}

export function reportText(desk: Desk): string {
  return buildReport(desk, Date.now() - desk.cfg.reports.intervalMin * 60_000).text;
}

/** Run a parsed command. kill without "confirm" only explains; with confirm it trips the persisted kill switch. */
export async function runCommand(desk: Desk, p: Parsed, onKill?: () => void): Promise<string> {
  if (!p.ok) return p.reply;
  switch (p.cmd) {
    case 'help': return HELP_TEXT;
    case 'status': return statusText(desk);
    case 'positions': return positionsText(desk);
    case 'report': return reportText(desk);
    case 'kill': {
      if (!p.confirm) return 'This flattens every position and stops the desk until someone runs npm run unkill -- --yes on the desk computer. Send "kill confirm" to do it.';
      onKill?.();
      const notes = await desk.kill();
      return safe(`KILL SWITCH ON. ${notes.join('; ') || 'nothing was open'}. Release only on the desk computer: npm run unkill -- --yes, then restart.`);
    }
  }
}
