# OKX setup (CEX, experimental)

<!-- Generated from server/setup/guide.ts by `npm run docs:setup`. Edit the guide, not this file. -->

Trading Agent Mpu Gandring trades OKX perpetual futures with **your own** account and key. Start in PAPER, then TESTNET, LIVE last. Not financial advice.

- **Sign-in:** Email or phone account. API keys only (no OAuth for personal keys). OKX may require a minimum balance before it lets you create an API key.
- **Connect wallet in the office:** no, manual steps below.
- **Permissions ON:** Read; Trade
- **Permissions OFF:** Withdraw
- **IP allowlist:** Add your IP to the allowlist (up to 20). Keys with Trade permission and no IP expire after 14 days without use (demo keys do not expire).

## Testnet (test money, do this first)

> OKX has no separate testnet site: Demo Trading inside your normal account. The app sends the x-simulated-trading header.

1. **Create an OKX account.** Demo Trading uses your normal OKX login. [OKX sign-up](https://www.okx.com/account/register)
2. **Switch to Demo Trading.** Trade, Demo Trading. The demo account comes with demo funds. [What is demo trading](https://www.okx.com/help/how-to-use-demo-trading)
3. **Create a Demo Trading API key.** In Demo Trading: Personal Center, Demo Trading API, Create Demo Trading API Key. Permission Trade only. Save key, secret and passphrase. [OKX API FAQ (demo key steps)](https://www.okx.com/help/api-faq)
4. **Check the permissions.** ON: Read; Trade. OFF: Withdraw. Add your IP to the allowlist (up to 20). Keys with Trade permission and no IP expire after 14 days without use (demo keys do not expire).
5. **Enter the keys on this computer.** Type them into the hidden prompts of npm run setup or the office Setup wizard (they go into .env, chmod 600): OKX_TESTNET_API_KEY, OKX_TESTNET_API_SECRET, OKX_TESTNET_API_PASSPHRASE. Never paste keys in a chat.
6. **Verify.** npm run doctor (or the Setup wizard "Run doctor") reads the key once: it must say it can trade and cannot withdraw. A key that can withdraw, a main wallet key or a seed phrase is refused.
7. **Switch to TESTNET and restart.** TESTNET is checked again on every start. Then watch the first order: its stop loss must appear as an open trigger order on OKX.

| .env name | What | Secret |
| --- | --- | --- |
| `OKX_TESTNET_API_KEY` | API key | yes, hidden input only |
| `OKX_TESTNET_API_SECRET` | API secret | yes, hidden input only |
| `OKX_TESTNET_API_PASSPHRASE` | API passphrase | yes, hidden input only |

Same steps in the terminal: `npm run setup` (or print them: `npm run setup -- guide okx`), or in the office: **Setup** (top right).

## Mainnet (real money, for LIVE)

1. **Create an OKX account.** Register and verify as OKX requires for your country. [OKX sign-up](https://www.okx.com/account/register)
2. **Deposit USDT to the trading account.** Only what you can afford to lose.
3. **Create the API key.** Profile, API, Create API key. Permissions Read + Trade, never Withdraw. Choose a passphrase; you need it in the app. [OKX API keys](https://www.okx.com/account/my-api) (sign in / connect wallet first)
4. **Check the permissions.** ON: Read; Trade. OFF: Withdraw. Add your IP to the allowlist (up to 20). Keys with Trade permission and no IP expire after 14 days without use (demo keys do not expire).
5. **Enter the keys on this computer.** Type them into the hidden prompts of npm run setup or the office Setup wizard (they go into .env, chmod 600): OKX_API_KEY, OKX_API_SECRET, OKX_API_PASSPHRASE. Never paste keys in a chat.
6. **Verify.** npm run doctor (or the Setup wizard "Run doctor") reads the key once: it must say it can trade and cannot withdraw. A key that can withdraw, a main wallet key or a seed phrase is refused.
7. **Switch to LIVE and restart.** LIVE (explicit confirmation) is checked again on every start. Then watch the first order: its stop loss must appear as an open trigger order on OKX.

| .env name | What | Secret |
| --- | --- | --- |
| `OKX_API_KEY` | API key | yes, hidden input only |
| `OKX_API_SECRET` | API secret | yes, hidden input only |
| `OKX_API_PASSPHRASE` | API passphrase | yes, hidden input only |

Same steps in the terminal: `npm run setup` (or print them: `npm run setup -- guide okx --network mainnet`), or in the office: **Setup** (top right).

## Verify

```bash
npm run doctor            # one harmless read: can trade, cannot withdraw
npm run setup -- check-key --network testnet
```

Then switch the mode (TESTNET, or LIVE with the typed confirmation) and restart. Watch the first order: its stop loss must show as an open trigger order on the venue. Every TESTNET/LIVE start checks the key again and refuses one that can withdraw.

## Official docs

- [OKX API FAQ](https://www.okx.com/help/api-faq)
- [OKX API docs (Demo Trading Services)](https://www.okx.com/docs-v5/en/)

Links checked 2026-10-17. Pages marked "sign in" need your login before they show the form. If a venue moves a page, tell us in an issue.
