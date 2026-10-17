# Orderly setup (DEX, experimental)

<!-- Generated from server/setup/guide.ts by `npm run docs:setup`. Edit the guide, not this file. -->

Trading Agent Mpu Gandring trades Orderly perpetual futures with **your own** account and key. Start in PAPER, then TESTNET, LIVE last. Not financial advice.

- **Sign-in:** Orderly has no app of its own: you trade through an Orderly-based frontend (for example WOOFi Pro) with your wallet, or with the official Orderly CLI. No OAuth.
- **Connect wallet in the office:** no, manual steps below.
- **Permissions ON:** Orderly key with scope read,trading
- **Permissions OFF:** Withdrawals and transfers (they need your wallet signature, an Orderly key cannot); Never the wallet private key
- **IP allowlist:** No IP allowlist in this app.

## Testnet (test money, do this first)

> The official Orderly CLI makes a testnet account, claims test USDC and adds an Orderly key with scope read,trading in four commands (broker id "demo").

1. **Create a testnet account with the Orderly CLI.** npm install -g @orderly.network/cli, then follow the Quick Start (Testnet) in the README. [Orderly CLI](https://github.com/OrderlyNetwork/cli)
2. **Claim test USDC.** orderly faucet-usdc (1,000 USDC per claim on EVM, up to 5 claims). [Faucet docs](https://orderly.network/docs/build-on-omnichain/restful-api/public/get-faucet-usdctestnet-only)
3. **Add an Orderly key.** orderly wallet-add-key --scope read,trading. Copy the account id (0x...) and the key secret (ed25519, base58). [Orderly CLI](https://github.com/OrderlyNetwork/cli)
4. **Check the permissions.** ON: Orderly key with scope read,trading. OFF: Withdrawals and transfers (they need your wallet signature, an Orderly key cannot); Never the wallet private key. No IP allowlist in this app.
5. **Enter the keys on this computer.** Type them into the hidden prompts of npm run setup or the office Setup wizard (they go into .env, chmod 600): ORDERLY_TESTNET_ACCOUNT_ID, ORDERLY_TESTNET_KEY_SECRET. Never paste keys in a chat.
6. **Verify.** npm run doctor (or the Setup wizard "Run doctor") reads the key once: it must say it can trade and cannot withdraw. A key that can withdraw, a main wallet key or a seed phrase is refused.
7. **Switch to TESTNET and restart.** TESTNET is checked again on every start. Then watch the first order: its stop loss must appear as an open trigger order on Orderly.

| .env name | What | Secret |
| --- | --- | --- |
| `ORDERLY_TESTNET_ACCOUNT_ID` | Orderly account id (0x..., public) | no (public) |
| `ORDERLY_TESTNET_KEY_SECRET` | Orderly key secret (ed25519:...) | yes, hidden input only |

Same steps in the terminal: `npm run setup` (or print them: `npm run setup -- guide orderly`), or in the office: **Setup** (top right).

## Mainnet (real money, for LIVE)

1. **Open an Orderly-based frontend.** For example WOOFi Pro. Connect your wallet and create the account. [WOOFi Pro](https://pro.woofi.com/) (sign in / connect wallet first), [Orderly](https://orderly.network/)
2. **Deposit USDC.** Only what you can afford to lose.
3. **Get an Orderly key with scope read,trading.** Create the key through the add-orderly-key flow (or a frontend that exports it). Copy the account id and the key secret. [Add Orderly key](https://orderly.network/docs/build-on-omnichain/restful-api/public/add-orderly-key)
4. **Check the permissions.** ON: Orderly key with scope read,trading. OFF: Withdrawals and transfers (they need your wallet signature, an Orderly key cannot); Never the wallet private key. No IP allowlist in this app.
5. **Enter the keys on this computer.** Type them into the hidden prompts of npm run setup or the office Setup wizard (they go into .env, chmod 600): ORDERLY_ACCOUNT_ID, ORDERLY_KEY_SECRET. Never paste keys in a chat.
6. **Verify.** npm run doctor (or the Setup wizard "Run doctor") reads the key once: it must say it can trade and cannot withdraw. A key that can withdraw, a main wallet key or a seed phrase is refused.
7. **Switch to LIVE and restart.** LIVE (explicit confirmation) is checked again on every start. Then watch the first order: its stop loss must appear as an open trigger order on Orderly.

| .env name | What | Secret |
| --- | --- | --- |
| `ORDERLY_ACCOUNT_ID` | Orderly account id (0x..., public) | no (public) |
| `ORDERLY_KEY_SECRET` | Orderly key secret (ed25519:...) | yes, hidden input only |

Same steps in the terminal: `npm run setup` (or print them: `npm run setup -- guide orderly --network mainnet`), or in the office: **Setup** (top right).

## Verify

```bash
npm run doctor            # one harmless read: can trade, cannot withdraw
npm run setup -- check-key --network testnet
```

Then switch the mode (TESTNET, or LIVE with the typed confirmation) and restart. Watch the first order: its stop loss must show as an open trigger order on the venue. Every TESTNET/LIVE start checks the key again and refuses one that can withdraw.

## Official docs

- [Wallet authentication and Orderly keys](https://orderly.network/docs/build-on-omnichain/user-flows/wallet-authentication)
- [Accounts](https://orderly.network/docs/build-on-omnichain/user-flows/accounts)
- [Add Orderly key](https://orderly.network/docs/build-on-omnichain/restful-api/public/add-orderly-key)

Links checked 2026-10-17. Pages marked "sign in" need your login before they show the form. If a venue moves a page, tell us in an issue.
