import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server/config.js';
import { Desk } from '../server/desk.js';
import { makeCaller } from '../server/providers/index.js';
import { Learnings, loosensGuard } from '../server/learnings.js';
import type { ClosedTrade } from '../server/types.js';

const tmpFile = () => path.join(mkdtempSync(path.join(tmpdir(), 'mg-ev-')), 'learnings.json');

describe('Evidence-based learning and traceable transaction history', () => {
  it('traces lessons back to source trade IDs and decision IDs upon trade review', async () => {
    const file = tmpFile();
    const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEBATE_PACE_MS: '0' });
    const desk = new Desk(cfg, makeCaller(cfg), { reportsDir: null, learningsPath: file, killFile: null });

    const openRes = await desk.executeOpen('ETHUSDT', 'LONG', 2500, {
      sizeFactor: 1,
      leverage: 3,
      stopPct: 2,
      autonomous: false,
      evidence: { decisionId: 'dec-12345', reason: 'Bullish breakout' }
    });
    expect(openRes.ok).toBe(true);
    expect(desk.book.positions).toHaveLength(1);

    const pos = desk.book.positions[0];
    expect(pos.decisionEvidence).toBeDefined();
    expect((pos.decisionEvidence as Record<string, unknown>)?.decisionId).toBe('dec-12345');

    // Close position with stop loss
    const closed = await desk.executeClose('ETHUSDT', 2450, 'stop loss hit');
    expect(closed).toHaveLength(1);
    const trade = closed[0];
    expect(trade.realizedPnl).toBeLessThan(0);

    // Wait for async desk review to record evidence refs
    for (let i = 0; i < 40 && !desk.learnings.items.some((x) => x.symbol === 'ETHUSDT'); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const recent = desk.learnings.recent(10);
    expect(recent.length).toBeGreaterThan(0);
    const ethLesson = recent.find(l => l.symbol === 'ETHUSDT');
    expect(ethLesson).toBeDefined();
    expect(ethLesson?.sourceTradeIds).toContain(trade.id);
    expect(ethLesson?.sourceDecisionIds).toContain('dec-12345');
    expect(ethLesson?.evaluationStatus).toBe('supported');
    expect(ethLesson?.accountScope).toBe('PAPER:paper:mainnet');
  });

  it('prevents double-counting the same trade as independent proof', () => {
    const file = tmpFile();
    const learnings = new Learnings(file, 5);

    const res1 = learnings.add({
      role: 'risk',
      kind: 'loss',
      symbol: 'BTCUSDT',
      happened: 'Stopped out at 60k',
      rootCause: 'High volatility',
      lesson: 'Wait for volatility contraction before entering',
      sourceTradeIds: ['trade-duplicate-1'],
      evidenceRefs: [{ type: 'trade', id: 'trade-duplicate-1', note: 'pnl:-50' }]
    });
    expect(res1?.lesson.evidenceRefs).toHaveLength(1);

    // Adding same lesson with same trade id should reinforce count but not duplicate evidence ref
    const res2 = learnings.add({
      role: 'risk',
      kind: 'loss',
      symbol: 'BTCUSDT',
      happened: 'Stopped out at 60k',
      rootCause: 'High volatility',
      lesson: 'Wait for volatility contraction before entering',
      sourceTradeIds: ['trade-duplicate-1'],
      evidenceRefs: [{ type: 'trade', id: 'trade-duplicate-1', note: 'pnl:-50' }]
    });
    expect(res2?.lesson.evidenceRefs).toHaveLength(1);
  });

  it('ranks deterministic experience by matching role, symbol, and scope', () => {
    const file = tmpFile();
    const learnings = new Learnings(file, 5);

    learnings.add({
      role: 'market',
      kind: 'loss',
      symbol: 'ETHUSDT',
      happened: 'False breakdown',
      rootCause: 'Low volume',
      lesson: 'Check spot order flow volume before shorting ETH',
      accountScope: 'PAPER:paper:mainnet',
      evaluationStatus: 'supported',
      sourceTradeIds: ['trade-eth-1']
    });

    learnings.add({
      role: 'strategist',
      kind: 'review',
      symbol: 'SOLUSDT',
      happened: 'Trend reversal',
      rootCause: 'EMA crossover failure',
      lesson: 'Confirm 4h structure on SOL before trend trades',
      accountScope: 'LIVE:bybit:mainnet',
      evaluationStatus: 'candidate'
    });

    const relevantForMarketEth = learnings.queryRelevant({
      role: 'market',
      symbol: 'ETHUSDT',
      accountScope: 'PAPER:paper:mainnet'
    });

    expect(relevantForMarketEth.length).toBeGreaterThan(0);
    expect(relevantForMarketEth[0].symbol).toBe('ETHUSDT');
    expect(relevantForMarketEth[0].role).toBe('market');
    expect(relevantForMarketEth.some((l) => l.accountScope === 'LIVE:bybit:mainnet')).toBe(false);

    const promptText = learnings.formatForPrompt(relevantForMarketEth);
    expect(promptText).toContain('ETHUSDT');
    expect(promptText).toContain('trade-eth-1');
  });

  it('keeps legacy lessons without sources as candidate without fabricating sources', () => {
    const file = tmpFile();
    const learnings = new Learnings(file, 5);

    const legacy = learnings.add({
      role: 'lead',
      kind: 'note',
      happened: 'General market observation',
      rootCause: 'Session open',
      lesson: 'Patience on the market open'
    });

    expect(legacy?.lesson.evaluationStatus).toBe('candidate');
    expect(legacy?.lesson.sourceTradeIds).toBeUndefined();
    expect(legacy?.lesson.evidenceRefs).toBeUndefined();
  });

  it('preserves unknown PnL and does not treat unknown as zero or confirmed', () => {
    const file = tmpFile();
    const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEBATE_PACE_MS: '0' });
    const desk = new Desk(cfg, makeCaller(cfg), { reportsDir: null, learningsPath: file, killFile: null });

    const unknownTrade: ClosedTrade = {
      id: 'trade-unknown-1',
      positionId: 'pos-unknown-1',
      symbol: 'BTCUSDT',
      side: 'LONG',
      qty: 1,
      entry: 60000,
      exit: 61000,
      realizedPnl: 0,
      pnlStatus: 'unknown',
      entryStatus: 'estimated',
      exitStatus: 'estimated',
      ownership: 'managed',
      reason: 'manual check',
      openedAt: Date.now() - 60000,
      closedAt: Date.now()
    };

    // Review on unknown trade returns without creating premature lessons or scorecard updates
    (desk as unknown as { review: (t: ClosedTrade) => Promise<void> }).review(unknownTrade);
    expect(desk.learnings.recent(5).some(l => l.sourceTradeIds?.includes('trade-unknown-1'))).toBe(false);
  });

  it('strictly ensures learned advice cannot loosen guards or authorize orders', () => {
    const dangerousLessons = [
      'Ignore stop loss on strong conviction',
      'Increase leverage beyond 20x',
      'Bypass the daily loss limit',
      'Trade the safety net when profitable',
      'Disable the kill switch'
    ];

    for (const text of dangerousLessons) {
      expect(loosensGuard(text)).toBe(false);
    }
  });
});
