import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../server/config.js';
import { Desk } from '../server/desk.js';
import { makeCaller } from '../server/providers/index.js';
import { rebuttalRounds } from '../server/decision/pace.js';
import { classifyHoldReason, HOLD_REASON, outcomeFor } from '../server/decision/reasons.js';
import { selectPreQuestions } from '../server/decision/evaluation.js';
import { loadJevSettings } from '../server/decision/jev.js';
import { saveJevSetup } from '../server/setup/jev.js';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { draftProfile } from '../server/trading-settings.js';
import { snapshotIsFresh, revalidateEntry } from '../server/decision/stale.js';
import { strategyVote } from '../server/strategy.js';
import { sampleCandles } from '../server/market/sample.js';

describe('decision pace', () => {
  it('keeps NORMAL rounds and one FAST challenge even when directional analysts agree', () => {
    expect(rebuttalRounds('normal', 2, { market: 'LONG', research: 'LONG', strategist: 'LONG', researchVote: 'LONG' })).toBe(2);
    expect(rebuttalRounds('normal', 2, { market: 'LONG', research: 'SHORT', strategist: 'LONG', researchVote: 'SHORT' })).toBe(2);
    expect(rebuttalRounds('fast', 2, { market: 'LONG', research: 'LONG', strategist: 'LONG', researchVote: 'LONG' })).toBe(1);
    expect(rebuttalRounds('fast', 2, { market: 'LONG', research: 'SHORT', strategist: 'LONG', researchVote: 'SHORT' })).toBe(1);
    expect(rebuttalRounds('fast', 2, { market: 'NEUTRAL', research: 'NEUTRAL', strategist: 'NEUTRAL', researchVote: 'ABSTAIN' })).toBe(0);
    expect(rebuttalRounds('fast', 2, { market: 'LONG', research: 'NEUTRAL', strategist: 'LONG', researchVote: 'VETO' })).toBe(0);
  });
});

describe('hold reasons', () => {
  it('maps stable reason codes and distinguishes HOLD from BLOCKED and FAILED', () => {
    expect(classifyHoldReason('Entry confidence 74.0% is below the configured 75% minimum.')).toBe(HOLD_REASON.LOW_CONFIDENCE);
    expect(classifyHoldReason('Daily loss stop is on (3% for today).')).toBe(HOLD_REASON.DAILY_LOSS_CAP);
    expect(classifyHoldReason('Stale signal: closed-bar rule flipped from LONG to SHORT.')).toBe(HOLD_REASON.STALE_SIGNAL);
    expect(classifyHoldReason('Risk rejected: verdict rejected.')).toBe(HOLD_REASON.RISK_REJECT);
    expect(outcomeFor({ action: 'HOLD', executed: false })).toBe('HOLD');
    expect(outcomeFor({ action: 'HOLD', executed: false, blocked: true })).toBe('BLOCKED');
    expect(outcomeFor({ action: 'OPEN_LONG', executed: false, failed: true })).toBe('FAILED');
    expect(outcomeFor({ action: 'OPEN_LONG', executed: false, reasonCode: HOLD_REASON.RISK_REJECT })).toBe('BLOCKED');
    expect(outcomeFor({ action: 'HOLD', executed: false, reasonCode: HOLD_REASON.RISK_REJECT })).toBe('BLOCKED');
    expect(outcomeFor({ action: 'OPEN_LONG', executed: true, executionStatus: 'filled' })).toBe('FILLED');
    expect(outcomeFor({ action: 'OPEN_LONG', executed: true, executionStatus: 'partial' })).toBe('PARTIAL');
  });
});

describe('Jev question selection', () => {
  it('skips news and whale questions when those feeds are absent', () => {
    const q = selectPreQuestions({ hasIndicators: true, hasNews: false, hasWhale: false });
    expect(q.market_regime).toBeTruthy();
    expect(q.news_relevant).toBeUndefined();
    expect(q.whale_significant).toBeUndefined();
    const missing = selectPreQuestions({ hasIndicators: false, hasNews: false, hasWhale: false });
    expect(JSON.stringify(missing.market_regime)).toContain('UNAVAILABLE');
  });
});

describe('Jev LIVE ASSIST authorization', () => {
  it('keeps LIVE assist as shadow until allowLive is set, then exposes assist', () => {
    const blocked = loadJevSettings({ JEV_ENABLED: 'true', JEV_MODE: 'assist', OPENROUTER_API_KEY: 'or-test-key', JEV_ALLOW_LIVE: 'false' }, 'LIVE');
    expect(blocked.mode).toBe('assist');
    expect(blocked.effectiveMode).toBe('shadow');
    const allowed = loadJevSettings({ JEV_ENABLED: 'true', JEV_MODE: 'assist', OPENROUTER_API_KEY: 'or-test-key', JEV_ALLOW_LIVE: 'yes' }, 'LIVE');
    expect(allowed.effectiveMode).toBe('assist');
  });

  it('persists LIVE ASSIST authorization without echoing the key', () => {
    const envFile = path.join(mkdtempSync(path.join(tmpdir(), 'mg-jev-live-')), '.env');
    saveJevSetup(envFile, { enabled: true, mode: 'assist', allowLive: true, key: 'jev-live-secret-value' });
    const text = readFileSync(envFile, 'utf8');
    expect(text).toMatch(/JEV_ALLOW_LIVE=yes/);
    expect(text).toMatch(/JEV_MODE=assist/);
    expect(JSON.stringify(loadJevSettings({ JEV_ENABLED: 'true', JEV_MODE: 'assist', JEV_ALLOW_LIVE: 'yes', JEV_OPENROUTER_API_KEY: 'jev-live-secret-value' }, 'LIVE'))).not.toContain('jev-live-secret-value');
  });
});

describe('profile draft selection', () => {
  it('maps saved profit to the profit dropdown, never current to a hidden value', () => {
    expect(draftProfile('profit')).toBe('profit');
    expect(draftProfile('current')).toBe('manual');
  });
});

describe('FAST debate and SHADOW Jev', () => {
  it('runs one FAST challenge round and the configured NORMAL rounds for aligned analysts', async () => {
    const env = { TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEBATE_PACE_MS: '0', DEBATE_MODE: 'fast' };
    const c = loadConfig(env);
    expect(c.debate.mode).toBe('fast');
    const base = makeCaller(c);
    const caller = vi.fn((r: Parameters<typeof base>[0]) => base(r));
    const desk = new Desk(c, caller, { reportsDir: null });
    const v = await desk.runDebate('ETHUSDT');
    expect(['OPEN_LONG', 'OPEN_SHORT', 'CLOSE', 'HOLD']).toContain(v.action);
    expect(v.timing?.total).toBeGreaterThan(0);
    const rebuttals = caller.mock.calls.filter(([r]) => r.task === 'rebuttal').length;
    const normal = loadConfig({ ...env, DEBATE_MODE: 'normal' });
    const nCaller = vi.fn((r: Parameters<typeof base>[0]) => makeCaller(normal)(r));
    const nDesk = new Desk(normal, nCaller, { reportsDir: null });
    await nDesk.runDebate('ETHUSDT');
    const normalRebuttals = nCaller.mock.calls.filter(([r]) => r.task === 'rebuttal').length;
    expect(rebuttals).toBe(3);
    expect(normalRebuttals).toBe(3 * normal.debate.rounds);
  });

  it('does not block SHADOW Jev on verdict generation', async () => {
    let release!: (v: Response) => void;
    const pending = new Promise<Response>((r) => { release = r; });
    const fetchImpl = vi.fn(async () => pending);
    const env = { TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEBATE_PACE_MS: '0', JEV_ENABLED: 'true', JEV_MODE: 'shadow', OPENROUTER_API_KEY: 'or-shadow-test-key' };
    const c = loadConfig(env);
    const desk = new Desk(c, makeCaller(c), { reportsDir: null, jevFetch: fetchImpl as unknown as typeof fetch, jevEnv: env });
    const v = await desk.runDebate('ETHUSDT');
    expect(['OPEN_LONG', 'OPEN_SHORT', 'CLOSE', 'HOLD']).toContain(v.action);
    expect(fetchImpl).toHaveBeenCalled();
    release(new Response(JSON.stringify({
      model: 'typesafe/jev-1.14-test',
      answers: { market_regime: { type: 'choice', choice: 'RANGING', probabilities: { RANGING: 1 }, confidence: 0.4 } }
    }), { status: 200 }));
    await desk.jev.flush();
    expect(JSON.stringify(desk.jevLast ?? desk.jev.status())).not.toContain('or-shadow-test-key');
  });
});

describe('stale signal revalidation', () => {
  it('rejects entries when the snapshot is stale and the closed-bar rule flips', () => {
    const now = Date.now();
    const candles = sampleCandles('ETHUSDT').map((c, index) => ({ ...c, c: 100 + index }));
    const last = candles.at(-1)!.c;
    const original = {
      symbol: 'ETHUSDT', source: 'sample' as const, example: true, last, change24hPct: 0, fundingRate: null,
      bid: last, ask: last, candles, fetchedAt: now - 30_001
    };
    expect(snapshotIsFresh(original, now)).toBe(false);
    expect(snapshotIsFresh({ ...original, fetchedAt: now - 30_000 }, now)).toBe(true);
    const originalRule = strategyVote(candles);
    expect(originalRule.side).toBe('LONG');
    const flipped = candles.map((c, i) => ({ ...c, c: 500 - i }));
    const fresh = { ...original, fetchedAt: Date.now(), candles: flipped, last: flipped.at(-1)!.c, bid: flipped.at(-1)!.c, ask: flipped.at(-1)!.c };
    const side = originalRule.side === 'SHORT' ? 'SHORT' : 'LONG';
    const result = revalidateEntry({ original, originalRule: { ...originalRule, side }, side, fresh });
    expect(strategyVote(flipped).side).toBe('SHORT');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Hard reversal/);
    expect(revalidateEntry({ original, originalRule, side, fresh: { ...original, fetchedAt: Date.now(), ask: 0, bid: 0, last: 0 } }).ok).toBe(false);
  });
});
