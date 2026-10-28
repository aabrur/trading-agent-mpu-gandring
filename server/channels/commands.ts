import type { Desk } from '../desk.js';
import { buildReport } from '../reports.js';
import { safe } from '../redact.js';
import { normSymbol, parseCommand as parseOwnerCommand } from '../commands.js';
import { proactiveScan } from '../scan.js';
import type { AgentId } from '../types.js';

export const SAFE_COMMANDS = ['status', 'report', 'positions', 'kill', 'help'] as const;
export type SafeCommand = (typeof SAFE_COMMANDS)[number];
export const INTERACTIVE_COMMANDS = ['scan', 'analyze', 'debate', 'ask', 'chat', 'watchlist', 'scorecard', 'lessons', 'cautious', 'aggressive', 'calm'] as const;
export type InteractiveCommand = (typeof INTERACTIVE_COMMANDS)[number];

export type Parsed =
  | { ok: true; cmd: SafeCommand; confirm: boolean }
  | { ok: true; cmd: 'scan' | 'watchlist' | 'scorecard' | 'lessons' | 'cautious' | 'aggressive' | 'calm' }
  | { ok: true; cmd: 'analyze' | 'debate'; symbol: string }
  | { ok: true; cmd: 'ask' | 'chat'; agent: AgentId; text: string }
  | { ok: true; cmd: 'owner'; text: string }
  | { ok: false; reply: string };

const FORBIDDEN: Array<[RegExp, string]> = [
  [/^(live|testnet|paper|mode|go-?live|switch)\b/, 'The trading mode cannot be changed from chat. Use npm run setup on the desk computer.'],
  [/^(unkill|un-kill|resume|unpause|start|release|restart)\b/, 'The kill switch can only be released on the desk computer: the local Office OFF button or npm run unkill -- --yes.'],
  [/^(key|keys|secret|api|token|env|set|config|wallet|withdraw|transfer)\b/, 'Keys and wallet permissions are configured locally.']
];

export const HELP_TEXT = [
  'Trading Agent Mpu Gandring Commands:',
  '• /status: Balance, equity, venue, guards status',
  '• /positions: Active positions and resting exchange stops',
  '• /report: Latest performance and execution report',
  '• /scan: Instant proactive scan for desk alerts',
  '• /analyze <symbol>: Direct agents to debate & auto-trade (e.g. /analyze BTCUSDT)',
  '• /ask <question>: Chat with Desk Lead (or /ask <agent> <question>)',
  '• /set profile <default|balance|profit|aggressive>, /set size <1.5..100>%, /set leverage <1..20>',
  '• /open long|short <symbol> [size%] [leverage], /buy <symbol>, /sell <symbol>',
  '• /close <symbol> or /close all: Execute directly using the active settings',
  '• /watchlist: Active auto-trading symbols',
  '• /scorecard: Agent performance & win rate',
  '• /lessons: Recent self-improving lessons',
  '• /cautious or /aggressive: Adjust agent risk appetite',
  '• /kill: Emergency stop (send "kill confirm" to flatten all positions)'
].join('\n');

const AGENTS: AgentId[] = ['lead', 'market', 'research', 'strategist', 'risk', 'execution'];

/** Parse one chat message. Accepts "/status", "status", "/status@MyBot", "desk status", "/analyze BTC", "/ask ...". */
export function parseCommand(text: string): Parsed {
  if (text.length > 2500) return { ok: false, reply: 'Message exceeds 2500 characters.' };
  const t = String(text ?? '').trim().replace(/^\/?(desk|mpu)\s+/i, '').replace(/^\//, '').replace(/^([a-z-]+)@\S+/i, '$1');
  const owner = parseOwnerCommand(t);
  if (owner.type === 'invalid') return { ok: false, reply: owner.reason };
  if (['set_profile', 'set_size', 'set_leverage', 'set_n', 'set_safety', 'open', 'close', 'close_all'].includes(owner.type)) return { ok: true, cmd: 'owner', text: t };
  if (/^(long|short|size|leverage)\b/i.test(t)) return { ok: false, reply: 'Usage: open long|short <symbol> [size%] [leverage], set size <percent>%, or set leverage <value>.' };
  const [rawWord = '', ...rest] = t.split(/\s+/);
  const word = rawWord.toLowerCase();
  if (!word) return { ok: false, reply: HELP_TEXT };
  if ((SAFE_COMMANDS as readonly string[]).includes(word)) {
    return { ok: true, cmd: word as SafeCommand, confirm: word === 'kill' && /^(confirm|yes)$/.test(rest.join(' ').replace(/^confirm:\s*/, '')) };
  }
  if (word === 'scan') return { ok: true, cmd: 'scan' };
  if (word === 'watchlist' || word === 'tokens') return { ok: true, cmd: 'watchlist' };
  if (word === 'scorecard' || word === 'scores') return { ok: true, cmd: 'scorecard' };
  if (word === 'lessons' || word === 'learnings') return { ok: true, cmd: 'lessons' };
  if (word === 'cautious' || word === 'hati-hati') return { ok: true, cmd: 'cautious' };
  if (word === 'aggressive' || word === 'berani') return { ok: true, cmd: 'aggressive' };
  if (word === 'calm' || word === 'reset') return { ok: true, cmd: 'calm' };
  if (['analyze', 'debate', 'analisa', 'debat'].includes(word)) {
    const sym = rest[0] ? normSymbol(rest[0]) : '';
    if (!sym) return { ok: false, reply: 'Usage: /analyze <symbol> (e.g. /analyze BTCUSDT)' };
    return { ok: true, cmd: 'analyze', symbol: sym };
  }
  if (word === 'ask' || word === 'chat' || (AGENTS as string[]).includes(word)) {
    let agent: AgentId = 'lead';
    let textContent = '';
    if ((AGENTS as string[]).includes(word)) {
      agent = word as AgentId;
      textContent = rest.join(' ').trim();
    } else if (rest[0] && (AGENTS as string[]).includes(rest[0].toLowerCase())) {
      agent = rest[0].toLowerCase() as AgentId;
      textContent = rest.slice(1).join(' ').trim();
    } else {
      textContent = rest.join(' ').trim();
    }
    if (!textContent) return { ok: false, reply: 'Usage: /ask <question> or /ask <agent> <question>' };
    return { ok: true, cmd: 'ask', agent, text: textContent };
  }
  for (const [re, reply] of FORBIDDEN) if (re.test(word)) return { ok: false, reply: `Refused. ${reply}` };
  return { ok: true, cmd: 'chat', agent: 'lead', text: t };
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
export async function runCommand(desk: Desk, p: Parsed, onKill?: () => void, conversationId = 'channel'): Promise<string> {
  if (!p.ok) return p.reply;
  switch (p.cmd) {
    case 'owner': return safe((await desk.command(p.text, undefined, conversationId)).reply);
    case 'help': return HELP_TEXT;
    case 'status': return statusText(desk);
    case 'positions': return positionsText(desk);
    case 'report': return reportText(desk);
    case 'scan': {
      const findings = proactiveScan(desk);
      if (!findings.length) return 'Proactive scan: all clear, no open warnings.';
      return safe(`Proactive Scan Findings:\n${findings.map((f) => `[${f.level.toUpperCase()}] ${f.text}`).join('\n')}`);
    }
    case 'analyze':
    case 'debate': {
      const res = await desk.command(`analyze ${p.symbol}`);
      return safe(res.reply);
    }
    case 'ask':
    case 'chat': {
      const res = await desk.command(p.text, p.agent, conversationId);
      return safe(`[${p.agent.toUpperCase()}]: ${res.reply}`);
    }
    case 'watchlist': {
      return safe(`Watchlist (${desk.cfg.auto.symbols.length} symbols, auto every ${desk.cfg.auto.intervalMin}m):\n${desk.cfg.auto.symbols.join(', ')}`);
    }
    case 'scorecard': {
      const rows = desk.scorecard.rows();
      return safe(`Employee Scorecard:\n${rows.map((r) => `• ${r.name}: ${r.note}`).join('\n')}`);
    }
    case 'lessons': {
      const ls = desk.learnings.recent(5);
      if (!ls.length) return 'No lessons recorded yet.';
      return safe(`Recent Lessons:\n${ls.map((l: { role: string; lesson: string }) => `• [${l.role}] ${l.lesson}`).join('\n')}`);
    }
    case 'cautious':
    case 'aggressive':
    case 'calm': {
      const res = await desk.command(p.cmd === 'cautious' ? 'be more cautious' : p.cmd === 'aggressive' ? 'be more aggressive' : 'calm down');
      return safe(res.reply);
    }
    case 'kill': {
      if (!p.confirm) return 'This flattens every position and stops the desk until the local Owner releases it with the Office OFF button or npm run unkill -- --yes. Send "kill confirm" to do it.';
      onKill?.();
      const notes = await desk.kill();
      return safe(`KILL SWITCH ON. ${notes.join('; ') || 'nothing was open'}. Release only on the desk computer: the local Office OFF button or npm run unkill -- --yes.`);
    }
  }
}
