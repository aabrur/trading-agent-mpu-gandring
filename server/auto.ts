import type { Desk } from './desk.js';
import { log, safe } from './redact.js';
import { fetchCoinMarketCapQuotes, cmcMomentum } from './market/coinmarketcap.js';

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
  private generation = 0;
  constructor(private desk: Desk, private firstDelayMs = 5000) {}

  get intervalMs() { return this.desk.cfg.auto.intervalMin * 60_000; }

  start() {
    if (!this.desk.cfg.auto.on || this.timer) return;
    if (this.desk.grokbot) { log('[auto] Grok Bot mode: the trading loop runs as a Grok Bot routine (see grokbot/BOOTSTRAP.md), not here'); return; }
    this.desk.autoState = { ...this.desk.autoState, on: true, intervalMin: this.desk.cfg.auto.intervalMin };
    this.desk.diagnostic({ source: 'automation', category: 'AUTO', eventName: 'automation.started', status: 'started', message: 'Auto trader started', details: { intervalMin: this.desk.cfg.auto.intervalMin } });
    log(`[auto] full auto on: ${this.desk.cfg.auto.symbols.join(', ')} every ${this.desk.cfg.auto.intervalMin} min`);
    if (!this.desk.autoState.running) this.schedule(this.firstDelayMs);
    this.desk.emit('state', this.desk.snapshot());
  }
  stop() {
    this.desk.diagnostic({ source: 'automation', category: 'AUTO', eventName: 'automation.stopped', status: 'stopped', message: 'Auto trader stopped' });
    this.generation++;
    this.desk.autoState.stopping = this.desk.autoState.running;
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
      c.symbols = opts.symbols.map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 10);
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
    this.desk.diagnostic({ source: 'automation', category: 'AUTO', eventName: 'automation.scheduled', status: 'scheduled', message: 'Next auto cycle scheduled', details: { nextAt: this.desk.autoState.nextAt, delayMs: ms } });
    this.timer = setTimeout(() => {
      this.timer = null;
      this.desk.autoState.nextAt = 0;
      this.cycle('scheduled')
        .catch((err) => log(`[auto] cycle error: ${safe((err as Error).message)}`))
        .finally(() => { if (!this.timer && this.desk.autoState.on && !this.desk.killed) this.schedule(this.intervalMs); });
    }, ms);
  }

  /** One cycle. Safe to call directly (tests, "run a cycle now"). */
  async cycle(trigger: 'manual' | 'scheduled' = 'manual'): Promise<{ ran: string[]; skipped: string }> {
    const d = this.desk;
    if (d.killed) { this.stop(); return { ran: [], skipped: 'kill switch' }; }
    if (d.paused) return { ran: [], skipped: 'desk paused' };
    if (d.autoState.running) return { ran: [], skipped: 'previous cycle still running' };
    const generation = this.generation;
    const cancelled = () => generation !== this.generation || d.paused || d.killed;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null; d.autoState.nextAt = 0;
    d.autoState.running = true; d.autoState.trigger = trigger; d.autoState.stopping = false;
    d.autoState.lastCycleAt = Date.now();
    d.emit('state', d.snapshot());
    const ran: string[] = [];
    const started = Date.now();
    const correlationId = `cycle-${started}-${generation}`;
    d.diagnostic({ source: 'automation', category: 'AUTO', eventName: 'automation.cycle_started', status: 'started', correlationId, message: 'Auto cycle started', details: { trigger } });
    try {
      if (d.cfg.learning.scan) d.scan();
      await d.closeStale(() => !cancelled());

      // PHASE A: Authoritative exchange reconciliation before determining the work queue
      if (d.hasExecutor) {
        try {
          await d.syncLive();
        } catch (e) {
          log(`[auto] exchange reconciliation failed: ${safe((e as Error).message)}`);
          d.recordError('exchange', `Reconciliation failed: ${(e as Error).message}`);
        }
      }

      // PHASE B & C: Manage all existing managed open positions first
      const managedPositions = d.book.positions.filter((p) => p.ownership !== 'external');
      const openSyms = [...new Set(managedPositions.map((p) => p.symbol))];

      for (const sym of openSyms) {
        if (cancelled()) break;
        for (let i = 0; d.debate && !cancelled() && i < 600; i++) await sleep(500); // a manual debate is running, wait for it
        if (cancelled()) break;
        try {
          await d.runDebate(sym);
          ran.push(sym);
        } catch (e) {
          log(`[auto] position review ${sym}: ${safe((e as Error).message)}`);
        }
      }

      if (cancelled()) return { ran, skipped: 'cancelled' };

      // PHASE D: Strict slot-based opportunity search
      // freeSlots = max(0, configuredN - exchangeConfirmedOpenPositionCount - pendingOpenCount)
      const slotState = d.availableSlots();

      if (slotState.freeSlots === 0) {
        const activeSymbols = d.book.positions.map((p) => p.symbol).join(', ') || 'none';
        const capMsg = `[auto] CAPACITY_FULL / MANAGING_POSITIONS: ${slotState.occupiedSlots}/${slotState.configuredN} slots in use (${activeSymbols}). Entry search skipped.`;
        log(capMsg);
        d.addLog({ kind: 'info', text: capMsg });
        d.note('skipped', 'AUTO', `CAPACITY_FULL / MANAGING_POSITIONS: ${slotState.occupiedSlots}/${slotState.configuredN} slots occupied (${activeSymbols}). Active positions monitored; new entry search skipped.`);
      } else {
        const ranking = (symbol: string) => {
          const evidence = d.opportunities[symbol];
          return evidence && Date.now() - evidence.at < d.cfg.tickerRefreshSeconds * 3000 ? evidence.score : 0;
        };
        const cmcKey = (process.env.COINMARKETCAP_API_KEY || process.env.CMC_API_KEY || '').trim();
        const quotes = cmcKey ? await fetchCoinMarketCapQuotes(d.cfg.auto.symbols, cmcKey) : {};
        const priority = (symbol: string) => cmcMomentum(symbol, quotes[symbol.replace(/(USDT|USDC|USD|BUSD|PERP)$/i, '')] ?? null).classification === 'ROTATION_SURGE' ? 1 : 0;
        const candidates = d.cfg.auto.symbols
          .filter((s) => !d.book.positions.some((p) => p.symbol === s))
          .sort((a, b) => priority(b) - priority(a) || ranking(b) - ranking(a));
        d.diagnostic({ source: 'automation', category: 'AUTO', eventName: 'automation.candidates', correlationId, message: 'Candidate scan completed', details: { candidates } });

        for (const sym of candidates) {
          if (cancelled()) break;
          const currentSlots = d.availableSlots();
          if (currentSlots.freeSlots <= 0) {
            log(`[auto] CAPACITY_FULL: capacity reached during cycle (${currentSlots.occupiedSlots}/${currentSlots.configuredN}). Halting candidate evaluation.`);
            break;
          }
          for (let i = 0; d.debate && !cancelled() && i < 600; i++) await sleep(500);
          if (cancelled()) break;
          try {
            await d.runDebate(sym);
            ran.push(sym);
          } catch (e) {
            log(`[auto] ${sym}: ${safe((e as Error).message)}`);
          }
        }
      }
      d.autoState.cycles++;
      if (d.autoState.cycles % d.cfg.learning.reflectEveryCycles === 0) d.reflect(started - 1);
      return { ran, skipped: '' };
    } finally {
      d.diagnostic({ source: 'automation', category: 'AUTO', eventName: 'automation.cycle_finished', status: cancelled() ? 'cancelled' : 'finished', correlationId, durationMs: Date.now() - started, message: 'Auto cycle finished', details: { ran } });
      d.autoState.running = false; d.autoState.stopping = false; d.autoState.completedAt = Date.now();
      if (d.autoState.on && !d.killed && !this.timer) this.schedule(this.intervalMs);
      d.emit('state', d.snapshot());
    }
  }
}
