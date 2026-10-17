# Aster setup (DEX, experimental)

<!-- Generated from server/setup/guide.ts by `npm run docs:setup`. Edit the guide, not this file. -->

Trading Agent Mpu Gandring trades Aster perpetual futures with **your own** account and key. Start in PAPER, then TESTNET, LIVE last. Not financial advice.

- **Sign-in:** Connect a wallet (MetaMask, Rabby). No OAuth. The app only ever gets a Pro API agent (API wallet) key with withdraw off.
- **Connect wallet in the office:** yes. One wallet signature (MetaMask or Rabby) approves a fresh trade-only agent key made on your computer; nothing to copy. Local mode, office on 127.0.0.1.
- **Permissions ON:** Pro API agent: perpetual trading
- **Permissions OFF:** Withdraw; Spot trading (not needed); Never your main wallet key or seed phrase
- **IP allowlist:** Optional IP allowlist when you create the API wallet by hand.
- **Note:** Optional ASTER_AGENT_WITHDRAW_OFF_VERIFIED (off by default). Aster accounts report the ACCOUNT flag canWithdraw=true even when your agent cannot withdraw, so without this LIVE/TESTNET is refused. Withdraw permission is set per agent: create a trade-only Aster agent (perp on, canWithdraw false; Connect wallet does this for you), then set ASTER_AGENT_WITHDRAW_OFF_VERIFIED to YOUR OWN agent address (the address of your agent key, never your main wallet). On every start the app reads GET /fapi/v3/agent and accepts the key only if Aster lists that agent for your main address with canWithdraw false, canPerpTrade true and not expired, and the account says canTrade true. Docs: https://asterdex.github.io/aster-api-website/asterCode/endpoints/ (Get Agents) and docs/venues.md.

## Testnet (test money, do this first)

> Aster may require a completed deposit before trading endpoints work.

1. **Connect your wallet on Aster testnet.** Open the testnet site and connect MetaMask or Rabby. [Aster testnet](https://www.asterdex-testnet.com/) (sign in / connect wallet first), [MetaMask](https://metamask.io/download/), [Rabby](https://rabby.io/)
2. **Claim test funds.** Testnet faucet (test USDT). [Aster testnet faucet](https://www.asterdex-testnet.com/en/faucet) (sign in / connect wallet first)
3. **Authorize an API wallet.** Easiest: the office Connect wallet button (local mode) registers a fresh agent with withdraw forced OFF, ONE signature. Or by hand: API wallet page, Pro API, Authorize new API wallet: perp on, spot off, withdraw off. [Testnet API wallet](https://www.asterdex-testnet.com/en/api-wallet) (sign in / connect wallet first)
4. **Check the permissions.** ON: Pro API agent: perpetual trading. OFF: Withdraw; Spot trading (not needed); Never your main wallet key or seed phrase. Optional IP allowlist when you create the API wallet by hand.
5. **Enter the keys on this computer.** Type them into the hidden prompts of npm run setup or the office Setup wizard (they go into .env, chmod 600): ASTER_TESTNET_USER_ADDRESS, ASTER_TESTNET_SIGNER_PRIVATE_KEY. Or use Connect wallet instead (one signature, nothing to copy). Never paste keys in a chat.
6. **Verify.** npm run doctor (or the Setup wizard "Run doctor") reads the key once: it must say it can trade and cannot withdraw. A key that can withdraw, a main wallet key or a seed phrase is refused.
7. **Switch to TESTNET and restart.** TESTNET is checked again on every start. Then watch the first order: its stop loss must appear as an open trigger order on Aster.

| .env name | What | Secret |
| --- | --- | --- |
| `ASTER_TESTNET_USER_ADDRESS` | Main account address (public) | no (public) |
| `ASTER_TESTNET_SIGNER_PRIVATE_KEY` | API wallet (agent) private key | yes, hidden input only |

Same steps in the terminal: `npm run setup` (or print them: `npm run setup -- guide aster`), or in the office: **Setup** (top right).

## Mainnet (real money, for LIVE)

1. **Connect your wallet on Aster.** Open Aster and connect MetaMask or Rabby (BNB Chain). [Aster](https://www.asterdex.com/en/trade/pro/futures/BTCUSDT) (sign in / connect wallet first), [MetaMask](https://metamask.io/download/), [Rabby](https://rabby.io/)
2. **Deposit USDT.** Only what you can afford to lose. A completed deposit is required for trading endpoints.
3. **Authorize an API wallet.** Office Connect wallet button (withdraw forced OFF) or by hand on the API wallet page: perp on, spot off, withdraw off. [API wallet](https://www.asterdex.com/en/api-wallet) (sign in / connect wallet first)
4. **Check the permissions.** ON: Pro API agent: perpetual trading. OFF: Withdraw; Spot trading (not needed); Never your main wallet key or seed phrase. Optional IP allowlist when you create the API wallet by hand.
5. **Enter the keys on this computer.** Type them into the hidden prompts of npm run setup or the office Setup wizard (they go into .env, chmod 600): ASTER_USER_ADDRESS, ASTER_SIGNER_PRIVATE_KEY. Or use Connect wallet instead (one signature, nothing to copy). Never paste keys in a chat.
6. **Verify.** npm run doctor (or the Setup wizard "Run doctor") reads the key once: it must say it can trade and cannot withdraw. A key that can withdraw, a main wallet key or a seed phrase is refused.
7. **Switch to LIVE and restart.** LIVE (explicit confirmation) is checked again on every start. Then watch the first order: its stop loss must appear as an open trigger order on Aster.

| .env name | What | Secret |
| --- | --- | --- |
| `ASTER_USER_ADDRESS` | Main account address (public) | no (public) |
| `ASTER_SIGNER_PRIVATE_KEY` | API wallet (agent) private key | yes, hidden input only |

Same steps in the terminal: `npm run setup` (or print them: `npm run setup -- guide aster --network mainnet`), or in the office: **Setup** (top right).

## Verify

```bash
npm run doctor            # one harmless read: can trade, cannot withdraw
npm run setup -- check-key --network testnet
```

Then switch the mode (TESTNET, or LIVE with the typed confirmation) and restart. Watch the first order: its stop loss must show as an open trigger order on the venue. Every TESTNET/LIVE start checks the key again and refuses one that can withdraw.

## Official docs

- [Aster API docs](https://github.com/asterdex/api-docs)
- [Futures authentication](https://asterdex.github.io/aster-api-website/asterCode/authentication/)
- [Agent endpoints (approveAgent, Get Agents: per-agent canWithdraw)](https://asterdex.github.io/aster-api-website/asterCode/endpoints/)

Links checked 2026-10-17. Pages marked "sign in" need your login before they show the form. If a venue moves a page, tell us in an issue.
