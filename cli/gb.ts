// npm run gb -- <command> [args] [--json]
// Keyless agent CLI for Grok Bot employees (and scripts). No model calls, ever.
// Read commands use public market data or the running office (/api/state).
// Write commands (open, close, event, scan, lessons add) go to the running office with
// AGENT_EVENT_SECRET as a Bearer token, so every order takes the desk's one execution path:
// risk gate caps, money split, mandatory stop, daily loss stop, kill switch. PAPER, TESTNET or
// LIVE follows TRADING_MODE in the office's .env. Exchange keys stay in the server's env.
import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { loadConfig, AGENT_IDS } from '../server/config.js';
import { getSnapshot, getCandles, TIMEFRAMES, MARKET_SOURCES, type Timeframe } from '../server/market/index.js';
import { EXCHANGES, VENUE_KIND, VENUE_LABEL, VENUE_KEY_HINT, ADAPTER_STATUS, envNames } from '../server/exchange/index.js';
import { moneySplit, planOrder, round2 } from '../server/money.js';
import { normSymbol } from '../server/commands.js';
import { safe } from '../server/redact.js';

export interface GbResult { ok: boolean; data: unknown; text: string }
interface Deps { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; baseUrl?: string }

const HELP = `Trading Agent Mpu Gandring agent CLI (no model keys needed)
  npm run gb -- market <symbol> [--source venue]     price, 24h change, funding
  npm run gb -- candles <symbol> [tf] [--limit 100] [--source venue]  closed candles, tf: ${TIMEFRAMES.join(' ')}
  npm run gb -- venues                               venues (CEX and DEX), key type, env names, status
  npm run gb -- account                              mode, balance, equity, daily loss stop
  npm run gb -- positions                            open positions with entry, stop, take profit, PnL
  npm run gb -- split [--balance B --safety S --n N] Money Trade = balance - safety net, per order = Money Trade / N
  npm run gb -- size <symbol> <LONG|SHORT> <entry> <stop> [--leverage L]   size a ticket (read only)
  npm run gb -- open <symbol> <LONG|SHORT> --stop P [--tp P] [--leverage L] [--reason "..."]
  npm run gb -- close <symbol|all>
  npm run gb -- report                               write a report now
  npm run gb -- event <agent> <text> [--stance LONG|SHORT|NEUTRAL --confidence 0.6 --target risk]
  npm run gb -- scan                                 proaktif-agent scan (loss cap, stops, errors, stale data, safety net)
  npm run gb -- lessons list [--n 30]
  npm run gb -- lessons add <role|desk> <lesson> [--kind loss|stop|error|scan|correction|note --happened "..." --cause "..." --symbol X]
Add --json for machine output. Agents: ${AGENT_IDS.join(', ')}. Not financial advice.`;

function parse(argv: string[]) {
  const pos: string[] = [], flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const nx = argv[i + 1]; if (nx !== undefined && !nx.startsWith('--')) { flags[k] = nx; i++; } else flags[k] = 'true'; }
    else pos.push(a);
  }
  return { pos, flags };
}
const num = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v));

export async function gb(argv: string[], deps: Deps = {}): Promise<GbResult> {
  const env = deps.env ?? process.env;
  const f = deps.fetchImpl ?? fetch;
  const { pos, flags } = parse(argv);
  const [cmd, ...args] = pos;
  const cfg = loadConfig({ ...env, TRADING_MODE: 'PAPER' }); // local view of caps; the office enforces the real mode
  const base = (deps.baseUrl ?? flags.url ?? env.GB_URL ?? `http://127.0.0.1:${env.PORT || 8787}`).replace(/\/$/, '');
  const secret = (env.AGENT_EVENT_SECRET ?? '').trim();
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown, auth = false) => {
    if (auth && !secret) throw new Error('AGENT_EVENT_SECRET is not set (npm run setup -- --yes --generate-agent-secret, or your Grok Bot secret store)');
    let res: Response;
    try {
      res = await f(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${secret}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) { throw new Error(`office not reachable at ${base} (start it with npm start or npm run dev): ${(e as Error).message}`); }
    const j = await res.json().catch(() => ({}));
    if (!res.ok && j?.ok !== false) throw new Error(`HTTP ${res.status}`);
    return j;
  };
  const state = () => call('GET', '/api/state');
  const ok = (data: unknown, text: string): GbResult => ({ ok: true, data, text });
  const fail = (text: string, data: unknown = null): GbResult => ({ ok: false, data, text });

  switch (cmd) {
    case undefined: case 'help': case '--help': return ok({ help: HELP }, HELP);
    case 'venues': {
      const rows = EXCHANGES.map((v) => ({ venue: v, label: VENUE_LABEL[v], kind: VENUE_KIND[v], status: ADAPTER_STATUS[v], key: VENUE_KEY_HINT[v], env: Object.values(envNames(v, 'mainnet')), testnetEnv: Object.values(envNames(v, 'testnet')), exchangeSideStops: true, selected: (env.EXCHANGE ?? '').toLowerCase() === v }));
      const line = (r: typeof rows[number]) => `  ${r.selected ? '*' : ' '} ${r.venue.padEnd(12)} ${r.label.padEnd(12)} ${r.status.padEnd(12)} ${r.env.join(', ')}`;
      return ok(rows, `CEX\n${rows.filter((r) => r.kind === 'CEX').map(line).join('\n')}\nDEX (delegated trade-only keys, never the main wallet key)\n${rows.filter((r) => r.kind === 'DEX').map(line).join('\n')}\nAll venues place the stop loss on the exchange. Not financial advice.`);
    }
    case 'market': {
      const s = normSymbol(args[0] ?? ''); if (!s) return fail('usage: market <symbol>');
      if (flags.source && !MARKET_SOURCES.includes(flags.source as never)) return fail(`--source must be one of ${MARKET_SOURCES.join(', ')}`);
      const snap = await getSnapshot(s, (flags.source as typeof cfg.marketSource) ?? cfg.marketSource);
      const d = { symbol: s, last: snap.last, bid: snap.bid, ask: snap.ask, change24hPct: round2(snap.change24hPct), fundingRate: snap.fundingRate, source: snap.source, example: snap.example, at: snap.fetchedAt };
      return ok(d, `${s} ${d.last} (${d.change24hPct}% 24h) funding ${d.fundingRate ?? 'n/a'} from ${d.source}${d.example ? ' (SAMPLE, not live)' : ''}`);
    }
    case 'candles': {
      const s = normSymbol(args[0] ?? ''); const tf = (args[1] ?? '15m') as Timeframe;
      if (!s || !TIMEFRAMES.includes(tf)) return fail(`usage: candles <symbol> [${TIMEFRAMES.join('|')}]`);
      if (flags.source && !MARKET_SOURCES.includes(flags.source as never)) return fail(`--source must be one of ${MARKET_SOURCES.join(', ')}`);
      const r = await getCandles(s, tf, (flags.source as typeof cfg.marketSource) ?? cfg.marketSource, num(flags.limit) ?? 100);
      const d = { symbol: s, tf: r.tf, source: r.source, example: r.example, candles: r.candles.map((c) => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: round2(c.v) })) };
      const last = d.candles.at(-1);
      return ok(d, `${s} ${r.tf}: ${d.candles.length} closed candles from ${r.source}${r.example ? ' (SAMPLE)' : ''}. Last close ${last?.c ?? 'n/a'}.`);
    }
    case 'account': {
      const st = await state();
      const d = { mode: st.mode, appMode: st.appMode, exchange: st.live?.exchange ?? null, balance: st.paper.balance, equity: st.paper.equity, safetyNet: st.paper.safetyNet, n: st.paper.n, moneyTrade: st.paper.moneyTrade, perOrder: st.paper.perOrder, open: st.paper.positions.length, dailyLoss: st.dailyLoss, killed: st.killed, paused: st.paused, auto: { on: st.auto?.on, intervalMin: st.auto?.intervalMin } };
      return ok(d, `${d.mode}${d.exchange ? ` on ${d.exchange}` : ''}: balance ${d.balance}, equity ${d.equity}, safety net ${d.safetyNet}, ${d.open}/${d.n} open, daily stop ${d.dailyLoss.limitPct}%${d.dailyLoss.hit ? ' HIT' : ''}${d.killed ? ', KILLED' : ''}`);
    }
    case 'positions': {
      const st = await state();
      const d = st.paper.positions.map((p: any) => ({ symbol: p.symbol, side: p.side, qty: p.qty, entry: p.entry, stop: p.stop, tp: p.tp, mark: p.mark, pnl: p.unrealizedPnl, margin: p.margin, leverage: p.leverage, openedAt: p.openedAt }));
      return ok(d, d.length ? d.map((p: any) => `${p.side} ${p.qty} ${p.symbol} entry ${p.entry} SL ${p.stop}${p.tp ? ` TP ${p.tp}` : ''} PnL ${p.pnl}`).join('\n') : 'no open positions');
    }
    case 'split': {
      let balance = num(flags.balance), safetyNet = num(flags.safety), n = num(flags.n);
      if (balance === undefined || safetyNet === undefined || n === undefined) {
        try { const st = await state(); balance ??= st.paper.balance; safetyNet ??= st.paper.safetyNet; n ??= st.paper.n; }
        catch { balance ??= cfg.paper.balance; safetyNet ??= cfg.paper.safetyNet; n ??= cfg.paper.n; }
      }
      const sp = moneySplit({ balance: balance!, safetyNet: safetyNet!, n: n! });
      return ok(sp, `Money Trade = ${sp.balance} - ${sp.safetyNet} = ${sp.moneyTrade}. Per order = ${sp.moneyTrade} / ${sp.n} = ${sp.perOrder}.`);
    }
    case 'size': {
      const s = normSymbol(args[0] ?? ''); const side = String(args[1] ?? '').toUpperCase(); const entry = Number(args[2]), stop = Number(args[3]);
      if (!s || (side !== 'LONG' && side !== 'SHORT') || !(entry > 0) || !(stop > 0)) return fail('usage: size <symbol> <LONG|SHORT> <entry> <stop>');
      if (side === 'LONG' ? stop >= entry : stop <= entry) return fail(`stop ${stop} is on the wrong side of entry ${entry}`);
      let book = { balance: cfg.paper.balance, safetyNet: cfg.paper.safetyNet, n: cfg.paper.n, open: 0, used: 0 };
      try { const st = await state(); book = { balance: st.paper.balance, safetyNet: st.paper.safetyNet, n: st.paper.n, open: st.paper.positions.length, used: st.paper.usedMargin }; } catch { /* offline: config values */ }
      const rawStopPct = (Math.abs(entry - stop) / entry) * 100;
      const stopPct = Math.min(cfg.risk.defaultStopPct, Math.max(cfg.risk.minStopPct, rawStopPct));
      const leverage = Math.max(1, Math.min(cfg.risk.maxLeverage, Math.floor(num(flags.leverage) ?? cfg.risk.maxLeverage)));
      const plan = planOrder({ balance: book.balance, safetyNet: book.safetyNet, n: book.n, openPositions: book.open, usedMargin: book.used, price: entry, side: side as 'LONG', sizeFactor: 1, leverage, stopPct, minOrderUsdt: cfg.risk.minOrderUsdt, maxLossPerTradePct: cfg.risk.maxLossPerTradePct, takeProfitR: cfg.risk.takeProfitR });
      const notes = [rawStopPct !== stopPct ? `stop distance ${round2(rawStopPct)}% clamped to ${round2(stopPct)}% by the caps` : '', (num(flags.leverage) ?? 0) > cfg.risk.maxLeverage ? `leverage capped to ${cfg.risk.maxLeverage}x` : ''].filter(Boolean);
      if (!plan.ok) return fail(`no ticket: ${plan.reason}`, { ok: false, reason: plan.reason, split: plan.split, notes });
      const riskAtStop = round2(Math.abs(entry - plan.stop) * plan.qty);
      const d = { symbol: s, side, entry, qty: plan.qty, margin: plan.margin, notional: plan.notional, leverage: plan.leverage, stop: plan.stop, tp: plan.tp, riskAtStop, split: plan.split, notes: [...notes, ...plan.notes] };
      return ok(d, `${side} ${plan.qty} ${s} at ${entry}: margin ${plan.margin} at ${plan.leverage}x, SL ${plan.stop}${plan.tp ? `, TP ${plan.tp}` : ''}, risk at stop ${riskAtStop} USDT.${d.notes.length ? ' ' + d.notes.join('. ') : ''}`);
    }
    case 'open': {
      const s = normSymbol(args[0] ?? ''); const side = String(args[1] ?? '').toUpperCase();
      if (!s || (side !== 'LONG' && side !== 'SHORT')) return fail('usage: open <symbol> <LONG|SHORT> --stop P [--tp P] [--leverage L]');
      const body: Record<string, unknown> = { symbol: s, side };
      for (const k of ['stop', 'tp', 'leverage'] as const) if (num(flags[k]) !== undefined) body[k] = num(flags[k]);
      if (flags.agent) body.agent = flags.agent;
      if (flags.reason) body.reason = flags.reason;
      const r = await call('POST', '/api/gb/open', body, true);
      return { ok: !!r.ok, data: r, text: r.ok ? r.reply : `not opened: ${r.reply ?? r.error}` };
    }
    case 'close': {
      if (!args[0]) return fail('usage: close <symbol|all>');
      const r = await call('POST', '/api/gb/close', { symbol: args[0], reason: flags.reason }, true);
      return { ok: !!r.ok, data: r, text: r.reply ?? r.error };
    }
    case 'report': {
      const r = await call('POST', '/api/reports/now');
      return { ok: !!r.ok, data: r.report, text: r.report?.text ?? 'no report' };
    }
    case 'event': {
      const agent = args[0]; const text = args.slice(1).join(' ');
      if (!AGENT_IDS.includes(agent as never) || (!text && !flags.status)) return fail(`usage: event <${AGENT_IDS.join('|')}> <text>`);
      const body: Record<string, unknown> = { agent, kind: flags.status ? 'status' : 'say' };
      if (text) body.text = text;
      if (flags.status) body.status = flags.status;
      if (flags.stance) body.stance = flags.stance.toUpperCase();
      if (num(flags.confidence) !== undefined) body.confidence = num(flags.confidence);
      if (flags.target) body.target = flags.target;
      const r = await call('POST', '/api/agent-event', body, true);
      return { ok: !!r.ok, data: r, text: r.ok ? `${agent}: ${r.reply}` : `not shown: ${r.error ?? r.reply}` };
    }
    case 'scan': {
      const r = await call('POST', '/api/gb/scan', {}, true);
      return { ok: !!r.ok, data: r.findings, text: (r.findings ?? []).map((x: any) => `${x.level}: ${x.text}`).join('\n') || (r.error ?? '') };
    }
    case 'lessons': {
      const sub = args[0] ?? 'list';
      if (sub === 'list') {
        const r = await call('GET', `/api/gb/lessons?n=${num(flags.n) ?? 30}`, undefined, true);
        const rules = (r.standingRules ?? []).map((l: any) => `RULE ${l.role}: ${l.lesson}`);
        const lines = (r.lessons ?? []).map((l: any) => `[${l.status}${l.count > 1 ? ` x${l.count}` : ''}] ${l.role}: ${l.lesson}`);
        return { ok: !!r.ok, data: r, text: [...rules, ...lines].join('\n') || 'no lessons yet' };
      }
      if (sub === 'add') {
        const role = args[1]; const lesson = args.slice(2).join(' ');
        if (!role || !lesson) return fail('usage: lessons add <role|desk> <lesson> [--kind ... --happened ... --cause ...]');
        const body: Record<string, unknown> = { role, lesson, kind: flags.kind ?? 'note' };
        if (flags.happened) body.happened = flags.happened;
        if (flags.cause) body.rootCause = flags.cause;
        if (flags.symbol) body.symbol = normSymbol(flags.symbol);
        const r = await call('POST', '/api/gb/lessons', body, true);
        return { ok: !!r.ok, data: r, text: r.ok ? `lesson ${r.event}: ${r.lesson.lesson}` : r.error };
      }
      return fail('usage: lessons list | lessons add <role> <lesson>');
    }
    default: return fail(`unknown command "${cmd}".\n${HELP}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  gb(argv.filter((a) => a !== '--json'))
    .then((r) => { console.log(safe(json ? JSON.stringify({ ok: r.ok, data: r.data, text: r.text }, null, 2) : r.text)); process.exitCode = r.ok ? 0 : 1; })
    .catch((e) => { const msg = safe((e as Error).message); console.log(json ? JSON.stringify({ ok: false, error: msg }) : `error: ${msg}`); process.exitCode = 1; });
}
