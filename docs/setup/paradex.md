# Paradex setup (DEX, experimental)

<!-- Generated from server/setup/guide.ts by `npm run docs:setup`. Edit the guide, not this file. -->

Trading Agent Mpu Gandring trades Paradex perpetual futures with **your own** account and key. Start in PAPER, then TESTNET, LIVE last. Not financial advice.

- **Sign-in:** Connect a wallet (EVM or Starknet) in the Paradex app. No OAuth. The app only takes a subkey (cannot withdraw or transfer).
- **Connect wallet in the office:** no, manual steps below.
- **Permissions ON:** Subkey: place, modify, cancel orders
- **Permissions OFF:** Withdrawals, transfers and key management (subkeys cannot); Never the main account key
- **IP allowlist:** Subkeys can carry an IP allowlist (set through the Paradex API); optional.

## Testnet (test money, do this first)

> Paradex testnet runs on Sepolia; your wallet may ask to switch network.

1. **Connect your wallet on Paradex testnet.** Open the testnet app and connect a wallet. [Paradex testnet](https://app.testnet.paradex.trade/) (sign in / connect wallet first)
2. **Test USDC.** New testnet accounts get test USDC automatically. Out of funds: create a sub-account and transfer. [Testnet FAQs](https://docs.paradex.trade/docs/testnet-faqs), [Sub-accounts](https://docs.paradex.trade/docs/accounts/sub-accounts)
3. **Create a subkey.** Account security settings, Key Management, Subkeys, + Add New Key. The private key is shown once. Copy your account address and the subkey private key. [How to create a subkey](https://docs.paradex.trade/api/general-information/api-authentication)
4. **Check the permissions.** ON: Subkey: place, modify, cancel orders. OFF: Withdrawals, transfers and key management (subkeys cannot); Never the main account key. Subkeys can carry an IP allowlist (set through the Paradex API); optional.
5. **Enter the keys on this computer.** Type them into the hidden prompts of npm run setup or the office Setup wizard (they go into .env, chmod 600): PARADEX_TESTNET_ACCOUNT_ADDRESS, PARADEX_TESTNET_SUBKEY_PRIVATE_KEY. Never paste keys in a chat.
6. **Verify.** npm run doctor (or the Setup wizard "Run doctor") reads the key once: it must say it can trade and cannot withdraw. A key that can withdraw, a main wallet key or a seed phrase is refused.
7. **Switch to TESTNET and restart.** TESTNET is checked again on every start. Then watch the first order: its stop loss must appear as an open trigger order on Paradex.

| .env name | What | Secret |
| --- | --- | --- |
| `PARADEX_TESTNET_ACCOUNT_ADDRESS` | Main account address (public) | no (public) |
| `PARADEX_TESTNET_SUBKEY_PRIVATE_KEY` | Subkey private key | yes, hidden input only |

Same steps in the terminal: `npm run setup` (or print them: `npm run setup -- guide paradex`), or in the office: **Setup** (top right).

## Mainnet (real money, for LIVE)

1. **Connect your wallet on Paradex.** Open the app and connect a wallet. [Paradex](https://app.paradex.trade/) (sign in / connect wallet first)
2. **Deposit USDC.** Only what you can afford to lose.
3. **Create a subkey.** Key Management, Subkeys, + Add New Key. Copy the account address and the subkey private key. [How to create a subkey](https://docs.paradex.trade/api/general-information/api-authentication)
4. **Check the permissions.** ON: Subkey: place, modify, cancel orders. OFF: Withdrawals, transfers and key management (subkeys cannot); Never the main account key. Subkeys can carry an IP allowlist (set through the Paradex API); optional.
5. **Enter the keys on this computer.** Type them into the hidden prompts of npm run setup or the office Setup wizard (they go into .env, chmod 600): PARADEX_ACCOUNT_ADDRESS, PARADEX_SUBKEY_PRIVATE_KEY. Never paste keys in a chat.
6. **Verify.** npm run doctor (or the Setup wizard "Run doctor") reads the key once: it must say it can trade and cannot withdraw. A key that can withdraw, a main wallet key or a seed phrase is refused.
7. **Switch to LIVE and restart.** LIVE (explicit confirmation) is checked again on every start. Then watch the first order: its stop loss must appear as an open trigger order on Paradex.

| .env name | What | Secret |
| --- | --- | --- |
| `PARADEX_ACCOUNT_ADDRESS` | Main account address (public) | no (public) |
| `PARADEX_SUBKEY_PRIVATE_KEY` | Subkey private key | yes, hidden input only |

Same steps in the terminal: `npm run setup` (or print them: `npm run setup -- guide paradex --network mainnet`), or in the office: **Setup** (top right).

## Verify

```bash
npm run doctor            # one harmless read: can trade, cannot withdraw
npm run setup -- check-key --network testnet
```

Then switch the mode (TESTNET, or LIVE with the typed confirmation) and restart. Watch the first order: its stop loss must show as an open trigger order on the venue. Every TESTNET/LIVE start checks the key again and refuses one that can withdraw.

## Official docs

- [API authentication (subkeys)](https://docs.paradex.trade/api/general-information/api-authentication)
- [Testnet FAQs](https://docs.paradex.trade/docs/testnet-faqs)

Links checked 2026-10-17. Pages marked "sign in" need your login before they show the form. If a venue moves a page, tell us in an issue.
