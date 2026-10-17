# Install Trading Agent Mpu Gandring in Grok Bot

In Grok Bot mode you need **no AI model API keys**. Six Grok Bot agents are the employees and the brains. The app in this repo only draws the office, keeps the book, enforces the guards and talks to the exchange.

> Risk warning. After the one-time setup the desk trades on its own (full auto, no approval step). On TESTNET that is test money, on LIVE it is real money and you can lose it. Not financial advice. No profit promised.

## Option A: template (one click)

Open the template link: `https://x.ai/bot/fX91UALWOlFMk_Oj2LBjn`

The template bot reads [BOOTSTRAP.md](BOOTSTRAP.md) and does everything below by itself: clones the repo, creates the six employees and their group chat, saves the two learning skills, interviews you once, and starts the trading loop and the reports.

## Option B: manual

Tell your Grok Bot:

> Read https://github.com/aabrur/trading-agent-mpu-gandring/blob/main/grokbot/BOOTSTRAP.md and follow it exactly to set up Trading Agent Mpu Gandring for me.

## What you will be asked (once)

- Venue: CEX Bybit (implemented), Binance, OKX; or DEX Hyperliquid, Aster, dYdX v4, Paradex, Orderly. All except Bybit are experimental and unverified. DEX venues take only a delegated trade-only key, never your main wallet key or seed.
- Network: PAPER (default), TESTNET or LIVE.
- Step-by-step venue links (sign-up, test funds, key page, permissions), one at a time. Same text as `docs/setup/<venue>.md`.
- Exchange key: through the platform's secret request card only. Never paste it in chat. Create it with **trading permission only, withdrawals off**. A key that can withdraw is refused automatically.
- Safety net (never traded), N (1 to 4 open positions), markets, max leverage, daily loss stop, report cadence (for example every 30, 60 or 240 minutes).

## What you get

- A group chat called "Trading Agent Mpu Gandring" with Desk Lead, Market Analyst, Research Analyst, Strategist, Risk Manager and Execution Trader.
- A trading loop every 15 minutes. Each cycle starts with the proaktif-agent scan and ends with the self-improving reflection, on its own.
- Periodic reports with balance, safety net, Money Trade, N, allocation, positions, what was opened, closed and skipped, a per-role scorecard and lessons this period.
- Optional: the office web view (`npm start`, port 8787) where you watch the agents talk and fight live.

## Setting up on your own computer instead

On your own computer (local mode) you can do the same setup in a terminal with `npm run setup` or in the office with the **Setup** button; see [docs/setup/README.md](../docs/setup/README.md) and the CLI/office table in [AGENTS.md](../AGENTS.md#cli-and-office-parity). Connect wallet (Hyperliquid, Aster) works there; in Grok Bot mode keys go only through the secret card.

## Show the office

Ask your Grok Bot "show me the office". It starts the web UI on its own computer in the background (`APP_MODE=grokbot npm run office`, left running; `npm run office:status` says whether it is up and on which ports), opens http://localhost:5173 in its desktop browser and sends you a screenshot. To watch live, open the bot's desktop view.

To stop everything at once: tell the Desk Lead "kill switch". It calls the office kill switch (`curl -s -X POST http://127.0.0.1:8787/api/kill`: cancel, flatten, stop) and pauses the routines. The kill switch stays on, also after a restart, until you run `npm run unkill -- --yes` in a terminal on that computer and restart the office.
