import type { Desk } from './desk.js';
import { log, safe } from './redact.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Full auto. Every DEBATE_INTERVAL_MIN: close anything past MAX_HOLD_HOURS, then debate each
// allowed symbol in turn. Verdicts execute on their own (open, close, stop, take profit, size).
// There is no approval step. The guards live in the desk: risk gate, money split, stop loss,
// daily loss stop, kill switch.
export class AutoTrader {
  private timer: NodeJS.Timeout | null = null;
  constructor(private desk: Desk, private firstDelayMs = 5000) {}

  get intervalMs() { return this.desk.cfg.auto.intervalMin * 60_000; }

  start() {
    if (!this.desk.cfg.auto.on || this.timer) return;
    this.desk.autoState = { ...this.desk.autoState, on: true, intervalMin: this.desk.cfg.auto.intervalMin };
    log(`[auto] full auto on: ${this.desk.cfg.auto.symbols.join(', ')} every ${this.desk.cfg.auto.intervalMin} min`);
    this.schedule(this.firstDelayMs);
  }
  stop() { if (this.timer) clearTimeout(this.timer); this.timer = null; this.desk.autoState.on = false; }

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
    const ran: string[] = [];
    try {
      await d.closeStale();
      for (const sym of d.cfg.auto.symbols) {
        if (d.paused || d.killed) break;
        for (let i = 0; d.debate && i < 600; i++) await sleep(500); // a manual debate is running, wait for it
        try { await d.runDebate(sym); ran.push(sym); }
        catch (e) { log(`[auto] ${sym}: ${safe((e as Error).message)}`); }
      }
      d.autoState.cycles++;
      return { ran, skipped: '' };
    } finally {
      d.autoState.running = false;
    }
  }
}
