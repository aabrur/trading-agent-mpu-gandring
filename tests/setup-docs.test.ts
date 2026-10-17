// docs/setup/*.md must match the shared guide (the CLI and office use the same data). Run `npm run docs:setup` after editing it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { EXCHANGES } from '../server/exchange/types.js';
import { venueDoc, indexDoc } from '../server/setup/docs.js';

describe('setup docs are generated from the guide', () => {
  it('every venue doc and the index are up to date', () => {
    for (const v of EXCHANGES) expect(readFileSync(`docs/setup/${v}.md`, 'utf8'), `docs/setup/${v}.md is stale: npm run docs:setup`).toBe(venueDoc(v));
    expect(readFileSync('docs/setup/README.md', 'utf8')).toBe(indexDoc());
  });
});
