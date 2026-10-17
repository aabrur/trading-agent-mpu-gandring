// npm run docs:setup  -> rewrites docs/setup/*.md from server/setup/guide.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { EXCHANGES } from '../server/exchange/types.js';
import { venueDoc, indexDoc } from '../server/setup/docs.js';
mkdirSync('docs/setup', { recursive: true });
for (const v of EXCHANGES) writeFileSync(`docs/setup/${v}.md`, venueDoc(v));
writeFileSync('docs/setup/README.md', indexDoc());
console.log('docs/setup written');
