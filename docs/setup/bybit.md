# Bybit setup (CEX, implemented)

<!-- Generated from server/setup/guide.ts by `npm run docs:setup`. Edit the guide, not this file. -->

Trading Agent Mpu Gandring trades Bybit perpetual futures with **your own** account and key. Start in PAPER, then TESTNET, LIVE last. Not financial advice.

- **Sign-in:** Email or phone account. API keys only (no OAuth for personal keys). Keys can only be created on the website, not in the app; new accounts may wait 48 hours.
- **Connect wallet in the office:** no, manual steps below.
- **Permissions ON:** API transaction, Read-Write; Contract (derivatives): Orders and Positions
- **Permissions OFF:** Withdraw; Transfer / Assets / Wallet; Everything not listed above
- **IP allowlist:** Bind the key to your IP address if you have a fixed one (recommended). Bybit may expire keys that have no IP bound; then make a new one.

## Testnet (test money, do this first)

> Bybit testnet is a separate site with its own account (PC browser only).

1. **Create a Bybit testnet account.** Register with email or phone on the testnet site. It is a different account from mainnet. [Bybit testnet sign-up](https://testnet.bybit.com/register), [Guide](https://www.bybit.com/en/help-center/article/How-to-Request-Test-Coins-on-Testnet)
2. **Get test coins.** Assets, Assets Overview, Request Test Coins (10,000 USDT, once every 24 hours). Move USDT to the derivatives/unified account if asked. [Bybit testnet](https://testnet.bybit.com/) (sign in / connect wallet first)
3. **Create the testnet API key.** API Management, Create New Key, System-generated. Tick only the permissions below. Withdraw and transfer stay OFF. [Testnet API management](https://testnet.bybit.com/app/user/api-management) (sign in / connect wallet first)
4. **Check the permissions.** ON: API transaction, Read-Write; Contract (derivatives): Orders and Positions. OFF: Withdraw; Transfer / Assets / Wallet; Everything not listed above. Bind the key to your IP address if you have a fixed one (recommended). Bybit may expire keys that have no IP bound; then make a new one.
5. **Enter the keys on this computer.** Type them into the hidden prompts of npm run setup or the office Setup wizard (they go into .env, chmod 600): BYBIT_TESTNET_API_KEY, BYBIT_TESTNET_API_SECRET. Never paste keys in a chat.
6. **Verify.** npm run doctor (or the Setup wizard "Run doctor") reads the key once: it must say it can trade and cannot withdraw. A key that can withdraw, a main wallet key or a seed phrase is refused.
7. **Switch to TESTNET and restart.** TESTNET is checked again on every start. Then watch the first order: its stop loss must appear as an open trigger order on Bybit.

| .env name | What | Secret |
| --- | --- | --- |
| `BYBIT_TESTNET_API_KEY` | API key | yes, hidden input only |
| `BYBIT_TESTNET_API_SECRET` | API secret | yes, hidden input only |

Same steps in the terminal: `npm run setup` (or print them: `npm run setup -- guide bybit`), or in the office: **Setup** (top right).

## Mainnet (real money, for LIVE)

1. **Create a Bybit account.** Register and finish identity verification (KYC) as Bybit requires for your country. [Bybit sign-up](https://www.bybit.com/register)
2. **Deposit USDT.** Deposit only what you can afford to lose and keep it in the derivatives/unified trading account. [Bybit](https://www.bybit.com/) (sign in / connect wallet first)
3. **Create the API key.** API Management, Create New Key, System-generated. Tick only the permissions below. Withdraw and transfer stay OFF. [API management](https://www.bybit.com/app/user/api-management) (sign in / connect wallet first)
4. **Check the permissions.** ON: API transaction, Read-Write; Contract (derivatives): Orders and Positions. OFF: Withdraw; Transfer / Assets / Wallet; Everything not listed above. Bind the key to your IP address if you have a fixed one (recommended). Bybit may expire keys that have no IP bound; then make a new one.
5. **Enter the keys on this computer.** Type them into the hidden prompts of npm run setup or the office Setup wizard (they go into .env, chmod 600): BYBIT_API_KEY, BYBIT_API_SECRET. Never paste keys in a chat.
6. **Verify.** npm run doctor (or the Setup wizard "Run doctor") reads the key once: it must say it can trade and cannot withdraw. A key that can withdraw, a main wallet key or a seed phrase is refused.
7. **Switch to LIVE and restart.** LIVE (explicit confirmation) is checked again on every start. Then watch the first order: its stop loss must appear as an open trigger order on Bybit.

| .env name | What | Secret |
| --- | --- | --- |
| `BYBIT_API_KEY` | API key | yes, hidden input only |
| `BYBIT_API_SECRET` | API secret | yes, hidden input only |

Same steps in the terminal: `npm run setup` (or print them: `npm run setup -- guide bybit --network mainnet`), or in the office: **Setup** (top right).

## Verify

```bash
npm run doctor            # one harmless read: can trade, cannot withdraw
npm run setup -- check-key --network testnet
```

Then switch the mode (TESTNET, or LIVE with the typed confirmation) and restart. Watch the first order: its stop loss must show as an open trigger order on the venue. Every TESTNET/LIVE start checks the key again and refuses one that can withdraw.

## Official docs

- [How to create your API key](https://www.bybit.com/en/help-center/article/How-to-create-your-API-key)
- [Bybit API docs](https://bybit-exchange.github.io/docs/v5/guide)

Links checked 2026-10-17. Pages marked "sign in" need your login before they show the form. If a venue moves a page, tell us in an issue.
