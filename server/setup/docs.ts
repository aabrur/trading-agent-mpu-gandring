// Renders docs/setup/<venue>.md from the shared guide, so the docs, the CLI wizard and the office Setup wizard say the same thing.
// npm run docs:setup rewrites them; tests/setup-docs.test.ts fails if they are out of date.
import { EXCHANGES, type ExchangeName, type Network } from '../exchange/types.js';
import { VENUE_GUIDES, guideSteps, envFields, LINKS_CHECKED_ON, type GuideLink } from './guide.js';

const link = (l: GuideLink) => `[${l.label}](${l.url})${l.login ? ' (sign in / connect wallet first)' : ''}${l.note ? ` (${l.note})` : ''}`;

export function venueDoc(v: ExchangeName): string {
  const g = VENUE_GUIDES[v];
  const out: string[] = [
    `# ${g.label} setup (${g.kind}, ${g.status})`, '',
    '<!-- Generated from server/setup/guide.ts by `npm run docs:setup`. Edit the guide, not this file. -->', '',
    `Trading Agent Mpu Gandring trades ${g.label} perpetual futures with **your own** account and key. Start in PAPER, then TESTNET, LIVE last. Not financial advice.`, '',
    `- **Sign-in:** ${g.login}`,
    `- **Connect wallet in the office:** ${g.connectWallet ? 'yes. One wallet signature (MetaMask or Rabby) approves a fresh trade-only agent key made on your computer; nothing to copy. Local mode, office on 127.0.0.1.' : 'no, manual steps below.'}`,
    `- **Permissions ON:** ${g.permissionsOn.join('; ')}`,
    `- **Permissions OFF:** ${g.permissionsOff.join('; ')}`,
    `- **IP allowlist:** ${g.ip}`,
    ...(g.extra ? [`- **Note:** ${g.extra}`] : []), ''
  ];
  for (const net of ['testnet', 'mainnet'] as Network[]) {
    out.push(`## ${net === 'testnet' ? 'Testnet (test money, do this first)' : 'Mainnet (real money, for LIVE)'}`, '');
    if (g.networks[net].note) out.push(`> ${g.networks[net].note}`, '');
    guideSteps(v, net).forEach((s, i) => { out.push(`${i + 1}. **${s.title}.** ${s.text}${s.links.length ? ' ' + s.links.map(link).join(', ') : ''}`); });
    out.push('', '| .env name | What | Secret |', '| --- | --- | --- |', ...envFields(v, net).map((f) => `| \`${f.name}\` | ${f.label} | ${f.secret ? 'yes, hidden input only' : 'no (public)'} |`), '');
    out.push('Same steps in the terminal: `npm run setup` (or print them: `npm run setup -- guide ' + v + (net === 'mainnet' ? ' --network mainnet' : '') + '`), or in the office: **Setup** (top right).', '');
  }
  out.push('## Verify', '', '```bash', 'npm run doctor            # one harmless read: can trade, cannot withdraw', `npm run setup -- check-key --network testnet`, '```', '',
    'Then switch the mode (TESTNET, or LIVE with the typed confirmation) and restart. Watch the first order: its stop loss must show as an open trigger order on the venue. Every TESTNET/LIVE start checks the key again and refuses one that can withdraw.', '',
    '## Official docs', '', ...g.docs.map((d) => `- ${link(d)}`), '', `Links checked ${LINKS_CHECKED_ON}. Pages marked "sign in" need your login before they show the form. If a venue moves a page, tell us in an issue.`, '');
  return out.join('\n');
}

export function indexDoc(): string {
  const rows = EXCHANGES.map((v) => { const g = VENUE_GUIDES[v]; return `| [${g.label}](${v}.md) | ${g.kind} | ${g.status} | ${g.connectWallet ? 'Connect wallet (one signature) or manual' : 'manual key'} | ${link(g.networks.testnet.steps.find((s) => s.id === 'key')!.links[0] ?? g.docs[0])} | ${link(g.networks.mainnet.steps.find((s) => s.id === 'key')!.links[0] ?? g.docs[0])} |`; });
  return ['# Venue setup guides', '', '<!-- Generated from server/setup/guide.ts by `npm run docs:setup`. -->', '',
    'Pick one venue. Each guide has a testnet and a mainnet section with the direct links, the permissions to tick, the `.env` names and how to verify. The same steps run in `npm run setup` and in the office Setup wizard.', '',
    '| Venue | Kind | Adapter | Key path | Testnet key page | Mainnet key page |', '| --- | --- | --- | --- | --- | --- |', ...rows, '',
    'Rules for every venue: your own account and key; trade permission only; withdrawals and transfers off; never a main wallet private key or seed phrase; keys only in `.env` (or your platform secret store), never in a chat.', '',
    'No exchange here offers OAuth for a personal trading key: CEXes issue API keys, DEXes use your wallet to approve a delegated key.', ''].join('\n');
}
