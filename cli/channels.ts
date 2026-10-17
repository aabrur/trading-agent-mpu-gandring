// npm run channels -- status                 what is set for each chat channel (secrets shown as set/empty)
// npm run channels -- guide <channel>        the official links, step by step
// npm run channels -- setup <channel>        interactive: walk the steps, type the values (secrets hidden), save to .env (chmod 600)
// npm run channels -- test <channel>         send one test message
// npm run channels -- telegram-chats         after you message your bot: show the chat id and your user id
// npm run channels -- discord-commands       print the official request that registers the slash commands (you run it)
// Same shared module as the office Setup wizard (server/channels/*). Chat can never open orders, go LIVE, un-kill or change keys.
import { pathToFileURL } from 'node:url';
import { ask, askSecret, askYes, isInteractive } from './prompt.js';
import { setupEnv } from '../server/setup/core.js';
import { CHANNEL_GUIDES, NOT_SHIPPED, SUPERVISOR_ENV } from '../server/channels/guide.js';
import { CHANNELS, type ChannelName } from '../server/channels/config.js';
import { channelStatus, saveChannel, testChannel, telegramChats, isChannel, discordRegisterCommand } from '../server/channels/setup.js';
import { HELP_TEXT } from '../server/channels/commands.js';

const ENV_FILE = process.env.DOTENV_PATH || '.env';

export function printChannelGuide(ch: ChannelName) {
  const g = CHANNEL_GUIDES[ch];
  console.log(`\n${g.label}: ${g.official}\n  Posts: ${g.outbound}. Commands: ${g.inbound}.`);
  g.steps.forEach((st, i) => { console.log(`\n  ${i + 1}. ${st.title}\n     ${st.text}`); for (const l of st.links) console.log(`     -> ${l.label}: ${l.url}${l.login ? ' (sign in first)' : ''}`); });
  console.log(`\n  .env: ${g.fields.map((f) => f.env).join(', ')}`);
  for (const n of g.notes) console.log(`  Note: ${n}`);
}

/** Interactive channel setup. Used by npm run setup (wizard step) and npm run channels -- setup <channel>. */
export async function channelWizard(ch: ChannelName, envFile = ENV_FILE): Promise<boolean> {
  const g = CHANNEL_GUIDES[ch];
  console.log(`\n  ${g.label}: ${g.official}`);
  for (const [i, st] of g.steps.entries()) {
    console.log(`\n    Step ${i + 1}/${g.steps.length}: ${st.title}\n      ${st.text}`);
    for (const l of st.links) console.log(`      -> ${l.label}: ${l.url}${l.login ? ' (sign in first)' : ''}`);
    if (isInteractive() && i < g.steps.length - 1) await ask('      Enter for the next step');
  }
  const cur = setupEnv(envFile);
  const values: Record<string, string> = {};
  for (const f of g.fields) {
    if (f.env === 'TELEGRAM_CHAT_ID' && values.TELEGRAM_BOT_TOKEN && await askYes('    Read the chat id from your bot now? (send it a message first)', true)) {
      const r = await telegramChats(values.TELEGRAM_BOT_TOKEN);
      console.log(`      ${r.detail}`); for (const c of r.chats) console.log(`      chat id ${c.chatId} (${c.chat})  user id ${c.userId} (${c.user})`);
    }
    const label = `    ${f.env}${f.required ? '' : ' (optional)'} - ${f.label}${cur[f.env] ? ' (already set, Enter keeps it)' : ''}`;
    const v = f.secret ? await askSecret(label) : await ask(label, '');
    if (v) values[f.env] = v;
  }
  const commands = await askYes(`    Allow the safe chat commands (${'status, report, positions, kill'}) from the allowlisted ids?`, cur.CHANNEL_COMMANDS === 'on');
  const r = saveChannel(envFile, ch, values, { commands });
  console.log(`    ${r.ok ? 'Saved' : 'Not saved'}: ${r.detail}${r.saved ? ` (${r.saved.join(', ')})` : ''}`);
  if (r.ok && await askYes('    Send a test message now?', true)) console.log(`    ${(await testChannel(setupEnv(envFile), ch)).detail}`);
  if (r.ok && g.publicUrl && commands) console.log(`    Commands arrive on a separate webhook server: http://127.0.0.1:${cur.CHANNEL_WEBHOOK_PORT || 8788}/api/channels/${ch}. Point your HTTPS tunnel at that port only (docs/channels.md).`);
  return r.ok;
}

function status() {
  const s = channelStatus(setupEnv(ENV_FILE));
  console.log(`Chat commands: ${s.commands ? 'on (allowlisted ids only)' : 'off'}. Desk Lead: ${s.supervisor.on ? `on, every ${s.supervisor.intervalMin} min, alert cooldown ${s.supervisor.cooldownMin} min` : 'off (no channel set, or SUPERVISOR=off)'}.`);
  for (const c of s.channels) console.log(`  ${c.label.padEnd(9)} ${c.enabled ? 'posting' : 'not set'}${c.commandsReady ? ', commands ready' : ''}   ${c.fields.map((f) => `${f.env}=${f.set ? (f.shown ?? 'set') : 'empty'}`).join('  ')}`);
  console.log(`  MiChat    not shipped: ${NOT_SHIPPED.michat}\n  Email     not shipped: ${NOT_SHIPPED.email}`);
  for (const e of SUPERVISOR_ENV) console.log(`  ${e.env}: ${e.text}`);
}

async function main(argv: string[]) {
  const [sub = 'status', arg] = argv;
  const need = () => { if (!isChannel(arg)) { console.error(`usage: npm run channels -- ${sub} <${CHANNELS.join('|')}>`); process.exitCode = 1; return false; } return true; };
  switch (sub) {
    case 'status': return status();
    case 'guide': if (need()) printChannelGuide(arg as ChannelName); return;
    case 'setup': if (need()) await channelWizard(arg as ChannelName); return;
    case 'test': if (need()) { const r = await testChannel(setupEnv(ENV_FILE), arg as ChannelName); console.log(r.detail); process.exitCode = r.ok ? 0 : 1; } return;
    case 'telegram-chats': { const r = await telegramChats((setupEnv(ENV_FILE).TELEGRAM_BOT_TOKEN ?? '').trim()); console.log(r.detail); for (const c of r.chats) console.log(`  chat id ${c.chatId} (${c.chat})  user id ${c.userId} (${c.user})`); process.exitCode = r.ok ? 0 : 1; return; }
    case 'discord-commands': console.log('Run this yourself with your app id and bot token in your shell (never paste the token in chat):\n'); console.log(discordRegisterCommand()); return;
    case 'commands': console.log(HELP_TEXT); return;
    default: console.error(`unknown command ${sub}. Try: status, guide, setup, test, telegram-chats, discord-commands, commands`); process.exitCode = 1;
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2)).catch((e) => { console.error(`channels failed: ${(e as Error).message}`); process.exit(1); });
