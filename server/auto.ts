import type { Desk } from './desk.js';
import { log, safe } from './redact.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Full auto. Every DEBATE_INTERVAL_MIN: close anything past MAX_HOLD_HOURS, then debate each
// allowed symbol in turn. Verdicts execute on their own (open, close, stop, take profit, size).
// There is no approval step. The guards live in the desk: risk gate, money split, stop loss,
// daily loss stop, kill switch.
// Every cycle also runs the two learning skills on its own:
//   before: proaktif-agent scan (loss cap usage, missing stops, errors, stale data, safety net)
//   after:  self-improving reflection (lessons with status new / confirmed / promoted)
export class AutoTrader {
  private timer: NodeJS.Timeout | null = null;
  constructor(private desk: Desk, private firstDelayMs = 5000) {}

  get intervalMs() { return this.desk.cfg.auto.intervalMin * 60_000; }

  start() {
    if (!this.desk.cfg.auto.on || this.timer) return;
    if (this.desk.grokbot) { log('[auto] Grok Bot mode: the trading loop runs as a Grok Bot routine (see grokbot/BOOTSTRAP.md), not here'); return; }
    this.desk.autoState = { ...this.desk.autoState, on: true, intervalMin: this.desk.cfg.auto.intervalMin };
    log(`[auto] full auto on: ${this.desk.cfg.auto.symbols.join(', ')} every ${this.desk.cfg.auto.intervalMin} min`);
    this.schedule(this.firstDelayMs);
    this.desk.emit('state', this.desk.snapshot());
  }
  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.desk.autoState.on = false;
    this.desk.autoState.nextAt = 0;
    this.desk.emit('state', this.desk.snapshot());
  }

  configure(opts: { on?: boolean; intervalMin?: number; symbols?: string[]; maxHoldHours?: number; n?: number }) {
    const c = this.desk.cfg.auto;
    if (typeof opts.intervalMin === 'number' && Number.isFinite(opts.intervalMin)) {
      c.intervalMin = Math.max(1, Math.min(1440, Math.round(opts.intervalMin)));
      this.desk.autoState.intervalMin = c.intervalMin;
    }
    if (Array.isArray(opts.symbols) && opts.symbols.length > 0) {
      c.symbols = opts.symbols.map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 12);
      for (const s of c.symbols) {
        if (!this.desk.cfg.watchlist.includes(s)) this.desk.cfg.watchlist.push(s);
      }
    }
    if (typeof opts.maxHoldHours === 'number' && Number.isFinite(opts.maxHoldHours)) {
      c.maxHoldHours = Math.max(0, Math.min(720, Math.round(opts.maxHoldHours)));
    }
    if (typeof opts.n === 'number' && [1, 2, 3, 4].includes(opts.n)) {
      this.desk.book.n = opts.n as 1 | 2 | 3 | 4;
      this.desk.cfg.paper.n = opts.n as 1 | 2 | 3 | 4;
    }
    if (typeof opts.on === 'boolean') {
      c.on = opts.on;
    }
    if (c.on && !this.desk.killed) {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      this.start();
    } else if (!c.on) {
      this.stop();
    } else {
      this.desk.emit('state', this.desk.snapshot());
    }
    return this.desk.snapshot().auto;
  }

  private schedule(ms: number) {
    this.desk.autoState.nextAt = Date.now() + ms;
    this.timer = setTimeout(() => { void this.cycle().finally(() => { if (this.timer && !this.desk.killed) this.schedule(this.intervalMs); }); }, ms);
  }

  /** One cycle. Safe to call directly (tests, "run a cycle now"). */
  async cycle(): Promise<{ ran: string[]; skipped: string }> {
    const d = this.desk;
    if (d.killed) { this.stop(); return { ran: [], skipped: 'kill switch' }; }
    if (d.paused) return { ran: [], skipped: 'desk paused' };
    if (d.autoState.running) return { ran: [], skipped: 'previous cycle still running' };
    d.autoState.running = true;
    d.autoState.lastCycleAt = Date.now();
    d.emit('state', d.snapshot());
    const ran: string[] = [];
    const started = Date.now();
    try {
      if (d.cfg.learning.scan) d.scan();
      await d.closeStale();
      // 1. Evaluate open positions first so any CLOSE decision frees up a slot out of N immediately.
      const openSyms = [...new Set(d.book.positions.map((p) => p.symbol))];
      const candidates = d.cfg.auto.symbols
        .filter((s) => !openSyms.includes(s))
        .sort((a, b) => Math.abs(d.tickers[b]?.change24hPct ?? 0) - Math.abs(d.tickers[a]?.change24hPct ?? 0));
      const queue = [...openSyms, ...candidates];
      for (const sym of queue) {
        if (d.paused || d.killed) break;
        for (let i = 0; d.debate && i < 600; i++) await sleep(500); // a manual debate is running, wait for it
        try { await d.runDebate(sym); ran.push(sym); }
        catch (e) { log(`[auto] ${sym}: ${safe((e as Error).message)}`); }
      }
      d.autoState.cycles++;
      if (d.autoState.cycles % d.cfg.learning.reflectEveryCycles === 0) d.reflect(started - 1);
      return { ran, skipped: '' };
    } finally {
      d.autoState.running = false;
      d.emit('state', d.snapshot());
    }
  }
}
