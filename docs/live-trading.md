# TESTNET and LIVE trading (full auto)

> **Real money. You can lose it.** This project is a learning tool, not financial advice, and it promises no profit. Agents are wrong often. Exchanges go down, stops slip, APIs change. Only trade an amount you are fine losing, on a sub-account that holds nothing else.

## How it works now

After a one-time setup the desk trades on its own. There is no confirmation phrase, no approval button and no mandatory testnet step. In TESTNET and LIVE the agents open, close, size and set stops and take profits themselves. You watch the office and read the reports.

`npm run setup` asks for the trading mode:

| Mode | What happens |
| --- | --- |
| `PAPER` (default, also when you skip) | Simulated book. Nothing is sent to an exchange. |
| `TESTNET` | Real orders on the exchange testnet, test funds. |
| `LIVE` | Real orders with real money. |

Agents and scripts can pick the mode too: `npm run setup -- --yes --exchange bybit --keys-from-env --trading-mode live`.

## Automatic guards (no human input, cannot be configured to zero)

- **No withdraw permission.** The key is checked on the exchange at setup and again on every start. A key that can withdraw, cannot trade, or whose permissions cannot be read is refused, and the server does not start (exit code 2). Bybit: `/v5/user/query-api`. Binance: `apiRestrictions`. OKX: `account/config`. Hyperliquid: the key must be an approved API agent wallet of your account, never the main wallet key. Aster: a Pro API agent, and the account must report `canWithdraw: false`. dYdX: an API Trading Key whose authenticator allows only place and cancel order messages. Paradex: a registered subkey. Orderly: an ACTIVE Orderly key with scope read,trading only. Main wallet keys and seed phrases are refused everywhere. See [venues.md](venues.md).
- **Stop loss on every order, resting on the exchange.** Attached to the position (Bybit), attached or conditional algo (OKX), closePosition `STOP_MARKET` (Binance, Aster), reduce-only trigger order (Hyperliquid, dYdX, Paradex) or positional TP/SL (Orderly). An order without a stop is refused in code, and an adapter that cannot place an exchange-side stop cannot open at all.
- **Verified after every fill (fail closed).** The executor reads the venue's open trigger orders. A missing stop (or take profit) is placed once; if the stop is still not there, the position is closed at once. A missing take profit is reported but never a reason to drop the stop.
- **Startup reconcile.** On every TESTNET/LIVE start, each open position on the venue must have an exchange-side stop. If one is missing, a stop is placed `PROTECT_STOP_PCT` (default 3, 0.5..20) away from the worse of entry and mark price; if that fails, the position is closed. This covers any position on that account, so keep manual trading on a separate (sub)account. Because stops rest on the exchange, positions stay protected while your laptop is off.
- **Daily loss stop.** Once equity is `DAILY_LOSS_LIMIT_PCT` (default 3, clamped to 0.5..20) below the start of the UTC day, no new orders until the next UTC day. Debates keep running so open positions can still close.
- **Safety net is never touched.** Money Trade = balance minus `SAFETY_NET`. `SAFETY_NET` must be above 0 in TESTNET and LIVE.
- **Max N open positions** (`OPEN_ORDERS_N`, 1 to 4). Allocation per order = (balance minus safety net) / N, recalculated from the exchange balance.
- **One send, no blind retry.** If a send errors or times out, the desk reads the exchange order record and trusts only that.
- **Reconcile from the exchange.** Fills use the exchange average price and size. Positions are re-read every 30 seconds; anything gone on the exchange (stop, take profit, closed by hand) is closed in the local mirror.
- **Kill switch** in the UI (or `POST /api/kill`): stops the auto loop, cancels all orders, flattens every position. It is saved to `data/kill-switch.json` (or `KILL_SWITCH_FILE`), so a restart, a crash restart or autostart keeps it on. The Owner can release it with the local Office OFF button or `npm run unkill -- --yes`. Both require local Owner authority. Release does not submit an order or enable Auto Trading. Remote channels and `gb` cannot release it.
- **Every ticket needs a stop price.** `npm run gb -- open` and a Desk Lead `proposal` without a stop are refused; the stop is used exactly (tick-rounded toward the entry) and refused if wider than `DEFAULT_STOP_PCT` or closer than `MIN_STOP_PCT`.
- **Local only.** In LIVE the server always binds to `127.0.0.1`, whatever `HOST` says.
- **Experimental adapters** (Binance, OKX, Hyperliquid, Aster, dYdX v4, Paradex, Orderly) also need `ALLOW_EXPERIMENTAL_LIVE=yes`, because nobody has verified them on a real account. Bybit does not need it.
- No exchange order on sample data. The desk does not trade positions it did not open, except the startup reconcile above, which only adds a missing stop (or closes if that is impossible).

## The auto loop

With `AUTO_TRADING=on` (off by default; setup asks, or pass `--auto on`) the scheduler starts with the server:

- every `DEBATE_INTERVAL_MIN` (default 15) it runs one debate per symbol in `AUTO_SYMBOLS` (default: the watchlist)
- the verdict executes on its own: open LONG or SHORT, CLOSE, or HOLD
- an open position is closed on a CLOSE verdict, on an opposite signal (it closes first and may re-enter next cycle), when its stop or take profit hits, or after `MAX_HOLD_HOURS` (0 = off)
- a cycle is skipped while the desk is paused or killed

## Reports

Every `REPORT_INTERVAL_MIN` (setup asks, for example 30, 60 or 240) the desk writes a report to `reports/YYYY-MM-DD/` (Markdown and JSON): balance, safety net, Money Trade, N, allocation per order, open positions with entry, stop, take profit and PnL, and everything opened, closed or skipped since the last report, with the reason. Reports show in the **Reports** panel of the office, go to the Grok Bot webhook bridge when it is configured, and to any chat channel you set up for the Desk Lead (Telegram, Discord, Slack, WhatsApp; see [channels.md](channels.md)). Reports pass through the secret redactor.

## Steps

```bash
npm run setup                       # exchange, keys (hidden prompt or env), auto, reports, trading mode
npm run doctor                      # harmless reads, key permission check
npm run doctor --roundtrip          # optional: a real testnet round trip (testnet funds only)
npm run dev
```

To go back to simulation: `npm run setup -- paper`.

The optional round trip places a small market entry with the stop attached on the testnet, reconciles it from the order record, closes it reduce-only, cancels leftovers and confirms flat. It is a good idea before the first LIVE start, but it does not gate anything.

## What is not done

- Bybit is tested against a mocked API only. Binance, OKX, Hyperliquid, Aster, dYdX v4, Paradex and Orderly adapters have never run against a real account (mocked API tests only). Connect wallet was never tried with a real wallet. Watch the first trades closely.
- dYdX order signing depends on the optional official SDK (`npm install @dydxprotocol/v4-client-js`) and was only exercised through a mocked chain interface.
- The desk book is in memory: after a restart it does not remember the stop it chose for a position. The exchange-side stop keeps protecting it, and the startup reconcile adds one where it is missing.
- Partial fills are mirrored at the filled size; there is no smart re-entry.
- No websocket order stream; the desk polls.
- The Telegram report channel is untested.
