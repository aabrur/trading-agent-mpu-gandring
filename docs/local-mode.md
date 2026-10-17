# Local mode: run it on your own computer

Local mode is the default. The agents run on model APIs you choose, from your computer.

## Setup in one command

```bash
npm install
npm run setup     # interactive wizard, writes .env
npm run doctor    # checks every key with a harmless read, never prints a secret
npm run dev
```

The wizard asks, one section at a time:

1. **Who drives the agents**: `local` or `grokbot` ([grokbot-mode.md](grokbot-mode.md)).
2. **Model keys**: xAI, OpenAI, Anthropic, Gemini, DeepSeek, OpenRouter. Hidden input, Enter skips. Then a default provider and, if you want, one provider per agent so they argue with different brains.
3. **TradingView**: the chart widget, and the alert webhook (it generates the passphrase).
4. **Plugins**: an optional news feed.
5. **Exchange**: none, Bybit, Binance, OKX or Hyperliquid, with testnet keys and (optionally) mainnet keys.
6. **Money**: paper balance, safety net, N (1 to 4), daily loss stop.
7. **Full auto and reports**: `AUTO_TRADING` (default on), minutes between debate cycles, optional max holding time, minutes between reports, and an optional Telegram bot for reports (experimental).
8. **Trading mode**: PAPER (default, also when you just press Enter), TESTNET or LIVE. For TESTNET and LIVE the key is checked on the exchange first and refused if it can withdraw.

Every auto cycle starts with the proaktif-agent scan (loss cap usage, missing stops, errors, stale data, safety net) and ends with the self-improving reflection, which writes lessons to `data/learnings.json` and promotes a lesson seen 3 times into a standing rule for that agent. Both are on by default (`LEARNING`, `PROACTIVE_SCAN`) and shown in the office Lessons panel. Lessons can never loosen a guard.

After this one-time setup the desk runs on its own: it debates every interval, opens, closes and sizes positions without asking, and writes a report to `reports/` and the Reports panel. See [live-trading.md](live-trading.md) before choosing LIVE.

### Non-interactive (for coding agents)

```bash
npm run setup -- --yes \
  --app-mode local \
  --default-provider xai --agent risk=anthropic --agent research=gemini \
  --model risk=claude-sonnet-4-5 \
  --tradingview-widget on --tradingview-webhook on \
  --news sample --exchange bybit \
  --balance 1000 --safety-net 200 --n 4 --daily-loss 3 \
  --auto on --debate-interval 15 --max-hold 0 --report-interval 60 \
  --trading-mode paper \
  --keys-from-env
```

`--keys-from-env` copies keys that are already set in the shell environment (for example from the agent platform's secret store) into `.env`. Keys are never accepted as command line flags, so they do not end up in shell history.

Other flags: `--dotenv path` (default .env), `--market-source bybit|binance|hyperliquid|sample`, `--generate-agent-secret`.

`npm run setup -- status` prints what is configured with secrets masked.

## TradingView

**Chart widget.** `TRADINGVIEW_WIDGET=on` adds a "TradingView" tab next to the desk chart. It loads the free TradingView Advanced Chart widget from tradingview.com in your browser, for symbol `<TRADINGVIEW_EXCHANGE_PREFIX>:<SYMBOL>.P` (default `BYBIT:BTCUSDT.P`). The desk chart stays the one with entry, stop and take profit lines.

**Alert webhook.** Set `TRADINGVIEW_PASSPHRASE` (the wizard generates one). In TradingView, create an alert, turn on Webhook URL, point it at `https://<your-host>/api/tradingview`, and use this message:

```json
{ "passphrase": "<from .env>", "symbol": "{{ticker}}", "action": "{{strategy.order.action}}", "price": {{close}}, "note": "{{strategy.order.comment}}" }
```

What happens:

- wrong passphrase: `401`
- more than one alert per symbol per minute: `429`
- otherwise the alert is logged, forwarded to the Grok Bot bridge as `kind=signal`, and **starts a normal debate** on that symbol. The agents see it as `externalSignal` marked untrusted. Risk still gates, the money split and stop still apply. An alert never places an order by itself.

TradingView only sends webhooks to ports 80 and 443, so you need a tunnel or a reverse proxy with HTTPS in front of port 8787.

## Plugins

| Plugin | Env | Status |
| --- | --- | --- |
| CryptoPanic news | `NEWS_PROVIDER=cryptopanic`, `CRYPTOPANIC_API_KEY` | Optional, experimental. Headlines go through the same untrusted-text filter as the sample feed. Falls back to sample news on any error. If CryptoPanic moves its API, set `CRYPTOPANIC_BASE_URL`. |

## Exchanges

All venues sit behind one interface, `server/exchange/types.ts` (`ExchangeAdapter`): ping, permissions, balance, instrument, ticker, placeOrder (with stop attached), getOrder (reconcile), positions, closePosition (reduce-only), cancelAll.

| Venue | Status | Testnet | Withdraw check |
| --- | --- | --- | --- |
| Bybit (USDT perps) | **Implemented**, tested against a mocked Bybit API | api-testnet.bybit.com | `/v5/user/query-api`, refuses `Wallet: Withdraw` and read-only keys |
| Binance (USD-M futures) | Experimental, untested on a real account | testnet.binancefuture.com (override with `BINANCE_TESTNET_BASE_URL`) | `/sapi/v1/account/apiRestrictions` `enableWithdrawals` |
| OKX (USDT swaps) | Experimental, untested on a real account | demo trading (`x-simulated-trading`) | `/api/v5/account/config` `perm` |
| Hyperliquid (perps) | Experimental, untested on a real account | api.hyperliquid-testnet.xyz | must be an approved API agent wallet (`extraAgents`), never the main wallet key |

Keys go in `.env` as `<VENUE>_TESTNET_API_KEY`, `<VENUE>_TESTNET_API_SECRET`, `<VENUE>_API_KEY`, `<VENUE>_API_SECRET` (plus `_API_PASSPHRASE` for OKX). Hyperliquid uses `HYPERLIQUID[_TESTNET]_ACCOUNT_ADDRESS` (your main address, public) and `HYPERLIQUID[_TESTNET]_AGENT_PRIVATE_KEY` (the API agent wallet).

Exchange keys are only used for `npm run doctor`, the optional `npm run doctor --roundtrip`, TESTNET and LIVE. In PAPER nothing is ever sent to an exchange. Going live: [live-trading.md](live-trading.md).
