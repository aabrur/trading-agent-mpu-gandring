# Binance setup (CEX, experimental)

<!-- Generated from server/setup/guide.ts by `npm run docs:setup`. Edit the guide, not this file. -->

Trading Agent Mpu Gandring trades Binance perpetual futures with **your own** account and key. Start in PAPER, then TESTNET, LIVE last. Not financial advice.

- **Sign-in:** Email or phone account. API keys only (no OAuth for personal keys).
- **Connect wallet in the office:** no, manual steps below.
- **Permissions ON:** Enable Reading; Enable Futures
- **Permissions OFF:** Enable Withdrawals; Universal Transfer; Margin / Spot trading (not needed)
- **IP allowlist:** Restrict the key to trusted IPs (recommended). Binance only allows withdrawals on IP-restricted keys; keep withdrawals off anyway.

## Testnet (test money, do this first)

> Binance replaced the old futures testnet with Demo Trading. Old testnet keys were deleted; create Demo Trading keys. This app talks to https://demo-fapi.binance.com on TESTNET.

1. **Use your Binance account in Demo Trading.** Demo Trading uses your normal Binance login. Sign up first if you have no account. [Binance sign-up](https://accounts.binance.com/register) (bot check, open in a browser)
2. **Open Demo Trading futures.** The demo account comes with demo funds; you can reset them in the UI. [Binance Demo Trading futures](https://demo.binance.com/en/futures/BTCUSDT) (sign in / connect wallet first)
3. **Create a Demo Trading API key.** Demo Trading, API Key Management, Create API. Tick only the permissions below. [Demo API management](https://demo.binance.com/en/my/settings/api-management) (sign in / connect wallet first)
4. **Check the permissions.** ON: Enable Reading; Enable Futures. OFF: Enable Withdrawals; Universal Transfer; Margin / Spot trading (not needed). Restrict the key to trusted IPs (recommended). Binance only allows withdrawals on IP-restricted keys; keep withdrawals off anyway.
5. **Enter the keys on this computer.** Type them into the hidden prompts of npm run setup or the office Setup wizard (they go into .env, chmod 600): BINANCE_TESTNET_API_KEY, BINANCE_TESTNET_API_SECRET. Never paste keys in a chat.
6. **Verify.** npm run doctor (or the Setup wizard "Run doctor") reads the key once: it must say it can trade and cannot withdraw. A key that can withdraw, a main wallet key or a seed phrase is refused.
7. **Switch to TESTNET and restart.** TESTNET is checked again on every start. Then watch the first order: its stop loss must appear as an open trigger order on Binance.

| .env name | What | Secret |
| --- | --- | --- |
| `BINANCE_TESTNET_API_KEY` | API key | yes, hidden input only |
| `BINANCE_TESTNET_API_SECRET` | API secret | yes, hidden input only |

Same steps in the terminal: `npm run setup` (or print them: `npm run setup -- guide binance`), or in the office: **Setup** (top right).

## Mainnet (real money, for LIVE)

1. **Create a Binance account.** Register and finish identity verification (KYC). Open a USD-M futures account. [Binance sign-up](https://accounts.binance.com/register) (bot check, open in a browser)
2. **Deposit USDT to USD-M futures.** Only what you can afford to lose.
3. **Create the API key.** API Management, Create API, System generated. Tick only the permissions below. Withdrawals OFF. [API management](https://www.binance.com/en/my/settings/api-management) (sign in / connect wallet first)
4. **Check the permissions.** ON: Enable Reading; Enable Futures. OFF: Enable Withdrawals; Universal Transfer; Margin / Spot trading (not needed). Restrict the key to trusted IPs (recommended). Binance only allows withdrawals on IP-restricted keys; keep withdrawals off anyway.
5. **Enter the keys on this computer.** Type them into the hidden prompts of npm run setup or the office Setup wizard (they go into .env, chmod 600): BINANCE_API_KEY, BINANCE_API_SECRET. Never paste keys in a chat.
6. **Verify.** npm run doctor (or the Setup wizard "Run doctor") reads the key once: it must say it can trade and cannot withdraw. A key that can withdraw, a main wallet key or a seed phrase is refused.
7. **Switch to LIVE and restart.** LIVE (explicit confirmation) is checked again on every start. Then watch the first order: its stop loss must appear as an open trigger order on Binance.

| .env name | What | Secret |
| --- | --- | --- |
| `BINANCE_API_KEY` | API key | yes, hidden input only |
| `BINANCE_API_SECRET` | API secret | yes, hidden input only |

Same steps in the terminal: `npm run setup` (or print them: `npm run setup -- guide binance --network mainnet`), or in the office: **Setup** (top right).

## Verify

```bash
npm run doctor            # one harmless read: can trade, cannot withdraw
npm run setup -- check-key --network testnet
```

Then switch the mode (TESTNET, or LIVE with the typed confirmation) and restart. Watch the first order: its stop loss must show as an open trigger order on the venue. Every TESTNET/LIVE start checks the key again and refuses one that can withdraw.

## Official docs

- [How to create API keys](https://www.binance.com/en/support/faq/how-to-create-api-keys-on-binance-360002502072) (bot check, open in a browser)
- [USD-M futures API docs](https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info) (bot check, open in a browser)

Links checked 2026-10-17. Pages marked "sign in" need your login before they show the form. If a venue moves a page, tell us in an issue.
