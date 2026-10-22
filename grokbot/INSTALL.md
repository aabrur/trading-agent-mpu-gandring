# Install Trading Agent Mpu Gandring in Grok Bot

Grok Bot mode runs **on Grok Bot's computer**, not on your laptop. The bot clones this repo, stores keys, starts the office, and runs the trading loop there. Your laptop can stay off.

You need **no AI model API keys**. Six Grok Bot agents are the employees and the brains. The app in this repo only draws the office, keeps the book, enforces the guards and talks to the exchange.

> Risk warning. After the one-time setup the desk trades on its own (full auto, no approval step). On TESTNET that is test money, on LIVE it is real money and you can lose it. Not financial advice. No profit promised.

## Option A: template (one click)

Open the template link: `https://x.ai/bot/fX91UALWOlFMk_Oj2LBjn`

Send the new bot any first message (for example "hi"). It starts [BOOTSTRAP.md](BOOTSTRAP.md) right away on **its own computer**; you do not paste anything. The installed bot turns itself into the **Head of Trading** and creates the other five, so you get exactly six agents, not seven. Then it clones the repo, saves the two learning skills, creates the group chat, kicks off the five (each posts an intro in the group), starts the office web UI, interviews you once, and asks you to confirm before the desk trades on its own. Only the Head of Trading talks to you; the others work in the group.

## Option B: manual

Tell your Grok Bot:

> Read https://github.com/aabrur/trading-agent-mpu-gandring/blob/main/grokbot/BOOTSTRAP.md and follow it exactly to set up Trading Agent Mpu Gandring for me. Run it on your computer, not on mine.

## What you will be asked (once)

- Venue: CEX Bybit (implemented), Binance, OKX; or DEX Hyperliquid, Aster, dYdX v4, Paradex, Orderly. All except Bybit are experimental and unverified. DEX venues take only a delegated trade-only key, never your main wallet key or seed.
- Network: PAPER (default), TESTNET or LIVE.
- Step-by-step venue links (sign-up, test funds, key page, permissions), one at a time. Same text as `docs/setup/<venue>.md`.
- Exchange key: through the platform's secret request card only, on Grok Bot. Never paste it in chat. Never put it in a file on your laptop. Create it with **trading permission only, withdrawals off**. A key that can withdraw is refused automatically.
- Safety net (never traded), N (1 to 4 open positions), markets, max leverage, daily loss stop, report cadence (for example every 30, 60 or 240 minutes).

## What you get

- A group chat called "Trading Agent Mpu Gandring" with Head of Trading, Technical Market, Macro Research, Trading Systems, Head of Risk and Execution Trader.
- A trading loop every 15 minutes on Grok Bot's computer. Each cycle starts with the proaktif-agent scan and ends with the self-improving reflection, on its own.
- Periodic reports with balance, safety net, Money Trade, N, allocation, positions, what was opened, closed and skipped, a per-role scorecard and lessons this period.
- Optional: the office web view on Grok Bot's computer (`npm start`, port 8787) where you watch the agents talk and fight live. Ask "show me the office".

## Show the office

Ask your Grok Bot "show me the office". It starts the production office **on its own computer** in the background (`APP_MODE=grokbot npm start`, left running), opens http://127.0.0.1:8787 in its desktop browser and sends you a screenshot. To watch live, open the bot's desktop view. Do not start `npm run dev` or `npm run office` on your laptop for this mode.

To stop everything at once: tell the Head of Trading "kill switch". It calls the office kill switch on Grok Bot's computer (`curl -s -X POST http://127.0.0.1:8787/api/kill`: cancel, flatten, stop) and pauses the routines. The kill switch stays on, also after a restart, until you tell Grok Bot to run `npm run unkill -- --yes` in that workspace and restart `npm start`. The Head of Trading never releases the kill switch itself.

## Setting up on your own computer instead (local mode)

That is a different product path. Local mode runs models or CLI agents on **your** laptop. Use `npm run setup` or the office **Setup** button; see [docs/setup/README.md](../docs/setup/README.md) and [AGENTS.md](../AGENTS.md). Connect wallet (Hyperliquid, Aster) works there. Do not mix that with Grok Bot mode.
