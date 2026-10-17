// Headless debate: npm run debate -- --symbol BTCUSDT [--rounds 2] [--offline] [--json]
import { loadConfig, ConfigError } from '../server/config.js';
import { Desk } from '../server/desk.js';
import { makeCaller } from '../server/providers/index.js';
import { ROLES } from '../server/agents/roles.js';
import type { AgentId } from '../server/types.js';

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : 'true') : undefined; };
if (flag('offline')) process.env.MARKET_SOURCE = 'sample';
if (flag('rounds')) process.env.DEBATE_ROUNDS = flag('rounds');
process.env.DEBATE_PACE_MS = '0';

let cfg;
try { cfg = loadConfig(); } catch (e) { console.error((e as Error).message); process.exit(e instanceof ConfigError ? e.exitCode : 1); }
cfg.bridge.enabled = cfg.bridge.enabled && flag('bridge') === 'true';

const desk = new Desk(cfg, makeCaller(cfg), { reportsDir: flag('no-report') ? null : 'reports' });
const json = flag('json') === 'true';
const c = (hex: string, s: string) => { if (json || !process.stdout.isTTY) return s; const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)); return `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`; };
if (!json) {
  desk.on('speech', (e: { agent: AgentId; text: string; done: boolean; example: boolean }) => { if (e.done) console.log(`${c(ROLES[e.agent].color, ROLES[e.agent].name.padEnd(17))} ${e.text}${e.example ? '  [EXAMPLE]' : ''}`); });
  desk.on('fight', (e: { from: AgentId; to: AgentId; intensity: number }) => console.log(c('#ff5d5d', `   POW! ${ROLES[e.from].name} swings at ${ROLES[e.to].name} (heat ${e.intensity.toFixed(2)})`)));
}
const symbol = (flag('symbol') ?? 'BTCUSDT').toUpperCase();
if (!json) console.log(`\nTrading Agent Mpu Gandring, PAPER debate on ${symbol}\n`);
const v = await desk.runDebate(symbol);
if (json) console.log(JSON.stringify({ verdict: v, paper: desk.snapshot().paper }, null, 2));
else {
  const s = desk.book.split();
  console.log(`\nVERDICT ${v.action} | risk ${v.riskDecision} | disagreement ${v.disagreement} | executed ${v.executed}${v.example ? ' | EXAMPLE' : ''}`);
  console.log(`Reason: ${v.reason}`);
  if (v.order) console.log(`Paper order: ${v.order.side} ${v.order.qty} @ ${v.order.entry} stop ${v.order.stop} margin ${v.order.margin} USDT ${v.order.leverage}x`);
  console.log(`Money split: balance ${s.balance} - safety net ${s.safetyNet} = Money Trade ${s.moneyTrade}; / N ${s.n} = ${s.perOrder} per order\n`);
}
process.exit(0);
