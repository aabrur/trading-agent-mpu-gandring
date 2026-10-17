# dYdX v4 setup (DEX, experimental)

<!-- Generated from server/setup/guide.ts by `npm run docs:setup`. Edit the guide, not this file. -->

Trading Agent Mpu Gandring trades dYdX v4 perpetual futures with **your own** account and key. Start in PAPER, then TESTNET, LIVE last. Not financial advice.

- **Sign-in:** Connect a wallet in the dYdX app. No OAuth. The app only takes an API Trading Key (place/cancel only), never the owner key.
- **Connect wallet in the office:** no, manual steps below.
- **Permissions ON:** API Trading Key: place and cancel orders
- **Permissions OFF:** Transfers and withdrawals (an API Trading Key cannot do them); Never the owner key or seed phrase
- **IP allowlist:** No IP allowlist. Remove the key in the dYdX app any time.
- **Note:** SDK required: run `npm install @dydxprotocol/v4-client-js` in the app folder before TESTNET or LIVE (not bundled, see docs/venues.md).

## Testnet (test money, do this first)

> Test USDC comes from the dYdX faucet API (https://faucet.v4testnet.dydx.exchange, used by the testnet app and the official SDK FaucetClient); it has no web page of its own.

1. **Connect your wallet on the dYdX testnet app.** Open the testnet app and connect a wallet. [dYdX testnet app](https://v4.testnet.dydx.exchange/) (sign in / connect wallet first), [MetaMask](https://metamask.io/download/), [Rabby](https://rabby.io/)
2. **Get test USDC.** Use the faucet in the testnet app, or the SDK FaucetClient. [Faucet client docs](https://docs.dydx.xyz/faucet-client)
3. **Create an API Trading Key.** In the app: More, API Trading Keys, create a key. Copy your dydx1 address, the key private key and the authenticator id. [How to create the key](https://help.dydx.trade/en/articles/267486-api-trading-keys-creating-a-new-key-on-the-front-end)
4. **Check the permissions.** ON: API Trading Key: place and cancel orders. OFF: Transfers and withdrawals (an API Trading Key cannot do them); Never the owner key or seed phrase. No IP allowlist. Remove the key in the dYdX app any time.
5. **Enter the keys on this computer.** Type them into the hidden prompts of npm run setup or the office Setup wizard (they go into .env, chmod 600): DYDX_TESTNET_ADDRESS, DYDX_TESTNET_API_PRIVATE_KEY, DYDX_TESTNET_AUTHENTICATOR_ID. Never paste keys in a chat.
6. **Verify.** npm run doctor (or the Setup wizard "Run doctor") reads the key once: it must say it can trade and cannot withdraw. A key that can withdraw, a main wallet key or a seed phrase is refused.
7. **Switch to TESTNET and restart.** TESTNET is checked again on every start. Then watch the first order: its stop loss must appear as an open trigger order on dYdX v4.

| .env name | What | Secret |
| --- | --- | --- |
| `DYDX_TESTNET_ADDRESS` | dYdX address (dydx1..., public) | no (public) |
| `DYDX_TESTNET_API_PRIVATE_KEY` | API Trading Key private key | yes, hidden input only |
| `DYDX_TESTNET_AUTHENTICATOR_ID` | Authenticator id (number, public) | no (public) |

Same steps in the terminal: `npm run setup` (or print them: `npm run setup -- guide dydx`), or in the office: **Setup** (top right).

## Mainnet (real money, for LIVE)

1. **Connect your wallet on dYdX.** Open dydx.trade and connect a wallet. [dYdX](https://dydx.trade/trade/ETH-USD) (sign in / connect wallet first), [MetaMask](https://metamask.io/download/), [Rabby](https://rabby.io/)
2. **Deposit USDC.** Only what you can afford to lose.
3. **Create an API Trading Key.** More, API Trading Keys, create a key (place/cancel only). [How to create the key](https://help.dydx.trade/en/articles/267486-api-trading-keys-creating-a-new-key-on-the-front-end)
4. **Check the permissions.** ON: API Trading Key: place and cancel orders. OFF: Transfers and withdrawals (an API Trading Key cannot do them); Never the owner key or seed phrase. No IP allowlist. Remove the key in the dYdX app any time.
5. **Enter the keys on this computer.** Type them into the hidden prompts of npm run setup or the office Setup wizard (they go into .env, chmod 600): DYDX_ADDRESS, DYDX_API_PRIVATE_KEY, DYDX_AUTHENTICATOR_ID. Never paste keys in a chat.
6. **Verify.** npm run doctor (or the Setup wizard "Run doctor") reads the key once: it must say it can trade and cannot withdraw. A key that can withdraw, a main wallet key or a seed phrase is refused.
7. **Switch to LIVE and restart.** LIVE (explicit confirmation) is checked again on every start. Then watch the first order: its stop loss must appear as an open trigger order on dYdX v4.

| .env name | What | Secret |
| --- | --- | --- |
| `DYDX_ADDRESS` | dYdX address (dydx1..., public) | no (public) |
| `DYDX_API_PRIVATE_KEY` | API Trading Key private key | yes, hidden input only |
| `DYDX_AUTHENTICATOR_ID` | Authenticator id (number, public) | no (public) |

Same steps in the terminal: `npm run setup` (or print them: `npm run setup -- guide dydx --network mainnet`), or in the office: **Setup** (top right).

## Verify

```bash
npm run doctor            # one harmless read: can trade, cannot withdraw
npm run setup -- check-key --network testnet
```

Then switch the mode (TESTNET, or LIVE with the typed confirmation) and restart. Watch the first order: its stop loss must show as an open trigger order on the venue. Every TESTNET/LIVE start checks the key again and refuses one that can withdraw.

## Official docs

- [API Trading Keys (create in the app)](https://help.dydx.trade/en/articles/267486-api-trading-keys-creating-a-new-key-on-the-front-end)
- [Permissioned keys](https://docs.dydx.xyz/interaction/permissioned-keys)
- [Endpoints and faucet](https://docs.dydx.xyz/interaction/endpoints)

Links checked 2026-10-17. Pages marked "sign in" need your login before they show the form. If a venue moves a page, tell us in an issue.
