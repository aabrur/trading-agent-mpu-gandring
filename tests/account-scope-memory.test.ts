import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Learnings } from '../server/learnings.js';

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
});
