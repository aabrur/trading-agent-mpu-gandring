// Chat channel setup data, shared by the CLI (npm run setup -- channel <name>), the office Setup wizard and docs/channels.md.
// Official paths only. Links checked on LINKS_CHECKED_ON; `login: true` means the page needs you to sign in first.
import type { ChannelName } from './config.js';

export const CHANNEL_LINKS_CHECKED_ON = '2026-10-17';
export interface ChLink { label: string; url: string; login?: boolean }
export interface ChField { env: string; label: string; secret: boolean; required: boolean; pattern: RegExp; hint: string }
export interface ChStep { title: string; text: string; links: ChLink[] }
export interface ChannelGuide { label: string; official: string; outbound: string; inbound: string; publicUrl: boolean; fields: ChField[]; steps: ChStep[]; notes: string[]; docs: ChLink[] }

const IDS = /^(\+?\d{3,20})([\s,]+\+?\d{3,20})*$/;
export const CHANNEL_GUIDES: Record<ChannelName, ChannelGuide> = {
  telegram: {
    label: 'Telegram', official: 'Telegram Bot API, bot created with @BotFather',
    outbound: 'sendMessage to your chat', inbound: 'long polling (getUpdates): no public URL needed', publicUrl: false,
    fields: [
      { env: 'TELEGRAM_BOT_TOKEN', label: 'Bot token from BotFather', secret: true, required: true, pattern: /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/, hint: 'looks like 123456789:AA...' },
      { env: 'TELEGRAM_CHAT_ID', label: 'Chat id where the desk posts', secret: false, required: true, pattern: /^-?\d{3,20}$/, hint: 'a number; groups start with -' },
      { env: 'TELEGRAM_ALLOWED_USER_IDS', label: 'User ids allowed to send commands (comma separated)', secret: false, required: false, pattern: IDS, hint: 'your numeric Telegram user id; empty = nobody can command' }
    ],
    steps: [
      { title: 'Create the bot', text: 'Open @BotFather in Telegram, send /newbot, pick a name and a username ending in "bot". BotFather replies with the bot token. Treat it like a password.', links: [{ label: 'Open @BotFather', url: 'https://t.me/BotFather' }, { label: 'BotFather guide', url: 'https://core.telegram.org/bots/features#botfather' }] },
      { title: 'Say hello to your bot', text: 'Open your new bot in Telegram and send it any message (or add it to a group and send a message there). Then use "Find my chat id" (office) or npm run channels -- telegram-chats (CLI) to read the chat id and your user id.', links: [{ label: 'getUpdates (how the id is read)', url: 'https://core.telegram.org/bots/api#getupdates' }] }
    ],
    notes: ['Commands work only from TELEGRAM_CHAT_ID and only from a user id in TELEGRAM_ALLOWED_USER_IDS.', 'getUpdates does not work while a webhook is set on the same bot, or while another program polls it.'],
    docs: [{ label: 'Bot API', url: 'https://core.telegram.org/bots/api' }, { label: 'From BotFather to Hello World', url: 'https://core.telegram.org/bots/tutorial' }]
  },
  discord: {
    label: 'Discord', official: 'Discord Bot API and Gateway; signed HTTP interactions remain supported',
    outbound: 'Bot API or existing webhook', inbound: 'Gateway locally; signed HTTP when configured on the application', publicUrl: false,
    fields: [
      { env: 'DISCORD_BOT_TOKEN', label: 'Bot Token', secret: true, required: false, pattern: /^[A-Za-z0-9._-]{20,400}$/, hint: 'Developer Portal, Bot, Reset Token' },
      ...['CHANNEL_ID', 'GUILD_ID', 'APPLICATION_ID'].map(key => ({ env: `DISCORD_${key}`, label: key, secret: false, required: false, pattern: /^\d{3,25}$/, hint: 'Selected during bot setup' })),
      { env: 'DISCORD_DELIVERY', label: 'Interaction delivery', secret: false, required: false, pattern: /^(gateway|http)$/, hint: 'Determined from the application endpoint' },
      { env: 'DISCORD_WEBHOOK_URL', label: 'Channel webhook URL', secret: true, required: false, pattern: /^https:\/\/(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\/\d+\/[\w-]+$/, hint: 'https://discord.com/api/webhooks/...' },
      { env: 'DISCORD_PUBLIC_KEY', label: 'App public key (General Information), for commands', secret: false, required: false, pattern: /^[0-9a-fA-F]{64}$/, hint: '64 hex characters; empty = no commands' },
      { env: 'DISCORD_ALLOWED_USER_IDS', label: 'User IDs for Direct Message (DM) & commands', secret: false, required: false, pattern: IDS, hint: 'Developer Mode on, right click your name, Copy User ID' }
    ],
    steps: [
      { title: 'Create a channel webhook', text: 'In your server: Edit Channel, Integrations, Webhooks, New Webhook, Copy Webhook URL. Anyone with this URL can post to the channel, so keep it secret.', links: [{ label: 'Webhook docs', url: 'https://docs.discord.com/developers/resources/webhook' }, { label: 'Intro to Webhooks (help center, opens in a browser)', url: 'https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks' }] },
      { title: 'Optional: slash commands', text: 'Create an application and bot in the Developer Portal. Enter its Bot Token in the masked input, validate it, install it in your server, then select a server and channel. Save automatically synchronizes /mpu. Gateway mode needs no public tunnel. Existing HTTP Interactions Endpoints keep their configured delivery.', links: [{ label: 'Developer Portal', url: 'https://discord.com/developers/applications', login: true }, { label: 'Interactions overview', url: 'https://docs.discord.com/developers/interactions/overview' }, { label: 'Application commands', url: 'https://docs.discord.com/developers/interactions/application-commands' }] }
    ],
    notes: ['Every interaction is checked against the Ed25519 signature; bad signatures get 401.', 'Commands are obeyed only from user ids in DISCORD_ALLOWED_USER_IDS.'],
    docs: [{ label: 'Receiving and responding', url: 'https://docs.discord.com/developers/interactions/receiving-and-responding' }]
  },
  slack: {
    label: 'Slack', official: 'Slack app with an Incoming Webhook (posts) and a slash command (commands)',
    outbound: 'incoming webhook', inbound: 'slash command to a signed Request URL (signing secret): needs a public HTTPS URL', publicUrl: true,
    fields: [
      { env: 'SLACK_WEBHOOK_URL', label: 'Incoming webhook URL', secret: true, required: true, pattern: /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+$/, hint: 'https://hooks.slack.com/services/...' },
      { env: 'SLACK_SIGNING_SECRET', label: 'Signing secret (Basic Information), for commands', secret: true, required: false, pattern: /^[0-9a-f]{20,64}$/i, hint: 'empty = no commands' },
      { env: 'SLACK_ALLOWED_USER_IDS', label: 'Member ids allowed to send commands', secret: false, required: false, pattern: /^U[A-Z0-9]{6,20}([\s,]+U[A-Z0-9]{6,20})*$/, hint: 'profile, More, Copy member ID (U...)' }
    ],
    steps: [
      { title: 'Create a Slack app', text: 'Create New App, From scratch, pick your workspace.', links: [{ label: 'Your apps', url: 'https://api.slack.com/apps', login: true }, { label: 'Creating an app', url: 'https://docs.slack.dev/app-management/quickstart-app-settings/' }] },
      { title: 'Turn on Incoming Webhooks', text: 'Features, Incoming Webhooks, On, Add New Webhook to Workspace, choose the channel, copy the URL.', links: [{ label: 'Incoming webhooks', url: 'https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/' }] },
      { title: 'Optional: slash command', text: 'Features, Slash Commands, Create New Command "/desk" with Request URL https://<your public host>/api/channels/slack. Copy the Signing Secret from Basic Information.', links: [{ label: 'Slash commands', url: 'https://docs.slack.dev/interactivity/implementing-slash-commands/' }, { label: 'Verifying requests', url: 'https://docs.slack.dev/authentication/verifying-requests-from-slack/' }] }
    ],
    notes: ['Each request is checked with the signing secret (HMAC-SHA256) and must be under 5 minutes old.', 'Commands are obeyed only from member ids in SLACK_ALLOWED_USER_IDS.'],
    docs: [{ label: 'Slack developer docs', url: 'https://docs.slack.dev/' }]
  },
  whatsapp: {
    label: 'WhatsApp', official: 'Meta WhatsApp Business Platform, Cloud API (no unofficial WhatsApp Web libraries)',
    outbound: 'Cloud API /messages', inbound: 'Meta webhook (X-Hub-Signature-256 with the app secret): needs a public HTTPS URL', publicUrl: true,
    fields: [
      { env: 'WHATSAPP_ACCESS_TOKEN', label: 'Access token (system user token for long term use)', secret: true, required: true, pattern: /^[A-Za-z0-9_-]{40,600}$/, hint: 'from WhatsApp, API Setup, or a system user' },
      { env: 'WHATSAPP_PHONE_NUMBER_ID', label: 'Phone number ID (not the phone number)', secret: false, required: true, pattern: /^\d{6,25}$/, hint: 'WhatsApp, API Setup' },
      { env: 'WHATSAPP_TO', label: 'Your WhatsApp number to receive alerts', secret: false, required: true, pattern: /^\+?\d{6,18}$/, hint: 'country code, digits only' },
      { env: 'WHATSAPP_TEMPLATE_NAME', label: 'Approved template for alerts (one {{1}} body parameter)', secret: false, required: false, pattern: /^[a-z0-9_]{1,512}$/, hint: 'needed outside the 24 hour window' },
      { env: 'WHATSAPP_APP_SECRET', label: 'App secret (App settings, Basic), for commands', secret: true, required: false, pattern: /^[0-9a-f]{32}$/i, hint: 'empty = no commands' },
      { env: 'WHATSAPP_VERIFY_TOKEN', label: 'Webhook verify token (any random string you choose)', secret: true, required: false, pattern: /^[\x21-\x7e]{16,128}$/, hint: '16+ characters' },
      { env: 'WHATSAPP_ALLOWED_NUMBERS', label: 'Numbers allowed to send commands', secret: false, required: false, pattern: IDS, hint: 'country code, digits only' }
    ],
    steps: [
      { title: 'Create a Meta app with WhatsApp', text: 'Create an app (Business type) and add the WhatsApp product. API Setup gives a test business number, its Phone number ID and a temporary token; add your own number as a test recipient.', links: [{ label: 'Meta apps', url: 'https://developers.facebook.com/apps', login: true }, { label: 'Get started with the Cloud API', url: 'https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started' }] },
      { title: 'Long term token', text: 'The temporary token expires quickly. Create a system user in Business settings and generate a token with whatsapp_business_messaging.', links: [{ label: 'System users', url: 'https://business.facebook.com/settings/system-users', login: true }] },
      { title: 'Business verification and your own number', text: 'For a real business number, verify your business in Meta Business Suite. The number must receive an SMS or voice code, and once registered it cannot be used in the WhatsApp app at the same time. New business portfolios start with up to two registered numbers.', links: [{ label: 'Verify your business', url: 'https://www.facebook.com/business/help/2058515294227817' }, { label: 'Business phone numbers', url: 'https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers' }] },
      { title: 'Template for alerts', text: 'Free text only reaches you within 24 hours of your last message to the business number. For alerts at any time, create a Utility template with one body parameter {{1}} and set WHATSAPP_TEMPLATE_NAME.', links: [{ label: 'Templates', url: 'https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview' }, { label: 'Pricing', url: 'https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing' }] },
      { title: 'Optional: commands', text: 'In WhatsApp, Configuration, set the Callback URL to https://<your public host>/api/channels/whatsapp, the Verify token to WHATSAPP_VERIFY_TOKEN, and subscribe to "messages".', links: [{ label: 'Webhooks', url: 'https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview' }] }
    ],
    notes: ['Meta charges per template message; check pricing for your country.', 'Every webhook POST is checked with X-Hub-Signature-256; commands are obeyed only from WHATSAPP_ALLOWED_NUMBERS.'],
    docs: [{ label: 'WhatsApp accounts', url: 'https://developers.facebook.com/documentation/business-messaging/whatsapp/whatsapp-business-accounts' }]
  }
};

export const SUPERVISOR_ENV = [
  { env: 'CHANNEL_COMMANDS', text: 'on lets allowlisted users send status, report, positions, kill. Default off.' },
  { env: 'SUPERVISOR', text: 'off disables the Desk Lead. Default on when a channel is set.' },
  { env: 'SUPERVISOR_INTERVAL_MIN', text: 'minutes between Desk Lead checks. Default 5.' },
  { env: 'ALERT_COOLDOWN_MIN', text: 'minutes before the same alert repeats (it repeats sooner if it gets worse). Default 30.' }
];

export const NOT_SHIPPED = {
  michat: 'MiChat publishes no bot or developer API (checked michat.sg, its terms, privacy policy and app store pages on 2026-10-17), and its terms forbid automation software and bots. Nothing is shipped; use Telegram, Discord, Slack or WhatsApp.',
  email: 'Sending needs an SMTP client dependency or a provider-specific API, and inbound email cannot be authenticated well enough to accept commands. Use a channel above; most of them also notify by email or phone.'
};

export function allChannelLinks(): ChLink[] {
  return Object.values(CHANNEL_GUIDES).flatMap((g) => [...g.steps.flatMap((s) => s.links), ...g.docs]);
}
