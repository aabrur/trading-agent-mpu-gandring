import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Desk } from '../server/desk.js';
import { loadConfig } from '../server/config.js';
import type { ModelCaller } from '../server/providers/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function createDesk(overrides: Record<string, string> = {}, caller?: ModelCaller) {
  const cfg = loadConfig({
    TRADING_MODE: 'PAPER',
    MARKET_SOURCE: 'sample',
    DEFAULT_PROVIDER: 'mock',
    DEBATE_PACE_MS: '0',
    LEARNING: 'off',
    ...overrides
  });
  const mockCall: ModelCaller = caller ?? (async () => JSON.stringify({ reply: 'All systems nominal Boss.' }));
  const desk = new Desk(cfg, mockCall, { reportsDir: null, learningsPath: null, killFile: null, opportunityReviewsPath: null });
  desk.book.autoExit = false;
  return { desk, cfg };
}

describe('Case G: Office Chat Operational Context Reliability', () => {
  it('prevents historical Bybit LINK position and unscoped positions from leaking into Aster LIVE chat facts', async () => {
    let capturedContext: any = null;
    const caller: ModelCaller = async (req) => {
      if (req.task === 'chat') {
        capturedContext = req.context;
        return JSON.stringify({ reply: 'Aster positions reported.' });
      }
      return JSON.stringify({ grade: 'A', lesson: 'ok' });
    };

    const { desk, cfg } = createDesk({}, caller);
    cfg.tradingMode = 'LIVE';
    cfg.exchange.name = 'aster';
    (desk as any).accountScope = () => 'LIVE:aster:mainnet:0x1111222233334444555566667777888899990000';

    // 1. Current Aster position
    desk.book.open({ symbol: 'ETHUSDT', side: 'LONG', qty: 1.5, entry: 2500, stop: 2400, tp: 2700, margin: 150, leverage: 2 });
    desk.book.positions[0].decisionEvidence = { accountScope: 'LIVE:aster:mainnet:0x1111222233334444555566667777888899990000' };
    desk.book.positions[0].protectionStatus = 'confirmed';

    // 2. Historical Bybit LINK position
    desk.book.open({ symbol: 'LINKUSDT', side: 'SHORT', qty: 10, entry: 15, stop: 16, tp: 13, margin: 50, leverage: 1 });
    desk.book.positions[1].decisionEvidence = { accountScope: 'HISTORICAL:bybit:mainnet:user_old' };
    desk.book.positions[1].protectionStatus = 'confirmed';

    // 3. Unscoped legacy position
    desk.book.open({ symbol: 'SOLUSDT', side: 'LONG', qty: 5, entry: 150, stop: 140, tp: 170, margin: 100, leverage: 1 });
    desk.book.positions[2].decisionEvidence = undefined;

    // Set venue account observation for Aster
    desk.venueAccount = {
      equity: 5000,
      available: 4850,
      unrealized: 15,
      at: Date.now(),
      status: 'confirmed',
      positions: [{ symbol: 'ETHUSDT', side: 'LONG', qty: 1.5 }]
    };

    const res = await desk.command('What are our active positions on Aster?', 'lead');
    expect(res.ok).toBe(true);
    expect(capturedContext).toBeDefined();

    // Verify only the Aster in-scope position is reported in chat facts
    expect(capturedContext.openPositions).toHaveLength(1);
    expect(capturedContext.openPositions[0].symbol).toBe('ETHUSDT');
    expect(capturedContext.openPositions[0].protectionConfirmed).toBe(true);

    // Verify historical Bybit LINK position is excluded
    expect(capturedContext.openPositions.some((p: any) => p.symbol === 'LINKUSDT')).toBe(false);

    // Verify unscoped legacy SOL position is excluded from Aster LIVE chat facts
    expect(capturedContext.openPositions.some((p: any) => p.symbol === 'SOLUSDT')).toBe(false);

    // Verify other scope exposure is surfaced for desk protection monitoring
    expect(capturedContext.otherScopeExposure).toContain('2 position(s) exist in local book with non-matching or legacy account scope');
    expect(capturedContext.accountEvidence.accountScope).toBe('LIVE:aster:mainnet:0x1111222233334444555566667777888899990000');
    expect(capturedContext.accountEvidence.venue).toBe('aster');
    expect(capturedContext.accountEvidence.source).toBe('exchange');
  });

  it('distinguishes fresh confirmed exchange snapshot from stale exchange snapshot', async () => {
    let capturedContext: any = null;
    const caller: ModelCaller = async (req) => {
      if (req.task === 'chat') {
        capturedContext = req.context;
        return JSON.stringify({ reply: 'Status check.' });
      }
      return JSON.stringify({ grade: 'A', lesson: 'ok' });
    };

    const { desk, cfg } = createDesk({}, caller);
    cfg.tradingMode = 'LIVE';
    cfg.exchange.name = 'aster';
    (desk as any).accountScope = () => 'LIVE:aster:mainnet:0xabc';

    // Fresh snapshot
    const now = Date.now();
    desk.venueAccount = {
      equity: 3000,
      available: 2800,
      unrealized: 50,
      at: now - 5000, // 5 seconds ago
      status: 'confirmed',
      positions: []
    };

    await desk.command('What is the venue status?', 'lead');
    expect(capturedContext.accountEvidence.status).toBe('confirmed');
    expect(capturedContext.accountEvidence.source).toBe('exchange');
    expect(capturedContext.accountEvidence.freshnessMs).toBeGreaterThanOrEqual(5000);

    // Stale snapshot: 90 seconds old
    desk.venueAccount.at = now - 90_000;
    await desk.command('How is the current venue status?', 'lead');
    expect(capturedContext.accountEvidence.status).toBe('stale');

    // Stale snapshot: status marked stale explicitly
    desk.venueAccount.at = now - 2000;
    desk.venueAccount.status = 'stale';
    await desk.command('Give me venue status now', 'lead');
    expect(capturedContext.accountEvidence.status).toBe('stale');
  });

  it('marks unconfirmed resting stops as UNKNOWN and never fabricates active protection', async () => {
    let capturedContext: any = null;
    const caller: ModelCaller = async (req) => {
      if (req.task === 'chat') {
        capturedContext = req.context;
        return JSON.stringify({ reply: 'Protection verified.' });
      }
      return JSON.stringify({ grade: 'A', lesson: 'ok' });
    };

    const { desk } = createDesk({ TRADING_MODE: 'PAPER' }, caller);

    // Position 1: Confirmed resting stop on exchange
    desk.book.open({ symbol: 'BTCUSDT', side: 'LONG', qty: 0.1, entry: 60000, stop: 58000, tp: 65000, margin: 100, leverage: 1 });
    desk.book.positions[0].protectionStatus = 'confirmed';

    // Position 2: Unconfirmed resting stop (protectionStatus is unknown)
    desk.book.open({ symbol: 'ETHUSDT', side: 'LONG', qty: 1, entry: 3000, stop: 2900, tp: 3200, margin: 50, leverage: 1 });
    desk.book.positions[1].protectionStatus = 'unknown';

    // Position 3: No stop set at all
    desk.book.open({ symbol: 'SOLUSDT', side: 'LONG', qty: 2, entry: 150, stop: 140, tp: 170, margin: 30, leverage: 1 });
    desk.book.positions[2].stop = undefined as any;
    desk.book.positions[2].protectionStatus = 'unknown';

    await desk.command('Review our resting stops', 'lead');

    const btc = capturedContext.openPositions.find((p: any) => p.symbol === 'BTCUSDT');
    expect(btc.protectionStatus).toBe('confirmed');
    expect(btc.protectionConfirmed).toBe(true);
    expect(btc.stop).toBe(58000);

    const eth = capturedContext.openPositions.find((p: any) => p.symbol === 'ETHUSDT');
    expect(eth.protectionStatus).toBe('UNKNOWN');
    expect(eth.protectionConfirmed).toBe(false);
    expect(eth.stop).toContain('UNKNOWN');

    const sol = capturedContext.openPositions.find((p: any) => p.symbol === 'SOLUSDT');
    expect(sol.protectionStatus).toBe('UNKNOWN');
    expect(sol.protectionConfirmed).toBe(false);
    expect(sol.stop).toBe('UNKNOWN');
  });

  it('detects and explicitly reports conflicting local and exchange position counts', async () => {
    let capturedContext: any = null;
    const caller: ModelCaller = async (req) => {
      if (req.task === 'chat') {
        capturedContext = req.context;
        return JSON.stringify({ reply: 'Discrepancy detected.' });
      }
      return JSON.stringify({ grade: 'A', lesson: 'ok' });
    };

    const { desk, cfg } = createDesk({}, caller);
    cfg.tradingMode = 'LIVE';
    cfg.exchange.name = 'aster';
    (desk as any).accountScope = () => 'LIVE:aster:mainnet:0xactive';

    // Local desk book has 2 in-scope positions
    desk.book.open({ symbol: 'BTCUSDT', side: 'LONG', qty: 0.1, entry: 60000, stop: 58000, tp: 65000, margin: 100, leverage: 1 });
    desk.book.positions[0].decisionEvidence = { accountScope: 'LIVE:aster:mainnet:0xactive' };
    desk.book.open({ symbol: 'ETHUSDT', side: 'LONG', qty: 1, entry: 3000, stop: 2900, tp: 3200, margin: 50, leverage: 1 });
    desk.book.positions[1].decisionEvidence = { accountScope: 'LIVE:aster:mainnet:0xactive' };

    // Exchange snapshot has only 1 position (BTCUSDT)
    desk.venueAccount = {
      equity: 5000,
      available: 4800,
      unrealized: 20,
      at: Date.now(),
      status: 'confirmed',
      positions: [{ symbol: 'BTCUSDT', side: 'LONG', qty: 0.1 }]
    };

    await desk.command('Inspect position alignment with exchange', 'lead');

    expect(capturedContext.accountEvidence.discrepancy).toBe(
      'Position count discrepancy: local desk has 2 in-scope position(s), but exchange snapshot has 1 position(s).'
    );
    expect(capturedContext.positionDiscrepancy).toBe(capturedContext.accountEvidence.discrepancy);
    // Prefers verified exchange snapshot count when confirmed
    expect(capturedContext.accountEvidence.positionCount).toBe(1);
  });

  it('distinguishes JEV CONFIGURED from a recent successful verified JEV response', () => {
    const { desk, cfg } = createDesk({ TRADING_MODE: 'PAPER' });

    // Scenario A: JEV is enabled and configured, but has not had a successful response
    cfg.jev.enabled = true;
    cfg.jev.openrouterKeySet = true;
    desk.jev.reload({ JEV_ENABLED: 'true', OPENROUTER_API_KEY: 'test-key' }, 'PAPER');
    desk.jev.metrics.success = 0;
    desk.jevLast = null;
    desk.jev.lastRecord = null;

    let jevCap = desk.capabilities().find(c => c.name === 'jev');
    expect(jevCap).toBeDefined();
    expect(jevCap?.status).toBe('CONFIGURED');
    expect(jevCap?.limitations[0]).toContain('no recent successful response has been verified');
    expect(desk.jev.status().verificationStatus).toBe('CONFIGURED_UNVERIFIED');

    // Scenario B: JEV has executed a successful remote verification
    desk.jev.metrics.success = 1;
    desk.jevLast = { ok: true, origin: 'remote', at: Date.now(), model: 'typesafe/jev-1.14' };
    desk.jev.lastRecord = desk.jevLast;

    jevCap = desk.capabilities().find(c => c.name === 'jev');
    expect(jevCap?.status).toBe('CONNECTED');
    expect(jevCap?.limitations[0]).toContain('verified recent response');
    expect(desk.jev.status().verificationStatus).toBe('VERIFIED');
  });

  it('preserves provider timeout, unavailable and failure classifications and recovers cleanly', async () => {
    let mode: 'timeout' | 'auth' | 'success' = 'timeout';
    const caller: ModelCaller = async (req) => {
      if (req.task === 'chat') {
        if (mode === 'timeout') throw new Error('Model request timed out after 15000ms');
        if (mode === 'auth') throw new Error('provider HTTP 401 unauthorized: invalid api key');
        return JSON.stringify({ reply: 'Recovered successfully Boss.' });
      }
      return JSON.stringify({ grade: 'A', lesson: 'ok' });
    };

    const { desk } = createDesk({ TRADING_MODE: 'PAPER' }, caller);

    // Call 1: Timeout failure
    mode = 'timeout';
    const resTimeout = await desk.command('Hello Lead', 'lead');
    expect(resTimeout.ok).toBe(false);
    expect(resTimeout.failureKind).toBe('timeout');
    expect(resTimeout.reply).toContain('timed out');

    // Call 2: Auth failure
    mode = 'auth';
    const resAuth = await desk.command('Hello Lead again', 'lead');
    expect(resAuth.ok).toBe(false);
    expect(resAuth.failureKind).toBe('auth');
    expect(resAuth.reply).toContain('authentication');

    // Call 3: Successful recovery
    mode = 'success';
    const resSuccess = await desk.command('Hello Lead final', 'lead');
    expect(resSuccess.ok).toBe(true);
    expect(resSuccess.failureKind).toBeUndefined();
    expect(resSuccess.reply).toContain('Recovered successfully Boss.');
  });

  it('enforces concise instructions and suppresses generic authorization boilerplate and em dashes', async () => {
    let capturedUser = '';
    const caller: ModelCaller = async (req) => {
      if (req.task === 'chat') {
        capturedUser = req.user;
        return JSON.stringify({ reply: 'Desk is operating smoothly.' });
      }
      return JSON.stringify({ grade: 'A', lesson: 'ok' });
    };

    const { desk } = createDesk({ TRADING_MODE: 'PAPER' }, caller);
    await desk.command('Give me an overview of operations', 'lead');

    // Verify instruction contains strict anti-boilerplate and no-em-dash rules
    expect(capturedUser).toContain('Provide concise, non-repetitive answers without authorization boilerplate');
    expect(capturedUser).toContain('Never use an em dash');
    expect(capturedUser).toContain('prefer the verified exchange snapshot and explicitly report the discrepancy');
  });

  it('preserves read-only chat boundaries when user asks questions about actions', async () => {
    const caller: ModelCaller = async (req) => {
      if (req.task === 'chat') {
        // Model attempts to propose an unauthorized command despite user only asking a question
        return JSON.stringify({
          reply: 'I think buying BTC is viable here.',
          commandToExecute: 'open long BTC'
        });
      }
      return JSON.stringify({ grade: 'A', lesson: 'ok' });
    };

    const { desk } = createDesk({ TRADING_MODE: 'PAPER' }, caller);
    const initialPositions = desk.book.positions.length;

    // User asks a question, not an execution instruction
    const res = await desk.command('What do you think about opening long BTC?', 'lead');
    expect(res.ok).toBe(false);
    expect(res.reply).toContain('No action executed: the proposed command did not match an explicit instruction in your current message.');
    expect(desk.book.positions).toHaveLength(initialPositions);

    // Another question
    const res2 = await desk.command('Can we close all positions now?', 'lead');
    expect(res2.ok).toBe(false);
    expect(res2.reply).toContain('No action executed');
  });
});
