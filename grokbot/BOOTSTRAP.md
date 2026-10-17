# BOOTSTRAP: steps a Grok Bot follows to set up Trading Agent Mpu Gandring

Follow these steps in order. Use only the name "Trading Agent Mpu Gandring". Keep the owner informed in short plain messages. Never ask for, accept or store an exchange key with withdrawal permission. Collect keys only through the platform secret request card, never in chat, never in a file you write from a chat message.

## 1. Get the app

```bash
git clone https://github.com/aabrur/trading-agent-mpu-gandring.git /workspace/trading-agent-mpu-gandring-app
cd /workspace/trading-agent-mpu-gandring-app
npm install
npm run build
```

## 2. Save the two learning skills

Save these files as skills in this Grok Bot, with the names shown, so every employee can use them:

- `grokbot/skills/proaktif-agent.md` as skill **proaktif-agent**
- `grokbot/skills/self-improving.md` as skill **self-improving**

## 3. Create the six employees

Use CreateAgent once per file. Name, then instructions = the full file text, then attach both skills:

| Agent name | Instructions |
| --- | --- |
| Desk Lead | `grokbot/roles/desk-lead.md` |
| Market Analyst | `grokbot/roles/market-analyst.md` |
| Research Analyst | `grokbot/roles/research-analyst.md` |
| Strategist | `grokbot/roles/strategist.md` |
| Risk Manager | `grokbot/roles/risk-manager.md` |
| Execution Trader | `grokbot/roles/execution-trader.md` |

Then create one group chat named **Trading Agent Mpu Gandring** with all six (the platform allows up to six members). The Desk Lead also keeps the journal and does the post-trade review; there is no seventh agent.

## 4. One-time setup interview

Ask the owner, one question at a time, and show the default in brackets:

1. Venue [bybit], shown in two groups:
   - CEX: `bybit` (implemented), `binance`, `okx`
   - DEX (perp DEX, delegated trade-only keys): `hyperliquid`, `aster`, `dydx`, `paradex`, `orderly`

   Say that every venue except Bybit is experimental and unverified (never run on a real account), and needs `ALLOW_EXPERIMENTAL_LIVE=yes` for LIVE. For a DEX say plainly: only a delegated key that cannot withdraw (agent wallet, API trading key, subkey, Orderly key), never the main wallet private key or seed phrase. Stops always rest on the exchange. dYdX also needs `npm install @dydxprotocol/v4-client-js` in the app folder before TESTNET or LIVE. In Grok Bot mode the office Connect wallet button is off; keys come only through the secret card. Details: `docs/venues.md`.
2. Network [PAPER]: PAPER, TESTNET or LIVE. Recommend PAPER first, then TESTNET, LIVE last. For LIVE say plainly: the desk will trade real money on its own, losses are possible, not financial advice, and ask the owner to type "I understand LIVE trades real money" themselves; pass it as `--confirm-live "..."`.
   For TESTNET or LIVE, walk the owner through the venue **one step and one direct link at a time**: run `npm run setup -- guide <venue> --network testnet` (or `--network mainnet`) and send each step (sign-up, test funds, key/agent/subkey page, permissions to tick) as its own message; wait for "done". The same text is in `docs/setup/<venue>.md`. Each owner uses their OWN account and keys.
3. Exchange key (TESTNET or LIVE only): request it with the **secret request card**, named exactly as the app expects. Mainnet names below; for TESTNET insert `_TESTNET` after the prefix (for example `BYBIT_TESTNET_API_KEY`, `ASTER_TESTNET_SIGNER_PRIVATE_KEY`).

   | Venue | Secret card names |
   | --- | --- |
   | bybit | `BYBIT_API_KEY`, `BYBIT_API_SECRET` |
   | binance | `BINANCE_API_KEY`, `BINANCE_API_SECRET` |
   | okx | `OKX_API_KEY`, `OKX_API_SECRET`, `OKX_API_PASSPHRASE` |
   | hyperliquid | `HYPERLIQUID_ACCOUNT_ADDRESS` (main address, public), `HYPERLIQUID_AGENT_PRIVATE_KEY` (approved API agent wallet) |
   | aster | `ASTER_USER_ADDRESS` (main address, public), `ASTER_SIGNER_PRIVATE_KEY` (Pro API agent, perp trading on, withdraw off) |
   | dydx | `DYDX_ADDRESS` (dydx1..., public), `DYDX_API_PRIVATE_KEY` (API Trading Key), `DYDX_AUTHENTICATOR_ID` (number) |
   | paradex | `PARADEX_ACCOUNT_ADDRESS` (public), `PARADEX_SUBKEY_PRIVATE_KEY` (registered subkey) |
   | orderly | `ORDERLY_ACCOUNT_ID` (public), `ORDERLY_KEY_SECRET` (Orderly key, scope read,trading) |

   Remind the owner: trading permission only, withdrawals off, never the main wallet key or seed. The app refuses anything else at setup and at every start.
4. Starting paper balance [1000] (PAPER only; other modes read the exchange balance), safety net [200], N open positions 1 to 4 [4].
5. Markets [BTCUSDT,ETHUSDT,SOLUSDT], max leverage [3], daily loss stop percent [3], max loss per trade percent [1].
6. Report cadence in minutes [60].

Then run setup with flags. Do **not** use `--keys-from-env`: the keys stay in the secret store and reach the app as environment variables.

```bash
cd /workspace/trading-agent-mpu-gandring-app
npm run setup -- --yes --app-mode grokbot --generate-agent-secret \
  --exchange bybit --trading-mode paper \
  --balance 1000 --safety-net 200 --n 4 --daily-loss 3 \
  --auto on --report-interval 60
```

Then write the remaining choices into `.env` (plain values, no secrets): `WATCHLIST=...`, `AUTO_SYMBOLS=...`, `MAX_LEVERAGE=...`, `MAX_LOSS_PER_TRADE_PCT=...`. Run `npm run doctor` and tell the owner the result in plain words (it must say the key can trade and cannot withdraw). After the first TESTNET/LIVE order, check `npm run gb -- positions --json`: every position must have a stop, and the venue must show it as an open trigger order. Refuse main wallet private keys, seed phrases and withdraw-enabled keys, even if the owner insists. If setup exits with code 2 the key was refused (it can withdraw, cannot trade, is a main wallet key, or is missing): tell the owner why and stay in PAPER. Never work around a refusal.

Start the office in the background and check it:

```bash
nohup npm start > /workspace/trading-agent-mpu-gandring-app/office.log 2>&1 &
sleep 3 && curl -s http://127.0.0.1:8787/api/health
npm run gb -- event lead "Desk is set up. First cycle soon." --json
```

## 5. Routines

Create two routines owned by the Desk Lead.

**Trading loop, every 15 minutes:**

> You are the Desk Lead of Trading Agent Mpu Gandring. Work in /workspace/trading-agent-mpu-gandring-app. If `curl -s http://127.0.0.1:8787/api/health` fails, start the office with `nohup npm start > office.log 2>&1 &` and wait 3 seconds.
> 1. Run the proaktif-agent skill first: `npm run gb -- scan --json`, `npm run gb -- account --json`, `npm run gb -- positions --json`, `npm run gb -- lessons list --json`. Post any warn or alert to the group chat "Trading Agent Mpu Gandring".
> 2. For each market in AUTO_SYMBOLS: ask Market Analyst, Research Analyst and Strategist in the group for a stance; each posts it to the office with `npm run gb -- event <role> "<text>" --stance X --confidence Y`. Decide OPEN_LONG, OPEN_SHORT, CLOSE or HOLD and post `npm run gb -- event lead "<verdict>"`. For an open, Risk Manager sizes it with `npm run gb -- size ...` and Execution Trader places it with `npm run gb -- open ... --stop ... --tp ...`. For a close, Execution Trader runs `npm run gb -- close <symbol>`.
> 3. Run the self-improving skill last: for every loss, stop hit, error, refusal or owner correction this cycle, `npm run gb -- lessons add <role> "<lesson>" --kind loss|stop|error|correction --happened "<facts>" --cause "<root cause>"`. The app promotes a lesson seen three times into a standing rule. Never write a lesson that loosens a guard; the app refuses those.
> No approval step. Never loosen a guard, never resend a refused order, never touch withdrawals. Not financial advice.

**Report, at the owner's cadence:**

> You are the Desk Lead of Trading Agent Mpu Gandring. In /workspace/trading-agent-mpu-gandring-app run `npm run gb -- report`. Send the text to the owner. Add one line on which employee is doing well or badly from the scorecard, and the lessons this period. Not financial advice, no profit promises.

## 6. Show the office

When the owner asks to see the web UI (the virtual office with the six agents):

1. Start it on your own computer in the background and leave it running:

   ```bash
   cd /workspace/trading-agent-mpu-gandring-app
   npm run office:status || (APP_MODE=grokbot nohup npm run office > office.log 2>&1 &)
   sleep 8 && npm run office:status
   ```

   `npm run office` starts the backend (port 8787) and the UI (port 5173) together. If the office from step 4 (`npm start`) is already running on 8787, stop it first or the backend port is taken; the UI on 5173 talks to whichever backend is on 8787.
2. Open http://localhost:5173 in your desktop browser, wait until the agents are drawn, and send the owner a screenshot.
3. For live viewing, tell the owner to open your desktop view; the office keeps updating as the agents post `npm run gb -- event ...` lines.

Never expose the office to the internet. It binds locally in LIVE.

## 7. Hand over

Tell the owner: the mode and venue, the markets, the money split (Money Trade = balance - safety net, per order = Money Trade / N), the report cadence, how to watch the office (port 8787 on this box), and how to stop: say "kill switch" to the Desk Lead. It runs `curl -s -X POST http://127.0.0.1:8787/api/kill` (cancels, flattens and stops the desk; it stays on across restarts until the owner runs `npm run unkill -- --yes` in a terminal and restarts the office) and pauses the routines. The Desk Lead never releases the kill switch itself. Automatic guards: no-withdraw key check at setup and every start, stop loss on every order, daily loss stop until the next UTC day, safety net untouched, max N positions, no blind retries, reconcile from the exchange, kill switch.
