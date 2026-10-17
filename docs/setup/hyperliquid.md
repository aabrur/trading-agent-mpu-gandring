# Hyperliquid setup (DEX, experimental)

<!-- Generated from server/setup/guide.ts by `npm run docs:setup`. Edit the guide, not this file. -->

Trading Agent Mpu Gandring trades Hyperliquid perpetual futures with **your own** account and key. Start in PAPER, then TESTNET, LIVE last. Not financial advice.

- **Sign-in:** Connect a wallet (MetaMask, Rabby) or email login. No password, no OAuth. The app only ever gets an API agent wallet key, never your wallet key.
- **Connect wallet in the office:** yes. One wallet signature (MetaMask or Rabby) approves a fresh trade-only agent key made on your computer; nothing to copy. Local mode, office on 127.0.0.1.
- **Permissions ON:** API agent wallet (can place and cancel orders)
- **Permissions OFF:** Agent wallets cannot withdraw by design. Never enter your main wallet private key or seed phrase.
- **IP allowlist:** No IP allowlist on Hyperliquid. Revoke the agent on the API page any time.

## Testnet (test money, do this first)

> The faucet only pays addresses that have deposited on mainnet. Email logins get a different address on testnet; use a wallet extension.

1. **Connect your wallet on Hyperliquid testnet.** Open the testnet app and connect MetaMask or Rabby. [Hyperliquid testnet](https://app.hyperliquid-testnet.xyz/) (sign in / connect wallet first), [MetaMask](https://metamask.io/download/), [Rabby](https://rabby.io/)
2. **Claim mock USDC.** 1,000 mock USDC from the drip page (the same address must have a mainnet deposit). [Testnet faucet (drip)](https://app.hyperliquid-testnet.xyz/drip) (sign in / connect wallet first)
3. **Approve an agent wallet.** Easiest: the office Connect wallet button (local mode) makes a fresh agent key on your computer and asks for ONE signature. Or by hand: API page, Generate, Authorize, copy the agent private key. [Testnet API page](https://app.hyperliquid-testnet.xyz/API) (sign in / connect wallet first)
4. **Check the permissions.** ON: API agent wallet (can place and cancel orders). OFF: Agent wallets cannot withdraw by design. Never enter your main wallet private key or seed phrase. No IP allowlist on Hyperliquid. Revoke the agent on the API page any time.
5. **Enter the keys on this computer.** Type them into the hidden prompts of npm run setup or the office Setup wizard (they go into .env, chmod 600): HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS, HYPERLIQUID_TESTNET_AGENT_PRIVATE_KEY. Or use Connect wallet instead (one signature, nothing to copy). Never paste keys in a chat.
6. **Verify.** npm run doctor (or the Setup wizard "Run doctor") reads the key once: it must say it can trade and cannot withdraw. A key that can withdraw, a main wallet key or a seed phrase is refused.
7. **Switch to TESTNET and restart.** TESTNET is checked again on every start. Then watch the first order: its stop loss must appear as an open trigger order on Hyperliquid.

| .env name | What | Secret |
| --- | --- | --- |
| `HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS` | Main account address (public) | no (public) |
| `HYPERLIQUID_TESTNET_AGENT_PRIVATE_KEY` | API agent wallet private key | yes, hidden input only |

Same steps in the terminal: `npm run setup` (or print them: `npm run setup -- guide hyperliquid`), or in the office: **Setup** (top right).

## Mainnet (real money, for LIVE)

1. **Connect your wallet on Hyperliquid.** Open the app and connect MetaMask or Rabby. [Hyperliquid](https://app.hyperliquid.xyz/trade) (sign in / connect wallet first), [MetaMask](https://metamask.io/download/), [Rabby](https://rabby.io/)
2. **Deposit USDC.** Deposit from Arbitrum in the app. Only what you can afford to lose.
3. **Approve an agent wallet.** Office Connect wallet button (one signature) or by hand: API page, Generate, Authorize, copy the agent private key. [API page](https://app.hyperliquid.xyz/API) (sign in / connect wallet first)
4. **Check the permissions.** ON: API agent wallet (can place and cancel orders). OFF: Agent wallets cannot withdraw by design. Never enter your main wallet private key or seed phrase. No IP allowlist on Hyperliquid. Revoke the agent on the API page any time.
5. **Enter the keys on this computer.** Type them into the hidden prompts of npm run setup or the office Setup wizard (they go into .env, chmod 600): HYPERLIQUID_ACCOUNT_ADDRESS, HYPERLIQUID_AGENT_PRIVATE_KEY. Or use Connect wallet instead (one signature, nothing to copy). Never paste keys in a chat.
6. **Verify.** npm run doctor (or the Setup wizard "Run doctor") reads the key once: it must say it can trade and cannot withdraw. A key that can withdraw, a main wallet key or a seed phrase is refused.
7. **Switch to LIVE and restart.** LIVE (explicit confirmation) is checked again on every start. Then watch the first order: its stop loss must appear as an open trigger order on Hyperliquid.

| .env name | What | Secret |
| --- | --- | --- |
| `HYPERLIQUID_ACCOUNT_ADDRESS` | Main account address (public) | no (public) |
| `HYPERLIQUID_AGENT_PRIVATE_KEY` | API agent wallet private key | yes, hidden input only |

Same steps in the terminal: `npm run setup` (or print them: `npm run setup -- guide hyperliquid --network mainnet`), or in the office: **Setup** (top right).

## Verify

```bash
npm run doctor            # one harmless read: can trade, cannot withdraw
npm run setup -- check-key --network testnet
```

Then switch the mode (TESTNET, or LIVE with the typed confirmation) and restart. Watch the first order: its stop loss must show as an open trigger order on the venue. Every TESTNET/LIVE start checks the key again and refuses one that can withdraw.

## Official docs

- [Nonces and API wallets](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets)
- [Testnet faucet](https://hyperliquid.gitbook.io/hyperliquid-docs/onboarding/testnet-faucet)

Links checked 2026-10-17. Pages marked "sign in" need your login before they show the form. If a venue moves a page, tell us in an issue.
