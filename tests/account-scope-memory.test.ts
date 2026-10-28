import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Learnings, lessonInScope } from '../server/learnings.js';
import { Desk } from '../server/desk.js';
import { loadConfig } from '../server/config.js';
import { planOrder } from '../server/money.js';

const file = () => path.join(mkdtempSync(path.join(tmpdir(), 'mg-scope-')), 'learnings.json');

describe('account-scope memory isolation', () => {
  it('keeps promoted PAPER lessons out of LIVE standing rules, prompts, and recent memory', () => {
    const learnings = new Learnings(file(), 1);
    learnings.add({ role: 'market', kind: 'note', happened: 'paper', rootCause: 'sim', lesson: 'Paper-only tape rule', accountScope: 'PAPER:paper:mainnet' });
    learnings.add({ role: 'market', kind: 'note', happened: 'live', rootCause: 'venue', lesson: 'Live tape rule', accountScope: 'LIVE:bybit:mainnet' });
    learnings.add({ role: 'market', kind: 'note', happened: 'general', rootCause: 'legacy', lesson: 'Unscoped tape rule' });
    learnings.add({ role: 'market', kind: 'note', happened: 'paper draft', rootCause: 'sim', lesson: 'Paper draft', accountScope: 'PAPER:paper:mainnet', evaluationStatus: 'disputed' });
    learnings.add({ role: 'market', kind: 'note', happened: 'live draft', rootCause: 'venue', lesson: 'Live draft', accountScope: 'LIVE:bybit:mainnet', evaluationStatus: 'disputed' });

    const liveRules = learnings.standingRules('market', 'LIVE:bybit:mainnet').map((l) => l.lesson);
    expect(liveRules).toEqual(['Live tape rule']);
    expect(liveRules).not.toContain('Unscoped tape rule');
    expect(learnings.queryRelevant({ role: 'market', accountScope: 'LIVE:bybit:mainnet' }).some((l) => l.accountScope === 'PAPER:paper:mainnet')).toBe(false);
    const liveDrafts = learnings.forRole('market', 5, 'LIVE:bybit:mainnet').join('\n');
    expect(liveDrafts).toContain('Live draft');
    expect(liveDrafts).not.toContain('Paper draft');
    expect(learnings.recent(10, 'LIVE:bybit:mainnet').some((l) => l.accountScope === 'PAPER:paper:mainnet')).toBe(false);
    expect(learnings.since(0, 'PAPER:paper:mainnet').map((l) => l.lesson)).toEqual(['Paper draft', 'Unscoped tape rule', 'Paper-only tape rule']);
  });

  it('isolates two different Aster LIVE accounts on the same network', () => {
    const learnings = new Learnings(file(), 1);
    const scopeA = 'LIVE:aster:mainnet:0x1111111111111111111111111111111111111111';
    const scopeB = 'LIVE:aster:mainnet:0x2222222222222222222222222222222222222222';

    learnings.add({ role: 'risk', kind: 'loss', happened: 'slip on A', rootCause: 'liquidity', lesson: 'Account A risk rule', accountScope: scopeA });
    learnings.add({ role: 'risk', kind: 'loss', happened: 'slip on B', rootCause: 'liquidity', lesson: 'Account B risk rule', accountScope: scopeB });

    const rulesA = learnings.standingRules('risk', scopeA).map(l => l.lesson);
    const rulesB = learnings.standingRules('risk', scopeB).map(l => l.lesson);

    expect(rulesA).toContain('Account A risk rule');
    expect(rulesA).not.toContain('Account B risk rule');

    expect(rulesB).toContain('Account B risk rule');
    expect(rulesB).not.toContain('Account A risk rule');

    const relevantA = learnings.queryRelevant({ role: 'risk', accountScope: scopeA }).map(l => l.lesson);
    expect(relevantA).toContain('Account A risk rule');
    expect(relevantA).not.toContain('Account B risk rule');

    const recentB = learnings.recent(10, scopeB).map(l => l.lesson);
    expect(recentB).toContain('Account B risk rule');
    expect(recentB).not.toContain('Account A risk rule');
  });

  it('proves multi-dimensional isolation: Bybit vs Aster, PAPER vs LIVE, TESTNET vs LIVE', () => {
    const learnings = new Learnings(file(), 1);
    const bybitLive = 'LIVE:bybit:mainnet:user123';
    const asterLive = 'LIVE:aster:mainnet:0x1111111111111111111111111111111111111111';
    const asterTestnet = 'TESTNET:aster:testnet:0x1111111111111111111111111111111111111111';
    const paper = 'PAPER:paper:mainnet';

    learnings.add({ role: 'lead', kind: 'note', happened: 'bybit', rootCause: 'cex', lesson: 'Bybit live rule', accountScope: bybitLive });
    learnings.add({ role: 'lead', kind: 'note', happened: 'aster', rootCause: 'dex', lesson: 'Aster live rule', accountScope: asterLive });
    learnings.add({ role: 'lead', kind: 'note', happened: 'testnet', rootCause: 'test', lesson: 'Aster testnet rule', accountScope: asterTestnet });
    learnings.add({ role: 'lead', kind: 'note', happened: 'paper', rootCause: 'sim', lesson: 'Paper rule', accountScope: paper });
    learnings.add({ role: 'lead', kind: 'note', happened: 'legacy', rootCause: 'none', lesson: 'Legacy unscoped rule' });

    // Aster LIVE gets only Aster LIVE
    const asterLiveRules = learnings.standingRules('lead', asterLive).map(l => l.lesson);
    expect(asterLiveRules).toEqual(['Aster live rule']);

    // Bybit LIVE gets only Bybit LIVE
    const bybitLiveRules = learnings.standingRules('lead', bybitLive).map(l => l.lesson);
    expect(bybitLiveRules).toEqual(['Bybit live rule']);

    // TESTNET gets only TESTNET
    const testnetRules = learnings.standingRules('lead', asterTestnet).map(l => l.lesson);
    expect(testnetRules).toEqual(['Aster testnet rule']);

    // PAPER sees PAPER and legacy unscoped
    const paperRules = learnings.standingRules('lead', paper).map(l => l.lesson);
    expect(paperRules).toContain('Paper rule');
    expect(paperRules).toContain('Legacy unscoped rule');
    expect(paperRules).not.toContain('Aster live rule');
    expect(paperRules).not.toContain('Bybit live rule');
  });

  it('treats missing account identity as explicitly UNKNOWN and refuses historical contamination', () => {
    const learnings = new Learnings(file(), 1);
    const unknownScope1 = 'LIVE:aster:mainnet:UNKNOWN';
    const unknownScope2 = 'LIVE:aster:mainnet:UNKNOWN';
    const unverifiedScope = 'LIVE:aster:mainnet:UNVERIFIED';

    learnings.add({ role: 'market', kind: 'note', happened: 'unverified trade', rootCause: 'unknown', lesson: 'Unverified lesson', accountScope: unknownScope1 });

    // UNKNOWN or UNVERIFIED scopes never match in lessonInScope
    expect(lessonInScope(unknownScope1, unknownScope2)).toBe(false);
    expect(lessonInScope(unknownScope1, 'LIVE:aster:mainnet:0x1111111111111111111111111111111111111111')).toBe(false);
    expect(lessonInScope(unverifiedScope, 'LIVE:aster:mainnet:0x1111111111111111111111111111111111111111')).toBe(false);
    expect(lessonInScope('LIVE:aster:mainnet:0x1111111111111111111111111111111111111111', unknownScope1)).toBe(false);

    // Standing rules and queryRelevant return empty for UNKNOWN
    expect(learnings.standingRules('market', unknownScope1)).toHaveLength(0);
    expect(learnings.queryRelevant({ role: 'market', accountScope: unknownScope1 })).toHaveLength(0);
    expect(learnings.recent(10, unknownScope1)).toHaveLength(0);
  });

  it('derives identity only from verified nonsecret public account information', () => {
    const cfg = loadConfig({ TRADING_MODE: 'PAPER' });
    const desk = new Desk(cfg, async () => '{}', { reportsDir: null });
    desk.cfg.tradingMode = 'LIVE';
    desk.cfg.exchange.name = 'aster';
    desk.cfg.live = { network: 'mainnet', exchange: 'aster' };

    // 1. AsterAdapter with public 0x user address
    const asterFake = {
      name: 'aster',
      network: 'mainnet',
      userAddress: '0x1234567890123456789012345678901234567890',
      publicAccountId: '0x1234567890123456789012345678901234567890'
    };
    desk.opts.executor = { adapter: asterFake } as any;
    expect(desk.accountScope()).toBe('LIVE:aster:mainnet:0x1234567890123456789012345678901234567890');

    // 2. Missing public identity falls back to UNKNOWN, never secret key slice or default
    const secretFake = {
      name: 'bybit',
      network: 'mainnet',
      key: 'secret_api_key_that_must_never_be_sliced'
    };
    desk.cfg.exchange.name = 'bybit';
    desk.opts.executor = { adapter: secretFake } as any;
    expect(desk.accountScope()).toBe('LIVE:bybit:mainnet:UNKNOWN');
    expect(desk.accountScope()).not.toContain('secret_api_key');
    expect(desk.accountScope()).not.toContain('default');
  });

  it('executes genuinely exchange-valid near-minimum order without learned HOLD rejection', () => {
    // Valid near-minimum order: satisfies minQty and minNotional, capital is within headroom
    const validPlan = planOrder({
      balance: 1000,
      safetyNet: 200,
      n: 4,
      openPositions: 0,
      usedMargin: 0,
      price: 100,
      side: 'LONG',
      sizeFactor: 1,
      leverage: 5,
      rules: {
        qtyStep: 0.01,
        minQty: 0.1,
        minNotional: 10,
        tickSize: 0.1,
        source: 'exchange'
      },
      adjustToVenueMinimum: true,
      minOrderUsdt: 10,
      maxOrderUsdt: 500,
      stopPct: 2
    });

    expect(validPlan.ok).toBe(true);
    if (validPlan.ok) {
      expect(validPlan.qty).toBeGreaterThanOrEqual(0.1);
      expect(validPlan.qty * 100).toBeGreaterThanOrEqual(10);
    }

    // Genuinely invalid order: below exchange minQty and capital cannot support minQty
    const invalidPlan = planOrder({
      balance: 205, // Headroom = 5 USDT
      safetyNet: 200,
      n: 4,
      openPositions: 0,
      usedMargin: 0,
      price: 1000,
      side: 'LONG',
      sizeFactor: 1,
      leverage: 1,
      rules: {
        qtyStep: 0.1,
        minQty: 1.0, // Needs 1000 USDT minimum
        minNotional: 1000,
        tickSize: 1,
        source: 'exchange'
      },
      adjustToVenueMinimum: true,
      minOrderUsdt: 10,
      maxOrderUsdt: 500,
      stopPct: 2
    });

    expect(invalidPlan.ok).toBe(false);
    expect(invalidPlan.reason).toMatch(/below the minimum quantity|Money Trade/i);
  });
});
