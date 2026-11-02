/** Plain-text command cards for Discord and Telegram. Emoji markers, no markdown. */

const LINE = '────────';

export function money(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'unavailable';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function signedMoney(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'unavailable';
  return `${n > 0 ? '+' : n < 0 ? '' : ''}${money(n)}`;
}

export function pnlMark(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n === 0) return '⚪ flat';
  return n > 0 ? '🟢 ▲' : '🔴 ▼';
}

export function modeMark(mode: string): string {
  if (mode === 'LIVE') return '🟢 LIVE';
  if (mode === 'TESTNET') return '🟡 TESTNET';
  return '⚪ PAPER';
}

/** Same rule as the office Open PnL badge. */
export function deskOpenPnl(input: {
  mode: string;
  paperUnrealized: number;
  venueUnrealized?: number | null;
  venueStatus?: string | null;
}): { value: number | null; source: string } {
  if (input.mode !== 'PAPER' && input.venueUnrealized != null && Number.isFinite(input.venueUnrealized)) {
    return {
      value: input.venueUnrealized,
      source: input.venueStatus === 'confirmed' ? 'Exchange' : 'Exchange stale'
    };
  }
  if (input.mode === 'PAPER') {
    return { value: Number.isFinite(input.paperUnrealized) ? input.paperUnrealized : null, source: 'Paper' };
  }
  return {
    value: Number.isFinite(input.paperUnrealized) ? input.paperUnrealized : null,
    source: 'Local estimate'
  };
}

export function pnlLine(label: string, value: number | null, source?: string): string {
  const tail = source ? ` · ${source}` : '';
  return `${pnlMark(value)} ${label} ${signedMoney(value)} USDT${tail}`;
}

export function formatStatusCard(input: {
  mode: string;
  venue: string | null;
  killed: boolean;
  paused?: boolean;
  autoOn: boolean;
  autoIntervalMin: number;
  equity: number | null;
  balance: number | null;
  safetyNet: number;
  moneyTrade: number | null;
  perOrder: number | null;
  openPnl: number | null;
  pnlSource: string;
  realized: number | null;
  positions: number;
  slots: number;
  freeSlots: number;
  dailyLossHit: boolean;
  dailyLossLimitPct: number;
}): string {
  const desk = input.killed ? '🛑 STOPPED' : input.paused ? '⏸ PAUSED' : '⚡ ACTIVE';
  return [
    `📊 STATUS · ${modeMark(input.mode)}${input.venue ? ` · ${input.venue.toUpperCase()}` : ''}`,
    LINE,
    `${desk}`,
    `${input.autoOn ? '🤖' : '⏸'} Auto ${input.autoOn ? `ON · every ${input.autoIntervalMin}m` : 'OFF'}`,
    `${input.killed ? '🛑' : '✅'} Kill ${input.killed ? 'ON' : 'OFF'}`,
    `${input.dailyLossHit ? '🚨' : '✅'} Daily loss ${input.dailyLossHit ? 'HIT' : 'clear'} · cap ${input.dailyLossLimitPct}%`,
    LINE,
    '💰 CAPITAL',
    `Equity ${money(input.equity)} · Balance ${money(input.balance)}`,
    pnlLine('Open PnL', input.openPnl, input.pnlSource),
    pnlLine('Realized', input.realized),
    `Safety ${money(input.safetyNet)} · Trade ${money(input.moneyTrade)} · Order ${money(input.perOrder)}`,
    LINE,
    `📌 Positions ${input.positions}/${input.slots} · Free ${input.freeSlots}`
  ].join('\n');
}

export function formatPositionsCard(input: {
  mode: string;
  positions: Array<{
    symbol: string;
    side: string;
    leverage?: number;
    qty: number;
    margin?: number;
    entry: number;
    mark?: number;
    stop?: number;
    tp?: number | null;
    protectionStatus?: string;
    unrealizedPnl?: number;
  }>;
}): string {
  const header = `📌 POSITIONS · ${input.positions.length}`;
  if (!input.positions.length) return `${header}\n${LINE}\nNone open.`;
  const cards = input.positions.slice(0, 8).map((p, i) => {
    const pnl = Number(p.unrealizedPnl ?? 0);
    const notional = p.entry * p.qty;
    const pct = notional > 0 ? Math.round((pnl / notional) * 10000) / 100 : null;
    const pctText = pct == null ? '' : ` (${pct > 0 ? '+' : ''}${pct.toFixed(2)}%)`;
    const stop = p.stop && p.stop > 0 ? String(p.stop) : 'MISSING';
    const stopMark = p.stop && p.stop > 0 ? '✅' : '🚨';
    const prot = p.protectionStatus === 'confirmed'
      ? '✅ confirmed'
      : p.protectionStatus === 'missing'
        ? '🚨 missing'
        : input.mode === 'PAPER'
          ? '⚪ paper'
          : '❔ unverified';
    return [
      `${i + 1}. ${pnlMark(pnl)} ${p.symbol} ${p.side}${p.leverage ? ` ${p.leverage}x` : ''}`,
      `Qty ${p.qty} · Margin ${money(p.margin ?? 0)}`,
      `Entry ${p.entry} · Mark ${p.mark ?? p.entry}`,
      `${stopMark} SL ${stop} · TP ${p.tp ?? 'none'} · ${prot}`,
      `PnL ${signedMoney(pnl)} USDT${pctText}`
    ].join('\n');
  });
  const more = input.positions.length > 8 ? `\n${LINE}\n+${input.positions.length - 8} more in the office` : '';
  return [header, LINE, cards.join(`\n${LINE}\n`) + more].join('\n');
}

export function formatReportCard(input: {
  at: number;
  mode: string;
  venue: string | null;
  killed: boolean;
  autoOn: boolean;
  autoIntervalMin: number;
  equity: number | null;
  balance: number | null;
  safetyNet: number;
  moneyTrade: number | null;
  openPnl: number | null;
  pnlSource: string;
  realized: number | null;
  dailyLossHit: boolean;
  dailyLossLimitPct: number;
  positions: Array<{
    symbol: string;
    side: string;
    qty?: string | number;
    entry?: string | number;
    stop?: string | number;
    tp?: string | number | null;
    unrealizedPnl?: number;
  }>;
}): string {
  const when = new Date(input.at).toISOString().replace('T', ' ').slice(0, 16);
  const pos = input.positions.slice(0, 6).map((p) => {
    const pnl = Number(p.unrealizedPnl ?? 0);
    const stop = p.stop && Number(p.stop) > 0 ? p.stop : 'MISSING';
    return `${pnlMark(pnl)} ${p.symbol} ${p.side} · qty ${p.qty ?? '-'} · entry ${p.entry ?? '-'} · SL ${stop} · PnL ${signedMoney(pnl)}`;
  });
  return [
    `📋 REPORT · ${modeMark(input.mode)}${input.venue ? ` · ${input.venue.toUpperCase()}` : ''}`,
    `🕐 ${when} UTC`,
    LINE,
    pnlLine('Open PnL', input.openPnl, input.pnlSource),
    pnlLine('Realized', input.realized),
    `Equity ${money(input.equity)} · Balance ${money(input.balance)}`,
    `Safety ${money(input.safetyNet)} · Trade ${money(input.moneyTrade)}`,
    `${input.killed ? '🛑' : '✅'} Kill ${input.killed ? 'ON' : 'OFF'} · ${input.autoOn ? '🤖' : '⏸'} Auto ${input.autoOn ? `ON ${input.autoIntervalMin}m` : 'OFF'}`,
    `${input.dailyLossHit ? '🚨' : '✅'} Daily loss ${input.dailyLossHit ? 'HIT' : 'clear'} · ${input.dailyLossLimitPct}%`,
    LINE,
    `📌 Positions ${input.positions.length}`,
    ...(pos.length ? pos : ['None'])
  ].join('\n');
}

export function formatScanCard(findings: string[]): string {
  if (!findings.length) {
    return ['🔎 SCAN', LINE, '✅ No alerts. Stops and kill switch look clear.'].join('\n');
  }
  return ['🔎 SCAN', LINE, ...findings.map((line) => (line.startsWith('🚨') || line.startsWith('⚠️') ? line : `⚠️ ${line}`))].join('\n');
}

export function formatWatchlistCard(symbols: string[], intervalMin: number): string {
  const list = symbols.length ? symbols.map((s) => `• ${s}`).join('\n') : '• none';
  return [`👀 WATCHLIST · ${symbols.length}`, `🤖 Auto every ${intervalMin}m`, LINE, list].join('\n');
}

export function formatScorecardCard(rows: Array<{ name: string; calls: number; right: number; wrong: number; note?: string }>): string {
  if (!rows.length) return ['📊 SCORECARD', LINE, 'No settled calls yet.'].join('\n');
  const lines = rows.map((r) => {
    const mark = r.right > r.wrong ? '🟢' : r.wrong > r.right ? '🔴' : '⚪';
    return `${mark} ${r.name}\nCalls ${r.calls} · Right ${r.right} · Wrong ${r.wrong}${r.note ? `\n${r.note}` : ''}`;
  });
  return ['📊 SCORECARD', LINE, lines.join(`\n${LINE}\n`)].join('\n');
}

export function formatLessonsCard(rows: Array<{ role: string; lesson: string }>): string {
  if (!rows.length) return ['📘 LESSONS', LINE, 'None recorded yet.'].join('\n');
  return ['📘 LESSONS', LINE, ...rows.slice(-5).map((l) => `• ${l.role}: ${l.lesson}`)].join('\n');
}
