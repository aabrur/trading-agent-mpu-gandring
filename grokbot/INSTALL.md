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

- Venue: Bybit (implemented), or Binance, OKX, Hyperliquid (experimental, unverified).
- Network: PAPER (default), TESTNET or LIVE.
- Exchange key: through the platform's secret request card only. Never paste it in chat. Create it with **trading permission only, withdrawals off**. A key that can withdraw is refused automatically.
- Safety net (never traded), N (1 to 4 open positions), markets, max leverage, daily loss stop, report cadence (for example every 30, 60 or 240 minutes).

## What you get

- A group chat called "Trading Agent Mpu Gandring" with Desk Lead, Market Analyst, Research Analyst, Strategist, Risk Manager and Execution Trader.
- A trading loop every 15 minutes. Each cycle starts with the proaktif-agent scan and ends with the self-improving reflection, on its own.
- Periodic reports with balance, safety net, Money Trade, N, allocation, positions, what was opened, closed and skipped, a per-role scorecard and lessons this period.
- Optional: the office web view (`npm start`, port 8787) where you watch the agents talk and fight live.

## Show the office

Ask your Grok Bot "show me the office". It starts the web UI on its own computer in the background (`APP_MODE=grokbot npm run office`, left running; `npm run office:status` says whether it is up and on which ports), opens http://localhost:5173 in its desktop browser and sends you a screenshot. To watch live, open the bot's desktop view.

To stop everything at once: tell the Desk Lead "kill switch", or `npm run gb -- close all` and pause the routines.
