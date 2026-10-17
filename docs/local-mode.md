# Local mode: run it on your own computer

Local mode is the default. The agents run on model APIs you choose, from your computer.

## Setup in one command

```bash
npm install
npm run setup     # interactive wizard, writes .env
npm run doctor    # checks every key with a harmless read, never prints a secret
npm run trade     # backend + office UI, full auto ON, prints the office URL
```

`npm run dev` still works for development (hot reload, UI on port 5173).

The wizard asks, one section at a time:

1. **Who drives the agents**: `local` or `grokbot` ([grokbot-mode.md](grokbot-mode.md)).
2. **Model keys**: xAI, OpenAI, Anthropic, Gemini, DeepSeek, OpenRouter. Hidden input, Enter skips. Then a default provider and, if you want, one provider per agent so they argue with different brains.
3. **TradingView**: the chart widget, and the alert webhook (it generates the passphrase).
4. **Plugins**: an optional news feed.
5. **Venue**, grouped: CEX (Bybit, Binance, OKX) or DEX (Hyperliquid, Aster, dYdX v4, Paradex, Orderly), or none. Then testnet keys and (optionally) mainnet keys. Public addresses are shown as you type; secrets are hidden. A main wallet key or a seed phrase is refused on the spot where it can be detected locally, and again by the venue check.
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

Other flags: `--dotenv path` (default .env), `--market-source bybit|binance|hyperliquid|aster|dydx|paradex|orderly|sample`, `--generate-agent-secret`. With `--keys-from-env`, venue keys that fail the local main-key check are dropped, not saved.

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

All venues sit behind one interface, `server/exchange/types.ts` (`ExchangeAdapter`): ping, permissions, balance, instrument, ticker, placeOrder (with stop attached), getOrder (reconcile), positions, closePosition (reduce-only), cancelAll, and the exchange-side protection pair `protection()` / `protect()`. Full venue notes, official doc links and skipped venues: [venues.md](venues.md).

| Venue | Status | Testnet | Withdraw check |
| --- | --- | --- | --- |
| Bybit (USDT perps) | **Implemented**, tested against a mocked Bybit API | api-testnet.bybit.com | `/v5/user/query-api`, refuses `Wallet: Withdraw` and read-only keys |
| Binance (USD-M futures) | Experimental, untested on a real account | Demo Trading, demo-fapi.binance.com (override with `BINANCE_TESTNET_BASE_URL`) | `/sapi/v1/account/apiRestrictions` `enableWithdrawals` |
| OKX (USDT swaps) | Experimental, untested on a real account | demo trading (`x-simulated-trading`) | `/api/v5/account/config` `perm` |
| Hyperliquid (perps) | Experimental, untested on a real account | api.hyperliquid-testnet.xyz | must be an approved API agent wallet (`extraAgents`), never the main wallet key |
| Aster (perps, API v3) | Experimental, untested on a real account | fapi.asterdex-testnet.com | Pro API agent wallet, not the main key; `/fapi/v3/account` must report `canWithdraw: false` |
| dYdX v4 (perps) | Experimental, untested on a real account | indexer.v4testnet.dydx.exchange | API Trading Key whose authenticator allows only place/cancel order messages; owner key refused |
| Paradex (perps) | Experimental, untested on a real account | api.testnet.paradex.trade | must be a registered, non revoked subkey (subkeys cannot withdraw) |
| Orderly (perps) | Experimental, untested on a real account | testnet-api.orderly.org | Orderly key ACTIVE, scope only read,trading (Orderly keys cannot withdraw) |

Keys go in `.env`. CEX: `<VENUE>[_TESTNET]_API_KEY`, `<VENUE>[_TESTNET]_API_SECRET` (plus `OKX[_TESTNET]_API_PASSPHRASE`). DEX:

- Hyperliquid: `HYPERLIQUID[_TESTNET]_ACCOUNT_ADDRESS` (main address, public), `HYPERLIQUID[_TESTNET]_AGENT_PRIVATE_KEY`
- Aster: `ASTER[_TESTNET]_USER_ADDRESS` (main address, public), `ASTER[_TESTNET]_SIGNER_PRIVATE_KEY`
- dYdX v4: `DYDX[_TESTNET]_ADDRESS` (dydx1..., public), `DYDX[_TESTNET]_API_PRIVATE_KEY`, `DYDX[_TESTNET]_AUTHENTICATOR_ID`. To trade on dYdX also run `npm install @dydxprotocol/v4-client-js`.
- Paradex: `PARADEX[_TESTNET]_ACCOUNT_ADDRESS` (public), `PARADEX[_TESTNET]_SUBKEY_PRIVATE_KEY`
- Orderly: `ORDERLY[_TESTNET]_ACCOUNT_ID` (public), `ORDERLY[_TESTNET]_KEY_SECRET`

**Stops live on the exchange.** In TESTNET and LIVE every stop loss (and take profit if set) is placed on the venue, not just tracked by the app: Bybit attaches it to the position, OKX uses attached or conditional algo orders, Binance and Aster use closePosition `STOP_MARKET` orders, Hyperliquid, dYdX and Paradex use reduce-only trigger orders, Orderly uses a positional TP/SL. After every fill the app reads the venue's open orders; a missing stop is re-placed once, then the position is closed if it still is not there (fail closed). On every start, positions without an exchange-side stop get one (`PROTECT_STOP_PCT`, default 3) or are closed.

## Connect wallet (DEX, experimental)

The office has a **Venue keys** panel (right column).

- **Hyperliquid and Aster:** press Connect wallet. Your browser wallet (MetaMask, Rabby or any injected EIP-1193 wallet) shares your MAIN address, for display and for `.env`. The app makes a fresh agent key on this computer (server side) and shows the agent address. You sign one approval in your wallet: Hyperliquid `ApproveAgent`, or Aster `registerAndApproveAgent` with withdraw forced OFF (Aster asks for BNB Chain, chain id 56). The app checks the signature is from your address, submits it, and saves the agent key and your main address to `.env` (chmod 600). Restart (`npm run trade`) to use it. Revoke any time on the venue's API wallet page (link in the panel).
- **dYdX, Paradex, Orderly:** the panel shows how to create the delegated key in the venue's own app, then you paste it into `npm run setup`.
- **CEX:** no wallet; the panel shows the API key steps.
- The main wallet private key or seed is never requested, exported or stored. Any request body that contains something shaped like a private key or a seed phrase is refused.
- Only works when the office is bound to 127.0.0.1 and opened from this computer (`http://127.0.0.1:8787` or `http://localhost:8787`). In Grok Bot mode it is off; use the Grok Bot secret card for keys.
- Experimental, untested on real wallets. The server side is covered by tests with a mocked signer.

## One command: `npm run trade`

`npm run trade` builds once if needed, then starts the backend with the built office UI on the same port, with full auto ON (local mode runs its own debate and trade loop; Grok Bot mode just starts the office and your Grok Bot team drives it). It reads your saved `.env` and prints the office URL, for example `http://127.0.0.1:8787`. Ctrl+C stops it. If a safety guard refuses to start (for example a key that can withdraw), it exits with code 2 and says why.

## Autostart on laptop login (optional)

```bash
npm run autostart:install    # install and start
npm run autostart:status
npm run autostart:remove
npm run autostart:install -- --dry-run   # preview the service file
```

| OS | What it installs |
| --- | --- |
| macOS | launchd agent `~/Library/LaunchAgents/com.mpugandring.trading-agent.plist` (RunAtLoad, KeepAlive on crash, log in `~/Library/Logs/trading-agent-mpu-gandring.log`) |
| Windows | Task Scheduler task `TradingAgentMpuGandring`, at logon (schtasks) |
| Linux | systemd user unit `~/.config/systemd/user/trading-agent-mpu-gandring.service` (Restart=on-failure). For start at boot before login: `loginctl enable-linger $USER` |

The service runs `npm run trade` in service mode: it restarts the backend on a crash with a growing pause, and stops for good after a safety guard refusal instead of looping. The service file holds no keys; it only points at this folder, and the app reads `.env` from here.

> Local trading runs only while the laptop is on and awake. A sleeping or shut down laptop does not trade (your exchange-side stops still protect open positions). Grok Bot mode runs in the cloud with the laptop off.

Exchange keys are only used for `npm run doctor`, the optional `npm run doctor --roundtrip`, TESTNET and LIVE. In PAPER nothing is ever sent to an exchange. Going live: [live-trading.md](live-trading.md).
