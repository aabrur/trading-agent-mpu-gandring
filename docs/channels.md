# Chat channels and the Desk Lead

The **Desk Lead** is the one supervisor that watches the desk and talks to you on a chat channel:

- every `SUPERVISOR_INTERVAL_MIN` (default 5) it checks health, open positions, positions without a stop, the daily loss cap, the safety net, API and exchange errors, stale or sample price feeds, and the kill switch;
- warnings and alerts go to every channel you set up, once per `ALERT_COOLDOWN_MIN` (default 30) per finding, sooner if a finding gets worse;
- scheduled reports (`REPORT_INTERVAL_MIN`) go to the same channels;
- with `CHANNEL_COMMANDS=on`, people on your allowlist can send **only** these commands: `status`, `report`, `positions`, `kill` (`kill confirm` to actually flatten and stop), `help`.

**Never possible from chat, on purpose:** opening, closing or resizing orders, switching PAPER/TESTNET/LIVE, releasing the kill switch (`npm run unkill -- --yes` on the desk computer only), and changing keys or settings. Those messages get a refusal. Secrets live only in `.env` (chmod 600) and pass through the redactor before anything is sent.

Only official setup paths are used. Links were checked on 2026-10-17. "(sign in)" means the page needs a login first.

## Set up a channel

| | CLI | Office |
| --- | --- | --- |
| Step-by-step links, values typed hidden, saved to `.env` | `npm run channels -- setup <telegram\|discord\|slack\|whatsapp>` (or pick a channel in `npm run setup`, or `npm run setup -- channel <name>`) | **Setup**, section 7 "Chat channel and Desk Lead" |
| Links only | `npm run channels -- guide <channel>` | Setup, section 7, Back / Next step |
| What is set (secrets shown as set/empty) | `npm run channels -- status` | Setup, section 7 status line |
| Test message | `npm run channels -- test <channel>` | **Send test message** |
| Telegram chat id and your user id | `npm run channels -- telegram-chats` | **Find my chat id** |
| Discord slash commands (you run the printed request) | `npm run channels -- discord-commands` | shown in section 7 |
| The allowed commands | `npm run channels -- commands` | shown in section 7 |

Restart the desk after saving. In Grok Bot mode the office will not take secrets: use the secret request card or the CLI.

## Telegram (shipped)

Official path: a bot made with **@BotFather**, the Telegram Bot API.

1. Open [@BotFather](https://t.me/BotFather), send `/newbot`, choose a name and a username ending in `bot`. Copy the token ([BotFather guide](https://core.telegram.org/bots/features#botfather)).
2. Send your new bot any message (or add it to a group and write there). Then `npm run channels -- telegram-chats` or **Find my chat id** shows the chat id and your user id (it calls [getUpdates](https://core.telegram.org/bots/api#getupdates)).

| Env | What |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | secret, from BotFather |
| `TELEGRAM_CHAT_ID` | where the desk posts |
| `TELEGRAM_ALLOWED_USER_IDS` | user ids allowed to command (comma separated); empty = nobody |

Commands use **long polling**, so no public URL is needed. A command is obeyed only if it comes from `TELEGRAM_CHAT_ID` **and** from a user in `TELEGRAM_ALLOWED_USER_IDS`. Polling does not work while a webhook is set on the same bot or while another program polls it. Docs: [Bot API](https://core.telegram.org/bots/api), [tutorial](https://core.telegram.org/bots/tutorial).

## Discord (shipped)

Official path: a **channel webhook** for posts; a **Developer Portal** application with an **Interactions Endpoint** for slash commands.

1. In your server: Edit Channel, Integrations, Webhooks, New Webhook, Copy Webhook URL ([webhook docs](https://docs.discord.com/developers/resources/webhook); help article [Intro to Webhooks](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks), which sits behind a bot check and opens in a normal browser).
2. Optional, commands: create an application in the [Developer Portal](https://discord.com/developers/applications) (sign in), copy the **Public Key** from General Information, register the commands with the request printed by `npm run channels -- discord-commands` (you run it with your own bot token in your shell; see [application commands](https://docs.discord.com/developers/interactions/application-commands)), and set the **Interactions Endpoint URL** to `https://<your public host>/api/channels/discord` ([interactions overview](https://docs.discord.com/developers/interactions/overview)).

| Env | What |
| --- | --- |
| `DISCORD_WEBHOOK_URL` | secret, `https://discord.com/api/webhooks/...` |
| `DISCORD_PUBLIC_KEY` | app public key (64 hex), turns on signed commands |
| `DISCORD_ALLOWED_USER_IDS` | user ids allowed to command |

Every interaction is checked with **Ed25519** (`X-Signature-Ed25519` over `X-Signature-Timestamp` + body); a bad signature gets 401. Replies are ephemeral. Posts never ping anyone (`allowed_mentions` empty).

## Slack (shipped)

Official path: a Slack app with **Incoming Webhooks** for posts and a **slash command** for commands.

1. [Your apps](https://api.slack.com/apps) (sign in), Create New App, From scratch ([guide](https://docs.slack.dev/app-management/quickstart-app-settings/)).
2. Features, Incoming Webhooks, On, Add New Webhook to Workspace, pick the channel, copy the URL ([incoming webhooks](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/)).
3. Optional, commands: Slash Commands, Create New Command `/desk`, Request URL `https://<your public host>/api/channels/slack` ([slash commands](https://docs.slack.dev/interactivity/implementing-slash-commands/)). Copy the **Signing Secret** from Basic Information ([verifying requests](https://docs.slack.dev/authentication/verifying-requests-from-slack/)).

| Env | What |
| --- | --- |
| `SLACK_WEBHOOK_URL` | secret, `https://hooks.slack.com/services/...` |
| `SLACK_SIGNING_SECRET` | secret, turns on signed commands |
| `SLACK_ALLOWED_USER_IDS` | member ids (`U...`) allowed to command |

Each request is checked with the signing secret (`v0` HMAC-SHA256 over timestamp and raw body) and must be under 5 minutes old.

## WhatsApp (shipped, Meta WhatsApp Business Platform Cloud API)

Official path only: **Meta's WhatsApp Business Cloud API**. No unofficial WhatsApp Web libraries, ever.

1. [Meta apps](https://developers.facebook.com/apps) (sign in): create an app, add WhatsApp. **API Setup** shows a test business number, its **Phone number ID** and a temporary token; add your own number as a test recipient ([get started](https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started)).
2. The temporary token expires quickly. For daily use create a **system user** in [Business settings](https://business.facebook.com/settings/system-users) (sign in) and generate a token with `whatsapp_business_messaging`.
3. **Business verification and phone requirements:** to use your own business number, [verify your business](https://www.facebook.com/business/help/2058515294227817) in Meta Business Suite. The number must be able to receive an SMS or voice code; once registered for the Cloud API it **cannot be used in the WhatsApp app** at the same time; new business portfolios start with up to two registered numbers ([business phone numbers](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers), [WhatsApp accounts](https://developers.facebook.com/documentation/business-messaging/whatsapp/whatsapp-business-accounts)).
4. **24 hour window:** free text reaches you only within 24 hours of your last message to the business number. For alerts at any time create an approved **Utility template** with one body parameter `{{1}}` and set `WHATSAPP_TEMPLATE_NAME` ([templates](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview)). Meta charges per template message ([pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)).
5. Optional, commands: WhatsApp, Configuration: Callback URL `https://<your public host>/api/channels/whatsapp`, Verify token = your `WHATSAPP_VERIFY_TOKEN`, subscribe to `messages` ([webhooks](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview)).

| Env | What |
| --- | --- |
| `WHATSAPP_ACCESS_TOKEN` | secret, system user token |
| `WHATSAPP_PHONE_NUMBER_ID` | the Phone number ID (not the number) |
| `WHATSAPP_TO` | your number for alerts, country code, digits only |
| `WHATSAPP_TEMPLATE_NAME` / `WHATSAPP_TEMPLATE_LANG` | optional approved template for alerts (default language `en_US`) |
| `WHATSAPP_APP_SECRET` | secret, App settings, Basic; turns on signed commands |
| `WHATSAPP_VERIFY_TOKEN` | secret, any random string of 16+ characters you also paste in Meta |
| `WHATSAPP_ALLOWED_NUMBERS` | numbers allowed to command |
| `WHATSAPP_GRAPH_VERSION` | Graph API version, default `v26.0` |

Every webhook POST is checked with `X-Hub-Signature-256` (HMAC-SHA256 with the app secret). Replies to commands go back to the sender inside the window they just opened.

## MiChat (documented only, nothing shipped)

We looked for an official MiChat bot or developer API on 2026-10-17: the official site [michat.sg](https://www.michat.sg/), its [terms](https://www.michat.sg/terms-conditions/) and [privacy policy](https://www.michat.sg/privacy-policy/), and the [Play Store listing](https://play.google.com/store/apps/details?id=com.michatapp.im). **There is no published bot or developer API**, and the terms forbid "automation software, bots, hacks, mods or unauthorised software". So there is no MiChat integration and there will not be an unofficial one. Use Telegram, Discord, Slack or WhatsApp.

## Email (documented only, nothing shipped)

Not shipped. Sending needs either an SMTP client dependency or one provider's own HTTP API, and inbound email cannot be authenticated well enough to accept even the safe commands. Every shipped channel can notify you by phone or email through its own app.

## Commands from a public URL: the separate webhook server

Discord, Slack and WhatsApp must reach the desk over public HTTPS. The desk does **not** expose the office for this. Inbound chat webhooks run on a **separate server** that has only `/api/channels/*`:

- `CHANNEL_WEBHOOK_PORT` (default `8788`), `CHANNEL_WEBHOOK_HOST` (default `127.0.0.1`);
- it starts only when `CHANNEL_COMMANDS=on` and at least one of Discord, Slack or WhatsApp has its signing key set;
- point your HTTPS tunnel or reverse proxy at **this port only**, never at the office port (8787) or the web port (5173). Official tunnel docs: [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/), [ngrok](https://ngrok.com/docs/start).

Order of checks for every inbound message: signature, then `CHANNEL_COMMANDS`, then the allowlist, then the safe command parser. Rate limited per source.

## Settings

| Env | Default | What |
| --- | --- | --- |
| `CHANNEL_COMMANDS` | `off` | `on` lets allowlisted ids send the safe commands |
| `SUPERVISOR` | on when a channel is set | `off` turns the Desk Lead off |
| `SUPERVISOR_INTERVAL_MIN` | `5` | minutes between Desk Lead checks |
| `ALERT_COOLDOWN_MIN` | `30` | minutes before the same alert repeats |
| `CHANNEL_WEBHOOK_PORT` / `CHANNEL_WEBHOOK_HOST` | `8788` / `127.0.0.1` | the separate inbound webhook server |

Code: `server/channels/` (config, adapters, signature checks, safe commands, Desk Lead, routes, setup). Tests: `tests/channels.test.ts` (mocked adapters, allowlists, signatures, refused commands).
