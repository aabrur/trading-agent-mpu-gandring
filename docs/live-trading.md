# LIVE trading (locked by default)

> **Real money. You can lose it.** This project is a learning tool, not financial advice, and it promises no profit. Agents are wrong often. Exchanges go down, stops slip, APIs change. Only trade an amount you are fine losing, on a sub-account that holds nothing else.

PAPER is the default and stays the default. LIVE unlocks only when **all** of these are true, and the server checks them on every start:

1. **Testnet first.** A real round trip on the exchange's testnet passed: place a market entry with the stop attached, reconcile it from the exchange's order record, see the position, close it reduce-only, cancel leftovers, confirm flat.
2. **No withdraw permission.** The mainnet key was checked on the exchange API and cannot withdraw. Bybit: `/v5/user/query-api` (refuses `Withdraw`, refuses read-only keys). Binance: `apiRestrictions`. OKX: `account/config`. Hyperliquid: the key must be an approved API agent wallet of your account, and not your main wallet key.
3. **A person typed it.** In a real terminal: `I UNDERSTAND LIVE TRADING CAN LOSE MONEY`.

Then the CLI writes `TRADING_MODE=LIVE` and `LIVE_CONFIRMED` to `.env`. You cannot get there by editing `.env`:

- Each step is a signed record in `.mpu-gandring/live-state.json`, signed with a random install key that only exists on your computer (`.mpu-gandring/install.key`, gitignored).
- `LIVE_CONFIRMED` is a signature over all three records plus a fingerprint of the current mainnet key.
- Change the key, hand-edit the state, or copy a config from someone else, and the server refuses LIVE with exit code 2.
- On start, the server asks the exchange about the key again and refuses if anything changed.

This protects against accidents and copy-paste. It is not a lock against the owner of the computer, who can always change the code.

Experimental adapters (Binance, OKX, Hyperliquid) also need `ALLOW_EXPERIMENTAL_LIVE=yes`.

## Steps

```bash
npm run setup                       # pick the exchange, enter testnet and mainnet keys (trade only, no withdraw)
npm run doctor                      # harmless reads on both keys
npm run setup -- testnet            # step 1, uses TESTNET funds only
npm run setup -- check-key          # step 2, mainnet key permissions
npm run setup -- unlock-live        # step 3, needs a person at a terminal
npm run dev
```

`unlock-live` refuses to run without a terminal, so a script or coding agent cannot unlock LIVE for you. To go back: `npm run setup -- lock`.

## What stays the same in LIVE

Every order still goes through:

- the debate and the **Risk gate** (code caps can only tighten)
- the **money split**: Money Trade = balance minus safety net, split over N (1 to 4), recalculated from the exchange balance
- a **mandatory stop loss**, attached to the order on the exchange (Bybit, OKX, Hyperliquid) or placed right after the fill (Binance, which closes the entry if the stop fails)
- the **daily loss stop** (`DAILY_LOSS_LIMIT_PCT`, default 3)
- **one send, no blind retry**: if a send errors or times out, the desk reads the exchange's order record and trusts only that
- **reconcile from the exchange**: fills use the exchange's average price and size; positions are re-read every 30 seconds, and anything gone on the exchange (stop, take profit, closed by hand) is closed in the local mirror
- a big red **LIVE** badge in the top bar and a **Kill switch** button (or `POST /api/kill`): cancel all orders, flatten every position, pause the desk until restart

Other LIVE rules:

- No LIVE order on sample data.
- The backend binds to `127.0.0.1` unless you set `HOST`.
- The desk never touches a position it did not open; it only warns about it.

## What is not done

- Binance, OKX and Hyperliquid adapters have never run against a real account. Run the testnet round trip and watch the first live trades closely.
- Partial fills are mirrored at the filled size, there is no smart re-entry.
- No websocket order stream; the desk polls.
