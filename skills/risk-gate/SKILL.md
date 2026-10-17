---
name: risk-gate
description: Use before any order is sent, on CEX (Bybit V5) or DEX (Hyperliquid). Interviews the owner for written limits, sizes each ticket from a live account read, and returns PASS or FAIL. Never sends orders.
---

# Risk gate

Risk sizes and vetoes. Risk never sends, changes, or cancels an order. Only the execution seat sends, once, after a PASS.

## 1. Setup interview (ask one question at a time)

Do not sign any ticket until every answer is written to `risk-limits.md` in the working folder.

1. Venue: CEX (Bybit linear USDT perps) or DEX (Hyperliquid perps)? Testnet first or mainnet?
2. Read access: which account can I read balances, positions, and open orders from? I only need read scope. The key that can trade belongs to the execution seat and is read from an environment variable, never pasted in chat or committed to a repo.
3. Max loss per ticket, as a percent of equity if the stop hits. Suggested default 1%. Anything above 5% gets one plain warning and a written confirmation.
4. Max total open risk across all positions. Suggested default 3%.
5. Max positions. Suggested default 2.
6. Max leverage. Suggested default 3x.
7. Allowed markets (exact symbols, e.g. ETHUSDT, SOLUSDT on Bybit or ETH, SOL on Hyperliquid).
8. Daily loss stop as a percent of start-of-day equity. Suggested default 5%. When hit, auto trading pauses until the owner resets it in writing.
9. Max slippage at send. Suggested default 10 bps.

Approval mode (approve each ticket, or auto-send every PASS) is asked once in `order-execution`, not here. Auto mode needs the daily loss stop from step 8 to be written first.

Write the answers, the date, and the venue to `risk-limits.md`. Newer written limits replace older ones; never mix them.

## 2. Every ticket

A ticket must name: market, side, entry type and price, stop price, size or risk budget, and the strategy side it came from with its bar close time.

Read live, right before sizing:
- Account: equity, available margin, open positions, open orders.
  - Bybit: `GET /v5/account/wallet-balance`, `GET /v5/position/list?category=linear`, `GET /v5/order/realtime?category=linear`.
  - Hyperliquid: `POST /info` with `clearinghouseState` and `openOrders` for the account address.
- Instrument: min qty, qty step, tick size, min notional, max leverage.
  - Bybit: `GET /v5/market/instruments-info?category=linear&symbol=...`.
  - Hyperliquid: `POST /info` with `meta` (szDecimals, maxLeverage).
- Book: best bid and ask. Reject if older than 60 seconds.

Size:

```
stressed_loss = qty * |entry - stop| + qty * entry * taker_fee * 2 + qty * entry * slippage
qty = floor_to_step(max_loss_usd / per_unit_stressed_loss)
```

Use the venue's real taker fee (Bybit linear default 0.00055; Hyperliquid per your fee tier).

FAIL if any of these is true:
- No stop, or stop on the wrong side of entry.
- Market not on the allowed list.
- qty after rounding is below the exchange minimum, or min notional cannot be met without breaking the loss cap. Do not round up to fit.
- Margin at the chosen leverage exceeds available margin.
- Leverage above the cap, positions would exceed the cap, or total open risk would exceed the cap.
- Daily loss stop already hit.
- Strategy side is cancelled (price past its invalidation) at the live book.
- Account or book read failed or is stale. Old numbers are never used.

PASS writes a file `risk/<UTC time>-<symbol>-<side>-pass.md` with: inputs, live reads with UTC times, qty, stop, leverage, stressed loss in USD and as % of equity, and the ticket id. FAIL writes the same with the reason.

## 3. Rules that never change

- Never send an order. Never move funds. Never ask for or print a private key.
- No profit promises. Unrealized PnL is not profit. A deposit is not profit.
- Agreement between bots is not evidence. Idle cash is not a reason to trade.
- If the result of a send is unknown, nothing is resent until the exchange record is read.
- Secrets live only in environment variables or the platform secret store, never in the repo.
